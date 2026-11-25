"use client";
import { useState } from "react";
import { Badge, Button, Card, useToast, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { InviteSheet } from "@/components/invite";
import { InvitationStatus, invitationState } from "@/components/invitation-status";
import { AsyncView, FormError, SubNav } from "@/components/ui";
import { ONBOARDING_NAV } from "@/components/subnavs";
import { useAction, useQuery } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { fmtDateTime } from "@/lib/format";

export default function InvitationsPage() {
  const { user } = useAuth();
  const toast = useToast();
  const q = useQuery("invitations", () => api.invitations.list({ limit: 200 }));
  const [open, setOpen] = useState(false);
  const { run, busy, error } = useAction();
  return (
    <div className="stack">
      <PageHeader title="Invitations" description="Sent, accepted, expired or revoked." actions={<>{can(user?.role, "invitation.create") && <Button variant="primary" onClick={() => setOpen(true)}>Send invite</Button>}</>} />
      <SubNav items={ONBOARDING_NAV} />
      <FormError error={error} />
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No invitations yet", description: "Invite an owner to set a password and accept the terms.", actionLabel: "Send invite", onAction: () => setOpen(true) }}>
        {(rows) => (
          <Card>
            <ul className="list">
              {rows.map((i) => (
                <li key={i.id}>
                  <span className="grow"><span className="title">{i.email}</span><br /><span className="small muted">sent {fmtDateTime(i.created_at)} · expires {fmtDateTime(i.expires_at)}</span></span>
                  <InvitationStatus inv={i} />
                  {i.delivery_status && <Badge tone={i.delivery_status === "sent" ? "success" : "danger"}>{i.delivery_status === "sent" ? "Emailed" : "Email failed"}</Badge>}
                  {invitationState(i) === "Sent" && <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { const r = await run(() => api.invitations.resend(i.id)); if (r) { toast.show(r.delivery_status === "sent" ? "Invite re-sent with a new link" : "Email failed. The old link no longer works; resend again.", r.delivery_status === "sent" ? "success" : "danger"); q.reload(); } }}>Resend</Button>}
                  {invitationState(i) === "Sent" && <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { if (await run(() => api.invitations.revoke(i.id))) { toast.show("Invite revoked", "success"); q.reload(); } }}>Revoke</Button>}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </AsyncView>
      <InviteSheet key={open ? "o" : "c"} open={open} onOpenChange={setOpen} onCreated={q.reload} />
    </div>
  );
}
