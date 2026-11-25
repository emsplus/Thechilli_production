"use client";
import Link from "next/link";
import { useState } from "react";
import { Button, EmptyState, Input, Select, Sheet, StatCard, useToast, PageHeader } from "@chilli/ui";
import { DataTable, FilterBar } from "@chilli/ui/data";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, CampaignBadge, FormError } from "@/components/ui";
import { useAction, useMediaQuery, useQuery } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { CampaignOut, CampaignStatus } from "@/lib/api/types";

const STATUSES: CampaignStatus[] = ["active", "draft", "paused", "ended"];
const STATUS_ORDER: Record<CampaignStatus, number> = { active: 0, paused: 1, draft: 2, ended: 3 };
const dates = (c: CampaignOut) => (c.starts_on ? `${fmtDate(c.starts_on)} to ${c.ends_on ? fmtDate(c.ends_on) : "open"}` : "No dates set");

export default function CampaignsPage() {
  const { user } = useAuth();
  const q = useQuery("campaigns", () => api.campaigns.list());
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<CampaignStatus | "">("");
  const term = search.trim().toLowerCase();
  const phone = useMediaQuery("(max-width: 767px)");
  const reset = () => { setSearch(""); setStatus(""); };
  return (
    <div className="stack">
      <PageHeader title="Campaigns" description="Where leads come from, and what each source delivers." actions={<>{can(user?.role, "campaign.edit") && <Button variant="primary" onClick={() => setOpen(true)}>+ Campaign</Button>}</>} />
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No campaigns yet", description: user?.role === "marketing_admin" ? "Create a campaign to track where leads come from." : "An admin creates campaigns.", ...(can(user?.role, "campaign.edit") ? { actionLabel: "+ Campaign", onAction: () => setOpen(true) } : {}) }}>
        {(all) => {
          const active = all.filter((c) => c.status === "active");
          const rows = all
            .filter((c) => (!status || c.status === status) && (!term || `${c.name} ${c.channel}`.toLowerCase().includes(term)))
            .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.created_at.localeCompare(a.created_at));
          return (
            <>
              <div className="grid kpis">
                <StatCard label="Active" value={active.length} />
                <StatCard label="Draft or paused" value={all.filter((c) => c.status === "draft" || c.status === "paused").length} />
                <StatCard label="Active budget" value={fmtMoney(active.reduce((s, c) => s + c.budget_minor, 0), "INR", { compact: true })} />
                <StatCard label="All campaigns" value={all.length} />
              </div>
              <FilterBar activeCount={(term ? 1 : 0) + (status ? 1 : 0)} onReset={reset}>
                <div className="search"><Input label="Search" type="search" placeholder="Name or channel" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
                <Select label="Show" value={status} onChange={(e) => setStatus(e.target.value as CampaignStatus | "")}>
                  <option value="">All statuses</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
                </Select>
              </FilterBar>
              {rows.length === 0 ? <EmptyState title="No campaigns match" description="Try a different search or clear the filters." actionLabel="Clear filters" onAction={reset} /> : (
                !phone ? (
                    <DataTable<CampaignOut> caption="Campaigns" getKey={(c) => c.id} rows={rows} exportName="campaigns"
                      columns={[
                        { key: "n", header: "Campaign", render: (c) => <Link href={`/campaigns/${c.id}`} className="title">{c.name}</Link>, sortValue: (c) => c.name },
                        { key: "ch", header: "Channel", render: (c) => c.channel, sortValue: (c) => c.channel },
                        { key: "s", header: "Status", render: (c) => <CampaignBadge status={c.status} />, sortValue: (c) => STATUS_ORDER[c.status], csv: (c) => c.status },
                        { key: "d", header: "Runs", render: (c) => dates(c), sortValue: (c) => c.starts_on ?? "", csv: (c) => dates(c) },
                        { key: "b", header: "Budget", align: "end", render: (c) => <span className="mono">{fmtMoney(c.budget_minor, c.currency)}</span>, sortValue: (c) => c.budget_minor, csv: (c) => c.budget_minor / 100 },
                      ]} />
                ) : (
                  <ul className="list" aria-label="Campaigns">
                    {rows.map((c) => (
                      <li key={c.id}>
                        <span className="grow">
                          <Link href={`/campaigns/${c.id}`} className="title">{c.name}</Link>
                          <span className="small muted">{c.channel} · budget <span className="mono">{fmtMoney(c.budget_minor, c.currency)}</span></span><br />
                          <span className="small muted">{dates(c)}</span>
                        </span>
                        <CampaignBadge status={c.status} />
                      </li>
                    ))}
                  </ul>
                )
              )}
            </>
          );
        }}
      </AsyncView>
      <CampaignSheet key={open ? "o" : "c"} open={open} onOpenChange={setOpen} onDone={q.reload} />
    </div>
  );
}

function CampaignSheet({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", channel: "whatsapp", status: "draft" as CampaignStatus, budget: "", starts: "", ends: "" });
  const { run, busy, error } = useAction();
  async function save() {
    const r = await run(() => api.campaigns.create({ name: f.name.trim(), channel: f.channel.trim(), status: f.status, budget_minor: Math.round(Number(f.budget || 0) * 100), currency: "INR", starts_on: f.starts || null, ends_on: f.ends || null }));
    if (r) { toast.show("Campaign created", "success"); onOpenChange(false); onDone(); }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="New campaign"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f.name.trim() || !f.channel.trim()} onClick={save}>Create</Button></>}>
      <div className="stack-sm">
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="Channel" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} hint="e.g. whatsapp, events, referral" />
        <Select label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as CampaignStatus })}>{["draft", "active", "paused", "ended"].map((s) => <option key={s}>{s}</option>)}</Select>
        <Input label="Budget (₹)" type="number" inputMode="decimal" min={0} value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} />
        <Input label="Starts" type="date" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} />
        <Input label="Ends" type="date" value={f.ends} onChange={(e) => setF({ ...f, ends: e.target.value })} />
        <FormError error={error} />
      </div>
    </Sheet>
  );
}
