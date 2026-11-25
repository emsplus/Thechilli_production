"use client";
import { useState } from "react";
import { DataTable, FilterBar } from "@chilli/ui/data";
import { Button, Notice, PageHeader, Section, Select, StatCard } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { useQuery, type QueryResult } from "@/lib/hooks";
import { fetchAll } from "@/lib/fetchAll";
import { can } from "@/lib/roles";
import { fmtMoney, fmtPct } from "@/lib/format";
import { STAGE_LABEL } from "@/lib/pipeline";
import { SubNav, errorText } from "@/components/ui";
import { earningsNav } from "@/components/subnavs";
import {
  PERIODS, commissionEarnedVsPaid, conversionBySalesperson, conversionBySource, demosSummary, inPeriod, leadsFunnel, onboardingCycle,
  type CommissionRow, type CycleRow, type FunnelRow, type PeriodKey, type SourceRow,
} from "@/lib/reports";

const status = <T,>(q: QueryResult<T>) => (q.loading ? "loading" : q.error ? "error" : "ready") as "loading" | "error" | "ready";
const days = (d: number | null) => (d === null ? "—" : `${d} d`);
const pct = (b: number, den = 1) => (den ? fmtPct(b) : "—");
const money = (minor: number, cur: string) => fmtMoney(minor, cur);

export default function ReportsPage() {
  const { user } = useAuth();
  const admin = can(user?.role, "team.manage");
  const [period, setPeriod] = useState<PeriodKey>("all");
  const leadsQ = useQuery("rep:leads", () => fetchAll((offset, limit) => api.leads.list({ limit, offset })));
  const demosQ = useQuery("rep:demos", () => api.demos.list({ limit: 500 }));
  const appsQ = useQuery("rep:apps", () => fetchAll((offset, limit) => api.onboarding.list({ limit, offset })));
  const entriesQ = useQuery("rep:entries", () => fetchAll((offset, limit) => api.commissions.entries({ limit, offset })));
  const usersQ = useQuery(`rep:users:${admin}`, () => (admin ? api.users.list() : Promise.resolve([])));

  const leads = inPeriod(leadsQ.data ?? [], (l) => l.created_at, period);
  const demos = inPeriod(demosQ.data ?? [], (d) => d.scheduled_at, period);
  const apps = inPeriod(appsQ.data ?? [], (a) => a.created_at, period);
  const entries = inPeriod(entriesQ.data ?? [], (e) => e.created_at, period);

  const funnel = leadsFunnel(leads);
  const bySource = conversionBySource(leads);
  const bySales = conversionBySalesperson(leads, usersQ.data ?? []);
  const ds = demosSummary(demos);
  const cycle = onboardingCycle(apps);
  const comm = commissionEarnedVsPaid(entries);
  const retry = (q: QueryResult<unknown>) => () => q.reload();

  const sourceCols = (first: string) => [
    { key: "k", header: first, render: (r: SourceRow) => <strong>{r.label}</strong>, sortValue: (r: SourceRow) => r.label },
    { key: "l", header: "Leads", align: "end" as const, render: (r: SourceRow) => r.leads, sortValue: (r: SourceRow) => r.leads },
    { key: "w", header: "Won", align: "end" as const, render: (r: SourceRow) => r.won, sortValue: (r: SourceRow) => r.won },
    { key: "x", header: "Lost", align: "end" as const, render: (r: SourceRow) => r.lost, sortValue: (r: SourceRow) => r.lost },
    { key: "c", header: "Conversion %", align: "end" as const, render: (r: SourceRow) => pct(r.conversionBps, r.leads), sortValue: (r: SourceRow) => r.conversionBps, csv: (r: SourceRow) => r.conversionBps / 100 },
  ];

  return (
    <div className="stack">
      <PageHeader title="Reports" description={admin ? "Everything the team did. Conversion is won / all leads in the period." : "Your own numbers. Rows you do not own are never included."} />
      <SubNav items={earningsNav(user?.role)} />
      <FilterBar label="Report period">
        <Select label="Period" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)}>
          {PERIODS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </Select>
      </FilterBar>

      <Section title="Leads funnel" description="Leads now at or beyond each stage. Stage history is not stored, so lost leads are shown separately.">
        {leadsQ.error ? <Notice tone="danger" title={errorText(leadsQ.error).title} action={<Button size="sm" onClick={retry(leadsQ)}>Retry</Button>}>{errorText(leadsQ.error).description}</Notice> : (
          <>
            <div className="grid kpis" style={{ marginBottom: 12 }}>
              <StatCard label="Leads" value={funnel.total} loading={leadsQ.loading} />
              <StatCard label="Won" value={funnel.rows.find((r) => r.stage === "won")?.atStage ?? 0} loading={leadsQ.loading} />
              <StatCard label="Lost" value={funnel.lost} loading={leadsQ.loading} />
              <StatCard label="Conversion" value={funnel.total ? fmtPct(Math.floor(((funnel.rows.find((r) => r.stage === "won")?.atStage ?? 0) * 10000) / funnel.total)) : "—"} loading={leadsQ.loading} />
            </div>
            <DataTable<FunnelRow> caption="Leads funnel by stage" exportName="leads-funnel" status={status(leadsQ)} onRetry={retry(leadsQ)} getKey={(r) => r.stage}
              rows={funnel.total ? funnel.rows : []} empty={<p className="muted empty-pad">No leads in this period.</p>}
              columns={[
                { key: "s", header: "Stage", render: (r) => <strong>{STAGE_LABEL[r.stage]}</strong>, csv: (r) => STAGE_LABEL[r.stage] },
                { key: "a", header: "Now at stage", align: "end", render: (r) => r.atStage, sortValue: (r) => r.atStage },
                { key: "r", header: "Reached or beyond", align: "end", render: (r) => r.reached, sortValue: (r) => r.reached },
                { key: "p", header: "% of all leads", align: "end", render: (r) => fmtPct(r.reachedBps), sortValue: (r) => r.reachedBps, csv: (r) => r.reachedBps / 100 },
              ]} />
          </>
        )}
      </Section>

      <Section title="Conversions by source" description="Which lead source turns into won businesses.">
        <DataTable<SourceRow> caption="Conversions by lead source" exportName="conversions-by-source" status={status(leadsQ)} onRetry={retry(leadsQ)} getKey={(r) => r.key}
          rows={bySource} empty={<p className="muted empty-pad">No leads in this period.</p>} columns={sourceCols("Source")} />
      </Section>

      {admin ? (
        <Section title="Conversions by salesperson" description="Leads by current owner.">
          <DataTable<SourceRow> caption="Conversions by salesperson" exportName="conversions-by-salesperson" status={leadsQ.loading || usersQ.loading ? "loading" : leadsQ.error || usersQ.error ? "error" : "ready"}
            onRetry={() => { leadsQ.reload(); usersQ.reload(); }} getKey={(r) => r.key} rows={bySales} empty={<p className="muted empty-pad">No leads in this period.</p>} columns={sourceCols("Salesperson")} />
        </Section>
      ) : <Notice tone="info" title="Per-person breakdown">Conversions by salesperson are visible to marketing admins only.</Notice>}

      <Section title="Demos held" description="Held means completed. Show rate = held / (held + no-show).">
        <div className="grid kpis" style={{ marginBottom: 12 }}>
          <StatCard label="Demos held" value={ds.held} loading={demosQ.loading} />
          <StatCard label="Scheduled" value={ds.scheduled} loading={demosQ.loading} />
          <StatCard label="No-show" value={ds.noShow} loading={demosQ.loading} />
          <StatCard label="Show rate" value={ds.held + ds.noShow ? fmtPct(ds.heldBps) : "—"} loading={demosQ.loading} />
        </div>
        <DataTable<{ k: string; label: string; n: number }> caption="Demos by status" exportName="demos-by-status" status={status(demosQ)} onRetry={retry(demosQ)} getKey={(r) => r.k}
          rows={ds.total ? [{ k: "completed", label: "Held (completed)", n: ds.held }, { k: "scheduled", label: "Scheduled", n: ds.scheduled }, { k: "no_show", label: "No-show", n: ds.noShow }, { k: "cancelled", label: "Cancelled", n: ds.cancelled }] : []}
          empty={<p className="muted empty-pad">No demos in this period.</p>}
          columns={[{ key: "l", header: "Status", render: (r) => <strong>{r.label}</strong>, csv: (r) => r.label }, { key: "n", header: "Demos", align: "end", render: (r) => r.n, sortValue: (r) => r.n }]} />
      </Section>

      <Section title="Onboarding cycle time" description="Days from application created to provisioned. Only provisioned applications count.">
        <DataTable<CycleRow> caption="Onboarding cycle time" exportName="onboarding-cycle-time" status={status(appsQ)} onRetry={retry(appsQ)} getKey={(r) => r.key}
          rows={apps.length ? cycle : []} empty={<p className="muted empty-pad">No applications in this period.</p>}
          columns={[
            { key: "l", header: "Applications", render: (r) => <strong>{r.label}</strong>, csv: (r) => r.label },
            { key: "p", header: "Provisioned", align: "end", render: (r) => r.provisioned, sortValue: (r) => r.provisioned },
            { key: "o", header: "Still open", align: "end", render: (r) => r.open, sortValue: (r) => r.open },
            { key: "a", header: "Average days", align: "end", render: (r) => days(r.avgDays), sortValue: (r) => r.avgDays },
            { key: "m", header: "Median days", align: "end", render: (r) => days(r.medianDays), sortValue: (r) => r.medianDays },
            { key: "f", header: "Fastest days", align: "end", render: (r) => days(r.fastestDays), sortValue: (r) => r.fastestDays },
            { key: "w", header: "Slowest days", align: "end", render: (r) => days(r.slowestDays), sortValue: (r) => r.slowestDays },
          ]} />
      </Section>

      <Section title="Commission earned vs paid" description="Earned = approved + paid, net of reversals. Owed = earned minus paid. Pending is awaiting approval.">
        <DataTable<CommissionRow> caption="Commission earned versus paid" exportName="commission-earned-vs-paid" status={status(entriesQ)} onRetry={retry(entriesQ)} getKey={(r) => r.currency}
          rows={comm} empty={<p className="muted empty-pad">No commission entries in this period.</p>}
          columns={[
            { key: "c", header: "Currency", render: (r) => <strong>{r.currency}</strong>, csv: (r) => r.currency },
            { key: "p", header: "Pending", align: "end", render: (r) => money(r.pending, r.currency), sortValue: (r) => r.pending, csv: (r) => r.pending / 100 },
            { key: "e", header: "Earned", align: "end", render: (r) => money(r.earned, r.currency), sortValue: (r) => r.earned, csv: (r) => r.earned / 100 },
            { key: "d", header: "Paid", align: "end", render: (r) => money(r.paid, r.currency), sortValue: (r) => r.paid, csv: (r) => r.paid / 100 },
            { key: "o", header: "Owed", align: "end", render: (r) => money(r.owed, r.currency), sortValue: (r) => r.owed, csv: (r) => r.owed / 100 },
          ]} />
      </Section>
    </div>
  );
}
