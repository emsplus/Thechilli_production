"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Boxes, CheckCircle2, FileText, Info, Loader, PackagePlus, Plus, ReceiptText, RotateCcw, ScanLine, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { Badge, Button, Checkbox, Dialog, IconButton, Input, Notice, PageHeader, Select, Table } from "@chilli/ui";
import { InlineInput, InlineSelect } from "@/components/inline-fields";
import { Card, CardHeader, EmptyState, Money, SegmentedControl, Skeleton, StatusPill, toast, useConfirm } from "@/components/ui";
import { EmptyMenuIllustration, SuccessCheckIllustration } from "@/components/illustrations";
import { api, ApiError } from "@/lib/api";
import { plainAiError } from "@/lib/aiErrors";
import { cn } from "@/lib/cn";
import { divDecimal, isDecimal, mulDecimal } from "@/lib/decimal";
import { dateWarning, duplicateGroups, normaliseGstin, sumQty } from "@/lib/invoiceHints";
import { looksLikeConsumable } from "@/lib/invoiceHints";
import { suggestItem } from "@/lib/matchItems";
import { formatDate } from "@/lib/datetime";
import { cmpMoney, currencyMark, formatCurrency, sumMoney } from "@/lib/money";
import { getTaxConfig, useCurrency } from "@/lib/taxConfig";
import type { InventoryItem, Purchase, PurchaseLine, StockAdded, Supplier } from "@/lib/types";
import { baseOf, prettyQty, unitsFor } from "@/lib/units";
import { useLoader } from "@/lib/useLoader";
import { useManage } from "./manage-context";
import { StockFlowStrip } from "./stock-flow";
import { ExpenseDialog } from "./ExpensesView";
import { InvoiceUpload } from "./InvoiceUpload";
import { BulkCreateDialog, CreateItemDialog, PackConverted, PackHelper, SuggestionChip, type PackSnapshot } from "./invoice-items";
import { taxWord } from "@/lib/taxWords";

/** The tax word, GST (non-hook read: the config is loaded by the shell). */
const TW = () => taxWord(getTaxConfig()?.country);

const fetchAll = async () => {
  const [purchases, items, suppliers] = await Promise.all([api.purchases(), api.inventoryItems(), api.suppliers()]);
  return { purchases, items, suppliers };
};
const trim = (v: string) => (/^\d+\.\d+$/.test(v) ? v.replace(/0+$/, "").replace(/\.$/, "") : v);
/** A price as a bill prints it: at least two decimals (280.00), more only when the price really has them (0.1665). */
const price2 = (v: string) => { const t = trim(v); return /^\d+$/.test(t) ? `${t}.00` : /^\d+\.\d$/.test(t) ? `${t}0` : t; };
/** Small buttons grow to a 44px touch target on phones. */
const TOUCH = "max-sm:h-11";
const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

/** A review line plus what only the browser knows: an exact total to keep, how to undo a conversion, and how the quantity was derived. */
type ReviewLine = PurchaseLine & { locked_total?: string; undo?: PackSnapshot & { unit: string }; derived?: boolean; derivedText?: string; printed?: { quantity: string; unit_price: string; amount: string } };
const MANUAL_EDIT: (keyof PurchaseLine)[] = ["quantity", "unit", "unit_price"];
/** Server total that differs from quantity x unit price only by unit-price rounding is the exact one to keep. */
function initialLine(l: PurchaseLine): ReviewLine {
  const q = trim(l.quantity), up = price2(l.unit_price);
  const out: ReviewLine = { ...l, quantity: q, unit_price: up };
  if (l.line_total && isDecimal(q) && isDecimal(up) && mulDecimal(q, up) !== l.line_total && Math.abs(Number(l.line_total) - Number(q) * Number(up)) <= Number(q) * 0.00005 + 0.005) out.locked_total = l.line_total;
  if (l.pack?.status === "ok" && l.pack.text) { out.derived = true; out.derivedText = l.pack.text; }
  if (l.id && l.line_total) out.printed = { quantity: q, unit_price: up, amount: l.line_total }; // what the scan read, to show when the person edits it
  return out;
}
const lineTotalOf = (l: ReviewLine) => l.locked_total ?? (isDecimal(l.quantity) && isDecimal(l.unit_price) ? mulDecimal(l.quantity, l.unit_price) : "0.00");
/** The line as it is printed on the paper bill: "4 x 6 x 2.55 kg @ 15.69 = 62.76". Empty when nothing differs from the editable fields. */
function printedLine(l: ReviewLine): string {
  const pk = l.pack;
  if (!pk?.invoiced?.quantity) return "";
  const size = pk.pack_text || (pk.pack_count && pk.unit_size ? `${trim(pk.pack_count)} x ${trim(pk.unit_size)} ${pk.unit_size_unit ?? ""}`.trim() : "");
  const qty = `${trim(pk.invoiced.quantity)}${pk.invoiced.unit ? ` ${pk.invoiced.unit}` : ""}`;
  if (!size && !pk.invoiced.unit && pk.invoiced.unit_price) return `${qty} × ${price2(pk.invoiced.unit_price)}${l.line_total ? ` = ${l.line_total}` : ""}`; // a plain line: "2 × 50.00 = 100.00"
  return [size ? `${qty} (${size})` : qty, pk.invoiced.unit_price ? `@ ${trim(pk.invoiced.unit_price)}` : "", l.line_total ? `= ${l.line_total}` : ""].filter(Boolean).join(" ");
}
const same = (a?: string | null, b?: string | null) => !!a && !!b && isDecimal(a) && isDecimal(b) && Number(a) === Number(b);
/** "On the bill: ..." text, only while the line differs from what is printed (edited, or restated by a derivation). */
function printedHint(l: ReviewLine): string {
  const inv = l.pack?.invoiced;
  if (inv?.quantity) {
    const unchanged = same(inv.quantity, l.quantity) && same(inv.unit_price, l.unit_price) && (!inv.unit || inv.unit === l.unit);
    return unchanged ? "" : printedLine(l);
  }
  const pr = l.printed;
  if (!pr || (same(pr.quantity, l.quantity) && same(pr.unit_price, l.unit_price))) return "";
  return `${trim(pr.quantity)} × ${price2(pr.unit_price)} = ${pr.amount}`;
}
/** Restates a line in another quantity/unit; the line TOTAL is kept and the unit price follows (decimal-exact). Always undoable. */
function reprice(l: ReviewLine, quantity: string, unit: string, text: string | null): ReviewLine {
  const total = lineTotalOf(l);
  const price = divDecimal(total, quantity, 4);
  if (!price || !(Number(quantity) > 0)) return l;
  return { ...l, quantity, unit, unit_price: trim(price), locked_total: total, derived: !!text, derivedText: text ?? undefined, needs_check: false, check_reason: null,
    undo: { quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, locked_total: l.locked_total } };
}
/** Maps a line to an item. A case of bottles read as "7.92 l" is restated as 12 pcs for an item counted in pieces (and the reverse). */
function applyMap(l: ReviewLine, it: InventoryItem): ReviewLine {
  let n: ReviewLine = { ...l, item_id: it.id };
  if (!l.id && l.confidence == null && baseOf(l.unit) !== it.base_unit) return { ...n, unit: it.base_unit }; // hand-typed placeholder unit
  const pk = l.pack;
  if (it.base_unit === "pcs" && pk?.count_total && baseOf(l.unit) !== "pcs") n = reprice(n, trim(pk.count_total), "pcs", `${trim(pk.invoiced.quantity ?? "")} × ${trim(pk.pack_count ?? "")} per case`);
  else if (it.base_unit !== "pcs" && pk?.measure && baseOf(l.unit) === "pcs") n = reprice(n, trim(pk.measure.quantity), pk.measure.unit, "from the size in the description");
  return n;
}

const BACK_LABEL: Record<string, { tab: string; view?: string; label: string }> = { inventory: { tab: "inventory", label: "Back to Inventory" }, overview: { tab: "overview", label: "Back to Overview" }, expenses: { tab: "suppliers", view: "expenses", label: "Back to Expenses" } };

export function PurchasesView({ embedded = false, initialInvoiceId, from }: { embedded?: boolean; initialInvoiceId?: string; from?: string }) {
  const { goto, refresh } = useManage();
  const { data, error, setError, loading, reload } = useLoader(fetchAll);
  const [openId, setOpenId] = useState<string | null>(initialInvoiceId ?? null);
  const [done, setDone] = useState<Purchase | null>(null);
  const [fetched, setFetched] = useState<Purchase | null>(null);
  const back = from ? BACK_LABEL[from] : undefined;
  const backButton = back && <Button variant="ghost" iconStart={<ArrowLeft />} onClick={() => goto(back.tab, back.view)}>{back.label}</Button>;
  // Poll while OCR runs; an invoice stuck in "uploaded" (job lost to a server restart) waits for "Retry reading".
  const pending = data?.purchases.some((p) => p.status === "uploaded" && !p.retry_extraction_allowed);

  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void reload(), 1200);
    return () => clearInterval(t);
  }, [pending, reload]);

  const listed = data?.purchases.find((p) => p.id === openId);
  // An invoice opened from a link (ledger, "Last received") may be older than the 200 most recent in the list.
  const needsFetch = !!openId && !!data && !listed && fetched?.id !== openId;
  useEffect(() => {
    if (!needsFetch || !openId) return;
    let off = false;
    api.purchase(openId).then((p) => { if (!off) setFetched(p); }).catch((e) => { if (!off) { setError(em(e, "Could not open that invoice")); setOpenId(null); } });
    return () => { off = true; };
  }, [needsFetch, openId, setError]);
  const open = listed ?? (fetched?.id === openId ? fetched : undefined);
  const supplierName = (id: string | null) => data?.suppliers.find((s) => s.id === id)?.name;

  if (done && data) {
    return <SuccessPanel p={done} supplier={supplierName(done.supplier_id)} onViewStock={() => goto("inventory", undefined, { highlight: (done.stock_added ?? []).map((s) => s.item_id).join(",") })}
      onAnother={() => { setDone(null); setOpenId(null); }} />;
  }

  if (open && data) {
    const step = open.status === "confirmed" ? 4 : 2;
    return (
      <>
        {embedded ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-fg-muted">{open.status === "confirmed" ? "This invoice is confirmed. It is read-only." : "Check every line. Nothing is added to stock until you confirm."}</p>
            <div className="flex flex-wrap gap-2">{backButton}<Button variant="secondary" iconStart={<ArrowLeft />} onClick={() => setOpenId(null)}>All invoices</Button></div></div>
        ) : <PageHeader title="Review invoice" description="Check every line. Nothing is added to stock until you confirm."
          actions={<Button variant="secondary" iconStart={<ArrowLeft />} onClick={() => setOpenId(null)}>All invoices</Button>} />}
        <StockFlowStrip step={step as 2 | 4} className="mb-4" />
        {error && <div className="mb-4"><Notice tone="danger">{error}</Notice></div>}
        <Review key={open.id + open.status} p={open} items={data.items} suppliers={data.suppliers} reload={reload} onBack={() => setOpenId(null)}
          onConfirmed={(c) => { setDone(c); refresh(); }} />
      </>
    );
  }
  if (openId && !data?.purchases.length && !error) return <div role="status" aria-label="Loading invoice"><Skeleton className="h-64 w-full rounded-2xl" /></div>;

  return (
    <>
      {embedded ? <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-fg-muted">Upload a supplier invoice, review what was read, then add it to stock.</p>{backButton}</div>
        : <PageHeader title="Purchases" description="Upload a supplier invoice, review what was read, then add it to stock." />}
      <StockFlowStrip step={1} className="mb-4" />
      {error && <div className="mb-4"><Notice tone="danger">{error}</Notice></div>}

      <InvoiceUpload setError={setError} onUploaded={async (p) => { setOpenId(p.id); await reload(); }} />

      <h2 className="mb-3 font-display text-lg font-semibold text-fg">Invoices</h2>
      {loading ? (
        <div className="space-y-2" role="status" aria-label="Loading invoices">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>
      ) : !data?.purchases.length ? (
        <Card><EmptyState illustration={<EmptyMenuIllustration />} title="No purchase invoices yet" hint="Upload your first supplier invoice above. If it cannot be read, you can type the lines in by hand." /></Card>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {data.purchases.map((p) => (
              <li key={p.id}>
                <button onClick={() => setOpenId(p.id)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/60 sm:px-5">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-fg-muted"><FileText className="size-5" aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-fg">{p.invoice_number ?? "No invoice number"}</span>
                    <span className="block truncate text-xs text-fg-subtle">{supplierName(p.supplier_id) ?? "No supplier yet"} · {formatDate(p.invoice_date)}</span>
                  </span>
                  <span className="hidden text-right sm:block">{p.total ? <Money value={p.total} strong /> : <span className="text-fg-subtle">-</span>}</span>
                  {p.status === "uploaded" && p.retry_extraction_allowed ? <Badge tone="warning">{<AlertTriangle />}Stuck, open to retry</Badge>
                    : p.status === "uploaded" ? <Badge tone="info">{<Loader className="animate-spin" />}Reading invoice…</Badge> : <StatusPill kind="purchase" status={p.status} />}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/* --------------------------------------------------------------------------- review */
function Review({ p, items, suppliers, reload, onBack, onConfirmed }: { p: Purchase; items: InventoryItem[]; suppliers: Supplier[]; reload: () => Promise<void>; onBack: () => void; onConfirmed: (p: Purchase) => void }) {
  const confirm = useConfirm();
  const currency = useCurrency();
  const locked = p.status === "confirmed";
  const [supplier, setSupplier] = useState(p.supplier_id ?? "");
  const [number, setNumber] = useState(p.invoice_number ?? "");
  const [date, setDate] = useState(p.invoice_date ?? "");
  const [lines, setLines] = useState<ReviewLine[]>(() => p.lines.map(initialLine));
  const [createFor, setCreateFor] = useState({ open: false, i: 0, nonce: 0 });
  const [bulk, setBulk] = useState({ open: false, nonce: 0 });
  const [busy, setBusy] = useState<"save" | "confirm" | "retry" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [supOpen, setSupOpen] = useState(false);

  const [docType, setDocType] = useState<"stock_purchase" | "expense" | "other">(p.document_type ?? "stock_purchase");
  const guessed = p.document_type ?? "stock_purchase";
  const [changingSupplier, setChangingSupplier] = useState(false);
  const [touched, setTouched] = useState(false); // quantities / prices edited here: the expense then uses the edited amounts
  // INR only: a bill printed in another currency is never converted automatically; the server refuses to confirm it.
  const billCur = p.bill?.currency ?? "";
  const cur = currency;
  const ocrWarnings = [...new Set([...(p.warnings ?? []), ...(p.bill?.warnings ?? [])].filter((w): w is string => !!w && !!w.trim()))];
  const foreign = (!!billCur && billCur.toUpperCase() !== "INR") || ocrWarnings.some((w) => /not INR/i.test(w));
  const taxLines = p.bill?.tax_lines ?? [];
  // First open: the supplier the bill names is selected (matched or created once by the server). Retries and second tabs find the same one.
  const resolving = useRef(false);
  useEffect(() => {
    if (locked || p.supplier_id || !p.supplier_name_raw || resolving.current) return;
    resolving.current = true;
    api.resolveSupplier(p.id).then(async (r) => {
      if (!r.supplier_id) return;
      const known = suppliers.some((x) => x.id === r.supplier_id);
      await reload();
      setSupplier((cur0) => cur0 || r.supplier_id!);
      if (!known) toast.success(`Supplier “${p.supplier_name_raw}” added`);
    }).catch(() => { /* the manual "Add supplier" panel stays available */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [expOpen, setExpOpen] = useState({ open: false, nonce: 0 });
  const { goto } = useManage();
  const totals = lines.map(lineTotalOf);
  const total = sumMoney(totals);
  const itemOf = (id: string | null) => items.find((i) => i.id === id);
  const mismatch = (l: PurchaseLine) => { const it = itemOf(l.item_id); const b = baseOf(l.unit); return !l.exclude_from_stock && !!it && (b === null || b !== it.base_unit); };
  const lineOk = (l: PurchaseLine) => !!l.description.trim() && isDecimal(l.quantity) && Number(l.quantity) > 0 && isDecimal(l.unit_price);
  const edit = (i: number, patch: Partial<ReviewLine>) => setLines((ls) => ls.map((l, j) => {
    if (j !== i) return l;
    const manual = MANUAL_EDIT.some((k) => k in patch) && !("locked_total" in patch);
    if (manual) setTouched(true);
    // typing a quantity or unit is a human decision: the machine's derivation and its warning no longer apply
    // (a "what one unit holds" hint is only information, so it stays)
    return { ...l, ...patch, ...(manual ? { locked_total: undefined, undo: undefined, derived: false, derivedText: undefined, needs_check: false, check_reason: null, pack: l.pack ? (l.pack.status === "hint" ? l.pack : { ...l.pack, status: "asis" as const, text: null }) : null } : {}) };
  }));
  /** "(2 pcs)": stock gets quantity x what one unit holds. Only on request; the line total stays and the unit price follows. Undoable. */
  const applyPerUnit = (i: number) => setLines((ls) => ls.map((l, j) => {
    const per = l.pack?.per_unit;
    if (j !== i || !per || !isDecimal(l.quantity)) return l;
    return reprice(l, trim(mulDecimal(l.quantity, per.quantity, 3)), per.unit, `${l.quantity} × ${trim(per.quantity)} ${per.unit} per unit`);
  }));
  /** The printed quantity and unit are what was received: the line stops needing a check. */
  const acceptPrinted = (i: number) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, needs_check: false, check_reason: null } : l)));
  const mapLine = (i: number, it: InventoryItem) => setLines((ls) => ls.map((l, j) => (j === i ? applyMap(l, it) : l)));
  const suggestions = useMemo(() => lines.map((l) => (l.item_id || l.exclude_from_stock || !l.description.trim() ? null : suggestItem(l.description, items))), [lines, items]);
  const packConvert = (i: number, n: { quantity: string; unit: string; unit_price: string; total: string }) => setLines((ls) => ls.map((l, j) => (j === i
    ? { ...l, quantity: n.quantity, unit: n.unit, unit_price: n.unit_price, locked_total: n.total, derived: false, derivedText: undefined, needs_check: false, check_reason: null, undo: { quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, locked_total: l.locked_total } } : l)));
  const packUndo = (i: number) => setLines((ls) => ls.map((l, j) => (j === i && l.undo ? { ...l, quantity: l.undo.quantity, unit: l.undo.unit, unit_price: l.undo.unit_price, locked_total: l.undo.locked_total, undo: undefined, derived: false, derivedText: undefined } : l)));
  /** "= 24 l (2 cases x 12 x 1 l)" back to what is printed on the invoice (2 cases @ 17.49); the pack helper then asks. */
  const asInvoiced = (i: number) => setLines((ls) => ls.map((l, j) => {
    const inv = l.pack?.invoiced;
    if (j !== i || !inv?.quantity || !inv.unit_price) return l;
    return { ...l, quantity: trim(inv.quantity), unit: inv.unit || (l.pack?.status === "hint" ? "pcs" : "case"), unit_price: trim(inv.unit_price), locked_total: lineTotalOf(l), derived: false, derivedText: undefined, undo: undefined };
  }));
  const setExcluded = (i: number, on: boolean) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, exclude_from_stock: on, item_id: on ? null : l.item_id } : l)));
  /** A dine-in bill has dishes, not stock: leave every line that has no stock item out of stock in one go (the money stays on the bill). */
  const excludeUnmatched = () => setLines((ls) => ls.map((l) => (l.item_id || l.exclude_from_stock ? l : { ...l, exclude_from_stock: true })));
  const stockLines = lines.filter((l) => !l.exclude_from_stock);
  const unmapped = stockLines.filter((l) => !l.item_id).length;
  const needsCheck = stockLines.filter((l) => l.needs_check).length;
  const lowConf = lines.filter((l) => l.confidence != null && Number(l.confidence) < 0.8).length;
  const unitProblems = stockLines.filter((l) => l.item_id && mismatch(l)).length;
  const ready = !!supplier && docType === "stock_purchase" && stockLines.length > 0 && lines.every((l) => lineOk(l) && (l.exclude_from_stock || (l.item_id && !mismatch(l) && !l.needs_check)));
  // What still needs a human, per line: blocking reasons stop Confirm; "soft" ones are only worth a look.
  const reviewing = !locked && docType === "stock_purchase";
  const issues = lines.map((l) => {
    if (!reviewing) return { block: [] as string[], soft: [] as string[] };
    const block: string[] = [], soft: string[] = [];
    if (!lineOk(l)) block.push("Quantity or price missing");
    if (!l.exclude_from_stock) {
      if (l.needs_check) block.push("Check the quantity");
      if (!l.item_id) block.push("Not mapped to a stock item");
      else if (mismatch(l)) block.push("Unit does not match the item");
    }
    if (l.confidence != null && Number(l.confidence) < 0.8) soft.push(`Read with low confidence (${(Number(l.confidence) * 100).toFixed(0)}%)`);
    if (l.pack?.price_note) soft.push(l.pack.price_note);
    return { block, soft };
  });
  const attention = issues.map((x, i) => (x.block.length || x.soft.length ? i : -1)).filter((i) => i >= 0);
  const [flash, setFlash] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const goToIssue = (i: number) => {
    document.getElementById(`invoice-line-${i}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlash(i); setTimeout(() => setFlash((f) => (f === i ? null : f)), 2200);
  };
  const nextIssue = () => { const target = attention[cursor % attention.length]; setCursor((c) => c + 1); if (target !== undefined) goToIssue(target); };
  const dupes = useMemo(() => (locked ? [] : duplicateGroups(lines)), [lines, locked]);
  const dateWarn = locked ? null : dateWarning(date);
  const printedNet = p.net ?? (p.total && p.vat ? sumMoney([p.total, `-${p.vat}`]) : null);
  const taxSum = taxLines.length ? sumMoney(taxLines.map((t) => t.amount)) : p.vat ?? null;
  const grand = taxSum != null ? sumMoney([total, taxSum]) : null;
  const netGap = printedNet != null ? Math.abs(Number(total) - Number(printedNet)) : null;

  const mergeDupes = (g: number[]) => setLines((ls) => {
    const first = ls[g[0]];
    const qty = sumQty(g.map((i) => ls[i].quantity)), tot = sumMoney(g.map((i) => lineTotalOf(ls[i])));
    const merged: ReviewLine = { ...first, quantity: qty, locked_total: tot, undo: undefined, derived: false, derivedText: undefined, needs_check: g.some((i) => ls[i].needs_check) };
    return ls.flatMap((l, j) => (j === g[0] ? [merged] : g.includes(j) ? [] : [l]));
  });

  async function addSupplierFromInvoice() {
    const name = (p.supplier_name_raw ?? "").trim();
    if (!name) return;
    const vat = normaliseGstin(p.supplier_vat_number);
    try {
      let s: Supplier;
      try { s = await api.createSupplier(name, vat); }
      catch (e) {
        if (e instanceof ApiError && e.status === 422 && vat) { s = await api.createSupplier(name); toast.message(`Added without the tax number (${vat} did not look valid). Check it on the Suppliers tab.`); }
        else throw e;
      }
      await reload(); setSupplier(s.id); toast.success(`${s.name} added`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { await reload(); const have = (await api.suppliers()).find((x) => x.name.toLowerCase() === name.toLowerCase()); if (have) { setSupplier(have.id); return; } }
      setErr(em(e, "Could not add the supplier"));
    }
  }

  const save = () => api.savePurchase(p.id, {
    supplier_id: supplier || null, invoice_number: number || null, invoice_date: date || null, document_type: docType,
    lines: lines.map((l) => ({ description: l.description, item_id: l.exclude_from_stock ? null : l.item_id || null, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, ...(l.locked_total ? { line_total: l.locked_total } : {}),
      pack: l.pack ?? null, needs_check: !!l.needs_check, check_reason: l.check_reason ?? null, exclude_from_stock: !!l.exclude_from_stock, item_code: l.item_code ?? null, vat_code: l.vat_code ?? null, vat_rate: l.vat_rate ?? null })),
  });

  async function onSave() {
    setBusy("save"); setErr(null);
    try { await save(); toast.success("Draft saved"); await reload(); } catch (e) { setErr(em(e, "Could not save")); } finally { setBusy(null); }
  }
  async function onConfirm() {
    const ok = await confirm({ title: "Add this purchase to stock?", description: `${stockLines.length} line${stockLines.length === 1 ? "" : "s"}${stockLines.length < lines.length ? ` (${lines.length - stockLines.length} marked not stock)` : ""} totalling ${formatCurrency(sumMoney(stockLines.map((l) => lineTotalOf(l))), cur)} will be added to your inventory. This cannot be undone; fix mistakes later with an adjustment.`, confirmLabel: "Confirm & add to stock" });
    if (!ok) return;
    setBusy("confirm"); setErr(null);
    try { await save(); const c = await api.confirmPurchase(p.id); onConfirmed(c); await reload(); } catch (e) { setErr(em(e, "Could not confirm")); } finally { setBusy(null); }
  }

  async function onRetry() {
    setBusy("retry"); setErr(null);
    try { await api.retryExtraction(p.id); toast.message("Reading the invoice again…"); await reload(); }
    catch (e) { setErr(em(e, "Could not retry")); } finally { setBusy(null); }
  }
  const retryButton = p.retry_extraction_allowed && (
    <Button size="sm" className={TOUCH} variant="secondary" iconStart={<RotateCcw />} loading={busy === "retry"} onClick={() => void onRetry()}>Retry reading</Button>
  );

  if (p.status === "uploaded" && p.retry_extraction_allowed) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <span className="grid size-16 place-items-center rounded-2xl bg-warning-soft text-warning-fg"><AlertTriangle className="size-8" aria-hidden /></span>
          <div><p className="font-display text-lg font-semibold">Reading did not finish</p><p className="text-sm text-fg-muted">The server may have restarted while reading this invoice. Nothing was lost; read it again.</p></div>
          {err && <Notice tone="danger">{err}</Notice>}
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="primary" iconStart={<RotateCcw />} loading={busy === "retry"} onClick={() => void onRetry()}>Retry reading</Button>
            <Button variant="secondary" onClick={onBack}>Back to invoices</Button>
          </div>
        </div>
      </Card>
    );
  }

  if (p.status === "uploaded") {
    return (
      <Card>
        <div className="flex flex-col items-center gap-4 py-10 text-center" role="status">
          <motion.span className="grid size-16 place-items-center rounded-2xl bg-primary-soft text-primary-soft-fg" animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 1.6, repeat: Infinity }}><ScanLine className="size-8" aria-hidden /></motion.span>
          <div><p className="font-display text-lg font-semibold">Reading invoice…</p><p className="text-sm text-fg-muted">This usually takes a few seconds. You can leave this page; it will be here in the list.</p></div>
          <div className="w-full max-w-md space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-2/3" /></div>
          <Button variant="secondary" onClick={onBack}>Back to invoices</Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Invoice" action={<StatusPill kind="purchase" status={p.status} />} />
        {locked && p.document_type === "expense" && <div className="mb-4"><Notice tone="info" title="Recorded as an expense" action={<Button size="sm" className={TOUCH} variant="secondary" onClick={() => goto("suppliers", "expenses")}>See expenses</Button>}>No stock was added. This invoice is filed under Expenses and is read-only.</Notice></div>}
        {locked && p.document_type !== "expense" && (addedNoStock(p)
          ? <div className="mb-4"><Notice tone="info" title="Saved, no stock added">This invoice is confirmed and read-only. Its goods were already received on a goods receipt with the same supplier and bill number, so they were not added again.</Notice></div>
          : <div className="mb-4"><Notice tone="success" title="Added to stock">This invoice is confirmed and read-only. The stock it added is listed below the lines.</Notice></div>)}
        {p.status === "failed" && (
          <div className="mb-4"><Notice tone="warning" title="We could not read this invoice" action={retryButton || undefined}>{p.error ? `${plainAiError(p.error, "Automatic invoice reading", false)} ` : ""}Try reading it again, or enter the lines by hand below. Nothing is lost, and nothing posts to stock until you confirm.</Notice></div>
        )}
        {foreign && <div className="mb-4" data-testid="not-inr"><Notice tone="danger" title="Not in rupees: needs manual conversion">This bill is printed in {billCur || "another currency"}, not INR. Amounts are shown exactly as printed and are never converted. It cannot be confirmed until it is entered in rupees.</Notice></div>}
        {ocrWarnings.filter((w) => !(foreign && /not INR/i.test(w))).map((w) => <div key={w} className="mb-4"><Notice tone="warning">{w}</Notice></div>)}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
          {!locked && supplier && p.supplier_name_raw && !changingSupplier ? (
            <div className="col-span-2 min-w-0 md:col-span-1">
              <p className="mb-1.5 text-sm font-medium text-fg">Supplier</p>
              <div data-testid="supplier-picked" className="rounded-xl border border-border bg-surface-2/50 px-3 py-2">
                <p className="flex items-center gap-1.5 font-semibold text-fg"><CheckCircle2 aria-hidden className="size-4 shrink-0 text-success-fg" /><span className="min-w-0 truncate">{suppliers.find((x) => x.id === supplier)?.name ?? p.supplier_name_raw}</span></p>
                <p className="mt-0.5 break-words text-xs text-fg-subtle">Bill says: {p.supplier_name_raw}{p.supplier_vat_number ? ` · ${p.supplier_vat_number}` : ""}</p>
                {(p.bill?.supplier_address || p.bill?.supplier_phone || p.bill?.supplier_email) && <p className="mt-0.5 break-words text-xs text-fg-subtle">{[p.bill?.supplier_address, p.bill?.supplier_phone, p.bill?.supplier_email].filter(Boolean).join(" · ")}</p>}
                <button type="button" onClick={() => setChangingSupplier(true)} className="mt-1 inline-flex min-h-11 items-center rounded-md text-xs font-semibold text-primary-soft-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-8">Not the right supplier? Change</button>
              </div>
            </div>
          ) : (
            <div className="col-span-2 flex items-end gap-2 md:col-span-1">
              <Select label="Supplier" disabled={locked} value={supplier} onChange={(e) => setSupplier(e.target.value)} error={!locked && !supplier && docType === "stock_purchase" ? "Choose the supplier" : undefined}>
                <option value="">Choose supplier…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
              {!locked && <IconButton variant="secondary" label="Add supplier" icon={<Plus />} onClick={() => setSupOpen(true)} />}
            </div>
          )}
          <Input label="Invoice number" disabled={locked} value={number} onChange={(e) => setNumber(e.target.value)} />
          <Input label="Invoice date" type="date" disabled={locked} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {p.bill && (p.bill.time || p.bill.table || p.bill.order_type || p.bill.payment) && (
          <dl aria-label="Printed on the bill" className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {([["Time", p.bill.time], ["Table", p.bill.table], ["Order", p.bill.order_type], ["Payment", p.bill.payment]] as const).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="flex gap-1.5"><dt className="text-fg-subtle">{k}</dt><dd className="font-medium text-fg">{v}</dd></div>
            ))}
          </dl>
        )}
        {!locked && !supplier && p.supplier_name_raw && (
          <div className="mt-3 rounded-xl border border-primary/25 bg-primary-soft/50 p-3 text-xs">
            <p className="text-fg-muted">The invoice says <span className="font-semibold text-fg">{p.supplier_name_raw}</span>{p.supplier_vat_number ? ` · ${TW()} no. ${normaliseGstin(p.supplier_vat_number)}` : ""}. That is not in your suppliers yet.</p>
            <Button size="sm" variant="secondary" className={cn("mt-2", TOUCH)} iconStart={<Plus />} onClick={() => void addSupplierFromInvoice()}>Add supplier “{p.supplier_name_raw}”</Button>
          </div>
        )}
        {dateWarn && <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs font-medium text-warning-fg"><AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />{dateWarn}</p>}
      </Card>

      {!locked && (
        <section aria-label="What to do with this bill" className="rounded-2xl border border-border bg-surface p-4 shadow-card">
          <h3 className="font-display text-base font-semibold">What do you want to do with this bill?</h3>
          <SegmentedControl label="Bill action" block size="lg" className="mt-3" value={docType === "stock_purchase" ? "stock" : "expense"}
            onChange={(v) => setDocType(v === "stock" ? "stock_purchase" : guessed === "stock_purchase" ? "expense" : guessed)}
            options={[{ value: "stock", label: "Add to stock" }, { value: "expense", label: "Record as expense" }]} />
          <p className="mt-2 text-xs text-fg-muted">
            {docType === "stock_purchase"
              ? "Each line is matched to a stock item and added to stock when you confirm. Nothing is added before that."
              : "The bill is kept as an expense with its amounts. Nothing is added to stock."}
            {" "}{(docType === "stock_purchase") === (guessed === "stock_purchase") ? "This is what the scan suggests; you can switch." : `The scan read this as ${guessed === "stock_purchase" ? "a stock purchase" : guessed === "expense" ? "an expense" : "a restaurant or other bill"}. You can still ${docType === "stock_purchase" ? "add its lines to stock" : "record it as an expense"}.`}
          </p>
        </section>
      )}

      {/* Check: everything needed to trust the read, without scrolling to the bottom */}
      <section aria-label="Check" className="rounded-2xl border border-border bg-surface p-4 shadow-card">
        <h3 className="font-display text-base font-semibold">Check</h3>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div className="rounded-xl bg-surface-2/70 p-3"><dt className="text-xs text-fg-subtle">Lines read</dt><dd className="tnum font-display text-lg font-bold">{lines.length}</dd></div>
          <div className={cn("rounded-xl p-3", attention.length ? "bg-warning-soft" : "bg-success-soft")}>
            <dt className={cn("text-xs", attention.length ? "text-warning-fg" : "text-success-fg")}>Need attention</dt>
            <dd className={cn("tnum font-display text-lg font-bold", attention.length ? "text-warning-fg" : "text-success-fg")}>{reviewing ? attention.length : "-"}</dd>
          </div>
          <div className="rounded-xl bg-surface-2/70 p-3"><dt className="text-xs text-fg-subtle">Lines total <span className="font-normal">(net)</span></dt><dd className="font-display text-lg font-bold"><Money value={total} currency={cur} /></dd></div>
          <div className="rounded-xl bg-surface-2/70 p-3"><dt className="text-xs text-fg-subtle">GST on the invoice</dt><dd className="tnum font-display text-lg font-bold">{taxSum != null ? <Money value={taxSum} currency={cur} /> : <span className="text-fg-subtle">not read</span>}</dd></div>
        </dl>
        <dl className="mt-3 space-y-1 text-sm">
          {printedNet != null && <div className="flex justify-between gap-3"><dt className="text-fg-muted">Invoice net (as printed)</dt><dd className="tnum font-medium"><Money value={printedNet} currency={cur} /></dd></div>}
          {p.total && <div className="flex justify-between gap-3"><dt className="text-fg-muted">Invoice total (with GST)</dt><dd className="tnum font-medium"><Money value={p.total} currency={cur} /></dd></div>}
          {p.confidence && <div className="flex justify-between gap-3"><dt className="text-fg-muted">Reading confidence</dt><dd className="tnum font-medium">{(Number(p.confidence) * 100).toFixed(0)}%</dd></div>}
        </dl>
        {!locked && netGap !== null && (netGap <= 0.05
          ? <p className="mt-2 flex items-start gap-1.5 text-xs font-medium text-success-fg"><CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span>The lines add up to the invoice net of <Money value={printedNet!} currency={cur} />. Stock costs are kept net of GST.</span></p>
          : <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs font-medium text-warning-fg"><AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span>The lines add up to <Money value={total} currency={cur} /> but the invoice net is <Money value={printedNet!} currency={cur} /> (difference <Money value={netGap.toFixed(2)} currency={cur} />). A line may be missing, misread, or edited.</span></p>)}
        {!locked && netGap === null && p.total && Number(p.total) !== Number(total) && <p className="mt-2 text-xs text-fg-subtle">Invoice total as read: <Money value={p.total} currency={cur} />. If it includes GST it will be higher than the lines. A big gap means a line was misread.</p>}
        {reviewing && attention.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" className={TOUCH} variant="secondary" iconStart={<AlertTriangle />} onClick={nextIssue}>{cursor === 0 ? "Show the first line to check" : "Next line to check"}</Button>
            <span className="text-xs text-fg-muted">{issues.filter((x) => x.block.length).length} must be fixed before you can confirm.</span>
          </div>
        )}
        {reviewing && attention.length === 0 && lines.length > 0 && <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-success-fg"><CheckCircle2 aria-hidden className="size-3.5" />Every line is mapped and checked.</p>}
        {!locked && err && <div className="mt-3"><Notice tone="danger">{err}</Notice></div>}
      </section>

      <Card padded={false}>
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <h3 className="font-display text-base font-semibold">Bill lines</h3>
            <p className="mt-0.5 text-xs text-fg-subtle">{locked ? "As recorded." : "As printed on the bill. Change a quantity, unit or price if it was read wrongly; the amount and totals follow."}</p>
            {lowConf > 0 && <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-warning-fg"><AlertTriangle className="size-3.5" aria-hidden />{lowConf} line{lowConf === 1 ? "" : "s"} read with low confidence. Please check.</p>}
          </div>
          {!locked && (
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {docType === "stock_purchase" && unmapped > 0 && lines.some((l) => !l.item_id && l.description.trim()) && <Button size="sm" className={TOUCH} variant="secondary" iconStart={<PackagePlus />} onClick={() => setBulk((b) => ({ open: true, nonce: b.nonce + 1 }))}>Create all unmatched lines as new items</Button>}
              {docType === "stock_purchase" && unmapped > 0 && <Button size="sm" className={TOUCH} variant="secondary" onClick={excludeUnmatched}>Leave all unmatched lines out of stock</Button>}
              <Button size="sm" className={TOUCH} variant="secondary" iconStart={<Plus />} onClick={() => setLines((ls) => [...ls, { description: "", item_id: null, quantity: "1", unit: "pcs", unit_price: "0" }])}>Add line</Button>
            </div>
          )}
        </div>
        {!locked && dupes.map((g) => (
          <div key={g.join("-")} className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-info-soft/60 px-4 py-2.5 text-sm text-info-fg sm:px-5">
            <span><span className="font-semibold">{lines[g[0]].description}</span> is listed {g.length} times with the same price.</span>
            <Button size="sm" className={TOUCH} variant="secondary" onClick={() => mergeDupes(g)}>Merge into one line</Button>
          </div>
        ))}
        {lines.length === 0 ? <EmptyState compact icon={<FileText />} title="No lines" hint="Add the items on the invoice." /> : (
          <div className="@container">
            <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_7rem_7rem_2.75rem] gap-2 border-b border-border bg-surface-2/60 px-5 py-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle @3xl:grid">
              <span>S.No · Item description</span><span>Qty</span><span>Unit</span><span className="text-right">Unit price ({currencyMark(cur) || "price"})</span><span className="text-right">Amount ({currencyMark(cur) || "amount"})</span><span />
            </div>
            <ul className="divide-y divide-border">
              {lines.map((l, i) => {
                const low = l.confidence != null && Number(l.confidence) < 0.8;
                const it = itemOf(l.item_id);
                const sug = docType === "stock_purchase" ? suggestions[i] : null;
                const excluded = !!l.exclude_from_stock;
                const stockUi = docType === "stock_purchase" && !excluded;
                const consumable = !locked && stockUi && !l.item_id && looksLikeConsumable(l, lines);
                const was = printedHint(l);
                const per = l.pack?.status === "hint" && !l.derived && !l.undo ? l.pack.per_unit : null;
                const cap = "mb-1 block text-xs font-semibold text-fg-subtle @3xl:hidden";
                return (
                  <li key={l.id ?? i} id={`invoice-line-${i}`} data-attention={issues[i].block.length ? "block" : issues[i].soft.length ? "soft" : undefined}
                    className={cn("relative scroll-mt-24 space-y-3 px-4 py-4 transition-shadow sm:px-5", low && "bg-warning-soft/50", issues[i].block.length > 0 && "border-l-4 border-l-warning bg-warning-soft/40", excluded && docType === "stock_purchase" && "bg-surface-2/50", flash === i && "ring-2 ring-inset ring-primary")}>
                    <div className="grid grid-cols-2 gap-x-2 gap-y-2.5 @xl:grid-cols-4 @3xl:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_7rem_7rem_2.75rem] @3xl:items-start">
                      <div className="col-span-2 flex min-w-0 items-start gap-2 pr-12 @xl:col-span-4 @3xl:col-span-1 @3xl:pr-0">
                        <span className="tnum mt-2.5 grid size-6 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-fg-subtle">{i + 1}</span>
                        <InlineInput aria-label={`Description, line ${i + 1}`} disabled={locked} value={l.description} placeholder="Description as on the invoice" onChange={(e) => edit(i, { description: e.target.value })} wrapperClassName="min-w-0 flex-1" />
                        {low && <Badge tone="warning" className="mt-2.5">{<AlertTriangle />}Check · {(Number(l.confidence) * 100).toFixed(0)}%</Badge>}
                      </div>
                      <div className="min-w-0"><span aria-hidden className={cap}>Qty</span>
                        <InlineInput aria-label={`Quantity, line ${i + 1}`} inputMode="decimal" disabled={locked} value={l.quantity} onChange={(e) => edit(i, { quantity: e.target.value })} error={l.quantity && !isDecimal(l.quantity) ? "Number" : undefined} className="text-base" /></div>
                      <div className="min-w-0"><span aria-hidden className={cap}>Unit</span>
                        <InlineSelect aria-label={`Unit, line ${i + 1}`} disabled={locked} value={l.unit} onChange={(e) => edit(i, { unit: e.target.value })}>
                          {[...new Set([...(it ? unitsFor(it.base_unit) : [...unitsFor("pcs"), ...unitsFor("g"), ...unitsFor("ml")]), l.unit])].map((u) => <option key={u}>{u}</option>)}
                        </InlineSelect></div>
                      <div className="min-w-0"><span aria-hidden className={cap}>Unit price ({currencyMark(cur) || "price"})</span>
                        <InlineInput aria-label={`Unit price, line ${i + 1}`} inputMode="decimal" disabled={locked} value={l.unit_price} onChange={(e) => edit(i, { unit_price: e.target.value })} error={l.unit_price && !isDecimal(l.unit_price) ? "Number" : undefined} className="text-base @3xl:text-right" /></div>
                      <div className="min-w-0 text-right"><span aria-hidden className={cap}>Amount ({currencyMark(cur) || "amount"})</span>
                        <p data-testid={`line-amount-${i + 1}`} className="tnum flex h-11 items-center justify-end font-semibold"><Money value={totals[i]} showCurrency={false} /></p></div>
                      {!locked && <div className="absolute right-3 top-3 @3xl:static @3xl:flex @3xl:justify-end"><IconButton label={`Remove line ${i + 1}`} icon={<Trash2 />} onClick={() => { setTouched(true); setLines((ls) => ls.filter((_, j) => j !== i)); }} /></div>}
                    </div>
                    {was && <p className="tnum text-xs text-fg-muted">On the bill: <span className="text-fg">{was}</span></p>}
                    {stockUi && !locked && <InlineSelect aria-label={`Inventory item, line ${i + 1}`} value={l.item_id ?? ""} onChange={(e) => { const v = e.target.value; if (v === "__new__") { setCreateFor((c) => ({ open: true, i, nonce: c.nonce + 1 })); return; } const n = items.find((x) => x.id === v); if (n) mapLine(i, n); else edit(i, { item_id: null }); }} error={!l.item_id ? "Choose which stock item this is" : undefined}>
                      <option value="">Map to item…</option><option value="__new__">➕ Create new item from this line</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.base_unit})</option>)}
                    </InlineSelect>}
                    {locked && l.item_id && <p className="text-xs text-fg-muted">Stock item: <span className="font-medium text-fg">{it?.name ?? "item"}</span></p>}
                    {excluded && docType === "stock_purchase" && <p className="text-sm text-fg-muted">Not added to stock. Kept on the invoice so the totals still add up.</p>}
                    {(l.vat_code || l.vat_rate != null || l.item_code) && <p className="tnum text-xs text-fg-subtle">{[l.item_code && `Code ${l.item_code}`, l.vat_rate != null ? `${TW()} ${trim(l.vat_rate)}%` : l.vat_code ? `${TW()} code ${l.vat_code}` : null].filter(Boolean).join(" · ")}</p>}
                    {issues[i].soft.length > 0 && !issues[i].block.length && <p className="flex items-start gap-1.5 text-xs font-medium text-warning-fg"><AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />{issues[i].soft.join(". ")}</p>}
                    {per && !locked && (
                      <div role="group" aria-label={`Stock multiplier, line ${i + 1}`} className="tnum flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-info-soft/70 px-3 py-2 text-xs text-info-fg">
                        <span className="flex min-w-0 items-start gap-1.5"><Info aria-hidden className="mt-0.5 size-3.5 shrink-0" /><span>Adds <span className="font-semibold">{trim(per.quantity)} {per.unit}</span> to stock per unit{isDecimal(l.quantity) && Number(l.quantity) !== 1 ? ` (${trim(mulDecimal(l.quantity, per.quantity, 3))} ${per.unit} for ${l.quantity})` : ""}. The printed quantity and price above are unchanged.</span></span>
                        {stockUi && <Button size="sm" variant="secondary" className={TOUCH} onClick={() => applyPerUnit(i)}>Add {trim(mulDecimal(isDecimal(l.quantity) ? l.quantity : "1", per.quantity, 3))} {per.unit} to stock</Button>}
                      </div>
                    )}
                    {!locked && stockUi && l.derived && l.derivedText && (
                      <p className="tnum flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-success-soft px-3 py-2 text-xs text-success-fg">
                        <span aria-label="Derived quantity"><span className="font-semibold">= {l.quantity} {l.unit}</span> ({l.derivedText})</span>
                        {l.pack?.invoiced?.quantity && <button type="button" onClick={() => asInvoiced(i)} className="min-h-8 rounded-md font-semibold max-sm:min-h-11 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">Show as invoiced</button>}
                      </p>
                    )}
                    {!locked && stockUi && l.needs_check && (
                      <div role="alert" className="rounded-xl border border-warning/40 bg-warning-soft/60 p-3 text-xs text-warning-fg">
                        <p className="flex items-start gap-1.5 font-semibold"><AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />Check the quantity. {l.check_reason}</p>
                        {l.pack?.options?.length ? <div className="mt-2 flex flex-wrap gap-2">{l.pack.options.map((o) => (
                          <Button key={o.label} size="sm" className={TOUCH} variant="secondary" onClick={() => setLines((ls) => ls.map((x, j) => (j === i ? (itemOf(x.item_id)?.base_unit === "pcs" && o.count_total ? reprice(x, trim(o.count_total), "pcs", o.label) : reprice(x, trim(o.quantity), o.unit, o.label)) : x)))}>{o.label}</Button>
                        ))}</div> : <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="sm" className={TOUCH} variant="secondary" onClick={() => acceptPrinted(i)}>Use as printed ({trim(l.quantity)} {l.unit})</Button><span className="font-normal">Or change the quantity and unit above, or map the line and say how much is in one pack.</span></div>}
                      </div>
                    )}
                    {sug && !locked && !excluded && <div className="flex flex-wrap items-center gap-2"><SuggestionChip name={sug.item.name} onUse={() => mapLine(i, sug.item)} /><span className="text-xs text-fg-subtle">Looks like an item you already have.</span></div>}
                    {!locked && stockUi && l.undo && <PackConverted before={l.undo} now={l} currency={cur} onUndo={() => packUndo(i)} />}
                    {!locked && stockUi && it && mismatch(l) && <PackHelper key={`${it.id}-${l.unit}`} line={l} item={it} lineTotal={totals[i]} currency={cur} onApply={(n) => packConvert(i, n)} />}
                    {mismatch(l) && it && locked && <p role="alert" className="flex items-center gap-1.5 text-xs font-medium text-danger-fg"><AlertTriangle className="size-3.5" aria-hidden />“{l.unit}” does not convert to {it.name}&apos;s base unit ({it.base_unit}).</p>}
                    {!l.item_id && !locked && stockUi && !sug && !l.needs_check && <p className="text-xs text-fg-subtle">Map this line to an inventory item, or create one from it, so it can be added to stock.</p>}
                    {!locked && docType === "stock_purchase" && (
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <Checkbox label="Don't add to stock (consumable or packaging)" checked={excluded} onChange={(e) => setExcluded(i, e.target.checked)} className="min-h-9 py-0.5 max-sm:min-h-11" />
                        {consumable && <button type="button" onClick={() => setExcluded(i, true)} className="rounded-md text-left text-xs max-sm:min-h-11 font-semibold text-primary-soft-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">Looks like packaging or supplies: leave it out of stock?</button>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>

      {lines.length > 0 && (
        <section aria-label="Bill totals" className="rounded-2xl border border-border bg-surface p-4 shadow-card">
          <dl className="ml-auto w-full max-w-sm space-y-1.5 text-sm">
            <div className="flex items-baseline justify-between gap-3"><dt className="text-fg-muted">Sub total</dt><dd className="tnum font-semibold"><Money value={total} currency={cur} /></dd></div>
            {printedNet != null && cmpMoney(total, printedNet) !== 0 && <p className="tnum text-right text-xs text-fg-subtle">printed: <Money value={printedNet} currency={cur} /></p>}
            {taxLines.length > 0
              ? taxLines.map((t, k) => <div key={k} className="flex items-baseline justify-between gap-3"><dt className="text-fg-muted">{t.label}</dt><dd className="tnum font-medium"><Money value={t.amount} currency={cur} /></dd></div>)
              : p.vat != null && <div className="flex items-baseline justify-between gap-3"><dt className="text-fg-muted">{TW()}</dt><dd className="tnum font-medium"><Money value={p.vat} currency={cur} /></dd></div>}
            {grand != null
              ? <div className="flex items-baseline justify-between gap-3 rounded-xl bg-primary-soft px-3 py-2 text-primary-soft-fg"><dt className="font-semibold">Grand total</dt><dd className="tnum font-display text-lg font-bold"><Money value={grand} currency={cur} /></dd></div>
              : p.total && <div className="flex items-baseline justify-between gap-3 rounded-xl bg-primary-soft px-3 py-2 text-primary-soft-fg"><dt className="font-semibold">Invoice total</dt><dd className="tnum font-display text-lg font-bold"><Money value={p.total} currency={cur} /></dd></div>}
            {grand != null && p.total && cmpMoney(grand, p.total) !== 0 && <p className="tnum text-right text-xs text-fg-subtle">printed: <Money value={p.total} currency={cur} />{touched ? " (changes with your edits; the GST rows stay as printed)" : ""}</p>}
          </dl>
          {p.bill?.amount_in_words && <p className="mt-3 rounded-xl bg-surface-2/70 px-3 py-2 text-sm"><span className="text-fg-subtle">Amount in words: </span><span className="font-medium text-fg">{p.bill.amount_in_words}</span></p>}
        </section>
      )}

      {locked && (
        <Card className="min-w-0 " padded={false}>
          <div className="border-b border-border px-4 py-3 sm:px-5"><h3 className="font-display text-base font-semibold">Stock added by this invoice</h3></div>
          {p.stock_added?.length ? <div className="p-3 sm:p-4"><StockAddedTable rows={p.stock_added} /></div> : <p className="px-5 py-6 text-sm text-fg-muted">No stock movements are linked to this invoice.</p>}
        </Card>
      )}

      {!locked && (
        <div role="region" aria-label="Total and confirm" className="sticky bottom-[calc(var(--tabbar-space)-0.25rem)] z-30 -mx-1 rounded-2xl border border-border bg-surface p-3 shadow-modal lg:bottom-3">
          {foreign && <p role="alert" className="mb-2 flex items-start gap-1.5 text-xs font-medium text-danger-fg"><AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />Not in rupees: needs manual conversion before it can be confirmed.</p>}
          {docType === "stock_purchase" && !ready && !foreign && (
            <p className="mb-2 flex items-start gap-1.5 text-xs text-fg-muted"><AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning-fg" /><span className="line-clamp-2">To confirm: {[!supplier && "choose a supplier", unmapped > 0 && `map or create items for ${unmapped} line${unmapped === 1 ? "" : "s"}`, needsCheck > 0 && `check the quantity of ${needsCheck} line${needsCheck === 1 ? "" : "s"}`, unitProblems > 0 && `convert the pack size of ${unitProblems} line${unitProblems === 1 ? "" : "s"}`].filter(Boolean).join(", ") || "fix the lines marked in red"}.{attention.length > 0 && <> <button type="button" onClick={nextIssue} className="inline-flex min-h-11 items-center font-semibold text-primary-soft-fg underline underline-offset-2">Show me</button></>}</span></p>
          )}
          <div className="flex items-center gap-x-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-fg-subtle">Lines total (net)</p>
              <p className="font-display text-lg font-bold leading-tight sm:text-xl"><Money value={total} currency={cur} /></p>
              {p.total && <p className="tnum text-xs text-fg-subtle max-sm:hidden">Invoice total <Money value={p.total} currency={cur} /></p>}
            </div>
            <Button variant="secondary" loading={busy === "save"} disabled={busy === "confirm"} onClick={() => void onSave()}>Save<span className="sr-only sm:not-sr-only">{" "}draft</span></Button>
            {docType === "stock_purchase"
              ? <Button variant="primary" size="lg" iconStart={<CheckCircle2 />} disabled={!ready || foreign || busy === "save"} loading={busy === "confirm"} onClick={() => void onConfirm()}>Confirm<span className="sr-only sm:not-sr-only">{" "}&amp; add to stock</span></Button>
              : <Button variant="primary" size="lg" iconStart={<ReceiptText />} disabled={foreign} onClick={() => setExpOpen((x) => ({ open: true, nonce: x.nonce + 1 }))}>Record as expense</Button>}
          </div>
        </div>
      )}

      <CreateItemDialog key={`c${createFor.nonce}`} open={createFor.open} onOpenChange={(o) => setCreateFor((c) => ({ ...c, open: o }))} line={lines[createFor.i]} items={items}
        onDone={async (it) => { await reload(); mapLine(createFor.i, it); }} />
      <BulkCreateDialog key={`b${bulk.nonce}`} open={bulk.open} onOpenChange={(o) => setBulk((b) => ({ ...b, open: o }))} lines={lines} items={items}
        onDone={async (mapping, made) => {
          await reload();
          const fresh = await api.inventoryItems().catch(() => items);
          setLines((ls) => ls.map((l, j) => { const id = mapping[j]; const it = id ? fresh.find((x) => x.id === id) : undefined; return it && !l.item_id ? applyMap(l, it) : l; }));
          toast.success(`${Object.keys(mapping).length} line${Object.keys(mapping).length === 1 ? "" : "s"} mapped${made ? `, ${made} new item${made === 1 ? "" : "s"} created` : ""}`);
        }} />
      <ExpenseDialog key={`e${expOpen.nonce}`} open={expOpen.open} onOpenChange={(o: boolean) => setExpOpen((x) => ({ ...x, open: o }))} invoice={p}
        supplierName={suppliers.find((x) => x.id === supplier)?.name || p.supplier_name_raw || ""} supplierId={supplier || null} date={date} number={number}
        net={touched ? total : undefined} vat={taxLines.length ? (taxSum ?? undefined) : undefined} currency={cur} beforeSave={touched ? async () => { await save(); } : undefined}
        onSaved={async () => { await reload(); onBack(); goto("suppliers", "expenses"); }} />
      <SupplierDialog open={supOpen} onOpenChange={setSupOpen} onCreated={async (s) => { await reload(); setSupplier(s.id); }} />
    </div>
  );
}

function SupplierDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (s: Supplier) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reset = useCallback(() => { setName(""); setErr(null); }, []);
  useEffect(() => { if (open) void Promise.resolve().then(reset); }, [open, reset]);
  async function submit() {
    if (!name.trim()) { setErr("Enter the supplier's name"); return; }
    setBusy(true); setErr(null);
    try { const s = await api.createSupplier(name.trim()); await onCreated(s); toast.success(`${s.name} added`); onOpenChange(false); }
    catch (e) { setErr(em(e, "Could not add supplier")); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add supplier"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" type="submit" form="supplier-form" loading={busy}>Add supplier</Button></>}>
      <form id="supplier-form" className="py-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Input label="Supplier name" autoFocus value={name} onChange={(e) => setName(e.target.value)} error={err ?? undefined} />
      </form>
    </Dialog>
  );
}

/* --------------------------------------------------------------------------- stock added */
function StockAddedTable({ rows }: { rows: StockAdded[] }) {
  return (
    <Table caption="Stock added" getKey={(r) => r.item_id} rows={rows} columns={[
      { key: "item", header: "Item", render: (r) => <span className="font-medium">{r.item_name}</span> },
      { key: "added", header: "Added", align: "end", render: (r) => <span className="font-semibold text-success-fg">+{prettyQty(r.quantity, r.unit)}</span> },
      { key: "before", header: "Stock before", align: "end", render: (r) => <span className="text-fg-muted">{prettyQty(r.balance_before, r.unit)}</span> },
      { key: "after", header: "Stock now", align: "end", render: (r) => <span className="font-semibold">{prettyQty(r.balance_after, r.unit)}</span> },
    ]} />
  );
}

/**
 * A confirmed stock bill whose lines are mapped to items but that added nothing: the server found the goods already received on a
 * goods receipt (same supplier and bill number) and did not post them twice. The invoice answer does not say so, the empty list is the signal.
 */
export const addedNoStock = (p: Purchase) => p.status === "confirmed" && p.document_type !== "expense" && (p.stock_added ?? []).length === 0 && p.lines.some((l) => l.item_id && !l.exclude_from_stock);

function SuccessPanel({ p, supplier, onViewStock, onAnother }: { p: Purchase; supplier?: string; onViewStock: () => void; onAnother: () => void }) {
  const rows = p.stock_added ?? [];
  const none = addedNoStock(p);
  const who = `Invoice ${p.invoice_number ?? "without a number"}${supplier ? ` from ${supplier}` : ""}`;
  return (
    <div className="space-y-4">
      <StockFlowStrip step={4} />
      <Card>
        <div className="flex flex-col items-center gap-3 text-center" role="status">
          <div className="w-24"><SuccessCheckIllustration /></div>
          <div>
            <h2 className="font-display text-2xl font-extrabold tracking-tight text-fg">{none ? "Bill saved, no stock added" : "Stock updated"}</h2>
            <p className="mt-1 max-w-prose text-sm text-fg-muted">
              {none
                ? `${who} is saved, but it added nothing to your stock: the same supplier and bill number were already received on a goods receipt, so the goods are not counted twice. See Goods received under Orders & receiving.`
                : `${who} added ${rows.length} item${rows.length === 1 ? "" : "s"} to your stock.`}
            </p>
          </div>
        </div>
        {rows.length > 0 && <div className="mt-5"><StockAddedTable rows={rows} /></div>}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button variant="primary" iconStart={<Boxes />} onClick={onViewStock}>View stock</Button>
          <Button variant="secondary" iconStart={<ScanLine />} onClick={onAnother}>Scan another invoice</Button>
        </div>
      </Card>
    </div>
  );
}
