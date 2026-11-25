"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Button, Input, Select, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import type { Outlet, TenantStatus } from "@/lib/api/types";
import { fmtNumber } from "@/lib/format";
import { useResource } from "@/lib/useResource";
import { Notice, PageHeader, ResourceView, StatusBadge } from "@/components/ui";

type Row = Outlet & { tenant: string; tenantRef: string; tenantStatus: TenantStatus };
const MAX_TENANTS = 1000, BATCH = 10;

/** Walks every business page (200 at a time) and loads outlet registries in small batches; platform-core has no all-outlets route. */
async function loadAll(): Promise<{ rows: Row[]; truncated: boolean; businesses: number }> {
  const tenants = [];
  let offset = 0, total = 0;
  do {
    const p = await api.tenants.list({ limit: 200, offset });
    tenants.push(...p.items); total = p.total; offset += p.items.length;
    if (p.items.length === 0) break;
  } while (tenants.length < total && tenants.length < MAX_TENANTS);
  const rows: Row[] = [];
  for (let i = 0; i < tenants.length; i += BATCH) {
    const details = await Promise.all(tenants.slice(i, i + BATCH).map((t) => api.tenants.get(t.id)));
    for (const d of details) for (const o of d.outlets) rows.push({ ...o, tenant: d.display_name, tenantRef: d.id, tenantStatus: d.status });
  }
  return { rows, truncated: total > tenants.length, businesses: tenants.length };
}

export default function OutletsPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [city, setCity] = useState("");
  const [bstatus, setBstatus] = useState("");
  const res = useResource(loadAll, "outlets");
  const cities = useMemo(() => [...new Set((res.data?.rows ?? []).map((r) => r.city).filter((c): c is string => !!c))].sort(), [res.data]);
  return (
    <>
      <PageHeader title="Outlets" subtitle="Outlet registry across all businesses (names and locations only)." actions={<Button onClick={res.reload}>Refresh</Button>} />
      <div className="hq-filters" role="search">
        <Input label="Search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Outlet, business, code or city" />
        <Select label="Outlet status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option><option value="active">Active</option><option value="inactive">Inactive</option></Select>
        <Select label="Business status" value={bstatus} onChange={(e) => setBstatus(e.target.value)}><option value="">Any</option>{(["pending", "active", "suspended", "closed"] as const).map((s) => <option key={s} value={s}>{s}</option>)}</Select>
        <Select label="City" value={city} onChange={(e) => setCity(e.target.value)}><option value="">Any</option>{cities.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        {q || status || city || bstatus ? <Button onClick={() => { setQ(""); setStatus(""); setCity(""); setBstatus(""); }}>Clear filters</Button> : null}
      </div>
      <ResourceView res={res} isEmpty={(d) => d.rows.length === 0} empty={{ title: "No outlets registered", description: "Outlets appear after a business is provisioned." }}>
        {(d) => {
          const s = q.toLowerCase();
          const rows = d.rows.filter((r) => (!s || [r.name, r.tenant, r.city ?? "", r.code ?? ""].some((x) => x.toLowerCase().includes(s))) && (!status || r.status === status) && (!city || r.city === city) && (!bstatus || r.tenantStatus === bstatus));
          const active = d.rows.filter((r) => r.status === "active").length;
          return (
            <>
              {d.truncated ? <Notice tone="warning">Showing outlets of the first {fmtNumber(d.businesses)} businesses only.</Notice> : null}
              <p className="hq-count" aria-live="polite">{fmtNumber(rows.length)} of {fmtNumber(d.rows.length)} outlets across {fmtNumber(d.businesses)} businesses ({fmtNumber(active)} active)</p>
              <Table<Row> caption="Outlets" getKey={(r) => r.id} rows={rows} empty={<p className="hq-muted">No outlet matches your filters.</p>} columns={[
                { key: "n", header: "Outlet", render: (r) => <>{r.name}{r.code ? <span className="hq-muted"> ({r.code})</span> : null}</> },
                { key: "t", header: "Business", render: (r) => <Link className="hq-link" href={`/businesses/${r.tenantRef}`}>{r.tenant}</Link> },
                { key: "bs", header: "Business status", render: (r) => <StatusBadge value={r.tenantStatus} /> },
                { key: "c", header: "City", render: (r) => r.city ?? "–" }, { key: "st", header: "State code", render: (r) => r.state_code ?? "–" },
                { key: "s", header: "Outlet status", render: (r) => <StatusBadge value={r.status} /> },
              ]} />
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
