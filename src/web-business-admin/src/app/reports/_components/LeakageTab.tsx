"use client";

import { formatDateTime, formatDayMonth } from "@/lib/datetime";
import { Notice } from "@chilli/ui";
import { useEffect, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2} from "lucide-react";
import { Card, CardHeader, Money } from "@/components/ui";
import { DataGrid, KpiTile } from "./parts";
import { api } from "@/lib/api";
import { formatMoney, formatCompactMoney, formatCurrency } from "@/lib/money";
import type { FlagSeverity, LeakageReport } from "@/lib/types";
import { InsightShell, ReportNotices } from "./ReportNotices";
import { flagSeverity, flagTitle, hasUnpaidFlag, unpaidSummary, type UnpaidFigure } from "@/lib/leakageView";
import { gapLines } from "@/lib/takings";
import { useInsight } from "./useInsight";

const SEVERITY: Record<FlagSeverity, { tone: "danger" | "warning" | "info"; label: string }> = {
  high: { tone: "danger", label: "High" }, medium: { tone: "warning", label: "Medium" }, low: { tone: "info", label: "Low" },
};
export const pct = (v: string | null | undefined) => (v == null || v === "" ? "-" : `${Number(v)}%`);
const dash = (v: string | null | undefined) => v || "-";
const when = (iso: string) => formatDateTime(iso);
const day = (iso: string) => formatDayMonth(iso.slice(0, 10));

/** A titled table that says so when there is nothing to list (an empty section is good news here, not an error). */
function Block({ title, description, empty, hasRows, children, testId }: { title: string; description?: ReactNode; empty: string; hasRows: boolean; children: ReactNode; testId?: string }) {
  return (
    <Card data-testid={testId}>
      <CardHeader title={title} description={description} />
      {hasRows ? children : <p className="text-sm text-fg-muted">{empty}</p>}
    </Card>
  );
}

/** Leakage: where money may be going missing (discounts, voids, refunds, unpaid bills, stock losses) with colour-coded flags. */
export function LeakageTab({ from, to, tick, paymentsUnpaid, onVoids, cancelledLabel = "Cancelled orders" }: { from: string; to: string; tick: number; paymentsUnpaid?: UnpaidFigure | null; onVoids?: (n: number | null) => void; cancelledLabel?: string }) {
  const { data: d, error, loading, stale } = useInsight(api.leakage, from, to, tick);
  const cur = d?.currency ?? "";
  return (
    <InsightShell loading={loading} error={error} stale={stale}>
      {d && <Body d={d} cur={cur} paymentsUnpaid={paymentsUnpaid} onVoids={onVoids} cancelledLabel={cancelledLabel} />}
    </InsightShell>
  );
}

function Body({ d, cur, paymentsUnpaid, onVoids, cancelledLabel }: { d: LeakageReport; cur: string; paymentsUnpaid?: UnpaidFigure | null; onVoids?: (n: number | null) => void; cancelledLabel: string }) {
  const voids = d.voids.count;
  useEffect(() => { onVoids?.(voids); return () => onVoids?.(null); }, [onVoids, voids]);
  const m = (v: string) => <Money value={v} currency={cur} />;
  const gap = d.payments_vs_takings.causes;
  const flags = d.flags.map((f) => ({ ...f, severity: flagSeverity(f, gap) })).sort((a, b) => "high medium low".indexOf(a.severity) - "high medium low".indexOf(b.severity));
  const stockUsage = d.stock.usage_gap;
  const unpaid = unpaidSummary(d.unpaid_bills, paymentsUnpaid); // one figure for Leakage and Payments
  return (
    <div className="space-y-4" data-testid="leakage-report">
      <ReportNotices meta={d} />

      <div className="space-y-2" data-testid="leakage-flags">
        {flags.length === 0 && !unpaid.any
          ? <Notice tone="success" title="No red flags in this period"><span className="flex items-center gap-2"><CheckCircle2 aria-hidden className="size-4 shrink-0" />Discounts, cancellations, refunds and unpaid bills look normal.</span></Notice>
          : <>
            {flags.map((f) => <Notice key={f.code + f.message} tone={SEVERITY[f.severity].tone} title={flagTitle(f.severity)}>{f.message}</Notice>)}
            {unpaid.any && !hasUnpaidFlag(flags) && (
              <Notice tone="info" title="For your information"><span data-testid="leak-awaiting-row">{unpaid.count} {unpaid.count === 1 ? "bill is" : "bills are"} awaiting payment ({formatMoney(unpaid.balance)}). They are not lost: take payment from Orders.</span></Notice>
            )}
          </>}
      </div>

      <div className="grid grid-cols-2 gap-3 max-sm:[&_.font-display]:text-2xl lg:grid-cols-5 sm:gap-4">
        <KpiTile label="Discounts" value={formatCompactMoney(d.discounts.total, cur)} hint={`${d.discounts.count} given · ${pct(d.discounts.percent_of_sales)} of sales`} />
        <KpiTile label={cancelledLabel} value={formatCompactMoney(d.voids.value, cur)} hint={`${d.voids.count} orders · ${d.voids.after_kitchen.count} after the kitchen ticket`} />
        <KpiTile label="Refunds" value={formatCompactMoney(d.refunds.value, cur)} hint={`${d.refunds.count} refunds · ${pct(d.refunds.percent_of_sales)} of sales`} />
        <KpiTile label="Unpaid bills" value={formatCompactMoney(unpaid.balance, cur)} hint={`${unpaid.count} open`} />
        <KpiTile label="Stock losses" value={formatCompactMoney(d.stock.total_loss_value, cur)} hint="Wastage, adjustments, count gaps" className="col-span-2 lg:col-span-1" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="Discounts by staff" description={`Sales before discount ${formatMoney(d.discounts.sales_before_discount)}`} empty="No discounts in this period." hasRows={d.discounts.by_staff.length > 0} testId="leak-discounts-staff">
          <DataGrid caption="Table" getKey={(r) => r.name} rows={d.discounts.by_staff}
 cols={[
  { header: "Staff", render: (r) => r.name },
  { header: "Count", end: true, render: (r) => r.count },
  { header: "Given", end: true, render: (r) => formatMoney(r.amount) },
  { header: "Their sales", end: true, render: (r) => r.sales ? formatMoney(r.sales) : "-" },
  { header: "% of sales", end: true, render: (r) => pct(r.percent_of_sales) },
 ]} />
        </Block>
        <Block title="Discounts by reason" empty="No discounts in this period." hasRows={d.discounts.by_reason.length > 0}>
          <DataGrid caption="Table" getKey={(r) => r.name} rows={d.discounts.by_reason}
 cols={[
  { header: "Reason", render: (r) => r.name },
  { header: "Count", end: true, render: (r) => r.count },
  { header: "Given", end: true, render: (r) => formatMoney(r.amount) },
 ]} />
        </Block>
        <Block title="Biggest discounts" empty="No discounts in this period." hasRows={d.discounts.biggest.length > 0}>
          <DataGrid caption="Table" getKey={(r) => r.invoice} rows={d.discounts.biggest}
 cols={[
  { header: "Invoice", render: (r) => r.invoice },
  { header: "Date", render: (r) => day(r.sale_date) },
  { header: "Staff", render: (r) => dash(r.staff) },
  { header: "Reason", render: (r) => dash(r.reason) },
  { header: "%", end: true, render: (r) => pct(r.percent) },
  { header: "Amount", end: true, render: (r) => formatMoney(r.amount) },
 ]} />
        </Block>
        <Block title="Cancelled orders by staff" description={`Before the kitchen ticket: ${d.voids.before_kitchen.count} (${formatMoney(d.voids.before_kitchen.value)})`} empty="No cancelled orders in this period." hasRows={d.voids.by_staff.length > 0} testId="leak-voids-staff">
          <DataGrid caption="Table" getKey={(r) => r.name} rows={d.voids.by_staff}
 cols={[
  { header: "Staff", render: (r) => r.name },
  { header: "Cancelled", end: true, render: (r) => r.count },
  { header: "Value", end: true, render: (r) => formatMoney(r.amount) },
  { header: "After kitchen", end: true, render: (r) => r.after_kitchen_count },
  { header: "After-kitchen value", end: true, render: (r) => formatMoney(r.after_kitchen_amount) },
 ]} />
        </Block>
        <Block title="Cancelled after the kitchen ticket" description="Food may already have been cooked" empty="No orders were cancelled after going to the kitchen." hasRows={d.voids.after_kitchen.orders.length > 0} testId="leak-after-kitchen">
          <DataGrid caption="Table" getKey={(r) => r.order_ref + r.cancelled_at} rows={d.voids.after_kitchen.orders}
 cols={[
  { header: "Order", render: (r) => r.order_ref },
  { header: "When", render: (r) => when(r.cancelled_at) },
  { header: "Staff", render: (r) => dash(r.staff) },
  { header: "Reason", render: (r) => dash(r.reason) },
  { header: "Amount", end: true, render: (r) => formatMoney(r.amount) },
 ]} />
        </Block>
        <Block title="Cancelled orders by reason" empty="No cancelled orders in this period." hasRows={d.voids.by_reason.length > 0}>
          <DataGrid caption="Table" getKey={(r) => r.name} rows={d.voids.by_reason}
 cols={[
  { header: "Reason", render: (r) => r.name },
  { header: "Count", end: true, render: (r) => r.count },
  { header: "Value", end: true, render: (r) => formatMoney(r.amount) },
 ]} />
        </Block>
        <Block title="Refunds by staff" empty="No refunds in this period." hasRows={d.refunds.by_staff.length > 0} testId="leak-refunds-staff">
          <DataGrid caption="Table" getKey={(r) => r.name} rows={d.refunds.by_staff}
 cols={[
  { header: "Staff", render: (r) => r.name },
  { header: "Count", end: true, render: (r) => r.count },
  { header: "Refunded", end: true, render: (r) => formatMoney(r.amount) },
 ]} />
        </Block>
        <Block title="Biggest refunds" empty="No refunds in this period." hasRows={d.refunds.biggest.length > 0}>
          <DataGrid caption="Table" getKey={(r) => `${r.invoice}-${r.credit_note ?? r.amount}`} rows={d.refunds.biggest}
 cols={[
  { header: "Invoice", render: (r) => r.invoice },
  { header: "Staff", render: (r) => dash(r.staff) },
  { header: "Reason", render: (r) => dash(r.reason) },
  { header: "Amount", end: true, render: (r) => formatMoney(r.amount) },
 ]} />
        </Block>
      </div>

      <Block title="Unpaid bills" description={unpaid.any ? <>{unpaid.count} open · balance {m(unpaid.balance)}{d.unpaid_bills.bills.length > 0 && d.unpaid_bills.min_age_days > 0 ? <> · older than {d.unpaid_bills.min_age_days} {d.unpaid_bills.min_age_days === 1 ? "day" : "days"}</> : null}</> : undefined}
        empty={unpaid.any ? `${unpaid.count} ${unpaid.count === 1 ? "bill is" : "bills are"} awaiting payment (${formatMoney(unpaid.balance)}). ${d.unpaid_bills.min_age_days > 0 ? `None is older than ${d.unpaid_bills.min_age_days} ${d.unpaid_bills.min_age_days === 1 ? "day" : "days"} yet, so none is listed here. ` : ""}See Payments above.` : "No bills are waiting for payment."} hasRows={d.unpaid_bills.bills.length > 0} testId="leak-unpaid">
        <DataGrid caption="Table" getKey={(b) => b.invoice} rows={d.unpaid_bills.bills}
 cols={[
  { header: "Invoice", render: (b) => <>{b.invoice}{b.part_paid && <span className="ml-2 text-xs text-fg-subtle">part paid</span>}</> },
  { header: "Customer", render: (b) => dash(b.customer) },
  { header: "Age", end: true, render: (b) => <>{b.age_days} {b.age_days === 1 ? "day" : "days"}</> },
  { header: "Total", end: true, render: (b) => formatMoney(b.total) },
  { header: "Balance", end: true, render: (b) => formatMoney(b.balance) },
 ]} />
      </Block>

      <Card data-testid="leak-stock">
        <CardHeader title="Stock losses" description={<>Wastage, adjustments and count gaps · total {m(d.stock.total_loss_value)}</>} />
        {d.stock.items.length === 0 && d.stock.by_type.length === 0 ? <p className="text-sm text-fg-muted">No stock losses recorded in this period.</p> : (
          <div className="grid gap-4 lg:grid-cols-2">
            <DataGrid caption="Table" getKey={(r) => r.type} rows={d.stock.by_type}
 cols={[
  { header: "Type", render: (r) => r.type.replace(/_/g, " ") },
  { header: "Movements", end: true, render: (r) => r.movements },
  { header: "Value", end: true, render: (r) => formatMoney(r.value) },
 ]} />
            <DataGrid caption="Table" getKey={(r) => r.item} rows={d.stock.items}
 cols={[
  { header: "Item", render: (r) => r.item },
  { header: "Quantity", end: true, render: (r) => <>{Number(r.quantity)} {r.unit}</> },
  { header: "Value", end: true, render: (r) => formatMoney(r.value) },
 ]} />
          </div>
        )}
        <div className="mt-4" data-testid="usage-gap">
          {stockUsage.available ? (
            <p className="text-sm text-fg-muted">Stock counts in this period: {stockUsage.stock_counts ?? 0}. Expected usage from recipes {formatMoney(stockUsage.theoretical_usage_value ?? "0")}; count differences {formatMoney(stockUsage.count_variance_value ?? "0")}.{stockUsage.note ? ` ${stockUsage.note}` : ""}</p>
          ) : (
            <Notice tone="info" title="Usage gap not available"><span className="flex items-start gap-2"><AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" /><span>{stockUsage.note ?? "Needs a stock count inside this period to compare what recipes say was used with what is really gone."}</span></span></Notice>
          )}
        </div>
      </Card>

      {d.payments_vs_takings.note && (() => {
        const p = d.payments_vs_takings; const lines = gapLines(gap, cur);
        if (!lines || p.billed_total === undefined) return <p className="text-xs text-fg-subtle" data-testid="payments-vs-takings">Payments {formatMoney(p.payments)} vs takings {formatMoney(p.takings)} (difference {formatMoney(p.difference)}). {p.note}</p>;
        return (
          <div className="text-xs text-fg-subtle" data-testid="payments-vs-takings">
            <p>Billed {formatCurrency(p.billed_total, cur)}, payments received {formatCurrency(p.payments, cur)}, total takings (money received, after refunds) {formatCurrency(p.total_takings ?? p.payments, cur)}. Payments differ from the amount billed by {formatCurrency(p.difference, cur)}.</p>
            {lines.causes.length > 0 && <ul className="mt-0.5 space-y-0.5">{lines.causes.map((c) => <li key={c.code} data-cause={c.code}>{c.text}</li>)}</ul>}
            {lines.unexplained && <p className="mt-0.5 font-semibold text-danger-fg">{lines.unexplained}</p>}
          </div>
        );
      })()}
    </div>
  );
}
