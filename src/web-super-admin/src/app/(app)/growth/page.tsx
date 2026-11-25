"use client";
import { useState } from "react";
import { Card, formatINR, Select, StatCard, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import type { OnboardingSource, OnboardingStatus } from "@/lib/api/types";
import { bpsToPercent, fmtDate, fmtMonth, fmtNumber } from "@/lib/format";
import { conversion, FUNNEL, lastMonths, pctChange, SOURCE_LABEL, SOURCES, windows, type StatusCounts } from "@/lib/growth";
import { useResource } from "@/lib/useResource";
import { HBars, StackedBars } from "@/components/charts";
import { Notice, PageHeader, ResourceView } from "@/components/ui";

const STATUSES: OnboardingStatus[] = ["received", "under_review", "approved", "provisioning", "provisioned", "rejected", "failed"];
const DECIDED: OnboardingStatus[] = ["provisioned", "rejected", "failed"];

/** Totals only (limit=1): platform-core has no aggregate endpoint for applications, but every list answer carries `total`. */
const countOf = (q: { status?: string; source?: string }) => api.onboarding.list({ ...q, limit: 1 }).then((p) => p.total);

async function load(months: number) {
  const w = windows(months);
  const series = lastMonths(months);
  const [cur, prev, perMonth, byStatus, bySource] = await Promise.all([
    api.analytics.overview(w.current),
    api.analytics.overview(w.previous),
    Promise.all(series.map((m) => api.analytics.overview({ since: m.since, until: m.until }).then((o) => ({ month: m.month, churn: o.churn })))),
    Promise.all(STATUSES.map(async (s) => [s, await countOf({ status: s })] as const)).then((e) => Object.fromEntries(e) as StatusCounts),
    Promise.all(SOURCES.map(async (src) => {
      const e = await Promise.all(DECIDED.map(async (s) => [s, await countOf({ status: s, source: src })] as const));
      return [src, Object.fromEntries(e) as StatusCounts] as const;
    })).then((e) => Object.fromEntries(e) as Record<OnboardingSource, StatusCounts>),
  ]);
  return { cur, prev, perMonth, byStatus, bySource, window: w.current };
}

export default function GrowthPage() {
  const [months, setMonths] = useState(6);
  const res = useResource(() => load(months), `growth-${months}`);
  return (
    <>
      <PageHeader title="Growth" subtitle="Where new businesses come from, how many go live, and what stays. Platform figures only; amounts exclude GST." />
      <div className="hq-filters">
        <Select label="Period" value={String(months)} onChange={(e) => setMonths(Number(e.target.value))}>
          <option value="3">Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last 12 months</option>
        </Select>
      </div>
      <ResourceView res={res} empty={{ title: "No data" }}>
        {(d) => <GrowthBody {...d} months={months} />}
      </ResourceView>
    </>
  );
}

function GrowthBody({ cur, prev, perMonth, byStatus, bySource, window, months }: Awaited<ReturnType<typeof load>> & { months: number }) {
  const conv = conversion(byStatus);
  const vs = `vs the ${months} months before`;
  return (
    <div className="hq-stack">
      <div className="hq-grid">
        <StatCard label="Signups" value={fmtNumber(cur.signups.total)} delta={pctChange(cur.signups.total, prev.signups.total)} deltaLabel={vs}
          hint={SOURCES.map((s) => `${SOURCE_LABEL[s]} ${fmtNumber(cur.signups.by_source[s] ?? 0)}`).join(" · ")} />
        <StatCard label="Applications that went live" value={conv.rateBps === null ? "–" : bpsToPercent(conv.rateBps)}
          hint={`${fmtNumber(conv.won)} of ${fmtNumber(conv.decided)} decided, all time · ${fmtNumber(conv.open)} still in the queue`} />
        <StatCard label="Monthly recurring revenue" money={cur.mrr_paise} hint={`ARR ${formatINR(cur.arr_paise)} · ${fmtNumber(cur.paying_subscriptions)} paying, ${fmtNumber(cur.trialing_tenants)} on a free trial`} />
        <StatCard label="Churn in period" value={bpsToPercent(cur.churn.rate_bps)} lowerIsBetter
          delta={pctChange(cur.churn.rate_bps, prev.churn.rate_bps)} deltaLabel={vs}
          hint={`${cur.churn.churned_tenants} of ${cur.churn.opening_tenants} businesses live on ${fmtDate(window.since)} have left`} />
      </div>

      <div className="hq-grid-2">
        <Card as="section">
          {cur.signups.by_month.length === 0 ? <><h2 className="hq-card-title">Signups by source</h2><p className="hq-muted">No signups in this period.</p></> :
            <StackedBars title="Signups by month and source" series={SOURCES.map((s) => ({ name: SOURCE_LABEL[s] }))}
              rows={cur.signups.by_month.map((m) => ({ label: fmtMonth(m.month), values: SOURCES.map((s) => m[s] ?? 0) }))} />}
        </Card>
        <Card as="section">
          <HBars title="Churn by month (share of businesses live at the start of the month that left)" rows={perMonth.map((m) => ({ label: fmtMonth(m.month), value: m.churn.rate_bps }))} format={bpsToPercent} />
        </Card>
      </div>

      <div className="hq-grid-2">
        <Card as="section">
          <h2 className="hq-card-title">Application funnel (all time)</h2>
          <dl className="hq-funnel" aria-label="Applications by stage">
            {FUNNEL.map((f) => (
              <div key={f.label}><dt>{f.label}</dt><dd>{fmtNumber(f.statuses.reduce((a, st) => a + (byStatus[st] ?? 0), 0))}</dd></div>
            ))}
          </dl>
        </Card>
        <Card as="section">
          <h2 className="hq-card-title">Went live, by source (all time)</h2>
          <Table caption="Conversion by source" getKey={(r) => r.src} rows={SOURCES.map((src) => ({ src, c: conversion(bySource[src]) }))} columns={[
            { key: "s", header: "Source", render: (r) => SOURCE_LABEL[r.src] },
            { key: "w", header: "Live", align: "end", render: (r) => fmtNumber(r.c.won) },
            { key: "d", header: "Decided", align: "end", render: (r) => fmtNumber(r.c.decided) },
            { key: "r", header: "Rate", align: "end", render: (r) => (r.c.rateBps === null ? "–" : bpsToPercent(r.c.rateBps)) },
          ]} />
        </Card>
      </div>

      <Card as="section">
        {cur.mrr_by_plan.length === 0 ? <><h2 className="hq-card-title">MRR by plan</h2><p className="hq-muted">No paying subscriptions yet.</p></> :
          <HBars title="MRR by plan, today" rows={cur.mrr_by_plan.map((p) => ({ label: `${p.plan_name} (${p.subscriptions})`, value: p.mrr_paise }))} format={(n) => formatINR(n)} />}
      </Card>

      <Notice title="How these are counted.">
        Signups and churn follow the period above. Churn is the share of businesses live at the start of a period that no longer have a live subscription (a plan switch is not churn).
        &quot;Went live&quot; counts applications that were provisioned out of those decided (provisioned, rejected or failed); platform-core cannot filter applications by date, so it is all time.
        MRR is today&apos;s figure only: platform-core does not keep MRR history yet, so there is no MRR trend line.
      </Notice>
    </div>
  );
}
