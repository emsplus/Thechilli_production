"use client";
import { useState } from "react";
import { Button, Input, Sheet, Table } from "@chilli/ui";
import { api } from "@/lib/api";
import type { AuditEntry } from "@/lib/api/types";
import { fmtDateTime } from "@/lib/format";
import { useTenants } from "@/lib/hooks";
import { useResource } from "@/lib/useResource";
import { DefList, PageHeader, Pager, ResourceView } from "@/components/ui";

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const { nameOf } = useTenants();
  const res = useResource(() => api.logs.audit({ action: action || undefined, offset }), `${action}|${offset}`);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every sensitive action by staff. Entries cannot be edited or deleted." />
      <div className="hq-filters" role="search"><Input label="Action" type="search" value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }} placeholder="e.g. tenant.* or invoice.issued" hint="Use * as a wildcard." /></div>
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: action ? "No matching entries" : "No audit entries yet", description: action ? "Try another action name." : "Actions will be recorded here.", actionLabel: action ? "Clear filter" : undefined, onAction: () => setAction("") }}>
        {(d) => (
          <>
            <Table<AuditEntry> caption="Audit log" getKey={(e) => String(e.id)} rows={d.items} columns={[
              { key: "w", header: "When", render: (e) => fmtDateTime(e.at) }, { key: "a", header: "Who", render: (e) => e.actor_label ?? e.actor_type },
              { key: "ac", header: "Action", render: (e) => <Button size="sm" variant="ghost" onClick={() => setOpen(e)}>{e.action}</Button> },
              { key: "t", header: "Business", render: (e) => (e.tenant_id ? nameOf(e.tenant_id) : "–") }, { key: "ip", header: "IP", render: (e) => e.ip ?? "–" },
            ]} />
            <Pager page={d} onOffset={setOffset} />
          </>
        )}
      </ResourceView>
      {open ? (
        <Sheet side="right" open onOpenChange={(o) => !o && setOpen(null)} title={open.action}>
          <div className="hq-stack">
            <DefList items={[["When", fmtDateTime(open.at)], ["Who", open.actor_label ?? open.actor_type], ["Target", `${open.target_type ?? "–"} ${open.target_id ?? ""}`], ["Business", open.tenant_id ? nameOf(open.tenant_id) : "–"], ["IP", open.ip]]} />
            {(["before", "after", "meta"] as const).map((k) => (open[k] ? <div key={k}><h3 className="hq-card-title">{k[0].toUpperCase() + k.slice(1)}</h3><pre className="hq-pre">{JSON.stringify(open[k], null, 2)}</pre></div> : null))}
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
