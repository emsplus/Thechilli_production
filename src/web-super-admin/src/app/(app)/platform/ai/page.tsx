"use client";
import { useState } from "react";
import { Card, Money, Select, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import { fmtNumber, microInrToPaise } from "@/lib/format";
import { useTenants } from "@/lib/hooks";
import { useResource } from "@/lib/useResource";
import { PageHeader, ResourceView } from "@/components/ui";
import { TenantLink } from "@/components/TenantLink";

const RANGES = [["", "All time"], ["7", "Last 7 days"], ["30", "Last 30 days"]] as const;
type Row = { tenant_id: string; calls: number; input: number; output: number; cost: number };

export default function AiUsagePage() {
  const [range, setRange] = useState("30");
  const { nameOf } = useTenants();
  const res = useResource(() => api.ai.summary(range ? new Date(Date.now() - Number(range) * 864e5).toISOString() : undefined), range);
  return (
    <>
      <PageHeader title="AI usage & cost" subtitle="Calls, tokens and cost by business. Counts only: no prompts or answers are stored here." />
      <div className="hq-filters"><Select label="Period" value={range} onChange={(e) => setRange(e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No AI usage in this period", description: "Usage appears once businesses use AI features.", actionLabel: range ? "Show all time" : undefined, onAction: () => setRange("") }}>
        {(d) => {
          const by = new Map<string, Row>();
          for (const r of d.items) { const x = by.get(r.tenant_id) ?? { tenant_id: r.tenant_id, calls: 0, input: 0, output: 0, cost: 0 }; x.calls += r.calls; x.input += r.input_tokens; x.output += r.output_tokens; x.cost += r.cost_micro_inr; by.set(r.tenant_id, x); }
          const rows = [...by.values()].sort((a, b) => b.cost - a.cost);
          const total = rows.reduce((n, r) => n + r.cost, 0);
          return (
            <>
              <div className="hq-grid" style={{ marginBottom: 16 }}>
                <Card><p className="hq-kpi__l">Total cost</p><p className="hq-kpi__v"><Money value={microInrToPaise(total)} alwaysDecimals /></p></Card>
                <Card><p className="hq-kpi__l">Calls</p><p className="hq-kpi__v">{fmtNumber(rows.reduce((n, r) => n + r.calls, 0))}</p></Card>
              </div>
              <Table<Row> caption="AI usage by business" getKey={(r) => r.tenant_id} rows={rows} columns={[
                { key: "t", header: "Business", render: (r) => <TenantLink id={r.tenant_id} name={nameOf(r.tenant_id)} /> }, { key: "c", header: "Calls", align: "end", render: (r) => fmtNumber(r.calls) },
                { key: "i", header: "Input tokens", align: "end", render: (r) => fmtNumber(r.input) }, { key: "o", header: "Output tokens", align: "end", render: (r) => fmtNumber(r.output) },
                { key: "m", header: "Cost", align: "end", render: (r) => <Money value={microInrToPaise(r.cost)} alwaysDecimals /> },
              ]} />
              <h2 className="hq-h2">By feature</h2>
              <Table caption="AI usage by feature" getKey={(r) => `${r.tenant_id}/${r.feature}`} rows={d.items} columns={[
                { key: "t", header: "Business", render: (r) => nameOf(r.tenant_id) }, { key: "f", header: "Feature", render: (r) => r.feature },
                { key: "c", header: "Calls", align: "end", render: (r) => fmtNumber(r.calls) }, { key: "m", header: "Cost", align: "end", render: (r) => <Money value={microInrToPaise(r.cost_micro_inr)} alwaysDecimals /> },
              ]} />
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
