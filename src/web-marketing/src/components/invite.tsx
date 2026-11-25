"use client";
import { useState } from "react";
import { Button, Input, Notice, Sheet, useToast, Checkbox } from "@chilli/ui";
import { api } from "@/lib/api";
import { FormError } from "./ui";
import { useAction } from "@/lib/hooks";
import type { InvitationCreated } from "@/lib/api/types";

/** Create an invitation. The token is shown exactly once (the server stores only its hash). */
export function InviteSheet({ open, onOpenChange, leadId, applicationId, defaultEmail, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; leadId?: string | null; applicationId?: string | null; defaultEmail?: string | null; onCreated?: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [sendEmail, setSendEmail] = useState(true);
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const { busy, error, run } = useAction();

  function close(o: boolean) { onOpenChange(o); if (!o) setCreated(null); }
  async function send() {
    const r = await run(() => api.invitations.create({ email: email.trim(), lead_id: leadId ?? null, application_id: applicationId ?? null, send: sendEmail }));
    if (r) { setCreated(r); onCreated?.(); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(created!.token); toast.show("Copied", "success"); } catch { toast.show("Copy failed. Select the code and copy it.", "danger"); }
  }
  return (
    <Sheet open={open} onOpenChange={close} title="Send invite" description="The owner sets a password and accepts the terms from the link."
      footer={created ? <Button variant="primary" onClick={() => close(false)}>Done</Button>
        : <><Button variant="ghost" onClick={() => close(false)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!email.includes("@")} onClick={send}>Create invite</Button></>}>
      {created ? (
        <div className="stack-sm">
          {created.delivery_status === "sent" && <Notice tone="success">Invite emailed to {created.email}. The code below is shown only once, in case you also want to send it by WhatsApp or SMS.</Notice>}
          {created.delivery_status === "failed" && <Notice tone="danger">The email could not be delivered to {created.email}. Send this code yourself, or resend from Invitations. It is shown only once.</Notice>}
          {!created.delivery_status && <Notice tone="success">Invite created for {created.email}. Send this code by WhatsApp or SMS. It is shown only once.</Notice>}
          <div className="token-box">{created.token}</div>
          <div><Button onClick={copy}>Copy code</Button></div>
        </div>
      ) : (
        <div className="stack-sm">
          <Input label="Owner email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Checkbox label="Email the invite link to the owner" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
          <FormError error={error} />
        </div>
      )}
    </Sheet>
  );
}
