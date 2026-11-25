"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, Ban, Banknote, Check, ChefHat, CloudOff, CreditCard, Pause, QrCode, Plus, Printer, ReceiptText, SplitSquareHorizontal, Tag, TriangleAlert } from "lucide-react";
import { EmptyState, Money, SuccessBurst, toast } from "@/components/ui";
import { Badge, Button } from "@chilli/ui";
import { EmptyCartIllustration, SuccessCheckIllustration } from "@/components/illustrations";
import { OrderActions, OrderItemList, OrderLineItem, OrderSummaryPanel } from "@/components/pos";
import { BillActions } from "@/components/pos/BillActions";
import { ThermalPrint } from "@/components/pos/ThermalPrint";
import { api, ApiError, mediaUrl } from "@/lib/api";
import { autoPrintKot, printKotSlip, printOfflineKot } from "@/lib/printing";
import { cmpMoney, formatCurrency, mulMoney } from "@/lib/money";
import { isEatIn } from "@/lib/taxEstimate";
import { taxPhrases } from "@/lib/taxWords";
import type { Customer, DiningTable, DiscountInput, OrderType, PaymentMethod, TableStatus } from "@/lib/types";
import { customerLabel } from "@/lib/customers";
import { CustomerPicker, OrderTypePicker, TablePicker } from "./OrderSetup";
import { BillSummary, ProvisionalReceipt } from "./Receipts";
import { needsTable, tablesForType, otherVariant, stageOf, ticketBadge, TYPE_NAME, variantDelta } from "./tickets";
import { areaLabel, tableWhere } from "@/lib/tableWhere";
import { groupCartLines } from "@/lib/groupLines";
import { PaySheet } from "./PaySheet";
import type { PayLine, TenderKind } from "./pay-plan";
import { DiscountDialog } from "./DiscountDialog";
import { billDiscountEditable } from "./discountPreview";
import type { PricingState } from "./pricing";
import { TotalsBlock } from "./TotalsBlock";
import type { ModifierGroup } from "@/lib/extras";
import { groupsFor } from "@/lib/modifiers";
import { vegOf } from "@/lib/menuAdmin";
import { offlineRef, type Stage, type Tax, type Ticket } from "./types";

/** Modifier choices under a cart line ("Hot", "Cheese"); the size is part of the name ("Butter Chicken · Half"). */
function addonsOf(l: Ticket["lines"][number]) {
  const out = (l.mods?.names ?? []).map((n) => ({ label: n, price: undefined as string | undefined }));
  return out.length ? out : undefined;
}

/** "Butter Chicken · Half": the size the kitchen will make, always visible on the line (C-03). */
const lineName = (l: Ticket["lines"][number]) => {
  const v = l.item.variants.find((x) => x.id === l.variantId);
  return v ? `${l.item.name} · ${v.name}` : l.item.name;
};

/** Plain status words (section 7 of the order-flow audit): what the stage means to the person at the counter. */
export const STAGE_TEXT: Record<Stage, string> = { draft: "Not sent yet", placed: "Not in kitchen yet", kitchen: "In kitchen", billed: "Bill made · take payment", paid: "Paid" };
const STAGE_TONE = { draft: "neutral", placed: "info", kitchen: "info", billed: "warning", paid: "success" } as const;

export interface OrderPanelActions {
  place: () => void; addMore: () => void; sendKot: () => void; finalize: () => void; /** Resolves true when the bill was paid (or queued offline); false/undefined = failed, the sheet stays open. */
  payLines: (lines: PayLine[]) => Promise<boolean | undefined>;
  /** One tap: pays the exact balance with this method (the original "Pay cash"). */
  payExact: (kind: TenderKind) => Promise<boolean | undefined>; settleOffline: (m: PaymentMethod) => void;
  receipt: () => void; cancel: () => void; hold: () => void; startNew: () => void; clear: () => void;
  setQty: (key: string, delta: number) => void; remove: (key: string) => void;
  /** Items added after the order was placed (not on the server yet). */
  setMoreQty: (key: string, delta: number) => void; removeMore: (key: string) => void;
  setType: (t: OrderType) => void; setTable: (id: string) => void;
  /** Remove a placed line the kitchen has not been sent yet (server). */
  removePlaced: (key: string) => void;
  /** "Change to Full" on a line (`more` = a line added after placing). */
  setVariant: (key: string, variantId: string | null, more: boolean) => void;
  /** "Check" on a voice line was confirmed (`more` = a line added after placing). */
  confirmLine: (key: string, more: boolean) => void;
  /** Kitchen note on a line ("no onion"). */
  editNote: (key: string, more: boolean) => void;
  /** Print the kitchen ticket again (after "Printer did not respond"). */
  reprintKot: () => void;
  /** Draft: sets the ticket's customer. Placed: saves it on the order (server / offline queue); may be async. */
  setCustomer: (id: string) => unknown;
  /** A customer created or found from the picker joins the loaded list. */
  customerCreated: (c: Customer) => void;
  setDiscount: (d: DiscountInput | null) => void;
  /** Bill made, nothing paid yet: add / change / remove its discount (the bill is replaced by a new one; the server enforces). */
  setBillDiscount: (d: DiscountInput | null) => void; setServiceCharge: (on: boolean) => void;
  /** Managers: keep / remove the automatic offers on this bill. */
  setApplyOffers: (on: boolean) => void;
  /** Open the option picker for a cart line (`more` = a line added after the order was placed). */
  editOptions: (key: string, more: boolean) => void;
}

function PaidView({ t, phone, restaurant, onCustomerSaved }: { t: Ticket; phone?: string | null; restaurant?: string; onCustomerSaved?: (c: Customer) => void }) {
  // Confetti only when the payment just happened in front of the cashier, not when a finished ticket is restored.
  const [fresh] = useState(() => !!t.paidAt && Date.now() - Date.parse(t.paidAt) < 8000);
  return (
    <div className="space-y-4 py-2" aria-live="polite">
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="relative"><SuccessCheckIllustration className="w-28" title="Success" /><SuccessBurst trigger={fresh ? t.id : null} /></div>
        <p className="font-display text-xl font-bold text-fg">{t.prov ? "Sale saved offline" : "Payment complete"}</p>
        <p className="text-sm text-fg-muted">{t.prov ? "The invoice is issued automatically once this device syncs." : t.kot !== null || t.hadKot ? "The kitchen has the order. Thank you!" : "Thank you!"}</p>
      </div>
      {t.bill && <BillSummary bill={t.bill} />}
      {t.bill && <BillActions bill={t.bill} phone={phone} onCustomerSaved={onCustomerSaved} />}
      {t.prov && <ProvisionalReceipt prov={t.prov} restaurant={restaurant} />}
    </div>
  );
}

/**
 * The right-hand "Order summary" for ONE ticket (aside on tablets/desktops, bottom sheet on phones). Purely driven by
 * the ticket it is given: switching tickets just swaps the prop, nothing is shared.
 */
export function OrderPanel({ variant, ticket: t, label, online, busy, tables, customers, tax, currency, pricing, canDiscount, discountLimit, claims, actions: a, groups = [], canToggleOffers = false,
  tableStatus, kotFirst = true, canCancelSent = true }: {
  variant: "aside" | "sheet";
  ticket: Ticket; label: string; online: boolean; busy: boolean;
  tables: DiningTable[]; customers: Customer[]; tax: Tax; currency: string;
  /** Totals of this ticket (bill > server preview > client estimate). */
  pricing: PricingState;
  /** The signed-in role may give discounts; `discountLimit` is the cashier's max percent (null = unlimited). */
  canDiscount: boolean; discountLimit: string | null;
  /** Table id -> labels of other unplaced tickets holding it. */
  claims: Map<string, string[]>;
  actions: OrderPanelActions;
  /** Modifier groups (to know which lines can change options). */
  groups?: ModifierGroup[];
  /** Owner / manager: may take the automatic offers off this bill. */
  canToggleOffers?: boolean;
  /** Live table states (GET /tables/status). */
  tableStatus?: Map<string, TableStatus>;
  /** Dine-in: the bill waits until the kitchen has the order (restaurant setting, default on). */
  kotFirst?: boolean;
  /** Owner / manager: may cancel an order the kitchen already has. */
  canCancelSent?: boolean;
}) {
  const stage = stageOf(t);
  const { order, bill, prov, kot } = t;
  const [autoPrint, setAutoPrint] = useState(false);
  const [payKind, setPayKind] = useState<TenderKind | null>(null); // pay sheet open with this method preselected
  const [paying, setPaying] = useState<TenderKind | null>(null);
  const payNow = (k: TenderKind) => { setPaying(k); void a.payExact(k).finally(() => setPaying(null)); };
  const [restaurantName, setRestaurantName] = useState<string | undefined>(bill?.seller_name);
  useEffect(() => {
    void Promise.resolve().then(() => setAutoPrint(autoPrintKot.get()));
    let cached: string | null = null;
    try { cached = localStorage.getItem("pos.restaurantName"); } catch { /* storage unavailable */ }
    if (cached) void Promise.resolve().then(() => setRestaurantName((n) => n ?? cached!));
    api.restaurant().then((r) => { setRestaurantName(r.name); try { localStorage.setItem("pos.restaurantName", r.name); } catch { /* ignore */ } }).catch(() => {});
  }, []);
  const printKot = async () => {
    try {
      if (t.kotId && navigator.onLine) await printKotSlip(t.kotId);
      else printOfflineKot({ ref: kot === "queued" || kot === null || kot === "sent" ? offlineRef(order!) : `Kitchen ticket #${kot}`, where: tableObj ? tableWhere(tableObj) : TYPE_NAME[t.type], at: new Date().toISOString(),
        lines: order!.lines.map((l) => ({ qty: l.qty, label: l.label })) });
    } catch (e) { toast.error("Could not open the kitchen slip", { description: e instanceof ApiError && e.status === 0 ? "No internet connection." : "Please try again." }); }
  };
  const offlineMode = !online || (order?.offline ?? false);
  const tbl = needsTable(t);
  const typeTables = tablesForType(tables, t.type);
  const tableObj = tbl ? tables.find((x) => x.id === t.tableId) : undefined;
  const tableLabel = tableObj?.label;
  const customer = customers.find((x) => x.id === t.customerId);
  // Picking works from the loaded list (also offline); adding a new customer needs the server (the picker says so).
  const pickerFor = (compact: boolean) => (online || customers.length > 0) && (
    <CustomerPicker customers={customers} value={t.customerId} onChange={a.setCustomer} onCreated={a.customerCreated} disabled={busy} online={online} compact={compact} />
  );
  const picker = pickerFor(false);
  const draft = stage === "draft";
  const canPlace = t.lines.length > 0 && (!tbl || t.tableId !== "");
  const owing = bill !== null && Number(bill.balance_due) > 0;
  const [discountOpen, setDiscountOpen] = useState(false);
  // An open bill (made, nothing paid) still takes a discount; a paid one never does here (a manager corrects it with a credit note).
  const billEditable = billDiscountEditable(bill);
  const discountNow: DiscountInput | null = t.discount ?? (bill && cmpMoney(bill.discount_amount ?? 0, 0) > 0 ? { type: "amount", value: bill.discount_amount!, reason: bill.discount_reason ?? "" } : null);
  const applyDiscount = (d: DiscountInput | null) => (billEditable ? a.setBillDiscount(d) : a.setDiscount(d));
  const serverOrderId = order && !order.offline ? order.id : null;
  const previewDiscount = billEditable && bill ? (d: DiscountInput, signal: AbortSignal) => api.billDiscountPreview(bill.id, d, signal)
    : serverOrderId && !bill && online && !(t.more?.length) ? (d: DiscountInput, signal: AbortSignal) => api.billPreview(serverOrderId, { discount: d, service_charge: t.serviceCharge !== false, apply_offers: t.applyOffers !== false }, signal)
    : undefined;
  const discountBar = canDiscount && pricing.priced && (billEditable || (!bill && !pendingMoreEarly(t))) ? (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3" data-testid="discount-bar">
      <p className="text-sm text-fg-muted">Total <span className="tnum font-bold text-fg" data-testid="bar-total">{formatCurrency(billEditable && bill ? bill.balance_due : pricing.priced.total, currency)}</span></p>
      <Button variant="ghost" size="sm" iconStart={<Tag />} className="min-h-11 text-primary-soft-fg" data-testid="bill-discount-btn" disabled={busy} onClick={() => setDiscountOpen(true)}>
        {cmpMoney(pricing.priced.discount_amount, 0) > 0 ? `Discount − ${formatCurrency(pricing.priced.discount_amount, currency)} · Edit` : "Discount"}
      </Button>
    </div>
  ) : null;
  /** Draft: the full type / table / customer choice is open again after "Change" (else folded into one row once a table is chosen). */
  const [setupOpen, setSetupOpen] = useState(false);
  const eatIn = tax ? isEatIn(t.type, tax) : tbl;
  const scConfigured = !!tax && eatIn && cmpMoney(tax.service_charge_percent || "0", 0) > 0;
  const clash = draft && tbl && t.tableId ? claims.get(t.tableId) : undefined;
  const count = t.lines.reduce((n, l) => n + l.qty, 0);
  const more = t.more ?? [];
  const pendingMore = more.length > 0;

  const showOrderLine = !!order && !bill && stage !== "paid";
  const showTableHint = draft && tbl && t.tableId === "" && t.lines.length > 0;
  const notice = !showOrderLine && !(clash && clash.length) && !showTableHint ? undefined : (
    <div className="space-y-2">
      {showOrderLine && order && (
        <div data-testid="order-line" className={`rounded-xl px-3 py-2.5 text-sm ${order.offline ? "bg-warning-soft text-warning-fg" : "bg-info-soft text-info-fg"}`}>
          {order.offline ? (
            <>
              <p className="flex items-center gap-1.5 font-semibold"><CloudOff className="size-4" aria-hidden />Saved offline <span className="font-mono">{offlineRef(order)}</span></p>
              <p className="mt-0.5">Subtotal <Money value={order.subtotal} currency={currency} strong /> <span className="text-xs opacity-80">(price confirmed on sync)</span></p>
            </>
          ) : (
            <p>Order placed. Subtotal <Money value={order.subtotal} currency={currency} strong /> <span className="text-xs opacity-80">{tax?.prices_include_tax ? `(${taxPhrases(tax?.country).incl})` : tax?.vat_registered === false ? "" : `(${taxPhrases(tax?.country).excl})`}</span></p>
          )}
        </div>
      )}
      {clash && clash.length > 0 && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-fg"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          Table {tableLabel} is also chosen on {clash.join(", ")}. Only one of those orders can be placed on it.</p>
      )}
      {showTableHint && <p className="text-xs font-medium text-warning-fg">Choose a table to place this order.</p>}
    </div>
  );

  const chosenTable = tbl && t.tableId && !setupOpen ? tables.find((x) => x.id === t.tableId) : undefined;
  const fields = stage === "paid" ? undefined : draft ? (chosenTable ? (
    // Once the table is chosen, type + table + customer fold into ONE row so the dishes get the room (C-05). Tapping the
    // chosen table changes nothing (C-08); "Change" opens the full choice again.
    <div role="group" aria-label="Table" className="flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-surface-2/60 pl-1" data-testid="table-chosen">
      <button type="button" aria-pressed="true" disabled={busy} onClick={() => {}}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 truncate rounded-lg px-2 text-left text-sm font-semibold text-fg">
        <Check aria-hidden className="size-4 shrink-0 text-primary" /><span className="sr-only">Table </span><span className="font-bold">{chosenTable.label}</span><span className="sr-only">,</span>
        <span className="truncate font-medium text-fg-muted"> · {areaLabel(chosenTable.area) ?? TYPE_NAME[t.type]}</span>
      </button>
      <button type="button" disabled={busy} onClick={() => setSetupOpen(true)} aria-label="Change table" className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2.5 text-sm font-semibold text-primary hover:bg-surface">Change</button>
      <div className="max-w-[45%] shrink-0">{pickerFor(true)}</div>
    </div>
  ) : (
    <div className="space-y-3">
      <OrderTypePicker value={t.type} onChange={a.setType} disabled={busy} />
      {tbl && (typeTables.length === 0 && tables.length > 0
        ? <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-fg" data-testid="no-tables-for-type">No {t.type === "outdoor" ? "outdoor" : "indoor"} tables set up. Add one in Manage, Tables.</p>
        : <TablePicker key={t.id} tables={typeTables} value={t.tableId} onChange={(id) => { a.setTable(id); setSetupOpen(false); }} disabled={busy} claims={claims} status={tableStatus} currency={currency} startOpen={setupOpen} />)}
      {picker}
    </div>
  )  ) : (stage === "placed" || stage === "kitchen") && (picker || (tbl && !order?.offline)) ? (
    <div className="space-y-2">
      {/* Wrong table after Place order: change it here (the order moves; C-11). Offline orders keep their table until synced. */}
      {tbl && !order?.offline ? (
        // Table (with "Change") and customer in one row, so the dishes keep the room (C-05).
        <div className="flex items-start gap-2 has-[[data-table-grid]]:flex-col">
          <div className="min-w-0 flex-1 has-[[data-table-grid]]:w-full"><TablePicker key={t.id} tables={tables} value={t.tableId} onChange={a.setTable} disabled={busy} status={tableStatus} currency={currency} /></div>
          {t.customerId ? null : pickerFor(true)}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="neutral">{tableObj ? tableWhere(tableObj) : TYPE_NAME[t.type]}</Badge>
        </div>
      )}
      {(!tbl || order?.offline || t.customerId) && picker}
    </div>
  ) : (
    <div className="flex flex-wrap gap-1.5">
      <Badge tone="neutral">{tableObj ? tableWhere(tableObj) : TYPE_NAME[t.type]}</Badge>
      {customer && <Badge tone="primary">{customerLabel(customer)}</Badge>}
    </div>
  );

  // Next logical step is the primary; KOT / Hold / Cancel are secondary.
  let actions: ReactNode = null;
  if (draft) {
    actions = (
      <div className="flex gap-2">
        {t.lines.length > 0 && <Button variant="secondary" size="pay" className="shrink-0 px-4" disabled={busy} iconStart={<Pause />} onClick={a.hold} title="Keep this order as a draft and start another">Hold</Button>}
        <Button variant="primary" size="pay" className="min-w-0 flex-1 whitespace-nowrap" disabled={busy || !canPlace} loading={busy} onClick={a.place}>{online ? "Place order" : "Place order (offline)"}{canPlace && pricing.priced ? <span className="tnum text-[0.85em] font-semibold opacity-90 max-lg:hidden">· {formatCurrency(pricing.priced.total, currency)}</span> : <Check />}</Button>
      </div>
    );
  } else if (stage === "placed" || stage === "kitchen") {
    // Kitchen first (C-01): until the kitchen has the order, "Send to kitchen" is the big red button and, for dine-in, the bill
    // waits ("Send the order to the kitchen first") unless the restaurant allows billing first. Same tap count as before.
    const sent = kot !== null; // a queued (offline) ticket counts: it reaches the kitchen first when the device syncs
    const billBlocked = !sent && tbl && kotFirst;
    const kitchenName = kot === "queued" ? "Waiting for internet (kitchen ticket saved)" : kot === "sent" ? "Order is in the kitchen" : kot ? `Kitchen ticket #${kot} sent`
      : offlineMode ? (t.hadKot ? "Send new items to kitchen (offline)" : "Send to kitchen (offline)") : t.hadKot ? "Send new items to kitchen" : "Send to kitchen";
    const tryCancel = () => {
      if ((sent || t.hadKot) && !canCancelSent) { toast.error("The kitchen already has this order", { description: "Ask a manager or owner to cancel it." }); return; }
      a.cancel();
    };
    const sendBtn = (
      <Button variant={sent ? "secondary" : "primary"} size={sent ? "lg" : "pay"} className="min-w-0 flex-1" disabled={busy || sent || pendingMore} loading={busy && !sent && !pendingMore}
        iconStart={sent ? <Check /> : <ChefHat />} onClick={a.sendKot}>
        <span className="truncate">{kitchenName}</span>{!sent && <span aria-hidden className="text-[0.7rem] font-semibold opacity-75">KOT</span>}
      </Button>
    );
    actions = (
      <div className="flex flex-col gap-2">
        {pendingMore && (
          <Button variant="primary" className="w-full" size="pay" disabled={busy} loading={busy} iconStart={<Plus />} onClick={a.addMore}>{offlineMode ? "Add to order (offline)" : "Add to order"}</Button>
        )}
        <div className="flex gap-2">
          {sendBtn}
          <Button variant="danger-soft" size={sent ? "lg" : "pay"} className="w-12 shrink-0 p-0" disabled={busy} aria-label="Cancel order" title="Cancel order" onClick={tryCancel}><Ban aria-hidden /></Button>
        </div>
        {t.kotId && <ThermalPrint kind="kot" refId={t.kotId} onPdf={() => void printKot()} />}
        {sent && (
          <Button variant="secondary" disabled={busy} iconStart={<Printer />} onClick={() => (t.kotPrint === "failed" ? a.reprintKot() : void printKot())}>{t.kotPrint === "failed" ? "Print kitchen ticket again" : t.kotId ? "Print kitchen ticket" : "Print kitchen slip (offline copy)"}</Button>
        )}
        {!sent && <label className="flex min-h-11 items-center gap-2 text-xs text-fg-muted"><input type="checkbox" className="size-4" checked={autoPrint} onChange={(e) => { setAutoPrint(e.target.checked); autoPrintKot.set(e.target.checked); }} />Also print the kitchen slip here (this device)</label>}
        {discountBar}
        {offlineMode ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant={sent ? "primary" : "secondary"} size="pay" className="min-w-0 px-2" disabled={busy || pendingMore || billBlocked} iconStart={<Banknote />} onClick={() => a.settleOffline("cash")}>Cash (offline)</Button>
            <Button size="pay" variant="secondary" className="min-w-0 px-2" disabled={busy || pendingMore || billBlocked} iconStart={<CreditCard />} onClick={() => a.settleOffline("card")}>Card (offline)</Button>
            <Button size="lg" variant="secondary" className="col-span-2 min-w-0" disabled iconStart={<QrCode />} title="UPI needs internet to check the payment">UPI needs internet</Button>
          </div>
        ) : (
          <Button variant={sent ? "primary" : "secondary"} className="w-full" size={sent ? "pay" : "lg"} disabled={busy || pendingMore || billBlocked} loading={busy && sent} iconStart={<ReceiptText />} onClick={a.finalize}
            aria-describedby={billBlocked ? `kot-first-${t.id}` : undefined}>Make bill</Button>
        )}
        {billBlocked && !pendingMore && <p id={`kot-first-${t.id}`} role="status" className="text-center text-sm font-semibold text-warning-fg">Send the order to the kitchen first</p>}
        {pendingMore && <p role="status" className="text-center text-xs font-medium text-warning-fg">Add the new items to the order first</p>}
      </div>
    );
  } else if (owing) {
    actions = <div className="flex flex-col gap-3">
      <BillActions bill={bill!} phone={customer?.phone} onCustomerSaved={a.customerCreated} />
      {/* One tap pays the exact balance (the original "Pay cash" / "Pay card"); tendered cash, change and splits live behind "Other amount / split". */}
      <OrderActions primary={<div className="space-y-2">
        {discountBar}
        {/* Named for screen readers and voice control: the row is "Pay ₹540.00", each button "Pay cash ₹540.00" (visible text "Cash" stays inside the name). */}
        <div className="grid grid-cols-3 gap-2" data-testid="pay-row" role="group" aria-label={`Pay ${bill ? formatCurrency(bill.balance_due, currency) : ""}`.trim()}>
          <Button variant="primary" size="pay" className="min-w-0 whitespace-nowrap px-2" disabled={busy} loading={busy && paying === "cash"} iconStart={<Banknote />} onClick={() => payNow("cash")} title={`Pay ${bill ? formatCurrency(bill.balance_due, currency) : ""} in cash`}><span className="sr-only">Pay </span>Cash<span className="sr-only">{bill ? ` ${formatCurrency(bill.balance_due, currency)}` : ""}</span></Button>
          <Button variant="secondary" size="pay" className="min-w-0 whitespace-nowrap px-2" disabled={busy} loading={busy && paying === "card"} iconStart={<CreditCard />} onClick={() => payNow("card")} title={`Pay ${bill ? formatCurrency(bill.balance_due, currency) : ""} by card`}><span className="sr-only">Pay </span>Card<span className="sr-only">{bill ? ` ${formatCurrency(bill.balance_due, currency)}` : ""}</span></Button>
          <Button variant="secondary" size="pay" className="min-w-0 whitespace-nowrap px-2" disabled={busy} loading={busy && paying === "upi"} iconStart={<QrCode />} onClick={() => payNow("upi")} title={`Pay ${bill ? formatCurrency(bill.balance_due, currency) : ""} by UPI`}><span className="sr-only">Pay </span>UPI<span className="sr-only">{bill ? ` ${formatCurrency(bill.balance_due, currency)}` : ""}</span></Button>
        </div>
        <button type="button" disabled={busy} onClick={() => setPayKind("cash")} data-testid="pay-other" aria-haspopup="dialog"
          className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-semibold text-primary hover:bg-surface-2 disabled:opacity-50">
          <SplitSquareHorizontal aria-hidden className="size-4" />Other amount / split
        </button>
      </div>} />
    </div>;
  } else {
    actions = <OrderActions
      secondary={prov ? [<Button key="p" variant="secondary" size="lg" iconStart={<Printer />} onClick={() => window.print()}>Print provisional receipt</Button>] : undefined}
      primary={<Button variant="primary" className="w-full" size="pay" disabled={busy} iconStart={<Plus />} onClick={a.startNew}>New order</Button>} />;
  }

  return (
    <>
      <p role="status" className="sr-only">{label}: {kot === "queued" && stage === "kitchen" ? "Waiting for internet" : STAGE_TEXT[stage]}</p>
      <OrderSummaryPanel
        className={variant === "aside" ? "h-full" : "h-[min(85dvh,48rem)] rounded-none border-0 shadow-none [&>header]:pr-14"}
        orderLabel={label}
        status={<><span data-testid="ticket-badge"><Badge tone="neutral">{ticketBadge(t, tables)}</Badge></span><Badge tone={kot === "queued" && stage === "kitchen" ? "warning" : STAGE_TONE[stage]}>{kot === "queued" && stage === "kitchen" ? "Waiting for internet" : STAGE_TEXT[stage]}</Badge>{order?.offline && <Badge tone="warning"><CloudOff />Offline</Badge>}
          {t.kotPrint === "failed" && stage !== "paid" && <button type="button" onClick={a.reprintKot} disabled={busy} data-testid="needs-reprint" className="inline-flex min-h-8 items-center gap-1 rounded-full bg-danger-soft px-2.5 text-xs font-bold text-danger-fg hover:opacity-90"><Printer aria-hidden className="size-3.5" />Needs reprint</button>}
          {bill && <span className="text-xs font-medium text-fg-subtle" title="Tax invoice number, given when the bill was made">Bill no. <span className="font-mono font-semibold text-fg-muted">{bill.invoice_number}</span></span>}</>}
        notice={notice}
        fields={fields}
        itemCount={stage === "paid" ? undefined : count}
        showItemsHeader={stage !== "paid"}
        onClear={draft ? a.clear : undefined}
        clearLabel="Clear cart"
        empty={<EmptyState compact illustration={<EmptyCartIllustration />} title="Cart is empty" hint="Tap a dish to add it." />}
        totals={stage === "paid" || (t.lines.length === 0 && !pendingMore) ? undefined : !pricing.priced ? (
          // The totals could not be worked out (e.g. a discount larger than the bill): say so and keep the way out, never a silently empty block.
          pricing.error ? (
            <div role="alert" data-testid="totals-error" className="space-y-2 rounded-lg bg-warning-soft px-3 py-2 text-sm font-medium text-warning-fg">
              <p>{pricing.error}</p>
              {t.discount && canDiscount && !bill ? <button type="button" className="font-bold underline" onClick={() => applyDiscount(null)}>Remove discount</button> : null}
            </div>
          ) : undefined
        ) : (
          <TotalsBlock pricing={pricing} currency={currency} owing={owing} paid={bill?.paid} balanceDue={bill?.balance_due}
            canDiscount={canDiscount} discountLocked={bill !== null} billDiscountEditable={billEditable} onDiscount={() => setDiscountOpen(true)} onRemoveDiscount={() => applyDiscount(null)}
            serviceChargeConfigured={scConfigured} serviceChargeOn={t.serviceCharge !== false} onToggleServiceCharge={a.setServiceCharge} eatIn={eatIn}
            canToggleOffers={canToggleOffers} offersOn={t.applyOffers !== false} onToggleOffers={a.setApplyOffers} manualReason={t.discount?.reason ?? null} />
        )}
        actions={actions}
      >
        {stage === "paid" ? <PaidView t={t} phone={customer?.phone} restaurant={restaurantName} onCustomerSaved={a.customerCreated} /> : (
          <OrderItemList label="Order items">
            {/* Once the order is placed, identical lines (same dish, option, modifiers, note and price) read as one: "3x Chicken 65 [Mild]", the same money. */}
            {(draft ? t.lines.map((l) => ({ ...l, keys: [l.key] })) : groupCartLines(t.lines)).map((l) => {
              // Before the kitchen has anything, a placed line can still be removed (server); afterwards a manager cancels.
              const placedRemovable = !draft && (stage === "placed") && !t.hadKot && kot === null && l.keys.length === 1 && !!order?.lineIds?.[l.key] && t.lines.length > 1;
              return (
                <OrderLineItem key={l.key} id={l.key} name={lineName(l)} foodType={vegOf(l.item)} qty={l.qty} unitPrice={l.unit} lineTotal={mulMoney(l.unit, l.qty)} currency={currency}
                  imageUrl={mediaUrl(l.item.thumb_url ?? l.item.image_url)} dense
                  addons={addonsOf(l)} note={l.note}
                  extra={draft ? <>{l.check && <CheckMarker name={l.item.name} disabled={busy} onConfirm={() => a.confirmLine(l.key, false)} />}<SizeSwitch l={l} currency={currency} disabled={busy} onPick={(v) => a.setVariant(l.key, v, false)} /></> : undefined}
                  onOptions={draft && groupsFor(l.item, groups).length > 0 ? () => a.editOptions(l.key, false) : undefined}
                  onNote={draft ? () => a.editNote(l.key, false) : undefined}
                  onIncrement={draft ? () => a.setQty(l.key, 1) : undefined}
                  onDecrement={draft ? () => a.setQty(l.key, -1) : undefined}
                  onRemove={draft ? () => a.remove(l.key) : placedRemovable ? () => a.removePlaced(l.key) : undefined}
                  locked={busy} />
              );
            })}
          </OrderItemList>
        )}
        {pendingMore && stage !== "paid" && (
          <div data-testid="more-items" className="mt-3 border-t border-border pt-3">
            <h3 className="px-1 pb-1 font-display text-sm font-bold text-fg">New items (not sent yet)</h3>
            <OrderItemList label="New items">
              {more.map((l) => (
                <OrderLineItem key={l.key} id={`more:${l.key}`} name={lineName(l)} foodType={vegOf(l.item)} qty={l.qty} unitPrice={l.unit} lineTotal={mulMoney(l.unit, l.qty)} currency={currency}
                  imageUrl={mediaUrl(l.item.thumb_url ?? l.item.image_url)} dense
                  addons={addonsOf(l)} note={l.note}
                  extra={<>{l.check && <CheckMarker name={l.item.name} disabled={busy} onConfirm={() => a.confirmLine(l.key, true)} />}<SizeSwitch l={l} currency={currency} disabled={busy} onPick={(v) => a.setVariant(l.key, v, true)} /></>}
                  onOptions={groupsFor(l.item, groups).length > 0 ? () => a.editOptions(l.key, true) : undefined}
                  onNote={() => a.editNote(l.key, true)}
                  onIncrement={() => a.setMoreQty(l.key, 1)} onDecrement={() => a.setMoreQty(l.key, -1)} onRemove={() => a.removeMore(l.key)}
                  locked={busy} />
              ))}
            </OrderItemList>
          </div>
        )}
      </OrderSummaryPanel>
      {bill && payKind && (
        <PaySheet key={`${bill.id}:${bill.balance_due}`} open balance={bill.balance_due} currency={currency} initialKind={payKind} payeeName={bill.seller_name} busy={busy}
          onClose={() => setPayKind(null)}
          onPay={async (lines) => { if (await a.payLines(lines)) setPayKind(null); }} />
      )}
      {pricing.priced && (
        <DiscountDialog open={discountOpen} onOpenChange={setDiscountOpen} current={discountNow} itemsTotal={pricing.priced.items} currency={currency}
          limitPercent={discountLimit} onApply={applyDiscount} onRemove={() => applyDiscount(null)} preview={previewDiscount}
          note={billEditable && bill ? `Bill ${bill.invoice_number} is replaced by a new bill with this discount. The old number is cancelled with a credit note.` : undefined} />
      )}
    </>
  );
}

/** A dish added by voice ("done") with a doubt: icon + the word Check (never colour alone) until staff confirm it (a tap) or edit the line. */
const pendingMoreEarly = (t: Ticket) => (t.more ?? []).length > 0;

function CheckMarker({ name, disabled, onConfirm }: { name: string; disabled: boolean; onConfirm: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onConfirm} data-testid="line-check" title="Heard by voice with a doubt. Tap when it is right."
      aria-label={`Check ${name}: heard by voice with a doubt. Tap to confirm`}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-warning bg-warning-soft px-2 text-xs font-bold text-warning-fg transition-colors hover:opacity-90 active:scale-[0.97] disabled:opacity-50">
      <TriangleAlert aria-hidden className="size-3.5" />Check
    </button>
  );
}

/** "Change to Full" (or "Change to Half") on a two-size line: one tap, the price follows. Dishes with 3+ sizes use the options picker. */
function SizeSwitch({ l, disabled, onPick }: { l: Ticket["lines"][number]; currency: string; disabled: boolean; onPick: (variantId: string | null) => void }) {
  const other = otherVariant(l.item, l.variantId);
  if (!other) return null;
  const d = variantDelta(l.item, other.id);
  return (
    <button type="button" disabled={disabled} onClick={() => onPick(other.id)} aria-label={`Change to ${other.name}${d ? ` (${d})` : ""}`} title={`Change to ${other.name}${d ? ` ${d}` : ""}`}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-border bg-surface px-2 text-xs font-semibold text-primary transition-colors hover:bg-primary-soft active:scale-[0.97] disabled:opacity-50">
      <ArrowLeftRight aria-hidden className="size-3.5" />{other.name}
    </button>
  );
}
