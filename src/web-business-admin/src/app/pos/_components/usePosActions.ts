"use client";

import { useEffect, useRef } from "react";
import { announceSessionExpired, api, ApiError } from "@/lib/api";
import { isStepUpCancelled, withStepUp } from "@/lib/stepUpPrompt";
import { notifyKitchenChanged } from "@/lib/kitchenSignal";
import { toast } from "@/components/ui";
import { listOps, type OpPayload } from "@/lib/offlineDb";
import { discardOrder, enqueue, setQueuedOrderCustomer } from "@/lib/sync";
import { formatCurrency, sumMoney } from "@/lib/money";
import { uuid } from "@/lib/uuid";
import { autoPrintKot, printKotSlip } from "@/lib/printing";
import { errorField, friendlyError, isNothingToSend } from "@/lib/orderErrors";
import { thermalAutoKot } from "@/lib/printJobs";
import type { DiscountInput, Kot, Order, PaymentMethod } from "@/lib/types";
import { apiLine, estimateOf, mergeLines, needsTable, stageOf } from "./tickets";
import { cartToEstimate } from "./pricing";
import type { Offer } from "@/lib/extras";
import { combinedDiscount, estimateOffers } from "@/lib/modifiers";
import type { CartLine } from "./types";
import { tryComputeInvoice } from "@/lib/taxEstimate";
import { walletBlock } from "@/lib/billing";
import { API_METHOD, type PayLine, type TenderKind } from "./pay-plan";
import { offlineRef, type KotPrint, type LocalOrder, type Tax, type Ticket } from "./types";
import type { useTickets } from "./useTickets";

const PAID_BY: Record<TenderKind, string> = { cash: "in cash", card: "by card", upi: "by UPI" };

type Store = ReturnType<typeof useTickets>;

/** Order-rule conflicts the page answers with a choice instead of a toast. */
export interface ActionHooks {
  /** 409 table_has_open_order on Place / Change table: the table's existing order id when the server sends it. */
  onTableBusy?: (ticketId: string, existingOrderId: string | null) => void;
  /** 409 bill_already_exists on Make bill (a retry after a timeout, maybe with a new discount). */
  onBillExists?: (ticketId: string, billId: string | null, canReplace: boolean) => void;
}

/** Server line ids of an order response by cart key: the response lists the lines in the order they were sent. */
export function lineIdsOf(lines: CartLine[], o: Pick<Order, "lines">, known: Record<string, string> = {}): Record<string, string> {
  const used = new Set(Object.values(known));
  const fresh = o.lines.filter((l) => !used.has(l.id));
  const out = { ...known };
  lines.filter((l) => !out[l.key]).forEach((l, i) => { if (fresh[i]) out[l.key] = fresh[i].id; });
  return out;
}

/** The toast after a kitchen ticket, from the server's print result (never a plain success when the printer failed). */
export function kotPrintMessage(k: Pick<Kot, "number" | "print" | "needs_reprint">): { tone: "success" | "error"; title: string; hint?: string; status: KotPrint | undefined } {
  const st = k.print?.status;
  const hint = k.print?.message ?? undefined;
  if (st === "failed" || k.needs_reprint || k.print?.needs_reprint) return { tone: "error", title: "Printer did not respond", hint: k.print?.error ?? hint, status: "failed" };
  if (st === "no_printer") return { tone: "success", title: "Sent to kitchen screen (no printer set up)", status: st };
  if (st === "queued" && k.print?.hub_online === false) return { tone: "success", title: "Sent to kitchen screen", hint: hint ?? "The kitchen printer helper is offline: the slip prints when it is back.", status: st };
  if (st === "sent" || st === "queued" || st === "printed") return { tone: "success", title: "Sent to kitchen printer", status: st };
  return { tone: "success", title: `Kitchen ticket #${k.number} sent`, status: undefined };
}

/**
 * The order lifecycle (place -> KOT -> bill -> pay), per ticket, every step falling back to the offline queue on network
 * failure. There is NO shared mutable state between tickets: every function takes a ticket id, reads that ticket's
 * latest snapshot from the store, and writes its result back with `patch(id, ...)`, so ticket A can be mid-request while
 * ticket B is placed, billed or paid. Idempotency: the order uses the ticket id as client_uuid and the payment keeps its
 * own key per ticket (kept until the payment succeeds), so a retry or a lost response never duplicates anything.
 */
export function usePosActions(store: Store, tax: Tax, labelOf: (t: Ticket) => string, offers: Offer[] = [], hooks: ActionHooks = {}) {
  const { get, patch, setBusy } = store;
  useEffect(() => { void thermalAutoKot(); }, []); // learn early (while online) whether orders go to the kitchen printer by themselves

  // One action at a time per ticket, decided synchronously: a second tap (or key repeat) in the moment before the button re-renders as
  // disabled, e.g. while an offline order is being written to IndexedDB, used to queue the same step twice (QA review L).
  const inflight = useRef(new Set<string>());
  async function guard<T>(id: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (inflight.current.has(id)) return undefined;
    inflight.current.add(id);
    setBusy(id, true);
    try { return await fn(); }
    catch (e) {
      // Plain words for every server error (never the raw detail), with "Try again" when a retry can help.
      // Session gone: the counter shows its "Session expired, sign in again" prompt (the order is kept), not a toast on top of it.
      if (e instanceof ApiError && e.status === 401 && announceSessionExpired()) return;
      const f = friendlyError(e);
      toast.error(f.title, { description: f.hint, action: f.retry ? { label: "Try again", onClick: () => void guard(id, fn) } : undefined });
    }
    finally { inflight.current.delete(id); setBusy(id, false); }
  }

  const queue = (o: LocalOrder, ops: { op: OpPayload; label: string }[]) =>
    enqueue(ops.map((x) => ({ ...x, order_ref: o.client_uuid })));

  /** Saves ops to the offline queue (IndexedDB) and reports a failure instead of pretending: storage full / blocked / private mode
   *  must never produce a "saved offline" message for a sale that exists nowhere. Returns false after telling the cashier. */
  async function saveOffline(o: LocalOrder, ops: { op: OpPayload; label: string }[]): Promise<boolean> {
    try { await queue(o, ops); return true; }
    catch {
      toast.error("Could not save this on the device", { description: "The device storage is full or blocked, so nothing was saved. Do not rely on this order: connect to the internet and try again, or free some space.", duration: 15_000 });
      return false;
    }
  }

  const markPaid = (t: Ticket): Ticket => (stageOf(t) === "paid" && !t.paidAt ? { ...t, paidAt: new Date().toISOString() } : t);

  async function placeOffline(t: Ticket) {
    const subtotal = estimateOf(t.lines);
    const o: LocalOrder = { client_uuid: t.id, id: null, offline: true, subtotal, lines: t.lines };
    if (!(await saveOffline(o, [{ label: `Order ${offlineRef(o)}`, op: { type: "create_order", accept_price_changes: false, order: {
      client_uuid: t.id, order_type: t.type, table_id: needsTable(t) ? t.tableId : null, customer_id: t.customerId || null,
      ...(t.secondOrder && needsTable(t) ? { allow_second_order: true } : {}),
      lines: t.lines.map((l) => apiLine(l, true)) } } }]))) return; // not stored: the ticket stays a draft
    patch(t.id, (x) => ({ ...x, order: o }));
    toast.message("Order saved offline", { description: `${labelOf(t)} will sync automatically when the connection returns.` });
  }

  const placeOrder = (id: string) => guard(id, async () => {
    const t = get(id);
    if (!t || t.order) return;
    if (!navigator.onLine) return placeOffline(t);
    try {
      const o: Order = await api.createOrder({
        client_uuid: t.id, order_type: t.type, table_id: needsTable(t) ? t.tableId : null, customer_id: t.customerId || null,
        ...(t.secondOrder && needsTable(t) ? { allow_second_order: true } : {}),
        lines: t.lines.map((l) => apiLine(l)) });
      patch(id, (x) => ({ ...x, order: { client_uuid: t.id, id: o.id, offline: false, subtotal: o.subtotal, lines: t.lines, lineIds: lineIdsOf(t.lines, o) } }));
      toast.success("Order placed", { description: `${labelOf(t)}: now send it to the kitchen` });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return placeOffline(t); // connection lost mid-request: safe, same UUID
      if (e instanceof ApiError && (e.code === "table_has_open_order" || /already has an open order/i.test(e.message)) && hooks.onTableBusy) {
        hooks.onTableBusy(id, errorField(e, "existing_order_id", "order_id")); return;
      }
      // 402 chilli_empty (docs/CHILLI_WALLET.md): no Chilli left for a NEW order. Plain English; the ticket stays a draft, open orders keep working.
      const w = walletBlock(e);
      if (w) {
        window.dispatchEvent(new Event("chilli:refresh"));
        toast.error(w.title, { description: w.description, duration: 15_000, action: { label: "Recharge", onClick: () => { window.location.href = "/manage?tab=billing"; } } });
        return;
      }
      throw e;
    }
  });

  /** Place the order; with a kitchen printer on automatic, its kitchen slip goes out right away (online or queued offline). */
  const place = async (id: string) => {
    await placeOrder(id);
    const t = get(id);
    if (t?.order && t.kot === null && await thermalAutoKot()) await sendKot(id);
  };

  /**
   * Put the items collected in `more` on the placed order (online: POST /orders/{id}/lines; offline or connection lost:
   * an add_lines op in the queue). The batch id stays on the ticket until it succeeds, so a retry or a lost response
   * never adds the items twice. Afterwards `kot` is null again: the new items still have to go to the kitchen.
   */
  const addToOrder = (id: string) => guard(id, async () => {
    const t = get(id);
    const order = t?.order;
    const more = t?.more ?? [];
    if (!t || !order || t.bill || more.length === 0) return;
    const sig = JSON.stringify(more.map((l) => [l.key, l.qty]));
    const batch = t.addBatch?.sig === sig ? t.addBatch.id : uuid();
    if (t.addBatch?.id !== batch) patch(id, (x) => ({ ...x, addBatch: { id: batch, sig } }));
    const done = (subtotal: string) => patch(id, (x) => ({ ...x, lines: mergeLines(x.lines, more), more: [], addBatch: undefined,
      hadKot: x.hadKot || x.kot !== null, kot: null, order: x.order && { ...x.order, subtotal, lines: mergeLines(x.order.lines, more) } }));
    const viaQueue = async () => {
      if (!(await saveOffline(order, [{ label: `Added items for ${offlineRef(order)}`, op: { type: "add_lines", order_client_uuid: order.client_uuid, batch_uuid: batch, accept_price_changes: false,
        lines: more.map((l) => apiLine(l, true)) } }]))) return;
      done(sumMoney([order.subtotal, estimateOf(more)]));
      toast.message("New items saved offline", { description: `${labelOf(t)}: they sync automatically when the connection returns.` });
    };
    if (order.offline || !navigator.onLine) return viaQueue();
    try {
      const o: Order = await api.addOrderLines(order.id!, { batch_uuid: batch, lines: more.map((l) => apiLine(l)) });
      done(o.subtotal);
      patch(id, (x) => (x.order ? { ...x, order: { ...x.order, lineIds: lineIdsOf(more, o, x.order.lineIds) } } : x));
      toast.success("Items added to the order", { description: labelOf(t) });
    } catch (e) { if (e instanceof ApiError && e.status === 0) return viaQueue(); throw e; }
  });

  /** Add the new items; with a kitchen printer on automatic, their kitchen slip goes out right away (like Place order). */
  const addMore = async (id: string) => {
    await addToOrder(id);
    const t = get(id);
    if (t?.order && !t.more?.length && t.kot === null && await thermalAutoKot()) await sendKot(id);
  };

  const sendKot = (id: string) => guard(id, async () => {
    const t = get(id);
    const order = t?.order;
    if (!t || !order) return;
    const viaQueue = async () => {
      if (!(await saveOffline(order, [{ label: `KOT for ${offlineRef(order)}`, op: { type: "send_kot", order_client_uuid: order.client_uuid } }]))) return;
      patch(id, (x) => ({ ...x, kot: "queued" }));
      toast.message("Will reach the kitchen when the internet is back", { description: `${labelOf(t)}: kitchen ticket saved on this device` });
    };
    if (order.offline || !navigator.onLine) return viaQueue();
    try {
      const k = await api.sendKot(order.id!);
      const m = kotPrintMessage(k);
      patch(id, (x) => ({ ...x, kot: k.number, kotId: k.id, kotPrint: m.status }));
      if (m.tone === "error") showPrintFailed(id, k.id, k.number, m.hint);
      else toast.success(m.title, { description: m.hint ?? `${labelOf(t)} · kitchen ticket #${k.number}` });
      if (autoPrintKot.get() && m.status !== "failed" && !(await thermalAutoKot())) void printKotSlip(k.id).catch(() => toast.error("Could not open the kitchen slip")); // the kitchen printer already prints it
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return viaQueue();
      // Another device (or tab) already sent it: show the order as in the kitchen now, not after the next refresh (QA D26).
      if (isNothingToSend(e)) { patch(id, (x) => ({ ...x, kot: x.kot ?? "sent", hadKot: true })); toast.message("Already in the kitchen", { description: `${labelOf(t)}: another screen sent it a moment ago` }); return; }
      throw e;
    }
  });

  /** The kitchen printer failed: a toast that stays, with "Try again" (print once more) and "Show on screen" (the slip as a PDF). */
  function showPrintFailed(id: string, kotId: string, no: number, why?: string) {
    toast.error("Printer did not respond", { duration: Infinity, id: `kot-print-${kotId}`,
      description: `Kitchen ticket #${no} is on the kitchen screen, but it was not printed.${why ? ` (${why})` : ""}`,
      action: { label: "Try again", onClick: () => void reprintKot(id) },
      cancel: { label: "Show on screen", onClick: () => void printKotSlip(kotId).catch(() => toast.error("Could not open the kitchen slip")) } });
  }

  /** Print the kitchen ticket again on the kitchen printer; the "Needs reprint" chip clears when it works. */
  const reprintKot = (id: string) => guard(id, async () => {
    const t = get(id);
    if (!t?.kotId || typeof t.kot !== "number") return;
    let failed: boolean, any: boolean;
    try {
      const r = await api.retryOrderPrint(t.order!.id!); // order-rules servers: every slip of the order that needs it
      failed = r.needs_reprint; any = true;
    } catch (e) {
      if (!(e instanceof ApiError && [404, 405].includes(e.status))) throw e;
      const r = await api.printKot(t.kotId); // older servers: this ticket again
      failed = r.jobs.some((j) => j.status === "failed"); any = r.jobs.length > 0;
    }
    patch(id, (x) => ({ ...x, kotPrint: failed ? "failed" : any ? "sent" : "no_printer" }));
    if (failed) showPrintFailed(id, t.kotId, t.kot);
    else { toast.dismiss(`kot-print-${t.kotId}`); toast.success(any ? "Sent to kitchen printer" : "No kitchen printer set up", { description: `Kitchen ticket #${t.kot}` }); }
  });

  /** Offline settlement: queue finalize + payment; show a provisional (non-tax) receipt. */
  async function doSettleOffline(id: string, method: PaymentMethod) {
    const t = get(id);
    const order = t?.order;
    if (!t || !order) return;
    const discount = t.discount ?? null;
    const serviceCharge = t.serviceCharge !== false;
    if (!(await saveOffline(order, [
      { label: `Finalize bill ${offlineRef(order)}`, op: { type: "finalize_bill", order_client_uuid: order.client_uuid, discount, service_charge: serviceCharge, ...(t.applyOffers === false ? { apply_offers: false } : {}) } },
      { label: `${method === "cash" ? "Cash" : "Card"} payment ${offlineRef(order)}`, op: { type: "payment", order_client_uuid: order.client_uuid, method } },
    ]))) return;
    // The provisional receipt shows the same numbers the live totals showed: the client-side GST estimate.
    // Same estimate as the live totals (running offers included).
    const inv = tax && !t.bill ? (offers.length && t.applyOffers !== false ? estimateInvoice(t, order.lines, tax, offers) : tryComputeInvoice(cartToEstimate(order.lines), tax, t.type, discount, serviceCharge).invoice) : null;
    const std = tax?.rates.find((r) => r.code === "standard");
    patch(id, (x) => markPaid({ ...x, prov: { ref: offlineRef(order), method, lines: order.lines, subtotal: t.bill?.subtotal ?? inv?.subtotal ?? sumMoney([order.subtotal]),
      vat: t.bill?.tax_amount ?? inv?.tax_amount ?? null, total: t.bill?.total ?? inv?.total ?? null, rate: std?.rate_percent ?? null,
      currency: tax?.currency ?? "", at: new Date().toISOString(), inv, country: tax?.country, taxNumberLabel: tax?.tax_number_label } }));
    toast.message("Sale saved offline", { description: "Payment is recorded when the device syncs." });
  }
  const settleOffline = (id: string, method: PaymentMethod) => guard(id, () => doSettleOffline(id, method));

  /** Make bill; `replace` = correct the unpaid bill already made for this order with this ticket's discount (bill_already_exists). */
  const finalize = (id: string, replace = false) => guard(id, async () => {
    const t = get(id);
    if (!t?.order?.id) return;
    try {
      // A discount over the cashier limit may need the PIN again first (docs/STAFF_PIN_DEVICES_API.md 5).
      const orderId = t.order.id;
      const bill = await withStepUp(() => api.finalize(orderId, { discount: t.discount ?? null, service_charge: t.serviceCharge !== false, apply_offers: t.applyOffers !== false, replace_existing: replace }), "give this discount");
      patch(id, (x) => ({ ...x, bill }));
      notifyKitchenChanged(); // the ticket leaves the Kitchen board when the bill is made: reload it now, no stale ticket
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) { toast.error("No internet connection", { description: "Use the offline payment buttons." }); return; }
      if (isStepUpCancelled(e)) { toast.error("Bill not made", { description: "Your PIN is needed for this discount." }); return; }
      if (e instanceof ApiError && e.code === "bill_already_exists" && hooks.onBillExists) { hooks.onBillExists(id, errorField(e, "bill_id", "existing_bill_id"), e.data?.can_replace === true); return; }
      // Older servers refused the BILL (402 wallet_empty / billing_suspended): plain English, the order stays open, nothing else changes.
      const w = walletBlock(e);
      if (w) { toast.error(w.title, { description: w.description, duration: 10_000 }); return; }
      throw e;
    }
  });

  /**
   * Discount on a bill that is made but not paid yet (POST /bills/{id}/discount): the issued invoice is replaced by a new one
   * (credit note for the old number); the ticket shows the bill that stands now. After a payment the server refuses (409
   * bill_has_payment): the toast says so and the bill stays as it is.
   */
  const applyBillDiscount = (id: string, d: DiscountInput | null) => guard(id, async () => {
    const t = get(id);
    if (!t?.bill) return;
    const billId = t.bill.id;
    try {
      const bill = await withStepUp(() => api.applyBillDiscount(billId, d), "give this discount");
      patch(id, (x) => ({ ...x, bill, discount: d }));
      toast.success(d ? "Discount added to the bill" : "Discount removed from the bill", { description: `New bill ${bill.invoice_number}. The earlier bill ${t.bill.invoice_number} was cancelled with a credit note.` });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) { toast.error("No internet connection", { description: "A discount on a made bill needs the connection." }); return; }
      if (isStepUpCancelled(e)) { toast.error("Discount not added", { description: "Your PIN is needed for this discount." }); return; }
      if (e instanceof ApiError && (e.status === 403 || e.status === 409 || e.status === 422)) { toast.error("Discount not added", { description: e.message }); return; }
      throw e;
    }
  });

  /**
   * Books the lines the cashier confirmed in the pay sheet (one payment per line, each with its own idempotency key so a retry
   * never double-books). If the connection is gone before anything was booked, the whole balance settles through the offline
   * queue with the first line's method (a split cannot be queued offline). If some lines were booked and a later one fails, the
   * bill is reloaded so the sheet shows what is still due, and the error is shown.
   */
  const payLines = (id: string, lines: PayLine[]) => guard(id, async () => {
    const t = get(id);
    const bill = t?.bill;
    if (!t || !bill || lines.length === 0) return false;
    let booked = 0;
    try {
      for (const l of lines) {
        await api.pay(bill.id, { idempotency_key: l.key, method: API_METHOD[l.kind], amount: l.amount });
        booked++;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 0 && booked === 0) { await doSettleOffline(id, API_METHOD[lines[0].kind]); return true; } // payment op settles whatever is still due
      if (booked > 0) { try { const fresh = await api.bill(bill.id); patch(id, (x) => ({ ...x, bill: fresh })); } catch { /* the next refresh shows it */ } }
      throw e;
    }
    const fresh = await api.bill(bill.id);
    patch(id, (x) => markPaid({ ...x, payKey: null, bill: fresh }));
    toast.success("Payment received", { description: labelOf(t) });
    return true;
  });

  /**
   * One tap (the original "Pay cash" / "Pay card"): pays exactly the balance due with one method. The idempotency key is kept on
   * the ticket per method, so a retry after a lost response never books twice. Offline, the balance goes through the offline queue.
   */
  const payExact = (id: string, kind: TenderKind) => guard(id, async () => {
    const t = get(id);
    const bill = t?.bill;
    if (!t || !bill) return false;
    const method = API_METHOD[kind];
    const key = t.payKey?.method === method ? t.payKey.key : uuid();
    patch(id, (x) => ({ ...x, payKey: { method, key } }));
    const amount = bill.balance_due;
    try {
      await api.pay(bill.id, { idempotency_key: key, method, amount });
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) { await doSettleOffline(id, method); return true; } // the queued payment settles whatever is still due
      throw e;
    }
    const fresh = await api.bill(bill.id);
    patch(id, (x) => markPaid({ ...x, payKey: null, bill: fresh }));
    toast.success(`Paid ${formatCurrency(amount, tax?.currency)} ${PAID_BY[kind]}`, { description: labelOf(t) });
    return true;
  });

  const receipt = (id: string) => guard(id, async () => {
    const t = get(id);
    if (t?.bill) window.open(await api.receiptBlobUrl(t.bill.id), "_blank");
  });

  /**
   * Attach / change / clear the customer of a placed (not yet billed) ticket; the bill snapshots it at finalize.
   * Online order: PUT /orders/{id}/customer. Offline order not synced yet: rewrite the customer inside its queued
   * create_order (same client_uuid). Offline order that already synced: look up its server id and use the endpoint.
   * Returns true when the change was saved.
   */
  const setCustomer = (id: string, customerId: string) => guard(id, async () => {
    const t = get(id);
    const o = t?.order;
    if (!t || !o || t.bill || t.prov) return false;
    if (t.customerId === customerId) return true;
    let serverId = o.offline ? null : o.id;
    if (o.offline) {
      const r = await setQueuedOrderCustomer(o.client_uuid, customerId || null);
      if (r === "updated") { patch(id, (x) => ({ ...x, customerId })); return true; }
      if (r === "synced" && navigator.onLine) serverId = (await api.orders()).find((x) => x.client_uuid === o.client_uuid)?.id ?? null;
    }
    if (!serverId || !navigator.onLine) { toast.error("Changing the customer needs a connection"); return false; }
    try {
      await api.setOrderCustomer(serverId, customerId || null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) { toast.error("Changing the customer needs a connection"); return false; }
      throw e;
    }
    patch(id, (x) => ({ ...x, customerId }));
    return true;
  });

  /** Use the bill the server already has for this order (after bill_already_exists): it becomes this ticket's bill as it is. */
  const adoptBill = (id: string, billId: string | null) => guard(id, async () => {
    const t = get(id);
    if (!t?.order?.id) return;
    const bid = billId ?? (await api.bills()).find((b) => b.order_id === t.order!.id && b.status !== "superseded" && b.status !== "voided")?.id;
    if (!bid) { toast.error("Could not find that bill", { description: "Open it from Orders." }); return; }
    const bill = await api.bill(bid);
    patch(id, (x) => ({ ...x, bill, discount: null }));
    toast.message("Showing the bill that was already made", { description: "The new discount was not added. Ask a manager to change the bill if needed." });
  });

  /** Remove a line of a placed order the kitchen has not been sent yet (server DELETE; the last line cannot go). */
  const removePlacedLine = (id: string, key: string) => guard(id, async () => {
    const t = get(id);
    const o = t?.order;
    const lineId = o?.lineIds?.[key];
    if (!t || !o?.id || !lineId) return;
    const fresh: Order = await api.removeOrderLine(o.id, lineId);
    const { [key]: _gone, ...lineIds } = o.lineIds ?? {}; void _gone;
    patch(id, (x) => ({ ...x, lines: x.lines.filter((l) => l.key !== key), order: x.order && { ...x.order, subtotal: fresh.subtotal, lines: x.order.lines.filter((l) => l.key !== key), lineIds } }));
    toast.success("Dish removed from the order", { description: labelOf(t) });
  });

  /** "Change table" on a placed dine-in order (POST /orders/{id}/transfer; a busy table is a 409 with the merge hint). */
  const changeTable = (id: string, tableId: string) => guard(id, async () => {
    const t = get(id);
    if (!t?.order?.id) { patch(id, (x) => ({ ...x, tableId })); return; }
    try { await api.transferOrder(t.order.id, tableId); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.code === "table_has_open_order" || /already has an open order/i.test(e.message))) { toast.error("That table already has an order", { description: "Pick a free table." }); return; }
      throw e;
    }
    patch(id, (x) => ({ ...x, tableId }));
    toast.success("Table changed", { description: labelOf(t) });
  });

  /** Cancel a server-side, unbilled order. Throws ApiError so the dialog can show it inline. */
  async function cancelServerOrder(id: string, reason: string) {
    const t = get(id);
    if (!t?.order?.id) return;
    await api.cancelOrder(t.order.id, reason);
    toast.success("Order cancelled", { description: labelOf(t) });
  }

  /**
   * Cancel an order that was saved offline. If it has not synced yet, it is simply discarded locally.
   * Returns "discarded", or "server" with the server order id when it already reached the server.
   */
  async function cancelOfflineOrder(id: string): Promise<"discarded" | { serverId: string }> {
    const o = get(id)!.order!;
    const ops = (await listOps()).filter((x) => x.order_ref === o.client_uuid && x.op.type === "create_order");
    if (ops.length === 0 || ops.some((x) => x.status !== "synced")) { await discardOrder(o.client_uuid); return "discarded"; }
    const found = (await api.orders()).find((x) => x.client_uuid === o.client_uuid);
    if (!found) { await discardOrder(o.client_uuid); return "discarded"; }
    patch(id, (x) => ({ ...x, order: { ...o, id: found.id, offline: false } }));
    return { serverId: found.id };
  }

  return { place, addMore, sendKot, reprintKot, settleOffline, finalize, applyBillDiscount, adoptBill, payLines, payExact, receipt, cancelServerOrder, cancelOfflineOrder, setCustomer, removePlacedLine, changeTable };
}

/** The offline provisional receipt's estimate with the running offers (same rule as the live totals). */
function estimateInvoice(t: Ticket, lines: CartLine[], tax: NonNullable<Tax>, offers: Offer[]) {
  const o = estimateOffers(lines.map((l) => ({ itemId: l.item.id, categoryId: l.item.category_id, unit: l.unit, qty: l.qty })), offers, t.type);
  const disc = o.applied.length ? combinedDiscount(estimateOf(lines), o.total, o.applied.map((a) => a.label), t.discount ?? null) : t.discount ?? null;
  return tryComputeInvoice(cartToEstimate(lines), tax, t.type, disc, t.serviceCharge !== false).invoice;
}
