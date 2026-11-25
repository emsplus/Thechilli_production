"use client";
import Link from "next/link";
import { Button, Card, PageHeader, StatCard } from "@chilli/ui";
import { useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AppStatusBadge, AsyncView, StageBadge } from "@/components/ui";
import { useAction, useQuery } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { endOfToday, fmtDateTime, fmtTime, isOverdue, startOfToday } from "@/lib/format";
import { BOARD_STAGES, STAGE_LABEL } from "@/lib/pipeline";
import { fetchAll } from "@/lib/fetchAll";
import type { ActivityOut, LeadOut } from "@/lib/api/types";

export default function MyDayPage() {
  const { user } = useAuth();
  const role = user?.role;
  const canLead = can(role, "lead.write");
  return (
    <div className="stack">
      <PageHeader title={`Hello, ${user?.name.split(" ")[0] ?? ""}`} description={new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })} actions={<>{canLead ? <Link href="/leads/new"><Button variant="primary">+ Lead</Button></Link>
          : can(role, "onboarding.create") && <Link href="/onboarding/new"><Button variant="primary">+ Application</Button></Link>}</>} />
      <div className="grid two">
        <FollowUps />
        <Demos />
      </div>
      <div className="grid two">
        {role !== "onboarding_agent" && <PipelineSummary />}
        <Applications />
      </div>
      {can(role, "commission.decide") && <PendingCommissions />}
    </div>
  );
}

function FollowUps() {
  const toast = useToast();
  const q = useQuery<ActivityOut[]>("follow-ups-today", () => api.activities.list({ status: "pending", due_before: endOfToday().toISOString() }));
  const { run, busy } = useAction();
  return (
    <Card as="section" aria-labelledby="fu">
      <div className="between"><h2 id="fu">Follow-ups due today</h2><Link href="/follow-ups" className="small">All follow-ups</Link></div>
      <AsyncView q={q} rows={3} isEmpty={(d) => d.length === 0} empty={{ title: "Nothing due today", description: "Log a follow-up on a lead to see it here." }}>
        {(rows) => (
          <ul className="list">
            {rows.map((a) => (
              <li key={a.id}>
                <span className="grow">
                  <Link href={`/leads/${a.lead_id}`} className="title">{a.summary}</Link>
                  <br /><span className={`small ${isOverdue(a.due_at) ? "" : "muted"}`} style={isOverdue(a.due_at) ? { color: "var(--c-danger-fg)" } : undefined}>{a.type.replace("_", " ")} · {isOverdue(a.due_at) ? "overdue, " : ""}{fmtDateTime(a.due_at)}</span>
                </span>
                <Button size="sm" disabled={busy} onClick={async () => { if (await run(() => api.activities.complete(a.id))) { toast.show("Marked done", "success"); q.reload(); } }}>Done</Button>
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </Card>
  );
}

function Demos() {
  const q = useQuery("demos-today", () => api.demos.list({ status: "scheduled", start: startOfToday().toISOString(), end: endOfToday().toISOString() }));
  return (
    <Card as="section" aria-labelledby="dm">
      <div className="between"><h2 id="dm">Demos today</h2><Link href="/demos" className="small">All demos</Link></div>
      <AsyncView q={q} rows={2} isEmpty={(d) => d.length === 0} empty={{ title: "No demos today" }}>
        {(rows) => (
          <ul className="list">
            {rows.map((d) => (
              <li key={d.id}><span className="grow"><Link href={`/leads/${d.lead_id}`} className="title">{fmtTime(d.scheduled_at)} · {d.duration_minutes} min</Link><br /><span className="small muted">{d.mode === "online" ? "Online" : d.location ?? "On site"}</span></span></li>
            ))}
          </ul>
        )}
      </AsyncView>
    </Card>
  );
}

function PipelineSummary() {
  const q = useQuery<LeadOut[]>("pipeline-summary", () => fetchAll((offset, limit) => api.leads.list({ limit, offset })));
  return (
    <Card as="section" aria-labelledby="pl">
      <div className="between"><h2 id="pl">Pipeline</h2><Link href="/leads/pipeline" className="small">Open board</Link></div>
      <AsyncView q={q} rows={3} isEmpty={(d) => d.length === 0} empty={{ title: "No leads yet", description: "Add your first lead to start the pipeline." }}>
        {(leads) => {
          const count = (s: string) => leads.filter((l) => l.stage === s).length;
          const max = Math.max(1, ...BOARD_STAGES.map(count));
          return (
            <ul className="list">
              {BOARD_STAGES.map((s) => (
                <li key={s}>
                  <span style={{ width: 120 }}><StageBadge stage={s} /></span>
                  <span className="grow"><div className="bar" role="img" aria-label={`${count(s)} ${STAGE_LABEL[s]}`}><span style={{ width: `${(count(s) / max) * 100}%` }} /></div></span>
                  <strong style={{ width: 28, textAlign: "end" }}>{count(s)}</strong>
                </li>
              ))}
            </ul>
          );
        }}
      </AsyncView>
    </Card>
  );
}

function Applications() {
  const q = useQuery("apps-blocked", () => api.onboarding.list({ limit: 50 }));
  return (
    <Card as="section" aria-labelledby="ap">
      <div className="between"><h2 id="ap">Applications needing work</h2><Link href="/onboarding" className="small">All applications</Link></div>
      <AsyncView q={q} rows={2} isEmpty={(d) => d.filter((a) => a.status === "draft" || a.status === "in_progress").length === 0} empty={{ title: "Nothing blocked", description: "Applications that are not yet ready show up here." }}>
        {(apps) => (
          <ul className="list">
            {apps.filter((a) => a.status === "draft" || a.status === "in_progress").map((a) => (
              <li key={a.id}><span className="grow"><Link href={`/onboarding/${a.id}`} className="title">{a.business_name}</Link></span><AppStatusBadge status={a.status} /></li>
            ))}
          </ul>
        )}
      </AsyncView>
    </Card>
  );
}

function PendingCommissions() {
  const q = useQuery("pending-commissions", () => api.commissions.entries({ status: "pending", limit: 50 }));
  return (
    <Card as="section" aria-labelledby="pc">
      <div className="between"><h2 id="pc">Commissions to review</h2><Link href="/earnings" className="small">Open ledger</Link></div>
      <AsyncView q={q} rows={1} isEmpty={(d) => d.length === 0} empty={{ title: "All caught up" }}>
        {(rows) => <div className="grid kpis"><Link href="/earnings" className="plain-link"><StatCard label="Pending entries" value={rows.length} /></Link></div>}
      </AsyncView>
    </Card>
  );
}
