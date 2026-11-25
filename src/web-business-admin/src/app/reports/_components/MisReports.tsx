"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Card, ErrorState, EmptyState, Section, SegmentedControl } from "@chilli/ui";
import { toCsv } from "@chilli/ui/data";
import { ApiError } from "@/lib/api";
import { useLocale, useMsg } from "@/lib/i18n";
import { currencyMark, formatCompactMoney, formatMoney } from "@/lib/money";
import { cashierMethods, isMissing, methodLabel, misApi, type CsvKind, type Scope } from "@/lib/reportsApi";
import { toast } from "@/components/ui";
import { formatDate, formatMonthYear } from "@/lib/datetime";
import { PdfButton } from "./PdfButton";
import { BlockSkeleton, DataGrid, KpiTile } from "./parts";
import { REPORT_MSG } from "./messages";

/** "31 Oct 2026" for a day, "Oct 2026" for a month (never the raw ISO key). */
const periodLabel = (p: string) => (/^\d{4}-\d{2}-\d{2}$/.test(p) ? formatDate(p) : /^\d{4}-\d{2}$/.test(p) ? formatMonthYear(p) : p);
/** "5%"; a 0% line says whether it is exempt or nil rated (two bare "Exempt" lines were ambiguous). */
const gstRate = (code: string, rate: string) => {
  const n = Number(rate);
  if (n) return `${n}%`;
  return /exempt/i.test(code) ? "Exempt (0%)" : /nil|zero/i.test(code) ? "Nil rated (0%)" : /none|outside|non/i.test(code) ? "Non-GST (0%)" : "0%";
};

type Status = "loading" | "ready" | "error" | "missing";

/** Loads one management report. A 404/405/501 marks it "missing" (the section hides); other failures are "error" with Retry. */
function useMis<T>(load: () => Promise<T>, deps: unknown[], onMissing: (gone: boolean) => void) {
  const [state, setState] = useState<{ status: Status; data?: T; error?: string }>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => {
    let off = false;
    void Promise.resolve().then(async () => {
      setState((s) => (s.data ? s : { status: "loading" }));
      try { const data = await loadRef.current(); if (!off) { setState({ status: "ready", data }); onMissing(false); } }
      catch (e) {
        if (off) return;
        if (isMissing(e)) { setState({ status: "missing" }); onMissing(true); }
        else setState({ status: "error", error: e instanceof ApiError ? e.message : "Failed to load" });
      }
    });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, retry: () => setTick((n) => n + 1) };
}

/** Server CSV when the server has it; otherwise the same table from the data on screen. */
function useCsv(kind: CsvKind, scope: Scope, fallback: () => [string[], (string | number)[][]], t: (k: keyof typeof REPORT_MSG) => string) {
  const [busy, setBusy] = useState(false);
  const name = `${kind}_${scope.from}_${scope.to}.csv`;
  const go = async () => {
    setBusy(true);
    try {
      let blob: Blob;
      try { blob = await misApi.csvBlob(kind, scope); }
      catch (e) {
        if (!isMissing(e)) throw e;
        const [head, rows] = fallback();
        blob = new Blob(["﻿" + toCsv(head, rows)], { type: "text/csv;charset=utf-8" });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(t("csvDone"));
    } catch (e) { toast.error(e instanceof ApiError ? e.message : t("csvFail")); }
    finally { setBusy(false); }
  };
  return { busy, go };
}

function Block({ id, title, hint, status, error, onRetry, empty, csv, controls, children, t, locale }: {
  id: string; title: string; hint: string; status: Status; error?: string; onRetry: () => void; empty: boolean;
  csv?: { busy: boolean; go: () => void }; controls?: ReactNode; children: ReactNode;
  t: (k: keyof typeof REPORT_MSG) => string; locale: "en" | "hi" | "hinglish";
}) {
  if (status === "missing") return null;
  return (
    <Card as="section" data-testid={`mis-${id}`} className="mb-4">
      <Section title={title} description={hint} actions={csv && status === "ready" && !empty ? <Button size="sm" loading={csv.busy} onClick={csv.go}>{t("csv")}</Button> : undefined}>
        {controls ? <div className="mb-3">{controls}</div> : null}
        {status === "loading" ? <BlockSkeleton label={`${title}: ${t("secLoading")}`} />
          : status === "error" ? <ErrorState title={t("secFail")} description={error} onAction={onRetry} actionLabel={t("retry")} locale={locale} />
          : empty ? <EmptyState title={t("secEmpty")} />
          : children}
      </Section>
    </Card>
  );
}

/** Management reports (GST, payments, sales summary, item ranking, outlet comparison) for the page's range and outlet filter. */
export function MisReports({ from, to, outletId, tick, onUnpaid, onVoided, hideVoidedTile }: { from: string; to: string; outletId: string; tick: number; /** Cancelled orders count of the Payments section (compared with Leakage's). */ onVoided?: (n: number | null) => void; /** Do not show the Payments "Cancelled orders" tile (Leakage holds a different number). */ hideVoidedTile?: boolean; /** The Payments section's unpaid figure, so Leakage reads the same number. */ onUnpaid?: (u: { bills: number; balance: string } | null) => void }) {
  const { locale } = useLocale();
  const t = useMsg(REPORT_MSG) as (k: keyof typeof REPORT_MSG) => string;
  const scope: Scope = useMemo(() => ({ from, to, outletId: outletId || undefined }), [from, to, outletId]);
  const [gone, setGone] = useState<Record<string, boolean>>({});
  const flag = (k: string) => (g: boolean) => setGone((o) => (o[k] === g ? o : { ...o, [k]: g }));
  const allGone = ["gst", "pay", "sales", "items", "outlets"].every((k) => gone[k]);

  const [groupBy, setGroupBy] = useState<"day" | "month">("day");
  const [dir, setDir] = useState<"top" | "bottom">("top");
  const [by, setBy] = useState<"revenue" | "quantity">("revenue");

  const gst = useMis(() => misApi.gst(scope), [scope, tick], flag("gst"));
  const pay = useMis(() => misApi.payments(scope), [scope, tick], flag("pay"));
  const unpaidNow = pay.data?.unpaid ?? null;
  useEffect(() => { onUnpaid?.(unpaidNow); }, [onUnpaid, unpaidNow]);
  const voidedNow = pay.data?.voided?.orders ?? null;
  useEffect(() => { onVoided?.(voidedNow); }, [onVoided, voidedNow]);
  const sales = useMis(() => misApi.sales(scope, groupBy), [scope, tick, groupBy], flag("sales"));
  const items = useMis(() => misApi.items(scope, dir, by), [scope, tick, dir, by], flag("items"));
  const outs = useMis(() => misApi.outlets(scope), [scope, tick], flag("outlets"));

  const gstCsv = useCsv("gst_summary", scope, () => [["Rate", "Taxable value", "GST", "Gross"], (gst.data?.by_rate ?? []).map((r) => [`${r.code} ${Number(r.rate_percent)}%`, r.taxable_value, r.tax, r.gross])], t);
  const payCsv = useCsv("payments_by_method", scope, () => [["Method", "Payments", "Amount"], (pay.data?.by_method ?? []).map((m) => [m.method, m.payments, m.amount])], t);
  const cashCsv = useCsv("payments_by_cashier", scope, () => [["Cashier", "Payments", "Collected", "Refunds", "Net"], (pay.data?.by_cashier ?? []).map((c) => [c.name, c.payments, c.total, c.refunds, c.net_collected])], t);
  const salesCsv = useCsv(groupBy === "day" ? "daily_summary" : "monthly_summary", scope, () => [["Period", "Bills", "Gross", "Discounts", "Refunds", "Net"], (sales.data?.periods ?? []).map((p) => [p.period, p.bills, p.gross_total, p.discounts, p.refunds, p.net_total])], t);
  const itemsCsv = useCsv(dir === "top" ? "top_items" : "bottom_items", scope, () => [["Rank", "Item", "Quantity", "Revenue excl GST"], (items.data?.items ?? []).map((i) => [i.rank, i.item, i.quantity, i.revenue_excl_tax])], t);
  const outCsv = useCsv("outlet_comparison", scope, () => [["Rank", "Outlet", "Bills", "Gross", "Refunds", "Net"], (outs.data?.outlets ?? []).map((o) => [o.rank, o.outlet, o.bills, o.gross_total, o.refunds, o.net_total])], t);

  if (allGone) return null;
  const cur = (x?: { currency?: string }) => x?.currency ?? "";
  const m = (v: string) => formatMoney(v);

  return (
    <div data-testid="mis-reports" className="mb-5">
      <h2 className="font-display text-lg font-bold text-fg">{t("mgmt")}</h2>
      <p className="mb-3 text-sm text-fg-muted">{t("mgmtHint")}</p>

      <Block id="gst" title={t("gst")} hint={t("gstHint")} {...gst} onRetry={gst.retry} empty={!!gst.data && gst.data.by_rate.length === 0 && gst.data.totals.bills === 0} csv={gstCsv} t={t} locale={locale}>
        {gst.data && (
          <>
            {/* Taxable value and tax are the top tiles / this table's total row: only the figures shown nowhere else get a tile. */}
            <div className="mb-3 grid grid-cols-2 gap-3">
              <KpiTile locale={locale} label={t("creditNoteTax")} value={formatCompactMoney(gst.data.totals.credit_note_tax, cur(gst.data), locale)} />
              <KpiTile locale={locale} label={t("netTax")} value={formatCompactMoney(gst.data.totals.net_tax, cur(gst.data), locale)} hint={`${gst.data.totals.bills} ${gst.data.totals.bills === 1 ? "bill" : t("bills").toLowerCase()}`} />
            </div>
            <DataGrid caption={t("gst")} getKey={(r) => `${r.code}-${r.rate_percent}`} rows={gst.data.by_rate}
              cols={[
                { header: t("rate"), render: (r) => r.code === "total" ? <strong>Total</strong> : gstRate(r.code, r.rate_percent) },
                { header: t("taxable"), end: true, render: (r) => m(r.taxable_value) },
                { header: t("tax"), end: true, render: (r) => m(r.tax) },
                { header: t("gross"), end: true, render: (r) => m(r.gross) },
              ]}
              total={{ code: "total", rate_percent: "", taxable_value: gst.data.totals.taxable_value, tax: gst.data.totals.tax, cgst: null, sgst: null, igst: null, gross: gst.data.totals.gross }} />
            {!gst.data.split_available && <p className="mt-2 text-xs text-fg-subtle">{t("splitNote")}</p>}
            {gst.data.input_tax && (
              <div className="mt-4" data-testid="gst-input">
                <div className="mb-3 grid grid-cols-2 gap-3">
                  <KpiTile locale={locale} label={t("inputTax")} value={formatCompactMoney(gst.data.input_tax.total, cur(gst.data), locale)} hint={t("inputTaxHint")} />
                  {gst.data.net_payable != null && (
                    <KpiTile locale={locale} label={t("netPayable")} value={formatCompactMoney(gst.data.net_payable, cur(gst.data), locale)}
                      hint={gst.data.net_payable.startsWith("-") ? t("netCredit") : t("netPayableHint")} />
                  )}
                </div>
                <DataGrid caption={t("inputTax")} getKey={(r) => r.key}
                  rows={[{ key: "purchases", label: t("purchases"), tax: gst.data.input_tax.purchases }, { key: "expenses", label: t("expenses"), tax: gst.data.input_tax.expenses }]}
                  total={{ key: "total", label: t("total"), tax: gst.data.input_tax.total }}
                  cols={[
                    { header: t("source"), render: (r) => r.label },
                    { header: t("tax"), end: true, render: (r) => m(r.tax) },
                  ]} />
                {(gst.data.input_tax.invoices_missing_tax ?? 0) > 0 && <p className="mt-2 text-xs text-fg-subtle">{t("missingTax").replace("{n}", String(gst.data.input_tax.invoices_missing_tax))}</p>}
              </div>
            )}
            {(gst.data.warnings ?? []).map((w) => <p key={w} role="note" className="mt-2 text-xs font-medium text-warning-fg">{w}</p>)}
          </>
        )}
      </Block>

      <Block id="payments" title={t("pay")} hint={t("payHint")} {...pay} onRetry={pay.retry} empty={!!pay.data && pay.data.by_method.length === 0 && pay.data.by_cashier.length === 0} csv={payCsv} t={t} locale={locale}>
        {pay.data && (
          <>
            <div className={`mb-3 grid grid-cols-2 gap-3 ${hideVoidedTile ? "lg:grid-cols-4" : "lg:grid-cols-5"}`}>
              <KpiTile locale={locale} label={t("collected")} value={formatCompactMoney(pay.data.totals.collected, cur(pay.data), locale)} />
              <KpiTile locale={locale} label={t("refunds")} value={formatCompactMoney(pay.data.totals.refunds, cur(pay.data), locale)} />
              <KpiTile locale={locale} label={t("netCollected")} value={formatCompactMoney(pay.data.totals.net_collected, cur(pay.data), locale)} />
              {!hideVoidedTile && <KpiTile locale={locale} label={t("voided")} value={formatCompactMoney(pay.data.voided.value, cur(pay.data), locale)} hint={`${pay.data.voided.orders}`} />}
              <KpiTile locale={locale} label={t("unpaid")} value={formatCompactMoney(pay.data.unpaid.balance, cur(pay.data), locale)} hint={`${pay.data.unpaid.bills}`} />
            </div>
            <h3 className="mb-2 mt-4 text-sm font-semibold text-fg">{t("byMethod")}</h3>
            <DataGrid caption={t("byMethod")} getKey={(r) => r.method} rows={pay.data.by_method}
              cols={[
                { header: t("method"), render: (r) => methodLabel(r.method) },
                { header: t("payments"), end: true, render: (r) => r.payments },
                { header: t("amount"), end: true, render: (r) => m(r.amount) },
                { header: t("share"), end: true, render: (r) => (r.share_percent == null ? "-" : `${Number(r.share_percent)}%`) },
              ]} />
            <div className="mb-2 mt-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-fg">{t("byCashier")}</h3>
              {pay.data.by_cashier.length > 0 && <Button size="sm" variant="ghost" loading={cashCsv.busy} onClick={cashCsv.go}>{t("csv")}</Button>}
            </div>
            <DataGrid caption={t("byCashier")} getKey={(r) => r.user_id} rows={pay.data.by_cashier}
              cols={[
                { header: t("cashier"), render: (r) => r.name },
                ...cashierMethods(pay.data).map((k) => ({ header: methodLabel(k), end: true, render: (r: { by_method: Record<string, string> }) => m(r.by_method[k] ?? "0") })),
                { header: t("refunds"), end: true, render: (r) => m(r.refunds) },
                { header: t("netCollected"), end: true, render: (r) => m(r.net_collected) },
              ]} empty={<EmptyState title={t("secEmpty")} />} />
          </>
        )}
      </Block>

      <Block id="sales" title={t("sales")} hint={t("salesHint")} {...sales} onRetry={sales.retry} empty={!!sales.data && sales.data.periods.length === 0} csv={salesCsv} t={t} locale={locale}
        controls={<SegmentedControl legend={t("sales")} name="mis-group" value={groupBy} onValueChange={(v) => setGroupBy(v as "day" | "month")} options={[{ value: "day", label: t("perDay") }, { value: "month", label: t("perMonth") }]} />}>
        {sales.data && (
          <>
            {/* Gross / net / bills / average bill are the tiles at the top of the page: the table carries the per-period figures. */}
            <DataGrid caption={t("sales")} getKey={(r) => r.period} rows={sales.data.periods}
              cols={[
                { header: t("period"), render: (r) => periodLabel(r.period) },
                { header: t("bills"), end: true, render: (r) => r.bills },
                { header: t("gross"), end: true, render: (r) => m(r.gross_total) },
                { header: t("discounts"), end: true, render: (r) => m(r.discounts) },
                { header: t("refunds"), end: true, render: (r) => m(r.refunds) },
                { header: t("net"), end: true, render: (r) => m(r.net_total) },
                { header: t("avgBill"), end: true, render: (r) => m(r.average_bill) },
              ]}
              total={{ period: t("total"), ...sales.data.totals }} />
          </>
        )}
      </Block>

      <Block id="items" title={t("items")} hint={t("itemsHint")} {...items} onRetry={items.retry} empty={!!items.data && items.data.items.length === 0} csv={itemsCsv} t={t} locale={locale}
        controls={
          <div className="flex flex-wrap gap-3">
            <SegmentedControl legend={t("items")} name="mis-dir" value={dir} onValueChange={(v) => setDir(v as "top" | "bottom")} options={[{ value: "top", label: t("top") }, { value: "bottom", label: t("bottom") }]} />
            <SegmentedControl legend={t("byRevenue")} name="mis-by" value={by} onValueChange={(v) => setBy(v as "revenue" | "quantity")} options={[{ value: "revenue", label: t("byRevenue") }, { value: "quantity", label: t("byQty") }]} />
            <PdfButton kind="item_sales" from={from} to={to} label="PDF" />
          </div>}>
        {items.data && (
          <DataGrid caption={t("items")} getKey={(r) => `${r.rank}-${r.item}`} rows={items.data.items}
            cols={[
              { header: t("rank"), render: (r) => r.rank },
              { header: t("item"), render: (r) => r.item },
              { header: t("qty"), end: true, render: (r) => r.quantity },
              { header: t("revenue"), end: true, render: (r) => `${currencyMark(cur(items.data!))}${m(r.revenue_excl_tax)}` },
            ]} />
        )}
      </Block>

      <Block id="outlets" title={t("outlets")} hint={t("outletsHint")} {...outs} onRetry={outs.retry} empty={!!outs.data && outs.data.outlets.length === 0} csv={outCsv} t={t} locale={locale}>
        {outs.data && (
          <DataGrid caption={t("outlets")} getKey={(r) => r.outlet_id} rows={outs.data.outlets}
            cols={[
              { header: t("rank"), render: (r) => r.rank },
              { header: t("outlet"), render: (r) => r.outlet },
              { header: t("bills"), end: true, render: (r) => r.bills },
              { header: t("gross"), end: true, render: (r) => m(r.gross_total) },
              { header: t("refunds"), end: true, render: (r) => m(r.refunds) },
              { header: t("net"), end: true, render: (r) => m(r.net_total) },
              { header: t("avgBill"), end: true, render: (r) => m(r.average_bill) },
              { header: t("discPct"), end: true, render: (r) => (r.discount_percent == null ? "-" : `${Number(r.discount_percent)}%`) },
              { header: t("refundPct"), end: true, render: (r) => (r.refund_percent == null ? "-" : `${Number(r.refund_percent)}%`) },
            ]} />
        )}
      </Block>
    </div>
  );
}
