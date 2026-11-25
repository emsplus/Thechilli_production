"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { MergeLeadDialog } from "@/components/merge-lead";
import { Button, Card, Dialog, Input, PageHeader, Select, Sheet, Textarea, useToast, Checkbox } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { InviteSheet } from "@/components/invite";
import { AppStatusBadge, AsyncView, DemoBadge, FormError, StageBadge, statusLabel } from "@/components/ui";
import { useAction, useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can } from "@/lib/roles";
import { fmtDate, fmtDateTime, inputAt } from "@/lib/format";
import { allowedStages, STAGE_LABEL } from "@/lib/pipeline";
import type { ActivityType, LeadOut, LeadStage } from "@/lib/api/types";

const ACTIVITY_TYPES: ActivityType[] = ["call", "whatsapp", "visit", "email", "follow_up", "note"];

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const lead = useQuery(`lead:${id}`, () => api.leads.get(id));
  return (
    <AsyncView q={lead} rows={5}>
      {(l) => <LeadView lead={l} reload={lead.reload} />}
    </AsyncView>
  );
}

function LeadView({ lead, reload }: { lead: LeadOut; reload: () => void }) {
  const [demoVersion, setDemoVersion] = useState(0);
  const { user } = useAuth();
  const role = user?.role;
  const router = useRouter();
  const toast = useToast();
  const { name, users } = usePeople();
  const write = can(role, "lead.write");
  const act = useAction();
  const [lostOpen, setLostOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [demoOpen, setDemoOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [assignTo, setAssignTo] = useState(lead.owner_id ?? "");

  async function stage(to: LeadStage, why?: string) {
    if (await act.run(() => api.leads.setStage(lead.id, to, why))) { toast.show(`Moved to ${STAGE_LABEL[to]}`, "success"); reload(); }
  }
  async function assign(owner: string | null) {
    if (await act.run(() => api.leads.assign(lead.id, owner))) { toast.show(owner ? "Assigned" : "Unassigned", "success"); reload(); }
  }
  async function startOnboarding() {
    const a = await act.run(() => api.onboarding.create({ lead_id: lead.id }));
    if (a) router.push(`/onboarding/${a.id}`);
  }
  const apps = useQuery(`lead-apps:${lead.id}`, async () => (await api.onboarding.list({ limit: 200 })).filter((a) => a.lead_id === lead.id));

  return (
    <div className="stack">
      <PageHeader title={lead.business_name} description={`${lead.contact_name}${lead.city ? ` · ${lead.city}` : ""}`} actions={<><StageBadge stage={lead.stage} />
        {write && <Link href={`/leads/${lead.id}/edit`}><Button>Edit</Button></Link>}
        {write && lead.stage !== "won" && <Button onClick={() => setDemoOpen(true)}>Schedule demo</Button>}
        {can(role, "invitation.create") && <Button onClick={() => setInviteOpen(true)}>Send invite</Button>}
        {write && lead.stage !== "lost" && <Button variant="ghost" onClick={() => setMergeOpen(true)}>Merge duplicate</Button>}</>} />
      <FormError error={act.error} />

      <div className="grid two">
        <Card as="section" aria-labelledby="det">
          <h2 id="det">Details</h2>
          <dl style={{ margin: "var(--space-12) 0 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px" }}>
            <dt className="muted">Phone</dt><dd style={{ margin: 0 }}>{lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : "—"}</dd>
            <dt className="muted">Email</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{lead.email ?? "—"}</dd>
            <dt className="muted">Type</dt><dd style={{ margin: 0 }}>{lead.business_type ? statusLabel(lead.business_type) : "—"}</dd>
            <dt className="muted">Source</dt><dd style={{ margin: 0 }}>{statusLabel(lead.source)}</dd>
            <dt className="muted">Owner</dt><dd style={{ margin: 0 }}>{name(lead.owner_id)}</dd>
            <dt className="muted">Added</dt><dd style={{ margin: 0 }}>{fmtDate(lead.created_at)}</dd>
            {lead.lost_reason && <><dt className="muted">Lost because</dt><dd style={{ margin: 0 }}>{lead.lost_reason}</dd></>}
          </dl>
          {lead.notes && <p className="small" style={{ marginTop: 12 }}>{lead.notes}</p>}
        </Card>

        <Card as="section" aria-labelledby="stg">
          <h2 id="stg">Stage and owner</h2>
          <div className="stack-sm" style={{ marginTop: 12 }}>
            {write && allowedStages(lead.stage).length > 0 ? (
              <Select label="Move to stage" value="" disabled={act.busy} onChange={(e) => { const to = e.target.value as LeadStage; if (to === "lost") { setReason(""); setLostOpen(true); } else if (to) void stage(to); }}>
                <option value="">Current: {STAGE_LABEL[lead.stage]}</option>
                {allowedStages(lead.stage).map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
              </Select>
            ) : <p className="muted small">{lead.stage === "won" ? "Won: set by provisioning, no further moves." : "You cannot change the stage."}</p>}
            {can(role, "lead.assign") && (
              <div className="row" style={{ alignItems: "end" }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Select label="Assign to" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                    <option value="">Unassigned</option>
                    {users.filter((u) => u.is_active && u.role !== "onboarding_agent").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </Select>
                </div>
                <Button disabled={act.busy || assignTo === (lead.owner_id ?? "")} onClick={() => assign(assignTo || null)}>Save</Button>
              </div>
            )}
            {can(role, "lead.claim") && !lead.owner_id && user && <div><Button disabled={act.busy} onClick={() => assign(user.id)}>Claim this lead</Button></div>}
          </div>
        </Card>
      </div>

      <ActivitiesCard lead={lead} canWrite={write} />
      <DemosCard leadId={lead.id} version={demoVersion} />

      <Card as="section" aria-labelledby="onb">
        <div className="between"><h2 id="onb">Onboarding</h2>
          {can(role, "onboarding.create") && lead.stage !== "won" && lead.stage !== "lost" && <Button disabled={act.busy} onClick={startOnboarding}>Start onboarding</Button>}
        </div>
        <AsyncView q={apps} rows={1} isEmpty={(d) => d.length === 0} empty={{ title: "No application yet", description: role === "salesperson" ? "An admin or onboarding agent starts the application after the demo." : "Start onboarding after the demo." }}>
          {(rows) => <ul className="list">{rows.map((a) => <li key={a.id}><Link href={`/onboarding/${a.id}`} className="title grow">{a.business_name}</Link><AppStatusBadge status={a.status} /></li>)}</ul>}
        </AsyncView>
      </Card>

      <Dialog open={lostOpen} onOpenChange={setLostOpen} title="Mark lead as lost" description="A reason is required."
        footer={<><Button variant="ghost" onClick={() => setLostOpen(false)}>Cancel</Button><Button variant="danger-soft" disabled={!reason.trim()} onClick={() => { setLostOpen(false); void stage("lost", reason.trim()); }}>Mark lost</Button></>}>
        <Textarea label="Why was it lost?" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Dialog>
      <MergeLeadDialog lead={lead} open={mergeOpen} onOpenChange={setMergeOpen} onMerged={reload} />
      <DemoSheet open={demoOpen} onOpenChange={setDemoOpen} leadId={lead.id} onDone={() => { setDemoVersion((v) => v + 1); reload(); }} />
      <InviteSheet key={inviteOpen ? "o" : "c"} open={inviteOpen} onOpenChange={setInviteOpen} leadId={lead.id} defaultEmail={lead.email} />
    </div>
  );
}

function ActivitiesCard({ lead, canWrite }: { lead: LeadOut; canWrite: boolean }) {
  const toast = useToast();
  const q = useQuery(`acts:${lead.id}`, () => api.leads.activities(lead.id));
  const { run, busy, error } = useAction();
  const [type, setType] = useState<ActivityType>("call");
  const [summary, setSummary] = useState("");
  const [due, setDue] = useState("");
  const [done, setDone] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    const r = await run(() => api.leads.addActivity(lead.id, { type, summary: summary.trim(), due_at: due ? new Date(due).toISOString() : null, completed: done }));
    if (r) { toast.show(done ? "Activity logged" : "Follow-up added", "success"); setSummary(""); setDue(""); setDone(false); q.reload(); }
  }
  return (
    <Card as="section" aria-labelledby="act">
      <h2 id="act">Activity and follow-ups</h2>
      {canWrite && (
        <form onSubmit={add} className="stack-sm" style={{ margin: "var(--space-12) 0" }}>
          <div className="grid form">
            <Select label="Type" value={type} onChange={(e) => setType(e.target.value as ActivityType)}>{ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</Select>
            <Input label="What" value={summary} onChange={(e) => setSummary(e.target.value)} required />
            <Input label="Due (optional)" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
          <Checkbox label="Already done (log it)" checked={done} onChange={(e) => setDone(e.target.checked)} />
          <FormError error={error} />
          <div><Button type="submit" variant="primary" loading={busy} disabled={!summary.trim()}>{done ? "Log activity" : "Add follow-up"}</Button></div>
        </form>
      )}
      <AsyncView q={q} rows={2} isEmpty={(d) => d.length === 0} empty={{ title: "No activity yet", description: "Log a call or plan the next follow-up." }}>
        {(rows) => (
          <ul className="list">
            {rows.map((a) => (
              <li key={a.id}>
                <span className="grow"><span className="title">{a.summary}</span><br /><span className="small muted">{a.type.replace("_", " ")} · {a.completed_at ? `done ${fmtDateTime(a.completed_at)}` : a.due_at ? `due ${fmtDateTime(a.due_at)}` : "no due date"}</span></span>
                {canWrite && !a.completed_at && <Button size="sm" onClick={async () => { if (await run(() => api.activities.complete(a.id))) q.reload(); }}>Done</Button>}
              </li>
            ))}
          </ul>
        )}
      </AsyncView>
    </Card>
  );
}

function DemosCard({ leadId, version }: { leadId: string; version: number }) {
  const q = useQuery(`lead-demos:${leadId}:${version}`, () => api.demos.list({ lead_id: leadId }));
  return (
    <Card as="section" aria-labelledby="dms">
      <h2 id="dms">Demos</h2>
      <AsyncView q={q} rows={1} isEmpty={(d) => d.length === 0} empty={{ title: "No demo scheduled" }}>
        {(rows) => <ul className="list">{rows.map((d) => <li key={d.id}><span className="grow">{fmtDateTime(d.scheduled_at)} · {d.duration_minutes} min · {d.mode === "online" ? "Online" : d.location ?? "On site"}</span><DemoBadge status={d.status} /></li>)}</ul>}
      </AsyncView>
    </Card>
  );
}

function DemoSheet({ open, onOpenChange, leadId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; leadId: string; onDone: () => void }) {
  const toast = useToast();
  const [when, setWhen] = useState(() => inputAt(1, 11));
  const [dur, setDur] = useState("30");
  const [mode, setMode] = useState<"online" | "on_site">("online");
  const [place, setPlace] = useState("");
  const { run, busy, error } = useAction();
  const chips = [["Tomorrow 11 am", 1, 11], ["Tomorrow 4 pm", 1, 16], ["In 2 days 11 am", 2, 11]] as const;
  const chip = (days: number, h: number) => setWhen(inputAt(days, h));

  async function save() {
    const r = await run(() => api.leads.scheduleDemo(leadId, { scheduled_at: new Date(when).toISOString(), duration_minutes: Number(dur), mode, location: mode === "on_site" ? place || null : null }));
    if (r) { toast.show("Demo scheduled", "success"); onOpenChange(false); onDone(); }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Schedule demo" description="The lead moves to Demo scheduled."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!when} onClick={save}>Schedule</Button></>}>
      <div className="stack-sm">
        <div className="row">{chips.map(([l, d, h]) => <Button key={l} size="sm" onClick={() => chip(d, h)}>{l}</Button>)}</div>
        <Input label="Date and time" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <Select label="Length" value={dur} onChange={(e) => setDur(e.target.value)}>{["15", "30", "45", "60"].map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select>
        <Select label="Mode" value={mode} onChange={(e) => setMode(e.target.value as "online" | "on_site")}><option value="online">Online</option><option value="on_site">On site</option></Select>
        {mode === "on_site" && <Input label="Place" value={place} onChange={(e) => setPlace(e.target.value)} />}
        <FormError error={error} />
      </div>
    </Sheet>
  );
}
