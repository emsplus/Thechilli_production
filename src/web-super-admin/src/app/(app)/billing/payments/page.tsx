"use client";
import { useState } from "react";
import { Button, Card, Input, Money, Select, StatCard, Table, Tabs, useToast } from "@chilli/ui";
import { downloadCsv } from "@chilli/ui/data";
import { api } from "@/lib/api";
import type { Payment, Subscription, UsageStatement } from "@/lib/api/types";
import { fmtDate, fmtDateTime, fmtMonth, fmtNumber } from "@/lib/format";
import { useTenants } from "@/lib/hooks";
import { istMonth, negativeCredit, overdue, PAYMENTS_WINDOW, paymentTotals, usageTotals } from "@/lib/payments";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { InlineError, Notice, PageHeader, Pager, ResourceView, StatusBadge } from "@/components/ui";
import { TenantLink } from "@/components/TenantLink";

/**
 * Payments management, read-only. Three sources in platform-core: plan payments recorded against GST invoices (/payments),
 * Chilli credit top-ups (/admin/billing/usage per month), and what is late (failed payments, overdue invoices, past-due
 * subscriptions, credit below zero). No payment gateway is connected, so nothing here moves money.
 */
export default function PaymentsPage() {
  const can = useCan();
  const items = [{ value: "plan", label: "Plan payments", content: <PlanPayments /> }];
  if (can("wallet.read")) items.push({ value: "credit", label: "Credit top-ups", content: <CreditTopups /> });
  items.push({ value: "late", label: "Failed & overdue", content: <Late /> });
  return (
    <>
      <PageHeader title="Payments" subtitle="What businesses have paid Chilli, for plans and for prepaid credit, and what is late. Read-only." />
      <Notice>No payment gateway is connected yet: payments are recorded by finance against an invoice, credit top-ups are added on the business page, and refunds show as a status on the original payment. Nothing on this page moves money.</Notice>
      <Tabs label="Payment views" items={items} defaultValue="plan" />
    </>
  );
}

// ------------------------------------------------------------------ plan payments
function PlanPayments() {
  const [view, setView] = useState<"all" | "succeeded" | "refunded" | "failed" | "initiated">("all");
  const [offset, setOffset] = useState(0);
  const { nameOf } = useTenants();
  const res = useResource(() => api.billing.payments({ limit: PAYMENTS_WINDOW }), "payments");
  return (
    <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No payments recorded", description: "Payments show up after finance records them against an invoice." }}>
      {(d) => {
        const t = paymentTotals(d.items);
        const shown = d.items.filter((p) => view === "all" || p.status === view);
        return (
          <div className="hq-stack">
            <div className="hq-grid">
              <StatCard label="Received" money={t.received_paise} hint={`${fmtNumber(d.items.filter((p) => p.status === "succeeded").length)} payments`} />
              <StatCard label="Refunded" money={t.refunded_paise} />
              <StatCard label="Failed" value={fmtNumber(t.failed)} hint={t.pending ? `${t.pending} still pending` : undefined} />
            </div>
            {d.total > d.items.length ? <p className="hq-sub">Figures cover the latest {fmtNumber(d.items.length)} of {fmtNumber(d.total)} payments (platform-core cannot filter payments by status or date yet).</p> : null}
            <div className="hq-filters">
              <Select label="Show" value={view} onChange={(e) => { setView(e.target.value as typeof view); setOffset(0); }}>
                <option value="all">All payments</option><option value="succeeded">Received</option><option value="refunded">Refunded</option>
                <option value="failed">Failed</option><option value="initiated">Pending</option>
              </Select>
            </div>
            <Table<Payment> caption="Plan payments" getKey={(p) => p.id} rows={shown.slice(offset, offset + 25)} empty={<p className="hq-muted">No payments with this status.</p>} columns={[
              { key: "d", header: "Date", render: (p) => <span className="hq-nowrap">{fmtDateTime(p.created_at)}</span> },
              { key: "t", header: "Business", render: (p) => <TenantLink id={p.tenant_id} name={nameOf(p.tenant_id)} /> },
              { key: "m", header: "Method", render: (p) => p.method ?? "–" },
              { key: "r", header: "Reference", render: (p) => <span className="hq-mono">{p.provider}:{p.provider_ref}</span> },
              { key: "s", header: "Status", render: (p) => <StatusBadge value={p.status} /> },
              { key: "a", header: "Amount", align: "end", render: (p) => <Money value={p.amount_paise} alwaysDecimals /> },
            ]} />
            <Pager page={{ total: shown.length, limit: 25, offset }} onOffset={setOffset} />
          </div>
        );
      }}
    </ResourceView>
  );
}

// ------------------------------------------------------------------ credit top-ups
function CreditTopups() {
  const toast = useToast();
  const [month, setMonth] = useState(istMonth);
  const valid = /^\d{4}-\d{2}$/.test(month);
  const res = useResource(() => api.credit.allUsage(month), `usage-${month}`, valid);
  const csv = useAction(async () => { downloadCsv(`chilli-credit-${month}`, await api.credit.allUsageCsv(month)); toast.show("Credit report downloaded", "success"); });
  return (
    <div className="hq-stack">
      <div className="hq-filters">
        <Input label="Month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} hint="Months follow India time (IST)." />
        <Button size="sm" loading={csv.busy} disabled={!valid} onClick={() => void csv.run()}>Download (CSV)</Button>
      </div>
      <InlineError error={csv.error} />
      {!valid ? <p className="hq-sub">Pick a month.</p> : (
        <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No credit accounts", description: "Businesses get a credit account when they are created." }}>
          {(d) => {
            const t = usageTotals(d.items);
            const rows = [...d.items].sort((a, b) => b.topups_paise - a.topups_paise);
            return (
              <>
                <div className="hq-grid">
                  <StatCard label={`Top-ups in ${fmtMonth(d.month)}`} money={t.topups_paise} hint={`${fmtNumber(d.items.filter((r) => r.topups_paise > 0).length)} businesses topped up`} />
                  <StatCard label="Promo credit given" money={t.promo_paise} />
                  <StatCard label="Bill fees charged (net)" money={t.net_fees_paise} hint="GST included as returned by platform-core" />
                  <StatCard label="Credit held at month end" money={t.closing_balance_paise} />
                </div>
                <Table<UsageStatement> caption={`Credit by business, ${fmtMonth(d.month)}`} getKey={(r) => r.tenant_id} rows={rows} columns={[
                  { key: "b", header: "Business", render: (r) => <TenantLink id={r.tenant_id} name={r.tenant} /> },
                  { key: "o", header: "Opening", align: "end", render: (r) => <Money value={r.opening_balance_paise} alwaysDecimals /> },
                  { key: "t", header: "Top-ups", align: "end", render: (r) => <Money value={r.topups_paise} alwaysDecimals /> },
                  { key: "n", header: "Receipts", align: "end", render: (r) => fmtNumber(r.receipts.length) },
                  { key: "p", header: "Promo", align: "end", render: (r) => <Money value={r.promo_paise} alwaysDecimals /> },
                  { key: "f", header: "Fees", align: "end", render: (r) => <Money value={-r.net_fees_paise} alwaysDecimals /> },
                  { key: "c", header: "Closing", align: "end", render: (r) => <Money value={r.closing_balance_paise} alwaysDecimals /> },
                ]} />
                <p className="hq-sub">Each top-up has a numbered receipt on the business page (Chilli credit). {d.items[0]?.tax_notice ?? ""}</p>
              </>
            );
          }}
        </ResourceView>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ failed & overdue
function Late() {
  const can = useCan();
  const { nameOf } = useTenants();
  const res = useResource(async () => {
    const [pay, inv, subs, plans, usage] = await Promise.all([
      api.billing.payments({ limit: PAYMENTS_WINDOW }),
      can("invoices.read") ? api.billing.invoices({ status: "issued", limit: 200 }) : Promise.resolve(null),
      can("subscriptions.read") ? api.catalog.subscriptions("past_due") : Promise.resolve(null),
      can("catalog.read") ? api.catalog.plans() : Promise.resolve(null),
      can("wallet.read") ? api.credit.allUsage(istMonth()) : Promise.resolve(null),
    ]);
    return { failed: pay.items.filter((p) => p.status === "failed"), overdue: inv ? overdue(inv.items) : null, pastDue: subs?.items ?? null,
      planName: (id: string) => plans?.items.find((p) => p.id === id)?.name ?? "–", negative: usage ? negativeCredit(usage.items) : null };
  }, "late");
  return (
    <ResourceView res={res} empty={{ title: "" }}>
      {(d) => (
        <div className="hq-stack">
          <div className="hq-grid">
            <StatCard label="Failed payments" value={fmtNumber(d.failed.length)} />
            {d.overdue ? <StatCard label="Overdue invoices" value={fmtNumber(d.overdue.length)} hint={<>Owed <Money value={d.overdue.reduce((a, i) => a + i.total_paise, 0)} /> incl. GST</>} /> : null}
            {d.pastDue ? <StatCard label="Past-due subscriptions" value={fmtNumber(d.pastDue.length)} /> : null}
            {d.negative ? <StatCard label="Credit below zero" value={fmtNumber(d.negative.length)} hint="Businesses billing on grace" /> : null}
          </div>

          {d.overdue ? (
            <Card as="section">
              <h2 className="hq-card-title">Overdue invoices</h2>
              <Table caption="Overdue invoices" getKey={(i) => i.id} rows={d.overdue} empty={<p className="hq-muted">Nothing overdue.</p>} columns={[
                { key: "n", header: "Invoice", render: (i) => <span className="hq-mono">{i.number ?? "draft"}</span> },
                { key: "b", header: "Business", render: (i) => <TenantLink id={i.tenant_id} name={nameOf(i.tenant_id)} /> },
                { key: "d", header: "Due", render: (i) => fmtDate(i.due_at) },
                { key: "o", header: "Overdue", align: "end", render: (i) => `${i.days_overdue} ${i.days_overdue === 1 ? "day" : "days"}` },
                { key: "a", header: "Total", align: "end", render: (i) => <Money value={i.total_paise} alwaysDecimals /> },
              ]} />
            </Card>
          ) : null}

          {d.pastDue ? (
            <Card as="section">
              <h2 className="hq-card-title">Past-due subscriptions</h2>
              <Table<Subscription> caption="Past-due subscriptions" getKey={(s) => s.id} rows={d.pastDue} empty={<p className="hq-muted">No subscription is past due.</p>} columns={[
                { key: "b", header: "Business", render: (s) => <TenantLink id={s.tenant_id} name={nameOf(s.tenant_id)} /> },
                { key: "p", header: "Plan", render: (s) => d.planName(s.plan_id) },
                { key: "e", header: "Period ends", render: (s) => fmtDate(s.current_period_end) },
                { key: "s", header: "Status", render: (s) => <StatusBadge value={s.status} /> },
              ]} />
            </Card>
          ) : null}

          <Card as="section">
            <h2 className="hq-card-title">Failed payments</h2>
            <Table<Payment> caption="Failed payments" getKey={(p) => p.id} rows={d.failed} empty={<p className="hq-muted">No failed payments among the latest {PAYMENTS_WINDOW}.</p>} columns={[
              { key: "d", header: "Date", render: (p) => <span className="hq-nowrap">{fmtDateTime(p.created_at)}</span> },
              { key: "b", header: "Business", render: (p) => <TenantLink id={p.tenant_id} name={nameOf(p.tenant_id)} /> },
              { key: "r", header: "Reference", render: (p) => <span className="hq-mono">{p.provider}:{p.provider_ref}</span> },
              { key: "a", header: "Amount", align: "end", render: (p) => <Money value={p.amount_paise} alwaysDecimals /> },
            ]} />
          </Card>

          {d.negative ? (
            <Card as="section">
              <h2 className="hq-card-title">Credit below zero (this month)</h2>
              <Table<UsageStatement> caption="Credit below zero" getKey={(r) => r.tenant_id} rows={d.negative} empty={<p className="hq-muted">Every business has credit left.</p>} columns={[
                { key: "b", header: "Business", render: (r) => <TenantLink id={r.tenant_id} name={r.tenant} /> },
                { key: "c", header: "Balance", align: "end", render: (r) => <Money value={r.closing_balance_paise} alwaysDecimals /> },
              ]} />
            </Card>
          ) : null}
        </div>
      )}
    </ResourceView>
  );
}
