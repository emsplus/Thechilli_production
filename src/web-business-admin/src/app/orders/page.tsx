"use client";

import { formatDateTime } from "@/lib/datetime";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Ban, BellRing, Bike, FilePenLine, FileText, GitBranch, HandCoins, ReceiptText, RefreshCw, ShoppingBag, Sun, Utensils, type LucideIcon } from "lucide-react";
import { Card, EmptyState, Money, PillTabs, Skeleton, StatusPill, toast } from "@/components/ui";
import { billAwaitsPayment, countOrders, filterOrders, orderCanBeBilled, ORDER_FILTERS, type OrderFilter } from "@/lib/orderFilters";
import { isMergedOrder, mergedIntoText } from "@/lib/mergedOrders";
import { groupBillLines } from "@/lib/groupLines";
import { notifyKitchenChanged } from "@/lib/kitchenSignal";
import { inKitchenOrderIds } from "@/lib/kitchenActive";
import { onKitchenChanged } from "@/lib/kitchenSignal";
import { orderArea, orderWhere } from "@/lib/tableWhere";
import { TakePayment } from "@/components/pos/TakePayment";
import { Badge, Button, Dialog, Notice, PageHeader } from "@chilli/ui";
import { EmptyCartIllustration } from "@/components/illustrations";
import { AmendBillDialog } from "@/components/pos/AmendBillDialog";
import { BillActions } from "@/components/pos/BillActions";
import { CancelOrderDialog } from "@/components/pos/CancelOrderDialog";
import { api, ApiError, auth } from "@/lib/api";
import { countryInfo, billTitle } from "@/lib/countries";
import { formatCurrency, mulMoney } from "@/lib/money";
import { useTaxConfig } from "@/lib/taxConfig";
import { useCan } from "@/lib/useRole";
import { BillSummary } from "@/app/pos/_components/Receipts";
import { VoidBillDialog } from "@/components/pos/VoidBillDialog";
import type { AmendOptions, AmendResult, Bill, BillRequest, DiningTable, Kot, Order, OrderType } from "@/lib/types";
import { BILL_POLL_MS, markBillRequestsRead, requestKey, useBillRequests } from "@/lib/billRequests";
import { billHref } from "@/components/shell/notification-bell";
import { relativeTime } from "@/lib/datetime";
import { taxPhrases } from "@/lib/taxWords";

const PAY_LABEL: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI", other: "Other", credit_note: "Credit note" };


const TYPE_ICON: Record<OrderType, LucideIcon> = { indoor: Utensils, outdoor: Sun, takeaway: ShoppingBag, delivery: Bike };
const shortId = (id: string) => id.slice(0, 6).toUpperCase();

/** Pill status shown to staff: a billed order is "Paid" once its bill has no balance. */
function pillStatus(o: Order, bill?: Bill): string {
  if (isMergedOrder(o)) return "merged"; // not a cancellation: neutral "Merged"
  if (o.status === "billed") return bill ? (Number(bill.balance_due) === 0 ? "paid" : "finalized") : "billed";
  return o.status;
}

/**
 * `asked`: the waiter asked for this order's bill (waiter app "Request bill"): the card is highlighted with "Bill asked" and a
 * Make bill button that opens it at the counter. `unread`: the cashier has not opened that request yet.
 */
function OrderCard({ o, bill, table, onCancel, onBill, onPay, onMakeBillNow, onOrder, billing, asked, unread, focused, onMakeBill, now }: { o: Order; bill?: Bill; table?: DiningTable; onCancel: () => void; onBill: () => void; onPay?: () => void; onMakeBillNow?: () => void; onOrder?: () => void; billing?: boolean;
  asked?: BillRequest; unread?: boolean; focused?: boolean; onMakeBill?: () => void; now?: number }) {
  const Icon = TYPE_ICON[(orderArea(o, table) as OrderType) ?? o.order_type] ?? Utensils;
  const cfg = useTaxConfig();
  const subtotalLabel = !cfg ? "Subtotal" : cfg.vat_registered === false ? "Subtotal" : cfg.prices_include_tax ? `Subtotal (${taxPhrases(cfg.country).incl})` : `Subtotal (${taxPhrases(cfg.country).excl})`;
  const where = orderWhere(o, table, bill?.table_label); // "Table AC1 · Indoor": the table's own area, never the order's type
  const awaiting = !!bill && o.status !== "cancelled" && billAwaitsPayment(bill);
  const merged = isMergedOrder(o);
  const cancellable = !merged && (o.status === "open" || o.status === "sent_to_kitchen");
  const unbilled = orderCanBeBilled(o, bill);
  const lines = o.lines.slice(0, 3);
  const more = o.lines.length - lines.length;
  return (
    <motion.li layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
      <Card className={`flex h-full flex-col gap-3 ${asked ? "ring-2 ring-warning" : ""} ${focused ? "ring-4 ring-primary" : ""}`} data-testid="order-card" data-bill-asked={asked ? "true" : undefined} id={`order-${o.id}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-fg"><Icon className="size-5" aria-hidden /></span>
            <div className="min-w-0">
              <p className="truncate font-semibold text-fg" data-testid="order-where">{where}</p>
              <p className="text-xs text-fg-muted"><span className="font-mono">{bill?.invoice_number ?? `#${shortId(o.id)}`}</span></p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <StatusPill kind="order" status={pillStatus(o, bill)} />
            {bill?.amends_number && <Badge tone="info"><FilePenLine /><span data-testid="amended-badge">Amended</span></Badge>}
            {asked && <Badge tone="warning"><BellRing /><span data-testid="bill-asked-badge">Bill asked{unread ? " · new" : ""}</span></Badge>}
          </div>
        </div>
        {asked && <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs font-medium text-warning-fg" data-testid="bill-asked-line">{asked.requested_by_name ?? asked.waiter_name ?? "A waiter"} asked for the bill{now ? ` ${relativeTime(asked.requested_at, now)}` : ""}</p>}
        <ul className="min-h-12 space-y-0.5 text-sm text-fg-muted">
          {lines.map((l) => <li key={l.id} className="flex justify-between gap-2"><span className="truncate"><span className="tnum font-semibold text-fg">{l.quantity}×</span> {l.item_name}</span></li>)}
          {more > 0 && <li className="text-xs text-fg-subtle">+{more} more</li>}
        </ul>
        {merged && <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs font-medium text-fg-muted" data-testid="merged-line">{mergedIntoText(o)}</p>}
        {!merged && o.status === "cancelled" && o.cancel_reason && <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs font-medium text-danger-fg">Cancelled: {o.cancel_reason}</p>}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div className="leading-tight">
            <p className="text-xs text-fg-subtle">{subtotalLabel}</p>
            <p className="text-lg font-bold text-fg"><Money value={o.subtotal} className={o.status === "cancelled" || o.status === "void" ? "amount-void" : undefined} /></p>
          </div>
          <div className="flex gap-2">
            {cancellable && <Button variant="danger-soft" iconStart={<Ban />} onClick={onCancel}>Cancel</Button>}
            {unbilled && onOrder && <Button variant="secondary" onClick={onOrder} data-testid="view-order">View order</Button>}
            {unbilled && onMakeBillNow && !(asked && onMakeBill) && <Button variant="primary" iconStart={<ReceiptText />} loading={billing} onClick={onMakeBillNow} data-testid="make-bill">Make bill</Button>}
            {asked && onMakeBill && <Button variant="primary" iconStart={<ReceiptText />} onClick={onMakeBill} data-testid="make-bill-asked">Make bill</Button>}
            {awaiting && onPay && <Button variant="primary" iconStart={<HandCoins />} onClick={onPay} data-testid="take-payment">Take payment</Button>}
            {bill && <Button variant="secondary" iconStart={<ReceiptText />} onClick={onBill}>View bill</Button>}
          </div>
        </div>
      </Card>
    </motion.li>
  );
}

const when = (iso?: string | null) => (iso ? formatDateTime(iso) : "");

/** "INV-…124 ← INV-…087 superseded": every version of the sale, each one openable. */
function Chain({ bill, all, onOpen }: { bill: Bill; all: Bill[]; onOpen: (b: Bill) => void }) {
  const ids = bill.amendment_chain ?? [];
  if (ids.length < 2) return null;
  const byId = new Map(all.map((x) => [x.id, x]));
  return (
    <div className="rounded-xl border border-border bg-surface-2/50 p-3 text-xs" data-testid="amend-chain">
      <p className="mb-1.5 flex items-center gap-1.5 font-semibold text-fg"><GitBranch className="size-3.5" aria-hidden />Corrected bill</p>
      {bill.amends_number && <p className="mb-1 text-fg-muted">Replaces {bill.amends_number}{bill.amends_credit_note ? ` (credit note ${bill.amends_credit_note})` : ""}{bill.amend_reason ? ` · ${bill.amend_reason}` : ""}</p>}
      {bill.status === "superseded" && bill.superseded_by_number && <p className="mb-1 font-semibold text-danger-fg">Superseded by {bill.superseded_by_number}</p>}
      <ol className="flex flex-wrap items-center gap-1.5">
        {[...ids].reverse().map((id, i) => {
          const v = byId.get(id);
          const label = v?.invoice_number ?? id.slice(0, 6);
          return (
            <li key={id} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="text-fg-subtle">←</span>}
              <button type="button" disabled={!v || id === bill.id} onClick={() => v && onOpen(v)} aria-current={id === bill.id ? "true" : undefined}
                className={`rounded-md px-1.5 py-0.5 font-mono ${id === bill.id ? "bg-primary-soft font-semibold text-primary-soft-fg" : "text-fg-muted underline hover:text-fg"} ${v?.status === "superseded" ? "opacity-70 line-through decoration-1" : ""}`}>{label}</button>
              {v?.status === "superseded" && <span className="text-fg-subtle">superseded</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** An order with no bill yet: what is on it, and Make bill / Cancel (the same actions as the cards). */
function OrderDialog({ order, where, canBill, billing, onClose, onMakeBill, onCancel }: { order: Order | null; where: string; canBill: boolean; billing: boolean; onClose: () => void; onMakeBill: (o: Order) => void; onCancel: (o: Order) => void }) {
  const [last, setLast] = useState<Order | null>(null);
  if (order && order !== last) setLast(order);
  const o = order ?? last;
  return (
    <Dialog open={order !== null} onOpenChange={(open) => { if (!open) onClose(); }} title={o ? `Order #${shortId(o.id)}` : "Order"} description={o ? where : undefined}
      footer={o && <div className="w-full space-y-2">
        {canBill && <Button className="w-full" variant="primary" size="lg" iconStart={<ReceiptText />} loading={billing} onClick={() => onMakeBill(o)} data-testid="order-make-bill">Make bill</Button>}
        {(o.status === "open" || o.status === "sent_to_kitchen") && <Button className="w-full" variant="danger-soft" iconStart={<Ban />} onClick={() => onCancel(o)}>Cancel order</Button>}
      </div>}>
      {o && (
        <div className="space-y-3 pb-3 text-sm">
          <p><StatusPill kind="order" status={pillStatus(o)} /></p>
          <ul className="divide-y divide-border">{o.lines.map((l) => <li key={l.id} className="flex justify-between gap-3 py-2"><span>{l.quantity} × {l.item_name}</span><Money value={mulMoney(l.unit_price, l.quantity)} showCurrency={false} /></li>)}</ul>
          <p className="flex justify-between font-semibold"><span>Subtotal</span><Money value={o.subtotal} /></p>
        </div>
      )}
    </Dialog>
  );
}

function BillDialog({ bill, all, where, onClose, onOpen, onChanged, onPay }: { bill: Bill | null; all: Bill[]; where?: string; onClose: () => void; onOpen: (b: Bill) => void; onChanged: () => void; onPay: (b: Bill) => void }) {
  const { can } = useCan();
  const admin = can("bills.amend");
  const [voiding, setVoiding] = useState(false);
  const [voidAbsent, setVoidAbsent] = useState(false); // the server answered 404/405/501: hide the button for this session
  const [last, setLast] = useState<Bill | null>(null);
  const [opts, setOpts] = useState<{ id: string; o: AmendOptions | null; err?: string } | null>(null);
  const [editing, setEditing] = useState(false);
  if (bill && bill !== last) setLast(bill);
  const b = bill ?? last;
  const bid = bill?.id;
  useEffect(() => {
    if (!bid || !admin) return;
    let off = false;
    void api.amendOptions(bid).then((o) => { if (!off) setOpts({ id: bid, o }); }, (e) => { if (!off) setOpts({ id: bid, o: null, err: e instanceof ApiError ? e.message : "Could not check" }); });
    return () => { off = true; };
  }, [bid, admin]);
  const o = opts && b && opts.id === b.id ? opts : null;
  async function pdf() {
    try { window.open(await api.receiptBlobUrl(b!.id), "_blank"); } catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not load the receipt"); }
  }
  function finished(r: AmendResult | null) { setEditing(false); onChanged(); if (r) onOpen(r.replacement); }
  const [done, setDone] = useState<AmendResult | null>(null);
  const superseded = b?.status === "superseded";
  const voided = b?.status === "voided";
  const canVoid = can("bills.void") && !voidAbsent && !voided;
  return (
    <>
      <Dialog open={bill !== null && !editing} onOpenChange={(open) => { if (!open) onClose(); }} title={b ? b.invoice_number : "Bill"} description={b ? `${b.seller_name}${b.seller_trn ? ` · ${countryInfo(b.country).taxNumberLabel} ${b.seller_trn}` : ""} · ${billTitle(b.country, b.vat_registered)}` : undefined}
        footer={b && <div className="w-full space-y-2">
          {billAwaitsPayment(b) && <Button className="w-full" variant="primary" size="lg" iconStart={<HandCoins />} onClick={() => onPay(b)} data-testid="bill-take-payment">Take payment</Button>}
          {admin && !superseded && !voided && (
            <div>
              <Button className="w-full" variant="secondary" iconStart={<FilePenLine />} disabled={!o?.o?.amendable} onClick={() => { setDone(null); setEditing(true); }} data-testid="edit-bill">Edit this bill</Button>
              {o && !o.o?.amendable && <p className="mt-1 text-xs text-fg-muted" data-testid="edit-bill-why">{o.o?.reason_if_not ?? o.err}</p>}
            </div>
          )}
          {canVoid && !superseded && <Button className="w-full" variant="danger-soft" onClick={() => setVoiding(true)} data-testid="void-bill">Void bill</Button>}
          <BillActions bill={b} /><Button className="w-full" variant="ghost" iconStart={<FileText />} onClick={() => void pdf()}>View PDF receipt</Button></div>}>
        {b && (
          <div className={`space-y-3 pb-3 text-sm ${superseded ? "opacity-80" : ""}`}>
            {superseded && <Notice tone="warning" title={`Superseded by ${b.superseded_by_number ?? "a newer invoice"}`}>This invoice was cancelled by credit note and replaced. It stays on record for the books.</Notice>}
            {where && <p className="text-sm font-semibold text-fg" data-testid="bill-where">{where}</p>}
            {b.sale_at && <p className="text-xs text-fg-muted" data-testid="bill-date">Sale date {when(b.sale_at)}{b.amended_at ? ` · corrected ${when(b.amended_at)}` : ""}</p>}
            <Chain bill={b} all={all} onOpen={onOpen} />
            <ul className="divide-y divide-border">
              {groupBillLines(b.lines).map((l, i) => <li key={i} className="flex justify-between gap-3 py-2"><span>{l.quantity} × {l.description}</span><Money value={l.line_total} currency={b.currency} showCurrency={false} /></li>)}
            </ul>
            <BillSummary bill={b} hideHeader />
            {b.payments.length > 0 && <p className="text-xs text-fg-muted">Payments: {b.payments.map((p) => `${PAY_LABEL[p.method] ?? p.method} ${formatCurrency(p.amount, b.currency)}`).join(", ")}</p>}
            {voided ? <Badge tone="neutral">Voided</Badge> : superseded ? <Badge tone="neutral">Superseded</Badge> : Number(b.balance_due) === 0 ? <Badge tone="success">Paid in full</Badge> : <Badge tone="warning">Awaiting payment</Badge>}
          </div>
        )}
      </Dialog>
      {b && voiding && <VoidBillDialog key={b.id} bill={b} open onClose={() => { setVoiding(false); onChanged(); }} onDone={() => onChanged()} onUnavailable={() => setVoidAbsent(true)} />}
      {b && editing && <AmendBillDialog key={b.id} bill={b} open onClose={() => finished(done)} onDone={(r) => { setDone(r); onChanged(); }} />}
    </>
  );
}

export default function OrdersPage() {
  const router = useRouter();
  // Default: everything except cancelled / voided, running orders first (UI_REVIEW BA-14). Filtering is local: one request.
  const [status, setStatus] = useState<OrderFilter>("all");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cancelling, setCancelling] = useState<Order | null>(null);
  const [viewing, setViewing] = useState<Bill | null>(null);
  const [paying, setPaying] = useState<Bill | null>(null);
  const [kots, setKots] = useState<Kot[] | null>(null);
  const [viewingOrder, setViewingOrder] = useState<Order | null>(null);
  const [billingId, setBillingId] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      // The kitchen tickets are read the way the Kitchen board reads them (one rule: lib/kitchenActive); no kitchen permission = order status only.
      const [o, b, t, k] = await Promise.all([api.orders(), api.bills(true), api.tables(), api.kots().catch(() => null)]);
      setOrders(o); setBills(b); setTables(t); setKots(k); setError(null);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Failed to load orders"); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    if (!auth.token) { router.replace("/login"); return; }
    void Promise.resolve().then(() => load());
  }, [load, router]);
  useEffect(() => onKitchenChanged(() => { if (auth.token) void load(true); }), [load]);
  useEffect(() => {
    const f = () => { if (auth.token) void load(); };
    window.addEventListener("focus", f);
    // New orders from the waiter app (a table "booked" there is an order on that table) and bill requests show up by
    // themselves: a light refresh while the tab is visible, none while it is hidden.
    const t = setInterval(() => { if (auth.token && !document.hidden) void load(true); }, BILL_POLL_MS);
    return () => { window.removeEventListener("focus", f); clearInterval(t); };
  }, [load]);
  const { can, ready } = useCan();
  const { byOrder: asked, seen } = useBillRequests(ready && can("bills.finalize"));
  const [now, setNow] = useState(0);
  useEffect(() => { const t = () => setNow(Date.now()); t(); const i = setInterval(t, 30_000); return () => clearInterval(i); }, []);
  // /orders?highlight=<id> (from a notification): that card is scrolled to and outlined, and its request counts as read.
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("highlight"); if (id) void Promise.resolve().then(() => setFocus(id)); }, []);
  useEffect(() => {
    if (!focus || !orders?.some((o) => o.id === focus)) return;
    document.getElementById(`order-${focus}`)?.scrollIntoView({ block: "center" });
    markBillRequestsRead([focus]);
  }, [focus, orders]);
  /** Make bill from Orders: the counter's own call (POST /orders/{id}/bill, service charge and offers as the counter's default), same permission (bills.finalize); the list refreshes. */
  async function makeBillNow(o: Order) {
    if (billingId) return;
    setBillingId(o.id);
    try {
      const b = await api.finalize(o.id, { discount: null, service_charge: true, apply_offers: true });
      notifyKitchenChanged();
      toast.success("Bill made", { description: `${b.invoice_number}: take payment next` });
      setViewingOrder(null);
      await load(true);
    } catch (e) {
      toast.error("Bill not made", { description: e instanceof ApiError ? (e.status === 0 ? "No internet connection." : e.message) : "Please try again." });
    } finally { setBillingId(null); }
  }
  const makeBill = (id: string) => { markBillRequestsRead([id]); router.push(billHref(id)); };

  // One card per order: its CURRENT bill (a corrected original is reachable through the chain in the bill dialog).
  const billByOrder = useMemo(() => { const m = new Map<string, Bill>(); for (const b of bills) { const cur = m.get(b.order_id); if (!cur || (cur.status === "superseded" && b.status !== "superseded")) m.set(b.order_id, b); } return m; }, [bills]);
  const tableById = useMemo(() => new Map(tables.map((t) => [t.id, t])), [tables]);
  const billOf = useCallback((o: Order) => billByOrder.get(o.id), [billByOrder]);
  const kitchenIds = useMemo(() => inKitchenOrderIds(orders ?? [], kots), [orders, kots]);
  const counts = useMemo(() => countOrders(orders ?? [], billOf, kitchenIds), [orders, billOf, kitchenIds]);
  const shown = useMemo(() => (orders ? filterOrders(orders, billOf, status, kitchenIds) : null), [orders, billOf, status, kitchenIds]);
  const whereOfBill = (b: Bill | null) => { if (!b) return undefined; const o = orders?.find((x) => x.id === b.order_id); const t = o?.table_id ? tableById.get(o.table_id) : undefined; return o ? orderWhere(o, t, b.table_label) : b.table_label ? `Table ${b.table_label}` : undefined; };
  const chips = useMemo(() => ORDER_FILTERS.filter((f) => f.value !== "merged" || counts.merged > 0).map((f) => ({ ...f, count: orders ? counts[f.value] : undefined })), [orders, counts]);

  return (
    <>
      <PageHeader title="Orders" description="Recent orders. Make a bill, take payment, cancel an unbilled order or open a bill."
        actions={<Button variant="secondary" iconStart={<RefreshCw className={refreshing ? "animate-spin" : undefined} />} onClick={() => void load()}>Refresh</Button>} />
      <PillTabs label="Filter by status" value={status} onChange={setStatus} options={chips} className="mb-4" />
      <div data-testid="orders-list">
          {error && <div className="mb-4"><Notice tone="danger" title="Could not load orders" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Notice></div>}
          {shown === null && !error ? (
            <div role="status" aria-label="Loading orders" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-52 rounded-xl" />)}
            </div>
          ) : shown && shown.length === 0 ? (
            <Card><EmptyState illustration={<EmptyCartIllustration />} title={status === "all" ? "No orders yet" : "No orders with this status"}
              hint={status === "all" ? "Orders placed in Chilli Agent show up here." : "Try another filter."}
              action={<Link href="/pos" className="ch-btn ch-btn--primary ch-btn--lg">Go to Chilli Agent</Link>} /></Card>
          ) : shown && (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <AnimatePresence initial={false}>
                {shown.map((o) => (
                  <OrderCard key={o.id} o={o} bill={billByOrder.get(o.id)} table={o.table_id ? tableById.get(o.table_id) : undefined}
                    onCancel={() => setCancelling(o)} onBill={() => setViewing(billByOrder.get(o.id) ?? null)} onPay={() => setPaying(billByOrder.get(o.id) ?? null)}
                    onMakeBillNow={can("bills.finalize") ? () => void makeBillNow(o) : undefined} onOrder={() => setViewingOrder(o)} billing={billingId === o.id}
                    asked={asked.get(o.id)} unread={asked.has(o.id) && !seen.has(requestKey(asked.get(o.id)!))} focused={focus === o.id} onMakeBill={() => makeBill(o.id)} now={now} />
                ))}
              </AnimatePresence>
            </ul>
          )}
      </div>
      <CancelOrderDialog open={cancelling !== null} onOpenChange={(o) => { if (!o) setCancelling(null); }} subject={cancelling ? `Order #${shortId(cancelling.id)}` : "This order"}
        onConfirm={async (reason) => { await api.cancelOrder(cancelling!.id, reason); toast.success("Order cancelled"); void load(); }} />
      <OrderDialog order={viewingOrder} where={viewingOrder ? orderWhere(viewingOrder, viewingOrder.table_id ? tableById.get(viewingOrder.table_id) : undefined) : ""} canBill={can("bills.finalize")} billing={billingId === viewingOrder?.id}
        onClose={() => setViewingOrder(null)} onMakeBill={(o) => void makeBillNow(o)} onCancel={(o) => { setViewingOrder(null); setCancelling(o); }} />
      <BillDialog bill={viewing} all={bills} where={whereOfBill(viewing)} onClose={() => setViewing(null)} onOpen={setViewing} onChanged={() => void load()} onPay={setPaying} />
      <TakePayment bill={paying} onClose={() => setPaying(null)} onPaid={(b, settled) => { setViewing((v) => (v && v.id === b.id ? b : v)); if (settled) setPaying(null); void load(true); }} />
    </>
  );
}
