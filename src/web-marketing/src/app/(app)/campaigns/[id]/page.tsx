"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button, Card, EmptyState, Select, useToast, PageHeader, StatCard } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, CampaignBadge, FormError, StageBadge } from "@/components/ui";
import { useAction, useQuery } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { fmtDate, fmtMoney, fmtPct } from "@/lib/format";
import { BOARD_STAGES } from "@/lib/pipeline";
import type { CampaignStatus } from "@/lib/api/types";

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const toast = useToast();
  const c = useQuery(`campaign:${id}`, () => api.campaigns.get(id));
  const stats = useQuery(`campaign-stats:${id}`, () => (can(user?.role, "campaign.stats") ? api.campaigns.stats(id) : Promise.resolve(null)));
  const { run, busy, error } = useAction();
  return (
    <AsyncView q={c} rows={3}>
      {(camp) => (
        <div className="stack">
          <PageHeader title={camp.name} description={`${camp.channel} · ${camp.starts_on ? `${fmtDate(camp.starts_on)} to ${camp.ends_on ? fmtDate(camp.ends_on) : "open"}` : "no dates"}`} actions={<><CampaignBadge status={camp.status} />
            <Link href="/campaigns"><Button variant="ghost">All campaigns</Button></Link></>} />
          <FormError error={error} />
          {can(user?.role, "campaign.edit") && (
            <Card><Select label="Status" value={camp.status} disabled={busy} onChange={async (e) => { if (await run(() => api.campaigns.update(camp.id, { status: e.target.value as CampaignStatus }))) { toast.show("Status updated", "success"); c.reload(); } }}>
              {["draft", "active", "paused", "ended"].map((s) => <option key={s}>{s}</option>)}</Select></Card>
          )}
          <h2>Performance</h2>
          <AsyncView q={stats} rows={2}>
            {(s) => !s ? <EmptyState title="Stats are not shown for your role" description="Ask a salesperson or an admin." /> : (
              <>
                <div className="grid kpis">
                  <StatCard label="Leads" value={s.leads} /><StatCard label="Won" value={s.won} /><StatCard label="Conversion" value={fmtPct(s.conversion_bps)} />
                  <StatCard label="Cost per lead" value={s.cost_per_lead_minor === null ? "—" : fmtMoney(s.cost_per_lead_minor, s.currency, { compact: true })} /><StatCard label="Via referral codes" value={s.referral_attributions} />
                </div>
                <Card as="section" aria-labelledby="fn"><h3 id="fn">Funnel</h3>
                  <ul className="list">{BOARD_STAGES.map((st) => <li key={st}><span style={{ width: 130 }}><StageBadge stage={st} /></span><span className="grow"><div className="bar"><span style={{ width: `${s.leads ? (s.by_stage[st] / s.leads) * 100 : 0}%` }} /></div></span><strong>{s.by_stage[st]}</strong></li>)}</ul>
                </Card>
              </>
            )}
          </AsyncView>
        </div>
      )}
    </AsyncView>
  );
}
