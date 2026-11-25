"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Select, Sheet, Table, useToast } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import type { OnboardingApplication, OnboardingStatus } from "@/lib/api/types";
import { fmtDate, fmtDateTime, titleCase } from "@/lib/format";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { DefList, InlineError, PageHeader, Pager, ReasonDialog, ResourceView, StatusBadge } from "@/components/ui";

const STATUSES: OnboardingStatus[] = ["received", "under_review", "approved", "provisioning", "provisioned", "rejected", "failed"];

export default function OnboardingPage() {
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const res = useResource(() => api.onboarding.list({ status: status || undefined, offset }), `${status}|${offset}`);
  return (
    <>
      <PageHeader title="Onboarding" subtitle="Applications from self-signup, the Partner app and staff intake." />
      <div className="hq-filters">
        <Select label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </Select>
      </div>
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No applications", description: status ? "Nothing with this status." : "New signups will show up here.", actionLabel: status ? "Show all" : undefined, onAction: () => setStatus("") }}>
        {(d) => (
          <>
            <Table<OnboardingApplication> caption="Onboarding applications" getKey={(a) => a.id} rows={d.items} columns={[
              { key: "b", header: "Business", render: (a) => <Button size="sm" variant="ghost" onClick={() => setOpenId(a.id)}>{a.business_name}</Button> },
              { key: "c", header: "Contact", render: (a) => a.contact_name }, { key: "src", header: "Source", render: (a) => titleCase(a.source) },
              { key: "p", header: "Plan", render: (a) => a.plan_code ?? "–" }, { key: "s", header: "Status", render: (a) => <StatusBadge value={a.status} /> }, { key: "d", header: "Received", render: (a) => fmtDate(a.created_at) },
            ]} />
            <Pager page={d} onOffset={setOffset} />
          </>
        )}
      </ResourceView>
      {openId ? <Detail id={openId} onClose={() => setOpenId(null)} onChanged={res.reload} /> : null}
    </>
  );
}

function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const can = useCan();
  const toast = useToast();
  const res = useResource(() => api.onboarding.get(id), id);
  const [reject, setReject] = useState(false);
  const step = useAction(async (kind: "review" | "approve" | "provision") => { await api.onboarding[kind](id); toast.show("Updated", "success"); res.reload(); onChanged(); });
  const a = res.data;
  const manage = can("onboarding.manage");
  const primary = a?.status === "received" ? "review" : a?.status === "under_review" ? "approve" : a?.status === "approved" || a?.status === "failed" ? "provision" : null;
  const label = { review: "Start review", approve: "Approve", provision: a?.status === "failed" ? "Retry provisioning" : "Provision" } as const;
  return (
    <Sheet side="right" open onOpenChange={(o) => !o && onClose()} title={a?.business_name ?? "Application"}
      footer={a && manage ? <>
        {["received", "under_review", "approved", "failed"].includes(a.status) ? <Button variant="danger-soft" onClick={() => setReject(true)}>Reject</Button> : null}
        {a.status === "received" ? <Button onClick={() => void step.run("approve")} loading={step.busy}>Approve now</Button> : null}
        {primary ? <Button variant="primary" loading={step.busy} onClick={() => void step.run(primary)}>{label[primary]}</Button> : null}
      </> : undefined}>
      <ResourceView res={res} isEmpty={() => false} empty={{ title: "" }}>
        {(d) => (
          <div className="hq-stack">
            <DefList items={[["Status", <StatusBadge key="s" value={d.status} />], ["Source", titleCase(d.source)], ["Contact", d.contact_name], ["Email", d.email], ["Phone", d.phone], ["Plan", d.plan_code], ["Attempts", String(d.attempts)], ["Created tenant", d.tenant_id ? <Link key="t" className="hq-link" href={`/businesses/${d.tenant_id}`}>Open business</Link> : "–"]]} />
            {d.last_error ? <p className="hq-inline-error" role="alert">Last error: {d.last_error}</p> : null}
            {d.reject_reason ? <p className="hq-sub">Rejected: {d.reject_reason}</p> : null}
            <InlineError error={step.error} />
            <h3 className="hq-card-title">History</h3>
            <ol>{d.events.map((e) => <li key={e.id}>{fmtDateTime(e.created_at ?? e.at)} · {e.from_status ? `${titleCase(e.from_status)} to ` : ""}<strong>{titleCase(e.to_status)}</strong> by {e.actor}{e.note ? ` (${e.note})` : ""}</li>)}</ol>
          </div>
        )}
      </ResourceView>
      {reject ? <ReasonDialog open onOpenChange={(o) => !o && setReject(false)} title="Reject application" description="The applicant is not told automatically. The reason is kept on the record." confirmLabel="Reject"
        onConfirm={async (reason): Promise<ApiError | undefined> => { try { await api.onboarding.reject(id, reason); toast.show("Rejected", "success"); res.reload(); onChanged(); } catch (e) { return e as ApiError; } }} /> : null}
    </Sheet>
  );
}
