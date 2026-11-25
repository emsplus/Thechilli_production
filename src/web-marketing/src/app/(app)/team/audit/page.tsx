"use client";
import { FilterBar } from "@chilli/ui/data";
import { useState } from "react";
import { Button, Card, Select, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, SubNav, NoAccess } from "@/components/ui";
import { TEAM_NAV } from "@/components/subnavs";
import { useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can } from "@/lib/roles";
import { formatAuditMeta } from "@/lib/audit-format";
import { fmtDateTime } from "@/lib/format";

const TYPES = ["", "lead", "activity", "demo", "onboarding_application", "invitation", "commission_entry", "marketing_user", "campaign"];

export default function AuditPage() {
  const { user } = useAuth();
  const { name } = usePeople();
  const [type, setType] = useState("");
  const [limit, setLimit] = useState(50);
  const admin = can(user?.role, "audit.read");
  const q = useQuery(`audit:${type}:${limit}:${admin}`, () => (admin ? api.audit.list({ entity_type: type || undefined, limit }) : Promise.resolve([])));
  if (!admin) return <NoAccess role={user?.role} what="The audit log" />;
  return (
    <div className="stack">
      <PageHeader title="Audit log" description="Who did what. Ids and field names only, no contact details." />
      <SubNav items={TEAM_NAV} />
      <FilterBar><Select label="Entity" value={type} onChange={(e) => { setType(e.target.value); setLimit(50); }}>{TYPES.map((t) => <option key={t} value={t}>{t ? t.replace("_", " ") : "All"}</option>)}</Select></FilterBar>
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No audit entries", description: type ? "Nothing for this entity type." : undefined }}>
        {(rows) => (
          <>
            <Card><ul className="list">{rows.map((a) => (
              <li key={a.id}><span className="grow"><span className="title">{a.action.replace(/[._]/g, " ")}</span><br /><span className="small muted">{name(a.actor_id)} · {a.entity_type.replace("_", " ")} · {fmtDateTime(a.created_at)}</span>{a.meta && <><br /><span className="small muted">{formatAuditMeta(a.meta)}</span></>}</span></li>))}</ul></Card>
            {rows.length >= limit && <div><Button onClick={() => setLimit((n) => n + 50)}>Show more</Button></div>}
          </>
        )}
      </AsyncView>
    </div>
  );
}
