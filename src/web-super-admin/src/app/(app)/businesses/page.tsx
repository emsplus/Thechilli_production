"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Input, Select, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import type { Tenant } from "@/lib/api/types";
import { fmtDate } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { PageHeader, Pager, ResourceView, StatusBadge } from "@/components/ui";

export default function BusinessesPage() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const router = useRouter();
  const res = useResource(() => api.tenants.list({ status: status || undefined, q: q || undefined, offset }), `${status}|${q}|${offset}`);
  const filtered = Boolean(status || q);
  return (
    <>
      <PageHeader title="Businesses" subtitle="Every business on Chilli. Account facts only." />
      <div className="hq-filters" role="search">
        <Input label="Search" type="search" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} placeholder="Name or slug" />
        <Select label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All</option>
          {["pending", "active", "suspended", "closed"].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </div>
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0}
        empty={{ title: filtered ? "No business matches" : "No businesses yet", description: filtered ? "Try a different search or status." : "Approved onboarding applications appear here.", actionLabel: filtered ? "Clear filters" : "Open onboarding", onAction: filtered ? () => { setQ(""); setStatus(""); } : () => router.push("/onboarding") }}>
        {(d) => (
          <>
            <Table<Tenant> caption="Businesses" getKey={(t) => t.id} rows={d.items} columns={[
              { key: "n", header: "Business", render: (t) => <Link className="hq-link" href={`/businesses/${t.id}`}>{t.display_name}</Link> },
              { key: "s", header: "Status", render: (t) => <StatusBadge value={t.status} /> },
              { key: "slug", header: "Slug", render: (t) => <span className="hq-mono">{t.slug}</span> },
              { key: "c", header: "Created", render: (t) => fmtDate(t.created_at) },
            ]} />
            <Pager page={d} onOffset={setOffset} />
          </>
        )}
      </ResourceView>
    </>
  );
}
