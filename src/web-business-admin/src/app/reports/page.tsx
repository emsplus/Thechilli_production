"use client";

import { formatDate, formatDayMonth, formatWeekdayDate } from "@/lib/datetime";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ClipboardCheck, Download, Lock, RefreshCw } from "lucide-react";
import { Card, CardHeader, EmptyState, Money, SegmentedControl, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, toast } from "@/components/ui";
import { Button, Notice, OutletSwitcher, PageHeader, Select } from "@chilli/ui";
import { KpiTile } from "./_components/parts";
import { MisReports } from "./_components/MisReports";
import { misApi, type OutletOption } from "@/lib/reportsApi";
import { useLocale } from "@/lib/i18n";
import { EmptyReportIllustration } from "@/components/illustrations";
import { ColumnChart, HorizontalBars, StackedBar, num, type ColumnDatum } from "@/components/charts";
import { CategorySalesCard } from "./_components/CategorySalesCard";
import { CustomersTab, FoodCostTab, PnlTab, StaffTab } from "./_components/InsightTabs";
import { LeakageTab } from "./_components/LeakageTab";
import { PdfButton } from "./_components/PdfButton";
import { api, ApiError, auth } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { addDays, todayIn } from "@/lib/datetime";
import { useTaxPhrases } from "@/lib/taxWords";
import { cmpMoney, formatCompactMoney, formatCurrency } from "@/lib/money";
import type { DailySales, ItemSales, OrderSummary, OrderType, Profitability, PurchaseSummary, ReportMeta, ReportPdfKind } from "@/lib/types";
import { TYPE_NAME } from "@/app/pos/_components/tickets";
import { timezoneLabel } from "@/lib/timezoneLabel";
import { cancelledView } from "@/lib/leakageView";
import { ADD_COSTS_TEXT, costKnown, RECIPES_HREF } from "@/lib/profitView";

type Preset = "today" | "yesterday" | "7d" | "30d" | "month" | "custom";
const PRESETS: { value: Preset; label: string }[] = [
  { value: "today", label: "Today" }, { value: "yesterday", label: "Yesterday" }, { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" }, { value: "month", label: "This month" }, { value: "custom", label: "Custom" },
];
/** Used only if /restaurant cannot be read: the browser's own zone. */
const FALLBACK_TZ = "Asia/Kolkata"; // India only: the restaurant zone until it is known
const ORDER_COLORS: Record<string, string> = { indoor: "var(--viz-1)", outdoor: "var(--viz-2)", takeaway: "var(--viz-3)", delivery: "var(--viz-4)" };

/** Preset ranges are computed in the restaurant's timezone (reports are restaurant-local), not the browser's. */
function rangeFor(p: Exclude<Preset, "custom">, tz: string): [string, string] {
  const t = todayIn(tz);
  switch (p) {
    case "today": return [t, t];
    case "yesterday": { const y = addDays(t, -1); return [y, y]; }
    case "7d": return [addDays(t, -6), t];
    case "30d": return [addDays(t, -29), t];
    case "month": return [`${t.slice(0, 8)}01`, t];
  }
}

/** Every rate line names its rate, so two exempt-looking lines can never read the same (UI_REVIEW BA-16). */
const rateLabel = (code: string, rate: string, none: string, word: string) => {
  const n = Number(rate);
  if (code === "zero") return `Zero rate ${n}%`;
  if (code === "standard") return `Standard ${n}%`;
  if (/exempt|none|nil|outside/i.test(code)) return n ? `${none} ${n}%` : none;
  return `${word} ${n}%`;
};
const shortDay = (iso: string) => formatDayMonth(iso);
const longDay = (iso: string) => formatWeekdayDate(iso);

/**
 * The detail tabs at the end and the PDF each downloads. Daily sales, items, order types and purchases are not tabs any
 * more: each is shown once above (chart / card / management table) with its own PDF and CSV (UI_REVIEW BA-16).
 */
const TAB_PDF: Record<string, ReportPdfKind> = {
  leakage: "leakage", staff: "staff_sales", foodcost: "food_cost", pnl: "profit_and_loss", customers: "customers",
};

interface Bundle { daily: DailySales; items: ItemSales; orders: OrderSummary; purchases: PurchaseSummary; profit: Profitability }

export default function ReportsPage() {
  const router = useRouter();
  const tx = useTaxPhrases(); // GST wording
  const W = tx.word;
  const [preset, setPreset] = useState<Preset>("7d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [tab, setTab] = useState("leakage");
  const [fetching, setFetching] = useState(true);
  const [tick, setTick] = useState(0);
  const [payVoided, setPayVoided] = useState<number | null>(null);
  const [leakVoided, setLeakVoided] = useState<number | null>(null);
  const cancelled = cancelledView(payVoided, leakVoided); // one count, or Leakage's under its own label
  const [payUnpaid, setPayUnpaid] = useState<{ bills: number; balance: string } | null>(null); // Payments section figure, shared with Leakage
  const [tz, setTz] = useState(FALLBACK_TZ);
  const { locale } = useLocale();
  const [outlets, setOutlets] = useState<OutletOption[]>([]);
  const [outletId, setOutletId] = useState("");
  useEffect(() => { let off = false; void misApi.outletOptions().then((o) => { if (!off) { setOutlets(o); } }, () => {}); return () => { off = true; }; }, []);

  useEffect(() => {  // default range computed on the client only; prerender cannot read the clock
    if (!auth.token) { router.replace("/login"); return; }
    let cancelled = false;
    void api.restaurant().then((r) => r.timezone, () => FALLBACK_TZ).then((zone) => {
      if (cancelled) return;
      const [f, t] = rangeFor("7d", zone); setTz(zone); setFrom(f); setTo(t);
      const want = new URLSearchParams(location.search).get("tab"); // deep link from Manage -> Needs attention
      if (want && want in TAB_PDF) setTab(want);
    });
    return () => { cancelled = true; };
  }, [router]);
  const valid = !from || !to || from <= to;

  useEffect(() => {
    if (!from || !to || from > to) return;
    if (!auth.token) { router.replace("/login"); return; }
    let cancelled = false;
    void Promise.resolve().then(async () => {
      setFetching(true); setError(null); setForbidden(false);
      try {
        const [daily, items, orders, purchases, profit] = await Promise.all([
          api.report<DailySales>("daily-sales", from, to), api.report<ItemSales>("item-sales", from, to),
          api.report<OrderSummary>("order-summary", from, to), api.report<PurchaseSummary>("purchases", from, to),
          api.report<Profitability>("profitability", from, to)]);
        if (!cancelled) setData({ daily, items, orders, purchases, profit });
      } catch (e) { if (!cancelled) { setForbidden(e instanceof ApiError && e.status === 403); setError(e instanceof ApiError ? e.message : "Failed to load reports"); } }
      finally { if (!cancelled) setFetching(false); }
    });
    return () => { cancelled = true; };
  }, [from, to, tick, router]);

  function pick(p: Preset) {
    setPreset(p);
    if (p !== "custom") { const [f, t] = rangeFor(p, tz); setFrom(f); setTo(t); }
  }

  const metas: ReportMeta[] = useMemo(() => (data ? [data.daily, data.items, data.orders, data.purchases, data.profit] : []), [data]);
  const incomplete = useMemo(() => [...new Set(metas.filter((m) => !m.data_complete).map((m) => m.incomplete_reason ?? "Some devices have unsynced sales."))], [metas]);
  const notes = useMemo(() => [...new Set(metas.flatMap((m) => m.warnings ?? []))], [metas]);
  const amended = data?.daily.amendments_count ?? 0;

  const days = useMemo(() => {
    if (!data) return [];
    const by = new Map(data.daily.days.map((d) => [d.date, d]));
    const span = from && to ? (new Date(to).getTime() - new Date(from).getTime()) / 86400000 : 0;
    if (!from || !to || span > 92) return data.daily.days;
    const out: DailySales["days"] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(by.get(d) ?? { date: d, bills: 0, subtotal: "0", vat: "0", gross_total: "0", discounts: "0", service_charge: "0", refunds: "0", net_total: "0" });
    return out;
  }, [data, from, to]);

  const cur = data?.daily.currency ?? "";
  const cm = (v: string | number) => formatCompactMoney(v, cur, locale);
  const columns: ColumnDatum[] = days.map((d) => ({
    key: d.date, label: shortDay(d.date), value: num(d.net_total), title: longDay(d.date), valueText: formatCurrency(d.net_total, cur),
    rows: [
      { label: "After refunds", value: <Money value={d.net_total} showCurrency={false} strong /> },
      { label: `Gross (incl. ${W})`, value: <Money value={d.gross_total} showCurrency={false} /> },
      { label: `Net sales (excl. ${W})`, value: <Money value={d.subtotal} showCurrency={false} /> },
      { label: `${W}`, value: <Money value={d.vat} showCurrency={false} /> },
      { label: "Refunds", value: <Money value={d.refunds} showCurrency={false} /> },
      { label: "Bills", value: d.bills },
    ],
  }));

  const vatRows = data?.daily.totals.vat_by_rate ?? [];

  function exportCsv() {
    if (!data) return;
    const t = data.daily.totals;
    const c = data.daily.currency;
    downloadCsv(`daily-sales_${from}_${to}.csv`, [
      ["Date", "Bills", `Net sales (excl. ${W})`, `${W}`, `Gross (incl. ${W})`, "Discounts", "Service charge", "Refunds", "Net after refunds", "Currency"],
      ...data.daily.days.map((d) => [d.date, d.bills, d.subtotal, d.vat, d.gross_total, d.discounts ?? "0.00", d.service_charge ?? "0.00", d.refunds, d.net_total, c]),
      ["Total", t.bills, t.subtotal, t.vat, t.gross_total, t.discounts ?? "0.00", t.service_charge ?? "0.00", t.refunds, t.net_total, c],
      [],
      [`${W} by rate`, "Code", "Rate %", "Net", `${W}`, "Gross", "", "", "", "Currency"],
      ...(t.vat_by_rate ?? []).map((r) => ["", r.code, r.rate_percent, r.net, r.vat, r.gross, "", "", "", c]),
    ]);
    toast.success("Daily sales exported");
  }

  const empty = !!data && data.daily.totals.bills === 0 && data.items.items.length === 0 && data.purchases.suppliers.length === 0;
  const showSkeleton = !data && fetching;

  return (
    <>
      <PageHeader title="Reports" description={data ? `${formatDate(data.daily.from_date ?? from)} to ${formatDate(data.daily.to_date ?? to)} · ${timezoneLabel(data.daily.timezone)} · ${data.daily.currency}` : "Sales, items, purchases and profit"}
        actions={forbidden ? undefined : <>
          <Link href="/end-of-day" className="ch-btn ch-btn--secondary ch-btn--md"><ClipboardCheck aria-hidden />End of day (Z report)</Link>
          <Button variant="secondary" iconStart={<RefreshCw className={fetching ? "animate-spin" : ""} />} onClick={() => setTick((n) => n + 1)} disabled={fetching}>Refresh</Button>
        </>} />

      {forbidden ? (
        <Card className="mx-auto mt-6 max-w-lg">
          <EmptyState icon={<Lock />} title="Ask the owner or manager" hint="Reports are for owners and managers. You can keep taking orders from Chilli Agent."
            action={<Link href="/pos" className="inline-flex h-11 items-center rounded-xl bg-primary bg-primary-gradient px-5 text-sm font-semibold text-primary-fg shadow-[var(--shadow-inset-hi),var(--shadow-glow)]">Back to Chilli Agent</Link>} />
        </Card>
      ) : <>
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="w-full sm:hidden"><Select label="Date range" value={preset} onChange={(e) => pick(e.target.value as Preset)}>{PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select></div>
        <div className="hidden max-w-full overflow-x-auto scrollbar-thin sm:block"><SegmentedControl label="Date range" options={PRESETS} value={preset} onChange={pick} /></div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-medium text-fg-muted">From<input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="mt-1 block h-11 rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg" /></label>
            <label className="text-xs font-medium text-fg-muted">To<input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="mt-1 block h-11 rounded-lg border border-border-strong bg-surface px-3 text-sm text-fg" /></label>
          </div>
        )}
      </div>
      <div className="mb-4 max-w-xs"><OutletSwitcher outlets={outlets.length < 2 ? [] : [{ id: "", name: locale === "hi" ? "सभी आउटलेट" : locale === "hinglish" ? "Sabhi outlets" : "All outlets" }, ...outlets.map((o) => ({ id: o.id, name: o.name }))]} value={outletId} onChange={setOutletId} locale={locale} /></div>
      {!valid && <div className="mb-4"><Notice tone="danger">The start date must not be after the end date.</Notice></div>}

      {error && <div className="mb-4"><Notice tone="danger" title="Could not load reports" action={<Button variant="secondary" size="sm" onClick={() => setTick((n) => n + 1)}>Retry</Button>}>{error}</Notice></div>}

      {incomplete.length > 0 && (
        <div className="mb-4"><Notice tone="warning" title="Incomplete data">
          <span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{incomplete.join(" ")} Figures below may change once every device has synced.</span></span>
        </Notice></div>
      )}

      {amended > 0 && (
        <div className="mb-4"><Notice tone="info" title="Includes corrected bills">
          <span data-testid="amended-footnote">{amended} bill{amended === 1 ? "" : "s"} in this range {amended === 1 ? "was" : "were"} corrected after the sale. These reports show the corrected version on its original sale date, so they can differ from the end-of-day Z reports (which show a correction on the day it was made).</span>
        </Notice></div>
      )}

      {showSkeleton && <ReportSkeleton />}

      {data && empty && (
        <Card><EmptyState illustration={<EmptyReportIllustration />} title="No sales in this range" hint="Try a wider range, or finalise and pay a bill in Chilli Agent to see numbers here." /></Card>
      )}

      {data && empty && <div className="mt-5"><MisReports from={from} to={to} outletId={outletId} tick={tick} onUnpaid={setPayUnpaid} onVoided={setPayVoided} hideVoidedTile={cancelled.hidePaymentsTile} /></div>}

      {data && !empty && (
        <div className={fetching ? "opacity-70 transition-opacity" : "transition-opacity"} aria-busy={fetching}>
          <div className="mb-5 grid grid-cols-2 gap-3 max-sm:[&_.font-display]:text-2xl lg:grid-cols-3 sm:gap-4">
            <KpiTile locale={locale} label={`Gross sales (incl. ${W})`} value={cm(data.daily.totals.gross_total)}
              hint="Before refunds" />
            <KpiTile locale={locale} label={`Net sales (excl. ${W})`} value={cm(data.daily.totals.subtotal)} hint={`Gross minus ${W}`} />
            {(vatRows.length > 0 || cmpMoney(data.daily.totals.vat, 0) !== 0) && <div data-testid="vat-by-rate">
              <KpiTile locale={locale} label={`${W} collected`} value={cm(data.daily.totals.vat)} className="h-full"
                hint={vatRows.length > 0 ? (
                  <ul className="w-full space-y-0.5" aria-label={`${W} by rate`}>
                    {vatRows.map((r) => (
                      <li key={`${r.code}-${r.rate_percent}`} className="flex justify-between gap-2"><span>{rateLabel(r.code, r.rate_percent, tx.none, W)}</span>
                        <span className="tnum font-medium text-fg-muted">{cmpMoney(r.vat, 0) > 0 || r.code !== "zero" ? formatCurrency(r.vat, cur) : `no ${W} on ${formatCurrency(r.net, cur)}`}</span></li>
                    ))}
                  </ul>) : undefined} />
            </div>}
            <KpiTile locale={locale} label="Discounts given" value={cm(data.daily.totals.discounts ?? "0")} hint={`Taken off before ${W}`} />
            <KpiTile locale={locale} label="Service charge" value={cm(data.daily.totals.service_charge ?? "0")} hint={`Eat-in orders, ${W} included`} />
            <KpiTile locale={locale} label="Net after refunds" value={cm(data.daily.totals.net_total)} hint={`Gross less refunds of ${formatCurrency(data.daily.totals.refunds, cur)}`} />
            <KpiTile locale={locale} label="Bills" value={String(data.daily.totals.bills)} />
            <KpiTile locale={locale} label="Average bill" value={cm(data.orders.average_bill_value)} />
            {costKnown(data.profit)
              ? <KpiTile locale={locale} label="Gross profit" value={cm(data.profit.gross_profit)} hint={data.profit.gross_margin_percent ? `${data.profit.gross_margin_percent}% margin` : "Margin not available"} />
              : <div data-testid="gross-profit-unknown" className="contents"><KpiTile locale={locale} label="Gross profit" value="-" hint={<Link href={RECIPES_HREF} className="font-semibold text-primary underline underline-offset-2">{ADD_COSTS_TEXT}</Link>} /></div>}
          </div>

          <div className="mb-5 grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader title="Daily sales after refunds" description={`What customers paid, ${W} included, minus refunds. Hover or focus a column for details.`}
                action={<div className="flex flex-wrap justify-end gap-2"><PdfButton kind="sales_summary" from={from} to={to} label="PDF" /><Button variant="secondary" size="sm" iconStart={<Download />} onClick={exportCsv} disabled={!data.daily.days.length}>Download CSV</Button></div>} />
              <ColumnChart data={columns} ariaLabel={`Daily sales after refunds, ${formatDate(from)} to ${formatDate(to)}`} seriesName={`Sales after refunds (${cur})`} />
            </Card>
            <Card>
              <CardHeader title="Order types" description={`${data.orders.billed_orders} billed orders`} />
              {data.orders.billed_by_order_type.length === 0 ? <p className="text-sm text-fg-muted">No billed orders.</p> : (
                <StackedBar ariaLabel="Billed total by order type" data={data.orders.billed_by_order_type.map((o, i) => ({
                  key: o.order_type, label: TYPE_NAME[o.order_type as OrderType] ?? o.order_type, value: num(o.total), color: ORDER_COLORS[o.order_type] ?? `var(--viz-${(i % 4) + 1})`,
                  valueText: <Money value={o.total} showCurrency={false} />, sub: `${o.bills} ${o.bills === 1 ? "bill" : "bills"}` }))} />
              )}
            </Card>
          </div>

          <div className="mb-5 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Purchases by supplier" description={<>Confirmed invoices · total <Money value={data.purchases.total} strong /></>} action={<PdfButton kind="purchases" from={from} to={to} label="PDF" />} />
              {data.purchases.suppliers.length === 0 ? <p className="text-sm text-fg-muted">No confirmed purchases in this range.</p> : (
                <HorizontalBars ariaLabel="Purchases by supplier" data={[...data.purchases.suppliers].sort((a, b) => cmpMoney(b.total, a.total)).map((s) => ({ key: s.supplier, label: s.supplier, value: num(s.total), sub: `${s.invoices} invoice${s.invoices === 1 ? "" : "s"}`, valueText: <Money value={s.total} showCurrency={false} /> }))} />
              )}
            </Card>
            <Card>
              <CardHeader title="Profitability" description="Revenue minus ingredient cost" />
              <dl className="space-y-2.5 text-sm">
                <div className="flex justify-between"><dt className="text-fg-muted">Revenue ({tx.excl})</dt><dd><Money value={data.profit.revenue_excl_vat} /></dd></div>
                <div className="flex justify-between"><dt className="text-fg-muted">Ingredient cost</dt><dd><Money value={data.profit.ingredient_cost} /></dd></div>
                {costKnown(data.profit) ? (<>
                  <div className="flex items-baseline justify-between border-t border-border pt-2.5"><dt className="font-semibold text-fg">Gross profit</dt><dd className="font-display text-xl font-bold"><Money value={data.profit.gross_profit} tone="auto" /></dd></div>
                  <div className="flex justify-between"><dt className="text-fg-muted">Margin</dt><dd className="tnum font-semibold">{data.profit.gross_margin_percent ? `${data.profit.gross_margin_percent}%` : "-"}</dd></div>
                </>) : (
                  <div className="flex items-baseline justify-between border-t border-border pt-2.5" data-testid="profit-card-unknown"><dt className="font-semibold text-fg">Gross profit</dt><dd className="text-right text-sm"><Link href={RECIPES_HREF} className="font-semibold text-primary underline underline-offset-2">{ADD_COSTS_TEXT}</Link></dd></div>
                )}
              </dl>
              <p className="mt-3 text-xs text-fg-subtle">Cost method: {data.profit.cost_method}.</p>
              <div className="mt-3 space-y-2">
                {data.profit.items_without_recipe.length > 0 && <Notice tone="warning" title="Items without a recipe">{data.profit.items_without_recipe.join(", ")}. Their cost is not counted, so profit looks higher than it is.</Notice>}
                {data.profit.ingredients_without_cost.length > 0 && <Notice tone="warning" title="Ingredients without a cost">{data.profit.ingredients_without_cost.join(", ")}. Confirm a purchase invoice for them to get a cost.</Notice>}
                {notes.map((n) => <Notice key={n} tone="warning">{n}</Notice>)}
              </div>
            </Card>
          </div>

          <MisReports from={from} to={to} outletId={outletId} tick={tick} onUnpaid={setPayUnpaid} onVoided={setPayVoided} hideVoidedTile={cancelled.hidePaymentsTile} />

          <CategorySalesCard from={from} to={to} tick={tick} />

          <Card padded={false}>
            <Tabs value={tab} onValueChange={setTab}>
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-2 sm:px-5">
                <TabsList className="border-b-0">
                  <TabsTrigger value="leakage">Leakage</TabsTrigger>
                  <TabsTrigger value="staff">Staff</TabsTrigger>
                  <TabsTrigger value="foodcost">Food cost</TabsTrigger>
                  <TabsTrigger value="pnl">Profit &amp; loss</TabsTrigger>
                  <TabsTrigger value="customers">Customers</TabsTrigger>
                </TabsList>
                <div className="flex flex-wrap items-center gap-2">
                  <PdfButton kind={TAB_PDF[tab]} from={from} to={to} />
                </div>
              </div>
              <div className="px-4 pb-4 sm:px-5">
                <TabsContent value="leakage"><LeakageTab from={from} to={to} tick={tick} paymentsUnpaid={payUnpaid} onVoids={setLeakVoided} cancelledLabel={cancelled.leakageLabel} /></TabsContent>
                <TabsContent value="staff"><StaffTab from={from} to={to} tick={tick} /></TabsContent>
                <TabsContent value="foodcost"><FoodCostTab from={from} to={to} tick={tick} /></TabsContent>
                <TabsContent value="pnl"><PnlTab from={from} to={to} tick={tick} /></TabsContent>
                <TabsContent value="customers"><CustomersTab from={from} to={to} tick={tick} /></TabsContent>
              </div>
            </Tabs>
          </Card>
        </div>
      )}
      </>}
    </>
  );
}

function ReportSkeleton() {
  return (
    <div role="status" aria-label="Loading reports">
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3 sm:gap-4">{Array.from({ length: 6 }, (_, i) => <KpiTile key={i} label="…" value="0" loading />)}</div>
      <div className="mb-5 grid gap-4 xl:grid-cols-3"><Skeleton className="h-72 rounded-xl xl:col-span-2" /><Skeleton className="h-72 rounded-xl" /></div>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-64 rounded-xl" /><Skeleton className="h-64 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div>
    </div>
  );
}
