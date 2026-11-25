"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { motion } from "motion/react";
import { Card, EmptyState } from "@/components/ui";
import { toast, useConfirm } from "@/components/ui";
import { Sheet } from "@chilli/ui";
import { CancelOrderDialog } from "@/components/pos/CancelOrderDialog";
import { OpenOrdersStrip, type OpenOrderChip, type OpenOrderStatus } from "@/components/pos";
import { markBillRequestsRead } from "@/lib/billRequests";
import { api, mediaUrl } from "@/lib/api";
import { flyToCart } from "@/lib/fly-to-cart";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { useSyncStatus } from "@/lib/useSyncStatus";
import { isAdminRole, useCan, useRole } from "@/lib/useRole";
import { discountLimitFor } from "./_components/discountPreview";
import type { DiscountInput, MenuItem, Order, OrderType } from "@/lib/types";
import { CounterStrip } from "./_components/CounterStrip";
import { MenuPanel } from "./_components/MenuPanel";
import { MobileCartBar } from "./_components/MobileCartBar";
import { OfflineBanner } from "./_components/OfflineBanner";
import { OrderPanel, STAGE_TEXT, type OrderPanelActions } from "./_components/OrderPanel";
import { ShiftOpenBanner } from "@/components/shell/shift-banner";
import { addLine, canAddMore, cartKey, changeLine, confirmLine, defaultVariantId, markCheck, setLineMods, setLineNote, setLineVariant, itemCount, lowestFreeNo, needsTable, stageOf, tableClaims, ticketBadge, ticketLabel } from "./_components/tickets";
import { OrderDialogs, useSoldOut, useTableStatus, type BusyTableAsk } from "./_components/OrderDialogs";
import { ApiError } from "@/lib/api";
import { ticketTotal, usePricing } from "./_components/pricing";
import { MAX_OPEN_TICKETS, offlineRef, type Ticket } from "./_components/types";
import { usePosActions } from "./_components/usePosActions";
import { usePosMenu } from "./_components/usePosMenu";
import { useTickets } from "./_components/useTickets";
import { VoiceOrderButton, type VoiceApply } from "./_components/VoiceOrder";
import { defaultMods, ModifierPicker, type PickerState } from "./_components/ModifierPicker";
import type { CartLine, LineMods } from "./_components/types";

const isEmptyDraft = (t: Ticket) => stageOf(t) === "draft" && t.lines.length === 0;

/** The kitchen role works on the Kitchen screen: the counter is not for it (the server refuses its orders anyway; QA D28). */
function KitchenLock() {
  return (
    <Card className="mx-auto mt-6 max-w-lg">
      <EmptyState icon={<Lock />} title="This screen is for the counter"
        hint="Your sign-in is for the Kitchen screen. Ask the owner or manager if you need to take orders."
        action={<Link href="/kitchen" className="inline-flex h-11 items-center rounded-xl bg-primary bg-primary-gradient px-5 text-sm font-semibold text-primary-fg shadow-[var(--shadow-inset-hi),var(--shadow-glow)]">Go to Kitchen</Link>} />
    </Card>
  );
}

export default function PosPage() {
  return useRole() === "kitchen" ? <KitchenLock /> : <Counter />;
}

function Counter() {
  const { online, ops } = useSyncStatus();
  const confirm = useConfirm();
  const wide = useMediaQuery("(min-width: 768px)");
  const desk = useMediaQuery("(min-width: 1024px) and (min-height: 760px)"); // the counter overview strip is desktop-only
  const menu = usePosMenu(online);
  const store = useTickets();
  const { tickets, activeId, ready, busy } = store;
  const { get, all, patch, create, remove, setActive, isBusy, activeRef } = store; // stable callbacks
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cancelFor, setCancelFor] = useState<string | null>(null);

  const role = useRole();
  const currency = menu.tax?.currency ?? "";
  const labelOf = useCallback((t: Ticket) => ticketLabel(t), []);
  // Order-rule conflicts answered with a plain choice (dialogs in OrderDialogs).
  const [busyAsk, setBusyAsk] = useState<BusyTableAsk | null>(null);
  const [billExists, setBillExists] = useState<{ ticketId: string; billId: string | null; canReplace: boolean } | null>(null);
  const act = usePosActions(store, menu.tax, labelOf, menu.offers, {
    onTableBusy: (ticketId, existing) => { const t = get(ticketId); if (t) setBusyAsk({ ticketId, tableId: t.tableId, orderId: existing, afterPlace: true }); },
    onBillExists: (ticketId, billId, canReplace) => setBillExists({ ticketId, billId, canReplace }),
  });
  const tableStatus = useTableStatus(online && role !== "kitchen");
  const soldOut = useSoldOut(menu.items, online);
  const { isSoldOut } = soldOut;
  // Dine-in: the bill waits for the kitchen ticket unless the restaurant allows billing first (GET /auth/me order_rules).
  const [kotFirst, setKotFirst] = useState(true);
  useEffect(() => { api.me().then((m) => setKotFirst(m.order_rules?.require_kot_before_bill !== false)).catch(() => {}); }, []);
  // Session over mid-order: a calm screen first ("your order is saved"), then the sign-in page (C-13).
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); setSignedOut(true); };
    window.addEventListener("pos:session-expired", on);
    return () => window.removeEventListener("pos:session-expired", on);
  }, []);

  const active = tickets.find((t) => t.id === activeId) ?? null;
  // Discounts: owner / manager unlimited, cashier up to the restaurant's limit (the server enforces it too); waiters and kitchen cannot.
  // The gate is the permission itself (bills.discount, cap unless bills.discount.over_limit), not the role name: custom roles count.
  const { can, feature } = useCan();
  const canDiscount = can("bills.discount") && feature("billing.discount"); // permission AND the Features switch (super admin grant + owner)
  const discountLimit = discountLimitFor(can, menu.tax?.max_cashier_discount_percent);
  const pricing = usePricing(active, menu.tax, { online, canPreview: can("bills.finalize"), offers: menu.offers });
  // Only owners / managers may take the automatic offers off a bill (the server needs no permission: it only raises the price).
  const canToggleOffers = isAdminRole(role) && role !== "unknown";
  const activeStage = active ? stageOf(active) : "draft";
  // A placed / in-kitchen ticket still takes menu taps (they collect in `more` until "Add to order"); billed / paid ones are locked.
  const locked = active ? active.order !== null && !canAddMore(active) : false;
  const activeLabel = active ? labelOf(active) : "";

  /** Ticket ids whose queued operations need a human (failed / price conflict), for the red chip dot. */
  const attention = useMemo(() => {
    const s = new Set<string>();
    for (const o of ops) if (o.status === "failed" || o.status === "conflict") s.add(o.order_ref);
    return s;
  }, [ops]);

  const chips: OpenOrderChip[] = useMemo(() => tickets.map((t) => {
    const stage = stageOf(t);
    const status: OpenOrderStatus = attention.has(t.id) ? "attention" : stage === "paid" ? "paid" : t.order?.offline ? "offline"
      : stage === "billed" ? "billed" : stage === "kitchen" ? "sent" : stage === "placed" ? "placed" : "draft";
    return { id: t.id, label: labelOf(t), badge: ticketBadge(t, menu.tables), itemCount: itemCount(t.lines) + itemCount(t.more ?? []), total: ticketTotal(t, menu.tax, menu.offers), status };
  }), [tickets, attention, labelOf, menu.tax, menu.tables, menu.offers]);

  /** Open tickets for the voice sheet's "Add to" selector. */
  const voiceBills = useMemo(() => tickets.map((t) => ({ id: t.id, no: t.no, itemCount: itemCount(t.lines) + itemCount(t.more ?? []), locked: stageOf(t) !== "draft" && !canAddMore(t), placed: t.order !== null && canAddMore(t), tableId: t.tableId || null })), [tickets]);

  /** Tables other (unplaced) tickets already picked, relative to the active ticket. */
  const claims = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const [table, list] of tableClaims(tickets)) {
      const labels = list.filter((t) => t.id !== activeId).map(labelOf);
      if (labels.length) out.set(table, labels);
    }
    return out;
  }, [tickets, activeId, labelOf]);

  const qtyByItem = useMemo(() => {
    const m = new Map<string, number>();
    // Once placed, the dish cards count (and step) only the items not added to the order yet.
    for (const l of (active?.order ? active.more : active?.lines) ?? []) m.set(l.item.id, (m.get(l.item.id) ?? 0) + l.qty);
    return m;
  }, [active]);

  // ---- menu -> active ticket (stable identities: the memoised dish cards never re-render for other dishes) ----
  const add = useCallback((item: MenuItem, variantId: string | null, from: Element | null, mods?: LineMods) => {
    const id = activeRef.current;
    const t = id ? get(id) : undefined;
    if (!id || !t || isBusy(id) || (t.order && !canAddMore(t))) return;
    if (isSoldOut(item)) { toast.error(`${item.name} is sold out`, { description: "Choose another dish." }); return; }
    patch(id, (x) => (x.order ? { ...x, more: addLine(x.more ?? [], item, variantId, mods) } : { ...x, lines: addLine(x.lines, item, variantId, mods) }));
    if (from) flyToCart(from, { imageUrl: mediaUrl(item.thumb_url ?? item.image_url) });
  }, [activeRef, get, patch, isBusy, isSoldOut]);
  const decrement = useCallback((item: MenuItem) => {
    const id = activeRef.current;
    const t = id ? get(id) : undefined;
    if (!id || !t || isBusy(id) || (t.order && !canAddMore(t))) return;
    patch(id, (x) => (x.order ? { ...x, more: changeLine(x.more ?? [], cartKey(item, null), -1) } : { ...x, lines: changeLine(x.lines, cartKey(item, null), -1) }));
  }, [activeRef, get, patch, isBusy]);

  /** Voice / typed order confirmed by staff: lines go through the same cart reducer as a tap on a dish. */
  const applyVoice = useCallback((v: VoiceApply): string | null => {
    let id: string | null = activeRef.current;
    if (v.bill !== null) {
      // The same ticket creation as the "New" button (persisted draft, becomes the active ticket); a spoken number that is not open yet is created with exactly that number.
      const existing = typeof v.bill === "number" ? all().find((x) => x.no === v.bill) : undefined;
      if (existing) {
        if ((stageOf(existing) !== "draft" && !canAddMore(existing)) || isBusy(existing.id)) { toast.error(`${ticketLabel(existing)} can no longer be changed`, { description: "Choose another bill or a new bill." }); return null; }
        id = existing.id; setActive(id);
      } else {
        id = typeof v.bill === "number" ? create(v.bill) : create();
        if (id === null) { toast.warning(`${MAX_OPEN_TICKETS} bills are already open`, { description: "Take payment for one, or close an empty one, to start another." }); return null; }
      }
    }
    const t = id ? get(id) : undefined;
    if (!id || !t || (t.order && !canAddMore(t)) || isBusy(id)) { toast.error("This ticket can no longer be changed", { description: "Start a new ticket and try again." }); return null; }
    const target = id;
    // A dish with sizes never goes in without one (Half by default); merged into the cart exactly like a tap on a dish.
    // A line added by "done" with a doubt (check) is marked "Check" until staff edit or confirm it.
    const addVoiceLines = (base: CartLine[]): CartLine[] => {
      let out = base;
      for (const l of v.lines) {
        const vid = l.variantId ?? defaultVariantId(l.item), mods = defaultMods(l.item, menu.groups);
        for (let i = 0; i < l.qty; i++) out = addLine(out, l.item, vid, mods, l.note);
        if (l.check) out = markCheck(out, cartKey(l.item, vid, mods, l.note));
      }
      return out;
    };
    // the same dish again (an earlier voice add or a tap): its line's quantity goes up, said in a small toast ("Butter Chicken now ×2")
    const sayMerged = (before: CartLine[], after: CartLine[]) => {
      const had = new Map(before.map((l) => [l.key, l.qty]));
      const grown = after.filter((l) => (had.get(l.key) ?? 0) > 0 && l.qty > (had.get(l.key) ?? 0));
      if (grown.length) toast.message(grown.map((l) => `${l.label} now ×${l.qty}`).join(", "));
    };
    if (t.order) {
      // Placed / in the kitchen: the dishes collect in `more` exactly like menu taps (merged by cart key); "Add to order" sends them, so a retry
      // reuses that idempotent batch. The order type and table cannot change any more; a customer can, the way the panel's picker does it.
      const more0 = t.more ?? [];
      patch(target, (x) => ({ ...x, more: addVoiceLines(x.more ?? []) }));
      sayMerged(more0, get(target)?.more ?? []);
      if (v.customer) void act.setCustomer(target, v.customer.id);
      return target;
    }
    const table = v.tableId ? menu.tables.find((x) => x.id === v.tableId) : undefined;
    const lines0 = t.lines;
    patch(target, (x) => {
      let next: Ticket = { ...x, lines: addVoiceLines(x.lines) };
      // Same fields the order-type buttons and the table picker set (GST and service charge are derived from `type`).
      if (v.type) {
        const type = table && (v.type === "indoor" || v.type === "outdoor") ? table.area : v.type; // the table decides inside / outside
        const held = menu.tables.find((tb) => tb.id === x.tableId);
        next = { ...next, type, tableId: !needsTable({ type }) ? "" : table ? table.id : held && held.area === type ? x.tableId : "" };
      } else if (table) next = { ...next, type: table.area, tableId: table.id };
      // the table already has an order and staff chose "Start a separate order" on the sheet (same flag as the counter's choice)
      if (table && v.tableMode?.mode === "separate") next = { ...next, secondOrder: true };
      if (v.customer) next = { ...next, customerId: v.customer.id };
      return next;
    });
    sayMerged(lines0, get(target)?.lines ?? []);
    return target;
  }, [activeRef, get, all, patch, create, setActive, isBusy, menu.tables, menu.groups, act]);

  // ---- ticket strip ----
  const openNew = useCallback((): string | null => {
    const id = create();
    if (id === null) toast.warning(`${MAX_OPEN_TICKETS} bills are already open`, { description: "Take payment for one, or close an empty one, to start another." });
    return id;
  }, [create]);

  const select = useCallback((id: string) => { setActive(id); }, [setActive]);
  const localOrderIds = useMemo(() => new Map(tickets.flatMap((t) => (t.order?.id ? [[t.order.id, t.id] as const] : []))), [tickets]);

  /** A server order (open / in the kitchen) as a ticket on this screen; returns the ticket id (an existing one when already here). */
  const openServerOrder = useCallback((o: Order, extra: CartLine[] = []): string | null => {
    const mine = localOrderIds.get(o.id);
    if (mine) { if (extra.length) patch(mine, (x) => ({ ...x, more: extra.reduce((acc, l) => { let m = acc; for (let i = 0; i < l.qty; i++) m = addLine(m, l.item, l.variantId, l.mods, l.note); return m; }, x.more ?? []) })); setActive(mine); return mine; }
    const tid = create();
    if (tid === null) { toast.warning(`${MAX_OPEN_TICKETS} bills are already open`, { description: "Take payment for one, then open the order again." }); return null; }
    const lines = o.lines.map((l) => ({ key: `srv:${l.id}`, label: l.item_name, unit: l.unit_price, qty: l.quantity, variantId: l.variant_id ?? null, ...(l.note ? { note: l.note } : {}),
      item: menu.items.find((i) => i.id === l.item_id) ?? { id: l.item_id, category_id: "", name: l.item_name, price: l.unit_price, is_active: true, variants: [] } }));
    patch(tid, (x) => ({ ...x, type: o.order_type, tableId: o.table_id ?? "", customerId: o.customer_id ?? "", lines, kot: o.status !== "open" ? "sent" : null, hadKot: o.status !== "open", more: extra,
      order: { client_uuid: o.client_uuid, id: o.id, offline: false, subtotal: o.subtotal, lines, lineIds: Object.fromEntries(lines.map((l) => [l.key, l.key.slice(4)])) } }));
    return tid;
  }, [localOrderIds, patch, setActive, create, menu.items]);

  /** "Add to this table's order": the table's open order opens here and this draft's dishes move into it (not sent yet). */
  const addToTableOrder = useCallback(async (fromTicket: string, orderId: string | null, tableId: string): Promise<string | null> => {
    const from = get(fromTicket);
    try {
      const list = await api.orders();
      const o = list.find((x) => (orderId ? x.id === orderId : x.table_id === tableId && (x.status === "open" || x.status === "sent_to_kitchen")));
      if (!o) { toast.error("That table's order is no longer open", { description: "Pick the table again." }); return null; }
      const carry = from && !from.order ? from.lines : [];
      const tid = openServerOrder(o, carry);
      if (tid && from && !from.order && tid !== fromTicket) remove(fromTicket);
      const label = menu.tables.find((t) => t.id === o.table_id)?.label ?? "";
      toast.success(`Table ${label}: order opened`, { description: carry.length ? "Your dishes are added below. Tap Add to order." : "Tap dishes, then Add to order." });
      setSheetOpen(true);
      return tid;
    } catch (e) { toast.error(e instanceof ApiError && e.status === 0 ? "No internet connection" : "Could not open that order", { description: "Please try again." }); return null; }
  }, [get, openServerOrder, remove, menu.tables]);

  /** Undo of a voice "done" add: the dishes it added come off that ticket again (the cart, or the new items of a placed order). */
  const undoVoice = useCallback((ticketId: string, lines: VoiceApply["lines"]) => {
    const take = (base: CartLine[]): CartLine[] => {
      let out = base;
      for (const l of lines) {
        const key = cartKey(l.item, l.variantId ?? defaultVariantId(l.item), defaultMods(l.item, menu.groups), l.note);
        for (let i = 0; i < l.qty; i++) out = changeLine(out, key, -1);
      }
      return out;
    };
    patch(ticketId, (x) => (x.order ? { ...x, more: take(x.more ?? []) } : { ...x, lines: take(x.lines) }));
  }, [patch, menu.groups]);

  /** Voice lines for a table that already has an order and "Add to this table's order" was chosen: the same move as the counter's choice. */
  const voiceApply = useCallback(async (v: VoiceApply): Promise<string | null> => {
    if (v.tableMode?.mode === "join" && v.tableId) {
      const id = applyVoice({ ...v, type: null, tableId: null, tableMode: null });
      return id ? addToTableOrder(id, v.tableMode.orderId, v.tableId) : null;
    }
    return applyVoice(v);
  }, [applyVoice, addToTableOrder]);

  /**
   * Why a spoken place / send cannot run on this ticket now, in words (the voice sheet says it and runs nothing), else null.
   * The same rules as the counter's buttons: Place order needs dishes and, for dine-in, a table; a billed ticket takes nothing.
   */
  const voiceCommandCheck = useCallback((c: "place" | "kot" | "clear", ticketId: string | null, sheet?: { items: number; type: OrderType | null; tableId: string | null }): string | null => {
    const id = ticketId ?? activeRef.current;
    const t = id ? get(id) : undefined;
    if (!id || !t) return "there is no open order";
    if (c === "clear") return null;
    if (isBusy(id)) return `${ticketLabel(t)} is still saving. Try again in a moment`;
    if (t.order && !canAddMore(t)) return `${ticketLabel(t)} is already billed. Billing and payment are never done by voice`;
    if (!t.order) {
      // what the sheet is about to add counts: its dishes, and a type / table said with them
      if (!t.lines.length && !sheet?.items) return "the cart is empty. Say the dishes first";
      const type = sheet?.type ?? t.type;
      const table = sheet?.tableId ?? (sheet?.type && sheet.type !== t.type ? "" : t.tableId);
      if (needsTable({ type }) && !table && menu.tables.length > 0) return "choose a table for this dine-in order first";
      return null;
    }
    // placed and in the kitchen, nothing new (in the cart or on the sheet): nothing to send, said at once (no countdown)
    if (t.kot !== null && !t.more?.length && !sheet?.items) return `${ticketLabel(t)} is already in the kitchen`;
    return null;
  }, [activeRef, get, isBusy, menu.tables]);

  /**
   * A spoken command, after its countdown (or the tap on the voice sheet). "place": Place order (or Add to order on a placed
   * one); "kot": that, then Send to kitchen (place-then-send in one go, the counter's kitchen-first flow); "clear": the dishes not
   * sent yet are removed, with Undo (a placed order is never cancelled by voice). A busy table (409) or a sold-out dish answers
   * exactly like the counter buttons. Billing and payment are never run by voice. Returns what happened, in words.
   */
  const runVoiceCommand = useCallback(async (c: "place" | "kot" | "clear", ticketId: string | null): Promise<{ ok: boolean; say: string }> => {
    const id = ticketId ?? activeRef.current;
    const t = id ? get(id) : undefined;
    if (!id || !t) { toast.error("Nothing to place: there is no open order"); return { ok: false, say: "Nothing to place: there is no open order" }; }
    const label = ticketLabel(t);
    if (c === "clear") {
      const lines = t.order ? t.more ?? [] : t.lines;
      if (!lines.length) { toast.message("Nothing to clear", { description: t.order ? "Dishes already placed are not cancelled by voice. Use Cancel order." : undefined }); return { ok: false, say: "Nothing to clear" }; }
      patch(id, (x) => (x.order ? { ...x, more: [] } : { ...x, lines: [] }));
      toast.message(t.order ? "New items cleared" : "Order cleared", { duration: 8000, action: { label: "Undo", onClick: () => patch(id, (x) => (x.order ? { ...x, more: x.more?.length ? x.more : lines } : { ...x, lines: x.lines.length ? x.lines : lines })) } });
      return { ok: true, say: t.order ? "New items cleared" : "Order cleared" };
    }
    // the till's own actions toast their result ("Order placed", "Kitchen ticket #3", or the error); here only what they leave silent
    if (!t.order) {
      await act.place(id);
      if (!get(id)?.order) return { ok: false, say: `${label}: the order was not placed` };
    } else if (t.more?.length) {
      await act.addMore(id);
      if (get(id)?.more?.length) return { ok: false, say: `${label}: the new items were not added to the order` };
    } else if (c === "place") {
      toast.message(`${label} is already placed`, { description: t.kot !== null ? "It is in the kitchen." : "Say “send to kitchen” or tap Send to kitchen." });
      return { ok: true, say: `${label} is already placed` };
    }
    if (c === "place") return { ok: true, say: `${label}: order placed` };
    const after = get(id);
    if (after?.order && after.kot === null && !after.more?.length) await act.sendKot(id);
    else if (after?.kot !== null && after?.kot !== undefined && t.order && !t.more?.length) {
      toast.message(`${label} is already in the kitchen`, { description: typeof after.kot === "number" ? `Kitchen ticket #${after.kot}` : "The kitchen ticket is saved on this device." });
      return { ok: true, say: `${label} is already in the kitchen` };
    }
    const sent = get(id)?.kot;
    return sent !== null && sent !== undefined ? { ok: true, say: `${label}: sent to the kitchen` } : { ok: false, say: `${label}: not sent to the kitchen` };
  }, [activeRef, get, patch, act]);

  // /pos?order=<id> (a seated reservation, "Open at counter", or a waiter's bill request from the bell / Orders): the server order becomes a ticket here, ready for its dishes.
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !ready || menu.loading) return;
    const id = new URLSearchParams(window.location.search).get("order");
    if (!id) return;
    adopted.current = true;
    markBillRequestsRead([id]); // opened from a bill request (bell / Orders): it is read now
    window.history.replaceState(null, "", "/pos");
    const mine = localOrderIds.get(id);
    if (mine) { setActive(mine); return; }
    api.orders().then((list) => {
      const o = list.find((x) => x.id === id);
      if (!o) { toast.error("That order is no longer open"); return; }
      if (openServerOrder(o) === null) return;
      toast.success(o.table_id ? `Table ${menu.tables.find((t) => t.id === o.table_id)?.label ?? ""} is open` : "Order opened", { description: "Tap dishes, then Add to order." });
    }).catch(() => toast.error("Could not open the order"));
  }, [ready, menu.loading, menu.tables, localOrderIds, setActive, openServerOrder]);

  // Back online: an order saved offline flips to its server state once its queued steps synced (C-12), with "Sent".
  useEffect(() => {
    for (const t of all()) {
      const o = t.order;
      if (!o?.offline || t.prov) continue;
      const mine = ops.filter((x) => x.order_ref === t.id);
      const created = mine.find((x) => x.op.type === "create_order" && x.status === "synced");
      const orderId = created?.result?.order_id;
      if (typeof orderId !== "string") continue;
      const kotOp = mine.find((x) => x.op.type === "send_kot");
      const kotNo = kotOp?.status === "synced" && typeof kotOp.result?.kot === "number" ? kotOp.result.kot : null;
      if (t.kot === "queued" && kotOp && kotOp.status !== "synced") continue; // wait until the kitchen ticket is through too
      patch(t.id, (x) => ({ ...x, order: x.order && { ...x.order, id: orderId, offline: false }, ...(x.kot === "queued" ? { kot: kotNo ?? x.kot, hadKot: true } : {}) }));
      toast.success(t.kot === "queued" ? "Sent to the kitchen (synced)" : "Order sent (synced)", { description: labelOf(t) });
    }
  }, [ops, all, patch, labelOf]);

  async function closeTicket(id: string) {
    const t = get(id);
    if (!t) return;
    const stage = stageOf(t);
    if (stage === "paid" || isEmptyDraft(t)) return remove(id);
    if (stage === "draft") {
      const ok = await confirm({ title: "Discard this draft?", tone: "danger", confirmLabel: "Discard draft",
        description: `${labelOf(t)} has ${itemCount(t.lines)} ${itemCount(t.lines) === 1 ? "item" : "items"} that were not placed. They will be lost.` });
      if (ok && get(id)) remove(id);
      return;
    }
    const ok = await confirm({ title: "Close this ticket?", tone: "danger", confirmLabel: "Close ticket",
      description: `${labelOf(t)} is already placed. Closing only removes it from this screen: the order stays open on the server (see Orders). To abandon it, use Cancel order instead.` });
    if (ok && get(id)) remove(id);
  }

  function hold() {
    if (!active) return;
    if (openNew() !== null) toast.message(`${activeLabel} held`, { description: "Pick it from the ticket bar any time." });
    setSheetOpen(false);
  }

  /** "New order" after a finished bill: dismiss it and land on an empty ticket (reusing an existing empty one). */
  function startNew() {
    if (!active) return;
    const id = active.id;
    const rest = all().filter((t) => t.id !== id);
    const empty = rest.find(isEmptyDraft);
    remove(id);
    if (!empty && rest.length > 0) openNew();
    else if (empty) setActive(empty.id);
    setSheetOpen(false);
  }

  async function cancelOrder() {
    const t = active;
    if (!t?.order) return;
    if (t.order.offline) {
      const ok = await confirm({ title: "Discard this offline order?", tone: "danger", confirmLabel: "Discard order",
        description: `${offlineRef(t.order)} has not reached the server yet. If you discard it the sale will NOT be recorded.` });
      if (!ok) return;
      try {
        const r = await act.cancelOfflineOrder(t.id);
        if (r === "discarded") { toast.success("Offline order discarded"); remove(t.id); } else setCancelFor(t.id); // it synced meanwhile: cancel on the server
      } catch { toast.error("Could not cancel the order"); }
    } else setCancelFor(t.id);
  }

  const cancelTicket = cancelFor ? get(cancelFor) : undefined;
  const [noteFor, setNoteFor] = useState<{ ticketId: string; key: string; more: boolean; name: string; note: string } | null>(null);

  /** Removes a cart line with an Undo toast (5 s): the line comes back where it was. */
  function removeWithUndo(id: string, key: string, more: boolean) {
    const t = get(id);
    const list = (more ? t?.more : t?.lines) ?? [];
    const idx = list.findIndex((l) => l.key === key);
    if (idx < 0) return;
    const line = list[idx];
    patch(id, (x) => (more ? { ...x, more: (x.more ?? []).filter((l) => l.key !== key) } : { ...x, lines: x.lines.filter((l) => l.key !== key) }));
    const back = (arr: CartLine[]) => (arr.some((l) => l.key === key) ? arr : [...arr.slice(0, idx), line, ...arr.slice(idx)]);
    toast.message(`Removed ${line.item.name}`, { duration: 5000, action: { label: "Undo", onClick: () => patch(id, (x) => (x.order && !more ? x : more ? { ...x, more: back(x.more ?? []) } : { ...x, lines: back(x.lines) })) } });
  }
  // "Change options" on a cart line (dishes with modifier groups only): same picker, edit mode.
  const [editLine, setEditLine] = useState<(PickerState & { key: string; more: boolean }) | null>(null);

  const panelActions: OrderPanelActions | null = active ? {
    place: () => void act.place(active.id),
    addMore: () => void act.addMore(active.id),
    sendKot: () => void act.sendKot(active.id),
    finalize: () => void act.finalize(active.id),
    payLines: (lines) => act.payLines(active.id, lines),
    payExact: (kind) => act.payExact(active.id, kind),
    settleOffline: (m) => void act.settleOffline(active.id, m),
    receipt: () => void act.receipt(active.id),
    cancel: () => void cancelOrder(),
    hold, startNew,
    // One tap clears; Undo brings everything back for 8 seconds (C-10).
    clear: () => {
      const id = active.id, before = active.lines;
      patch(id, (x) => ({ ...x, lines: [] }));
      toast.message("Order cleared", { duration: 8000, action: { label: "Undo", onClick: () => patch(id, (x) => ({ ...x, lines: before.length && !x.lines.length ? before : x.lines })) } });
    },
    setQty: (key, d) => { const l = active.lines.find((x) => x.key === key); if (l && l.qty + d <= 0) return removeWithUndo(active.id, key, false); patch(active.id, (x) => ({ ...x, lines: changeLine(x.lines, key, d) })); },
    remove: (key) => removeWithUndo(active.id, key, false),
    setMoreQty: (key, d) => { const l = (active.more ?? []).find((x) => x.key === key); if (l && l.qty + d <= 0) return removeWithUndo(active.id, key, true); patch(active.id, (x) => ({ ...x, more: changeLine(x.more ?? [], key, d) })); },
    removeMore: (key) => removeWithUndo(active.id, key, true),
    removePlaced: (key) => void act.removePlacedLine(active.id, key),
    confirmLine: (key, more) => patch(active.id, (x) => (more ? { ...x, more: confirmLine(x.more ?? [], key) } : { ...x, lines: confirmLine(x.lines, key) })),
    setVariant: (key, variantId, more) => patch(active.id, (x) => (more ? { ...x, more: setLineVariant(x.more ?? [], key, variantId) } : { ...x, lines: setLineVariant(x.lines, key, variantId) })),
    editNote: (key, more) => { const l = (more ? active.more ?? [] : active.lines).find((x) => x.key === key); if (l) setNoteFor({ ticketId: active.id, key, more, name: l.item.name, note: l.note ?? "" }); },
    reprintKot: () => void act.reprintKot(active.id),
    // The order's type follows its table's area (the server derives it the same way): switching Dine-in <-> Outdoor drops a table of the other area.
    setType: (type: OrderType) => patch(active.id, (x) => ({ ...x, type, tableId: (type === "indoor" || type === "outdoor") && (!x.tableId || menu.tables.find((tb) => tb.id === x.tableId)?.area === type) ? x.tableId : "" })),
    // A table that already has an order asks first: add to that order, or start a separate one (C-02).
    setTable: (tableId) => {
      const st = tableStatus.byId.get(tableId);
      if (st && st.status !== "free" && st.status !== "reserved" && st.orders.length && !active.order) { setBusyAsk({ ticketId: active.id, tableId, orderId: st.orders[0].order_id, afterPlace: false }); return; }
      if (active.order) { void act.changeTable(active.id, tableId).then(() => tableStatus.refresh()); return; }
      const area = menu.tables.find((tb) => tb.id === tableId)?.area;
      patch(active.id, (x) => ({ ...x, tableId, type: area === "indoor" || area === "outdoor" ? area : x.type, secondOrder: undefined }));
    },
    setCustomer: (customerId) => (active.order ? act.setCustomer(active.id, customerId) : patch(active.id, (x) => ({ ...x, customerId }))),
    customerCreated: menu.upsertCustomer,
    setDiscount: (d: DiscountInput | null) => patch(active.id, (x) => (x.bill ? x : { ...x, discount: d })),
    setBillDiscount: (d: DiscountInput | null) => { void act.applyBillDiscount(active.id, d); },
    setServiceCharge: (on) => patch(active.id, (x) => (x.bill ? x : { ...x, serviceCharge: on })),
    setApplyOffers: (on) => patch(active.id, (x) => (x.bill ? x : { ...x, applyOffers: on })),
    editOptions: (key, more) => {
      const l = (more ? active.more ?? [] : active.lines).find((x) => x.key === key);
      if (l) setEditLine({ item: l.item, from: null, mode: "edit", variantId: l.variantId, selected: l.mods?.ids ?? [], key, more });
    },
  } : null;

  const panel = (variant: "aside" | "sheet") => active && panelActions ? (
    <motion.div key={active.id} className="h-full" initial={{ opacity: 0, x: variant === "aside" ? 14 : 0, y: variant === "sheet" ? 8 : 0 }} animate={{ opacity: 1, x: 0, y: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
      <OrderPanel variant={variant} ticket={active} label={activeLabel} online={online} busy={!!busy[active.id]} tables={menu.tables} customers={menu.customers}
        tax={menu.tax} currency={currency} pricing={pricing} canDiscount={canDiscount} discountLimit={discountLimit} claims={claims} actions={panelActions}
        groups={menu.groups} canToggleOffers={canToggleOffers} tableStatus={tableStatus.byId} kotFirst={kotFirst} canCancelSent={isAdminRole(role)} />
    </motion.div>
  ) : null;

  const cartTotal = pricing.priced?.total ?? (active ? ticketTotal(active, menu.tax) : "0.00");

  return (
    <div data-pos-root="" className="flex min-w-0 flex-col gap-3 pb-20 md:h-[calc(100dvh-var(--topbar-h)-var(--tabbar-space)-2.25rem)] md:pb-0 lg:h-[calc(100dvh-8.75rem)]">
      <h1 className="sr-only">Chilli Agent</h1>
      <ShiftOpenBanner />
      <div data-open-strip="" className="sticky top-[var(--topbar-h)] z-20 -mx-3 shrink-0 bg-bg px-3 py-1.5 sm:-mx-5 sm:px-5 md:static md:mx-0 md:bg-transparent md:p-0">
        <OpenOrdersStrip orders={chips} activeId={activeId} onSelect={select} onNew={() => void openNew()} onClose={(id) => void closeTicket(id)}
          currency={currency} label="Open orders" />
      </div>

      <div className="min-h-0 min-w-0 flex-1 md:flex md:gap-4">
        {/* The overview strip sits above the menu column only, so the order panel keeps its full height. */}
        <div className="@container/menucol flex min-h-0 min-w-0 flex-col gap-3 md:h-full md:flex-1">
        {desk && role !== "kitchen" && <div className="hidden min-w-0 @min-[1000px]/menucol:block" data-testid="counter-strip-wrap"><CounterStrip tables={menu.tables} customers={menu.customers} currency={currency} localOrderIds={localOrderIds} onOpenLocal={select} /></div>}
        <MenuPanel className="min-h-0 md:flex-1" cats={menu.cats} items={menu.items} groups={menu.groups} loading={menu.loading || !ready} error={menu.error}
          locked={locked} lockedLabel={activeLabel} currency={currency} qtyByItem={qtyByItem} onAdd={add} onDecrement={decrement}
          isSoldOut={isSoldOut} onDishMenu={soldOut.openMenu}
          onRetry={() => void menu.reload()} onOpenNew={() => void openNew()}
          banner={<OfflineBanner online={online} staleSince={menu.staleSince} />}
          searchAction={role === "kitchen" ? undefined : (
            <VoiceOrderButton online={online} disabled={!active || !!busy[active.id]} currentLocked={locked} bills={voiceBills} nextNo={lowestFreeNo(tickets)} items={menu.items} cats={menu.cats} tables={menu.tables}
              customers={menu.customers} aliases={menu.aliases} onLearnt={menu.upsertAlias} currency={currency} ticketKey={active?.id ?? null} claims={claims}
              onApply={voiceApply} onUndoApply={undoVoice} onCommand={runVoiceCommand} commandCheck={voiceCommandCheck} isSoldOut={isSoldOut} tableStatus={tableStatus.byId} onCustomerCreated={menu.upsertCustomer} />
          )} />
        </div>

        {wide ? (
          <aside data-pos-aside="" aria-label="Current order" className="hidden min-h-0 w-[22rem] shrink-0 md:block xl:w-[26rem]">{panel("aside")}</aside>
        ) : (
          <>
            <MobileCartBar show={!!active && !sheetOpen} count={active ? itemCount(active.lines) + itemCount(active.more ?? []) : 0}
              total={cartTotal} currency={currency} label={`${activeLabel} · ${STAGE_TEXT[activeStage]}`} onOpen={() => setSheetOpen(true)} />
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="Current order" hideTitle flush>{panel("sheet")}</Sheet>
          </>
        )}
      </div>

      <ModifierPicker state={editLine} groups={menu.groups} currency={currency} onClose={() => setEditLine(null)}
        onPick={(v, mods) => {
          if (editLine && active) patch(active.id, (x) => {
            const edit = (lines: CartLine[]) => {
              let out = mods ? setLineMods(lines, editLine.key, mods) : lines;
              const l = lines.find((y) => y.key === editLine.key);
              const k2 = l ? cartKey(l.item, l.variantId, mods ?? l.mods, l.note) : editLine.key;
              if (l && v !== l.variantId && l.item.variants.length) out = setLineVariant(out, k2, v);
              return out;
            };
            return editLine.more ? { ...x, more: edit(x.more ?? []) } : { ...x, lines: edit(x.lines) };
          });
          setEditLine(null);
        }} />
      <OrderDialogs
        busyAsk={busyAsk} tables={menu.tables} tableStatus={tableStatus.byId} currency={currency}
        onBusyClose={() => setBusyAsk(null)}
        onAddToTableOrder={(a) => { setBusyAsk(null); void addToTableOrder(a.ticketId, a.orderId, a.tableId); }}
        onSeparateOrder={(a) => {
          setBusyAsk(null);
          patch(a.ticketId, (x) => ({ ...x, tableId: a.tableId, secondOrder: true }));
          if (a.afterPlace) void act.place(a.ticketId); // the refused Place again, now as a separate order (no extra tap)
        }}
        billExists={billExists} onBillExistsClose={() => setBillExists(null)}
        onUseExistingBill={(b) => { setBillExists(null); void act.adoptBill(b.ticketId, b.billId); }}
        onReplaceBill={(b) => { setBillExists(null); void act.finalize(b.ticketId, true); }}
        canChangeBill={isAdminRole(role)}
        note={noteFor} onNoteClose={() => setNoteFor(null)}
        onNoteSave={(text) => { if (noteFor) patch(noteFor.ticketId, (x) => (noteFor.more ? { ...x, more: setLineNote(x.more ?? [], noteFor.key, text) } : { ...x, lines: setLineNote(x.lines, noteFor.key, text) })); setNoteFor(null); }}
        soldOut={soldOut} canMarkSoldOut={isAdminRole(role) || role === "cashier"} signedOut={signedOut} />
      <CancelOrderDialog open={cancelFor !== null} onOpenChange={(o) => { if (!o) setCancelFor(null); }}
        subject={cancelTicket?.order ? (cancelTicket.order.offline ? offlineRef(cancelTicket.order) : labelOf(cancelTicket)) : "This order"}
        onConfirm={async (reason) => { if (!cancelFor) return; await act.cancelServerOrder(cancelFor, reason); const id = cancelFor; setCancelFor(null); remove(id); setSheetOpen(false); }} />
    </div>
  );
}
