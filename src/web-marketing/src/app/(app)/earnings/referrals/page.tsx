"use client";
import { useState } from "react";
import { Badge, Button, Card, Input, Select, Sheet, useToast, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, FormError, SubNav, NoAccess } from "@/components/ui";
import { earningsNav } from "@/components/subnavs";
import { useAction, useQuery } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { fmtDate } from "@/lib/format";
import type { ReferralOut } from "@/lib/api/types";
import { usePeople } from "@/lib/people";

export default function ReferralsPage() {
  const { user } = useAuth();
  const { name } = usePeople();
  const toast = useToast();
  const q = useQuery("referrals", () => api.referrals.list());
  const campaigns = useQuery("campaigns", () => api.campaigns.list());
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: "", campaign: "", max: "" });
  const [openId, setOpenId] = useState<string | null>(null);
  const create = useAction();
  const toggle = useAction();
  if (!can(user?.role, "referral.manage")) return <NoAccess role={user?.role} what="Referral codes" needs="salespeople and marketing admins" />;
  const campaignName = (id: string | null) => campaigns.data?.find((c) => c.id === id)?.name;

  async function save() {
    const r = await create.run(() => api.referrals.create({ code: f.code.trim() || null, campaign_id: f.campaign || null, max_uses: f.max ? Number(f.max) : null }));
    if (r) { toast.show(`Code ${r.code} created`, "success"); setOpen(false); setF({ code: "", campaign: "", max: "" }); q.reload(); }
  }
  return (
    <div className="stack">
      <PageHeader title="Referral codes" description="Share a code. Leads and businesses that use it are credited to you." actions={<><Button variant="primary" onClick={() => setOpen(true)}>+ Code</Button></>} />
      <SubNav items={earningsNav(user?.role)} />
      <FormError error={toggle.error} />
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No referral codes", description: "Create a code to track who you bring in.", actionLabel: "New code", onAction: () => setOpen(true) }}>
        {(rows) => (
          <Card>
            <ul className="list">
              {rows.map((r) => (
                <li key={r.id} style={{ flexWrap: "wrap" }}>
                  <span className="grow">
                    <span className="title mono">{r.code}</span> {!r.is_active && <Badge tone="neutral">off</Badge>}<br />
                    <span className="small muted">{r.uses}{r.max_uses ? ` of ${r.max_uses}` : ""} uses{admin(user?.role) ? ` · ${name(r.owner_id)}` : ""}{campaignName(r.campaign_id) ? ` · ${campaignName(r.campaign_id)}` : ""}{r.expires_at ? ` · expires ${fmtDate(r.expires_at)}` : ""}</span>
                  </span>
                  <Button size="sm" onClick={() => setOpenId(openId === r.id ? null : r.id)} aria-expanded={openId === r.id}>Who used it</Button>
                  <Button size="sm" variant="ghost" disabled={toggle.busy} onClick={async () => { if (await toggle.run(() => api.referrals.update(r.id, { is_active: !r.is_active }))) q.reload(); }}>{r.is_active ? "Turn off" : "Turn on"}</Button>
                  {openId === r.id && <div style={{ flexBasis: "100%" }}><Attributions code={r} /></div>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </AsyncView>
      <Sheet open={open} onOpenChange={setOpen} title="New referral code" description="Leave the code empty to generate one."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.busy} onClick={save}>Create</Button></>}>
        <div className="stack-sm">
          <Input label="Code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} hint="4 to 32 letters or numbers" />
          <Select label="Campaign" value={f.campaign} onChange={(e) => setF({ ...f, campaign: e.target.value })}><option value="">None</option>{(campaigns.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
          <Input label="Max uses" type="number" inputMode="numeric" min={1} value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} hint="Optional" />
          <FormError error={create.error} />
        </div>
      </Sheet>
    </div>
  );
}
const admin = (r?: string) => r === "marketing_admin";

function Attributions({ code }: { code: ReferralOut }) {
  const q = useQuery(`attr:${code.id}`, () => api.referrals.attributions(code.id));
  return (
    <AsyncView q={q} rows={1} isEmpty={(d) => d.length === 0} empty={{ title: "Nobody yet" }}>
      {(rows) => <ul className="small">{rows.map((a) => <li key={a.id}>{a.application_id ? "Business application" : "Lead"} · {fmtDate(a.created_at)}</li>)}</ul>}
    </AsyncView>
  );
}
