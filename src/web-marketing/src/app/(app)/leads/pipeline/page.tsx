"use client";
import Link from "next/link";
import { useState } from "react";
import { Button, Dialog, PageHeader, Select, Textarea, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, FormError, SubNav } from "@/components/ui";
import { leadsNav } from "@/components/subnavs";
import { useAction, useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can } from "@/lib/roles";
import { fetchAll } from "@/lib/fetchAll";
import { allowedStages, BOARD_STAGES, STAGE_LABEL } from "@/lib/pipeline";
import type { LeadOut, LeadStage } from "@/lib/api/types";

/** Kanban-lite: columns per stage, cards move with a native select (works on phones, no drag and drop). */
export default function PipelinePage() {
  const { user } = useAuth();
  const { name } = usePeople();
  const toast = useToast();
  const q = useQuery<LeadOut[]>("board", () => fetchAll((offset, limit) => api.leads.list({ limit, offset })));
  const move = useAction();
  const [pendingLost, setPendingLost] = useState<LeadOut | null>(null);
  const [reason, setReason] = useState("");
  const canMove = can(user?.role, "lead.write");

  async function setStage(l: LeadOut, stage: LeadStage, lost_reason?: string) {
    const r = await move.run(() => api.leads.setStage(l.id, stage, lost_reason));
    if (r) { toast.show(`${l.business_name} moved to ${STAGE_LABEL[stage]}`, "success"); q.reload(); }
    else toast.show("Could not move the lead", "danger");
  }

  return (
    <div className="stack">
      <PageHeader title="Pipeline" description="Move a lead with the stage menu on its card." actions={<>{canMove && <Link href="/leads/new"><Button variant="primary">+ Lead</Button></Link>}</>} />
      <SubNav items={leadsNav(user?.role)} />
      <FormError error={move.error} />
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No leads in the pipeline", description: "Add a lead to see it here." }}>
        {(leads) => (
          <div className="board" role="list" aria-label="Pipeline stages">
            {BOARD_STAGES.map((s) => {
              const col = leads.filter((l) => l.stage === s);
              return (
                <section key={s} className="col" role="listitem" aria-label={`${STAGE_LABEL[s]}, ${col.length} leads`}>
                  <div className="col-head"><span>{STAGE_LABEL[s]}</span><span className="muted">{col.length}</span></div>
                  <div className="col-body">
                    {col.length === 0 && <p className="small muted" style={{ padding: 8 }}>Empty</p>}
                    {col.map((l) => (
                      <div key={l.id} className="card-lite">
                        <Link href={`/leads/${l.id}`} className="t">{l.business_name}</Link>
                        <span className="small muted">{l.contact_name}{l.city ? ` · ${l.city}` : ""}</span>
                        <span className="small muted">{name(l.owner_id)}</span>
                        {canMove && allowedStages(l.stage).length > 0 && (
                          <Select label="Move to" value="" disabled={move.busy}
                            onChange={(e) => { const to = e.target.value as LeadStage; if (to === "lost") { setPendingLost(l); setReason(""); } else void setStage(l, to); }}>
                            <option value="">Move to...</option>
                            {allowedStages(l.stage).map((to) => <option key={to} value={to}>{STAGE_LABEL[to]}</option>)}
                          </Select>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </AsyncView>
      <Dialog open={!!pendingLost} onOpenChange={(o) => !o && setPendingLost(null)} title="Mark lead as lost"
        description={pendingLost?.business_name}
        footer={<><Button variant="ghost" onClick={() => setPendingLost(null)}>Cancel</Button>
          <Button variant="danger-soft" disabled={!reason.trim() || move.busy} onClick={async () => { const l = pendingLost!; setPendingLost(null); await setStage(l, "lost", reason.trim()); }}>Mark lost</Button></>}>
        <Textarea label="Why was it lost?" value={reason} onChange={(e) => setReason(e.target.value)} required />
      </Dialog>
    </div>
  );
}
