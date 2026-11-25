"use client";
import { Badge, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import type { Feature, Plan } from "@/lib/api/types";
import { fmtLimit } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { PageHeader, ResourceView } from "@/components/ui";

export default function FeaturesPage() {
  const res = useResource(async () => {
    const [f, p] = await Promise.all([api.catalog.features(), api.catalog.plans()]);
    return { features: f.items, plans: p.items };
  }, "features");
  const cell = (plan: Plan, f: Feature) => {
    const row = plan.features.find((x) => x.feature_code === f.code);
    if (!row?.enabled) return <span className="hq-muted" aria-label="Not included">–</span>;
    return f.kind === "limit" ? (row.limit_value === null ? `∞${f.unit ? ` ${f.unit}` : ""}` : fmtLimit(row.limit_value, f.unit)) : <span aria-label="Included">Yes</span>;
  };
  return (
    <>
      <PageHeader title="Features" subtitle="The feature catalogue and which plan includes what. Per-business exceptions are set under Entitlements." />
      <ResourceView res={res} isEmpty={(d) => d.features.length === 0} empty={{ title: "No features defined", description: "The catalogue is managed in platform-core." }}>
        {(d) => (
          <div className="hq-matrix">
            <Table<Feature> caption="Features by plan" getKey={(f) => f.code} rows={d.features} columns={[
              { key: "f", header: "Feature", render: (f) => <>{f.name} <span className="hq-mono hq-muted">{f.code}</span>{!f.is_active ? <> <Badge>Retired</Badge></> : null}</> },
              { key: "k", header: "Type", render: (f) => f.kind },
              ...d.plans.map((p) => ({ key: p.code, header: p.name, render: (f: Feature) => cell(p, f) })),
            ]} />
          </div>
        )}
      </ResourceView>
    </>
  );
}
