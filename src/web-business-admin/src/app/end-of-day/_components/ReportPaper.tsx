import type { ReactNode } from "react";
import { formatDateTime } from "@/lib/datetime";
import { taxPhrases } from "@/lib/taxWords";
import { cn } from "@/lib/cn";
import { cmpMoney, formatMoney } from "@/lib/money";
import type { ZReportData } from "@/lib/types";
import { gapLines, hasTakingsSplit } from "@/lib/takings";

/** "05 Oct 2026, 10:49 PM" in the restaurant's own time zone, whatever the browser's zone (lib/datetime). */
export function formatLocal(iso: string, timeZone: string): string {
  return formatDateTime(iso, timeZone);
}

const methodLabel = (m: string) => (m === "cash" ? "CASH" : m === "card" ? "CARD" : m.toUpperCase());
const orderTypeLabel = (t: string) => ({ indoor: "Table", outdoor: "Table", takeaway: "Take away", delivery: "Online" }[t] ?? t);

function Rule({ strong }: { strong?: boolean }) {
  return <hr className={cn("my-3 border-0 border-t border-dashed", strong ? "border-fg-muted" : "border-border-strong")} />;
}
function Heading({ children }: { children: ReactNode }) {
  return <h3 className="my-2 text-center text-[0.8rem] font-bold uppercase tracking-[0.12em] text-fg">{children}</h3>;
}
/** Label on the left, value on the right (tabular, never wraps the value). */
function Line({ label, value, sub, strong, tone, indent }: { label: ReactNode; value?: ReactNode; sub?: ReactNode; strong?: boolean; tone?: "danger"; indent?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-px", strong && "font-bold", tone === "danger" && "text-danger-fg", indent && "pl-4 text-fg-muted")}>
      <span className="min-w-0 break-words">{label}{sub && <span className="ml-2 text-fg-subtle">{sub}</span>}</span>
      {value !== undefined && <span className="tnum shrink-0 whitespace-nowrap">{value}</span>}
    </div>
  );
}

/**
 * The thermal Z / X slip as a screen "paper": same sections and wording as the 80 mm printout, in monospace with
 * tabular figures. Pure rendering of the report object (X or stored Z); every number comes from the API.
 */
export function ReportPaper({ report: r, className }: { report: ZReportData; className?: string }) {
  const cur = r.restaurant.currency_symbol?.trim() || r.restaurant.currency;
  const m = (v: string | number) => formatMoney(v);
  const T = taxPhrases(r.restaurant.country).word.toUpperCase(); // GST
  const d = r.deductions;
  const tz = r.period.timezone || r.restaurant.timezone;
  const nonZero = (v: string) => cmpMoney(v, 0) !== 0;
  const showDisc = r.channels.some((c) => c.categories.some((x) => nonZero(x.disc)));
  const title = r.kind === "Z" ? "Z-REPORT" : "X-REPORT";

  return (
    <article data-testid="report-paper" aria-label={`${title}${r.number_label ? ` ${r.number_label}` : ""}`}
      className={cn("mx-auto w-full max-w-[34rem] rounded-sm border border-border bg-surface px-4 py-6 font-mono text-[0.8rem] leading-[1.45] text-fg shadow-card sm:px-7", className)}>
      <header className="text-center">
        <p className="font-display text-lg font-extrabold uppercase tracking-wide">{r.restaurant.name}</p>
        {r.restaurant.address && <p className="whitespace-pre-line text-fg-muted">{r.restaurant.address}</p>}
        {r.restaurant.phone && <p className="text-fg-muted">TEL: {r.restaurant.phone}</p>}
        {r.restaurant.vat_registered && r.restaurant.tax_number && <p className="text-fg-muted">{r.restaurant.tax_number_label}: {r.restaurant.tax_number}</p>}
        <p className="mt-3 text-base font-bold tracking-[0.18em]">{title}</p>
        {r.kind === "X" && <p className="text-fg-subtle">Reading only, the day is not closed</p>}
      </header>
      <Rule />
      <div className="space-y-px">
        {r.number_label && <Line label="REPORT NO" value={r.number_label} strong />}
        <Line label="TILL" value={r.till} />
        {r.closed_by && <Line label="CLOSED BY" value={r.closed_by.name} />}
        <Line label="FROM" value={formatLocal(r.period.from, tz)} />
        <Line label="TO" value={formatLocal(r.period.to, tz)} />
        <Line label="CURRENCY" value={`${r.restaurant.currency} (${cur})`} />
      </div>

      <Rule strong />
      <Heading>Sales summary by category</Heading>
      {r.channels.map((c) => (
        <section key={c.key} aria-label={`${c.heading}`} className="mb-3">
          <p className="mb-1 bg-surface-2 px-2 py-1 text-center text-[0.72rem] font-bold uppercase tracking-[0.1em]">{c.heading}</p>
          <p className="mb-1 text-center font-bold">{c.label} ({c.orders} {c.orders === 1 ? "ORDER" : "ORDERS"})</p>
          {c.categories.length === 0 ? <p className="py-1 text-center text-fg-subtle">No sales</p> : (
            <table className="w-full table-fixed border-collapse">
              <colgroup><col />{<col className="w-12" />}{showDisc && <col className="w-16" />}<col className="w-24" /></colgroup>
              <thead>
                <tr className="border-b border-border-strong text-[0.7rem] uppercase text-fg-muted">
                  <th className="py-1 text-left font-semibold">Department</th><th className="py-1 text-right font-semibold">Items</th>
                  {showDisc && <th className="py-1 text-right font-semibold">Disc</th>}<th className="py-1 text-right font-semibold">Sales</th>
                </tr>
              </thead>
              <tbody>
                {c.categories.map((x) => (
                  <tr key={x.category}>
                    <td className="py-px pr-2 uppercase">{x.category}</td><td className="tnum py-px text-right">{x.items}</td>
                    {showDisc && <td className="tnum py-px text-right">{m(x.disc)}</td>}<td className="tnum py-px pl-3 text-right">{m(x.sales)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border-strong font-bold">
                  <td className="pt-1">SUB TOTAL</td><td className="tnum pt-1 text-right">{c.sub_total.items}</td>
                  {showDisc && <td className="tnum pt-1 text-right">{m(c.sub_total.disc)}</td>}<td className="tnum pt-1 pl-3 text-right">{m(c.sub_total.sales)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </section>
      ))}
      <Line label="ALL CHANNELS" sub={`${r.grand_total.orders} orders, ${r.grand_total.items} items`} value={m(r.grand_total.sales)} strong />

      <Rule strong />
      <Heading>Total deductions</Heading>
      <Line label="ITEM DISCOUNT" value={m(d.item_discount)} />
      <Line label="BILL DISCOUNTS -" sub={d.bill_discounts.count ? `${d.bill_discounts.count}` : undefined} value={m(d.bill_discounts.amount)} />
      {d.bill_discounts.by_reason.map((x) => <Line key={x.reason} indent label={x.reason} sub={`x${x.count}`} value={m(x.amount)} />)}
      <Line label="GROSS RETURNS -" sub={d.gross_returns.count ? `${d.gross_returns.count}` : undefined} value={m(d.gross_returns.amount)} />
      {d.gross_returns.items.map((x) => <Line key={x.credit_note} indent label={`${x.credit_note} (${x.invoice})`} sub={x.reason} value={m(x.amount)} />)}
      {d.amendment_reversals && d.amendment_reversals.count > 0 && <Line label="CORRECTIONS (REVERSED) -" sub={`${d.amendment_reversals.count}`} value={m(d.amendment_reversals.amount)} />}
      {nonZero(d.card_commission) && <Line label="CARD COMMISSION +" value={m(d.card_commission)} />}
      <Line label="SERVICE CHARGE +" sub={d.other_charges.service_charge.count ? `${d.other_charges.service_charge.count}` : undefined} value={m(d.other_charges.service_charge.amount)} />
      <Line label="DELIVERY CHARGE +" sub={d.other_charges.delivery_charge.count ? `${d.other_charges.delivery_charge.count}` : undefined} value={m(d.other_charges.delivery_charge.amount)} />
      <Rule />
      <Line label="NET SALES" value={m(d.net_sales)} strong />
      {d.vat !== null && <Line label={`${T} +`} value={m(d.vat)} />}
      {/* New server: the figure here is what was BILLED (unpaid bills included); money received follows under Payments. Older server: total_takings is the billed figure. */}
      {hasTakingsSplit(d)
        ? <Line label="TOTAL BILLED" value={`${cur}${m(d.billed_total!)}`} strong />
        : <Line label="TOTAL TAKINGS" value={`${cur}${m(d.total_takings)}`} strong />}
      {nonZero(r.deposits.sub_total) && (<><Rule /><Heading>Deposit details</Heading><Line label="SUB TOTAL" value={m(r.deposits.sub_total)} /></>)}

      <Rule strong />
      <Heading>Payments</Heading>
      {r.summary.payments.length === 0 && <p className="text-center text-fg-subtle">No payments in this period</p>}
      {r.summary.payments.map((p) => <Line key={p.method} label={methodLabel(p.method)} sub={`${p.count}`} value={m(p.amount)} />)}
      <Line label="TOTAL PAYMENTS" value={m(r.summary.total_payments)} strong />
      {hasTakingsSplit(d) && d.takings && (<>
        {nonZero(d.takings.refunds_paid) && <Line label="REFUNDS PAID -" value={m(d.takings.refunds_paid)} />}
        <Line label="TOTAL TAKINGS (RECEIVED)" value={`${cur}${m(d.total_takings)}`} strong />
      </>)}
      {nonZero(r.checks_info.payments_minus_takings) && (() => {
        const gap = gapLines(r.checks_info.payments_gap, r.restaurant.currency);
        // The real causes when the server sends them; the old generic sentence only for an older server.
        if (!gap) return <p className="mt-1 text-[0.72rem] text-fg-subtle">Payments differ from takings by {m(r.checks_info.payments_minus_takings)}: bills settled in another period or refunds paid out.</p>;
        return (
          <div className="mt-1 text-[0.72rem] text-fg-subtle" data-testid="payments-gap">
            <p>Payments differ from the amount billed by {m(r.checks_info.payments_minus_takings)}:</p>
            <ul className="mt-0.5 space-y-0.5">{gap.causes.map((c) => <li key={c.code} data-cause={c.code}>{c.text}</li>)}</ul>
            {gap.unexplained && <p className="mt-0.5 font-semibold text-danger-fg" data-testid="gap-unexplained">{gap.unexplained}</p>}
          </div>
        );
      })()}

      {r.summary.vat.shown && r.summary.vat.rows.length > 0 && (
        <>
          <Rule strong />
          <Heading>{T}</Heading>
          <table className="w-full table-fixed border-collapse">
            <colgroup><col /><col className="w-24" /><col className="w-24" /></colgroup>
            <thead><tr className="border-b border-border-strong text-[0.7rem] uppercase text-fg-muted"><th className="py-1 text-left font-semibold">Rate</th><th className="py-1 text-right font-semibold">Base</th><th className="py-1 text-right font-semibold">{T}</th></tr></thead>
            <tbody>
              {r.summary.vat.rows.map((v) => (
                <tr key={`${v.code}-${v.rate_percent}`}><td className="py-px">{T} {Number(v.rate_percent)}%</td><td className="tnum py-px text-right">{m(v.base)}</td><td className="tnum py-px text-right">{m(v.vat)}</td></tr>
              ))}
              {r.summary.vat.corrections && nonZero(r.summary.vat.corrections.base) && (
                <tr><td className="py-px">CORRECTIONS</td><td className="tnum py-px text-right">{m(r.summary.vat.corrections.base)}</td><td className="tnum py-px text-right">{m(r.summary.vat.corrections.vat)}</td></tr>
              )}
              {r.summary.vat.returns && nonZero(r.summary.vat.returns.base) && (
                <tr><td className="py-px">RETURNS</td><td className="tnum py-px text-right">-{m(r.summary.vat.returns.base)}</td><td className="tnum py-px text-right">-{m(r.summary.vat.returns.vat)}</td></tr>
              )}
            </tbody>
            {r.summary.vat.total && (
              <tfoot><tr className="border-t border-border-strong font-bold"><td className="pt-1">TOTAL {T}</td><td className="tnum pt-1 text-right">{m(r.summary.vat.total.base)}</td><td className="tnum pt-1 text-right">{m(r.summary.vat.total.vat)}</td></tr></tfoot>
            )}
          </table>
        </>
      )}

      {r.corrections && r.corrections.count > 0 && (
        <section data-testid="corrections-block" aria-label="Corrections">
          <Rule strong />
          <Heading>Corrections (bills amended)</Heading>
          <p className="mb-2 text-[0.72rem] text-fg-subtle">Each correction cancels an earlier invoice with a credit note and issues a replacement. The old invoice stays in the report of the day it was rung; only the change is booked here.</p>
          {r.corrections.items.map((it) => (
            <div key={it.credit_note} className="mb-3 rounded-sm bg-surface-2/60 p-2" data-testid="correction-item">
              <Line label={it.replacement_invoice} strong />
              <Line indent label={`replaces ${it.original_invoice}`} />
              <Line indent label={`credit note ${it.credit_note}`} />
              <Line indent label={`sale ${formatLocal(it.sale_at, tz)}`} />
              <Line indent label={`reason: ${it.reason}`} />
              <Line label="TOTAL" value={`${m(it.original_total)} > ${m(it.new_total)} (${m(it.delta_total)})`} />
              {r.summary.vat.shown && <Line label={T} value={`${m(it.original_vat)} > ${m(it.new_vat)} (${m(it.vat_delta)})`} />}
              {r.summary.vat.shown && it.by_rate.filter((x) => nonZero(x.base_delta) || nonZero(x.vat_delta)).map((x) => (
                <Line key={`${x.code}-${x.rate_percent}`} indent label={x.code === "none" ? `NO ${T}` : `${T} ${Number(x.rate_percent)}%`} value={`base ${m(x.base_delta)} ${T.toLowerCase()} ${m(x.vat_delta)}`} />
              ))}
              {it.payout && <Line label={`REFUND ${it.payout.method.toUpperCase()}`} value={`-${m(it.payout.amount)}`} />}
            </div>
          ))}
          <Line label="NET CHANGE TO SALES" value={m(r.corrections.delta.base)} strong />
          {r.summary.vat.shown && <Line label={`NET CHANGE TO ${T}`} value={m(r.corrections.delta.vat)} strong />}
          {r.corrections.payments.map((p) => <Line key={p.method} label={`PAYMENT ${methodLabel(p.method)}`} value={m(p.amount)} />)}
        </section>
      )}

      <Rule strong />
      <Heading>Voids</Heading>
      <Line label="VOIDS" sub={`${r.voids.count}`} value={m(r.voids.amount)} strong />
      {r.voids.orders.map((v) => (
        <Line key={v.order_id} indent label={`${v.order_ref} · ${orderTypeLabel(v.order_type)}`} sub={v.reason ?? undefined} value={m(v.amount)} />
      ))}

      <Rule strong />
      <Heading>Open items</Heading>
      <Line label="OPEN ORDERS" sub={`${r.open_items.open_orders.count}`} value={m(r.open_items.open_orders.amount)} />
      <Line label="UNPAID BILLS" sub={`${r.open_items.unpaid_bills.count}`} value={m(r.open_items.unpaid_bills.balance)} />
      <p className="mt-1 text-[0.72rem] text-fg-subtle">Open orders and unpaid bills are not part of these totals.</p>

      {r.warnings.length > 0 && (
        <>
          <Rule strong />
          <div role="alert" className="rounded-sm bg-danger-soft px-3 py-2 text-danger-fg">
            {r.warnings.map((w) => <p key={w} className="font-bold">{w}</p>)}
          </div>
        </>
      )}
      <Rule strong />
      <p className="text-center text-fg-subtle">{r.kind === "Z" ? `Closed ${formatLocal(r.created_at ?? r.generated_at, tz)}` : `Printed ${formatLocal(r.generated_at, tz)}`}</p>
    </article>
  );
}
