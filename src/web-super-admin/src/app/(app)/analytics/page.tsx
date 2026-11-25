"use client";
import { useState } from "react";
import { Button, Card, Input, Money, formatINR, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import type { ExportReport, OnboardingSource } from "@/lib/api/types";
import { bpsToPercent, fmtMonth, fmtNumber, titleCase } from "@/lib/format";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { HBars, StackedBars } from "@/components/charts";
import { InlineError, Notice, PageHeader, ResourceView } from "@/components/ui";

const SOURCES: OnboardingSource[] = ["self_signup", "marketing", "staff"];
const REPORTS: [ExportReport, string][] = [["mrr_by_plan", "MRR by plan"], ["signups", "Signups by month"], ["subscriptions", "Live subscriptions"], ["tenants", "Businesses"]];
const monthLabel = fmtMonth;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

export default function AnalyticsPage() {
  const can = useCan();
  const toast = useToast();
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const res = useResource(() => api.analytics.overview({ since: since || undefined, until: until || undefined }), `an-${since}-${until}`);
  const exp = useAction(async (r: ExportReport) => {
    const text = await api.analytics.exportCsv(r, { since: since || undefined, until: until || undefined });
    download(`${r}-${new Date().toISOString().slice(0, 10)}.csv`, text);
    toast.show("Export downloaded", "success");
  });
  return (
    <>
      <PageHeader title="Analytics" subtitle="Subscription revenue and growth. Platform figures only; amounts exclude GST." />
      <div className="hq-filters" role="search">
        <Input label="From" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        <Input label="To" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        {since || until ? <Button onClick={() => { setSince(""); setUntil(""); }}>Last 90 days</Button> : null}
      </div>
      <ResourceView res={res} empty={{ title: "No data" }}>
        {(o) => (
          <>
            <div className="hq-grid">
              <Card as="section"><p className="hq-kpi__l">Monthly recurring revenue</p><p className="hq-kpi__v"><Money value={o.mrr_paise} /></p><p className="hq-sub">ARR <Money value={o.arr_paise} /></p></Card>
              <Card as="section"><p className="hq-kpi__l">Active businesses</p><p className="hq-kpi__v">{fmtNumber(o.active_tenants)}</p><p className="hq-sub">Subscriptions: {fmtNumber(o.paying_subscriptions)} paying, {fmtNumber(o.trialing_tenants)} on a free trial</p></Card>
              <Card as="section"><p className="hq-kpi__l">Churn in period</p><p className="hq-kpi__v">{bpsToPercent(o.churn.rate_bps)}</p><p className="hq-sub">{o.churn.churned_tenants} of the {o.churn.opening_tenants} businesses live at the start have left</p></Card>
              <Card as="section"><p className="hq-kpi__l">Signups in period</p><p className="hq-kpi__v">{fmtNumber(o.signups.total)}</p><p className="hq-sub">{SOURCES.map((s) => `${titleCase(s)} ${o.signups.by_source[s] ?? 0}`).join(" · ")}</p></Card>
            </div>
            <div className="hq-grid-2" style={{ marginTop: 16 }}>
              <Card as="section">
                {o.signups.by_month.length === 0 ? <><h2 className="hq-card-title">Signups by source</h2><p className="hq-muted">No signups in this period.</p></> :
                  <StackedBars title="Signups by month and source" series={SOURCES.map((s) => ({ name: titleCase(s) }))} rows={o.signups.by_month.map((m) => ({ label: monthLabel(m.month), values: SOURCES.map((s) => m[s] ?? 0) }))} />}
              </Card>
              <Card as="section">
                {o.mrr_by_plan.length === 0 ? <><h2 className="hq-card-title">MRR by plan</h2><p className="hq-muted">No paying subscriptions yet.</p></> :
                  <HBars title="MRR by plan" rows={o.mrr_by_plan.map((p) => ({ label: p.plan_name, value: p.mrr_paise }))} format={(n) => formatINR(n)} />}
              </Card>
            </div>
            <Notice>
              How these are counted: monthly recurring revenue adds up active and overdue subscriptions before GST; a yearly plan counts as one twelfth of its yearly price and free trials are not counted. Churn is the share of businesses that were live at the start of the period and no longer have a live subscription.
            </Notice>
          </>
        )}
      </ResourceView>
      {can("analytics.export") ? (
        <>
          <h2 className="hq-h2">Exports (CSV)</h2>
          <p className="hq-sub">Respects the date range above. Cells that could run as spreadsheet formulas are neutralised. Each export is recorded in the audit log.</p>
          <div className="hq-row" style={{ marginTop: 8 }}>{REPORTS.map(([r, label]) => <Button key={r} loading={exp.busy} onClick={() => void exp.run(r)}>{label}</Button>)}</div>
          <InlineError error={exp.error} />
        </>
      ) : null}
    </>
  );
}
