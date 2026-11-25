"use client";
import Link from "next/link";
import { FilterBar } from "@chilli/ui/data";
import { useState } from "react";
import { Button, Input, Select, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, StageBadge, SubNav } from "@/components/ui";
import { useDebounced, useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can } from "@/lib/roles";
import { BOARD_STAGES, STAGE_LABEL } from "@/lib/pipeline";
import { leadsNav } from "@/components/subnavs";
import { fmtDate } from "@/lib/format";
import type { LeadStage } from "@/lib/api/types";

export default function LeadsPage() {
  const { user } = useAuth();
  const { users, name } = usePeople();
  const campaigns = useQuery("campaigns", () => api.campaigns.list());
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<LeadStage | "">("");
  const [owner, setOwner] = useState(""); // "" all | "unassigned" | user id
  const [campaign, setCampaign] = useState("");
  const [limit, setLimit] = useState(50);
  const q0 = useDebounced(search.trim());
  const q = useQuery(`leads:${q0}:${stage}:${owner}:${campaign}:${limit}`, () =>
    api.leads.list({ q: q0 || undefined, stage: stage || undefined, unassigned: owner === "unassigned" || undefined, owner_id: owner && owner !== "unassigned" ? owner : undefined, campaign_id: campaign || undefined, limit }));
  const filtered = !!(q0 || stage || owner || campaign);

  return (
    <div className="stack">
      <PageHeader title="Leads" actions={<>{can(user?.role, "lead.write") && <Link href="/leads/new"><Button variant="primary">+ Lead</Button></Link>}</>} />
      <SubNav items={leadsNav(user?.role)} />
      <FilterBar>
        <div className="search"><Input label="Search" type="search" placeholder="Business, contact, phone or email" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(50); }} /></div>
        <Select label="Stage" value={stage} onChange={(e) => { setStage(e.target.value as LeadStage | ""); setLimit(50); }}>
          <option value="">All stages</option>
          {BOARD_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </Select>
        <Select label="Owner" value={owner} onChange={(e) => { setOwner(e.target.value); setLimit(50); }}>
          <option value="">Everyone</option>
          <option value="unassigned">Unassigned</option>
          {users.filter((u) => u.role !== "onboarding_agent").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <Select label="Campaign" value={campaign} onChange={(e) => { setCampaign(e.target.value); setLimit(50); }}>
          <option value="">All campaigns</option>
          {(campaigns.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </FilterBar>
      <AsyncView q={q} isEmpty={(d) => d.length === 0}
        empty={filtered ? { title: "No leads match", description: "Try a different search or clear the filters.", actionLabel: "Clear filters", onAction: () => { setSearch(""); setStage(""); setOwner(""); setCampaign(""); } }
          : { title: "No leads yet", description: user?.role === "onboarding_agent" ? "Leads linked to your applications appear here." : "Add your first lead to get started." }}>
        {(leads) => (
          <>
            <ul className="list">
              {leads.map((l) => (
                <li key={l.id}>
                  <span className="grow">
                    <Link href={`/leads/${l.id}`} className="title">{l.business_name}</Link><br />
                    <span className="small muted">{l.contact_name}{l.city ? ` · ${l.city}` : ""}{l.phone ? ` · ${l.phone}` : ""}</span><br />
                    <span className="small muted">{name(l.owner_id)} · added {fmtDate(l.created_at)}</span>
                  </span>
                  <StageBadge stage={l.stage} />
                </li>
              ))}
            </ul>
            {leads.length >= limit && <div><Button onClick={() => setLimit((n) => n + 50)}>Show more</Button></div>}
          </>
        )}
      </AsyncView>
    </div>
  );
}
