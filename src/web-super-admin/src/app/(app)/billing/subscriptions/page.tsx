"use client";
import { useState } from "react";
import { Select, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import type { Subscription } from "@/lib/api/types";
import { fmtDate } from "@/lib/format";
import { useTenants } from "@/lib/hooks";
import { useResource } from "@/lib/useResource";
import { PageHeader, ResourceView, StatusBadge } from "@/components/ui";
import { TenantLink } from "@/components/TenantLink";

export default function SubscriptionsPage() {
  const [status, setStatus] = useState("");
  const { nameOf } = useTenants();
  const res = useResource(async () => {
    const [subs, plans] = await Promise.all([api.catalog.subscriptions(status || undefined), api.catalog.plans()]);
    return { subs: subs.items, plans: plans.items };
  }, status);
  return (
    <>
      <PageHeader title="Subscriptions" subtitle="Which business is on which plan." />
      <div className="hq-filters">
        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>{["trialing", "active", "past_due", "cancelled", "expired"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </Select>
      </div>
      <ResourceView res={res} isEmpty={(d) => d.subs.length === 0} empty={{ title: "No subscriptions", description: status ? "Nothing with this status." : "Subscriptions start when a business is provisioned.", actionLabel: status ? "Show all" : undefined, onAction: () => setStatus("") }}>
        {(d) => (
          <Table<Subscription> caption="Subscriptions" getKey={(s) => s.id} rows={d.subs} columns={[
            { key: "t", header: "Business", render: (s) => <TenantLink id={s.tenant_id} name={nameOf(s.tenant_id)} /> },
            { key: "p", header: "Plan", render: (s) => d.plans.find((p) => p.id === s.plan_id)?.name ?? "–" },
            { key: "s", header: "Status", render: (s) => <StatusBadge value={s.status} /> },
            { key: "e", header: "Period ends", render: (s) => fmtDate(s.current_period_end) },
            { key: "c", header: "Cancels at period end", render: (s) => (s.cancel_at_period_end ? "Yes" : "No") },
          ]} />
        )}
      </ResourceView>
    </>
  );
}
