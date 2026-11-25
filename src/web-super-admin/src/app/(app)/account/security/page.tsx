"use client";
import { useState } from "react";
import Link from "next/link";
import { Button, Card, Dialog, Input, Table, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import type { AuthSession } from "@/lib/api/types";
import { fmtDateTime, timeAgo } from "@/lib/format";
import { useAction, useResource } from "@/lib/useResource";
import { InlineError, Notice, PageHeader, ResourceView, StatusBadge } from "@/components/ui";
import { MfaEnrol } from "@/components/MfaEnrol";

/** Short device label from a user agent string (no tracking, just so people recognise their sessions). */
const device = (ua: string | null) => {
  if (!ua) return "Unknown device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : ua.slice(0, 30);
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${br} on ${os}` : br;
};

export default function SecurityPage() {
  const toast = useToast();
  const mfa = useResource(() => api.auth.mfaStatus(), "mfa");
  const sessions = useResource(() => api.auth.sessions(), "sessions");
  const [dialog, setDialog] = useState<null | "enrol" | "disable" | "codes">(null);
  const [newCodes, setNewCodes] = useState<string[]>();
  const revoke = useAction(async (id: string) => { await api.auth.revokeSession(id); toast.show("Session signed out", "success"); sessions.reload(); });
  const revokeOthers = useAction(async () => { const r = await api.auth.revokeOtherSessions(); toast.show(`Signed out ${r.revoked} other ${r.revoked === 1 ? "session" : "sessions"}`, "success"); sessions.reload(); });
  return (
    <>
      <PageHeader title="Security" subtitle="Two-step verification and where you are signed in." actions={<Link className="hq-link" href="/account">Back to account</Link>} />
      <h2 className="hq-h2">Two-step verification</h2>
      <ResourceView res={mfa} empty={{ title: "Unavailable" }}>
        {(m) => (
          <Card as="section">
            <div className="hq-row"><StatusBadge value={m.enrolled ? "active" : "inactive"} /><strong>{m.enrolled ? "Authenticator app is on" : "Authenticator app is off"}</strong></div>
            {m.required ? <p className="hq-sub">Required for your role, so it cannot be turned off.</p> : null}
            {m.enrolled ? <p className="hq-sub">{m.recovery_codes_remaining} recovery {m.recovery_codes_remaining === 1 ? "code" : "codes"} left{m.recovery_codes_remaining <= 2 ? ". Generate new ones soon." : "."}</p> : <p className="hq-sub">Adds a 6-digit code from your phone to every sign-in.</p>}
            <div className="hq-row" style={{ marginTop: 12 }}>
              {!m.enrolled ? <Button variant="primary" onClick={() => setDialog("enrol")}>Set up</Button> : <Button onClick={() => { setNewCodes(undefined); setDialog("codes"); }}>New recovery codes</Button>}
              {m.enrolled && !m.required ? <Button variant="danger-soft" onClick={() => setDialog("disable")}>Turn off</Button> : null}
            </div>
          </Card>
        )}
      </ResourceView>
      <h2 className="hq-h2">Signed-in sessions</h2>
      <ResourceView res={sessions} isEmpty={(d) => d.items.length === 0} empty={{ title: "No active sessions" }}>
        {(d) => (
          <>
            <Table<AuthSession> caption="Your sessions" getKey={(s) => s.id} rows={d.items} columns={[
              { key: "d", header: "Device", render: (s) => <>{device(s.user_agent)}{s.current ? <> <StatusBadge value="active" /> <span className="hq-muted">this device</span></> : null}</> },
              { key: "ip", header: "IP address", render: (s) => s.ip ?? "–" },
              { key: "m", header: "2-step", render: (s) => (s.mfa ? "Yes" : "No") },
              { key: "st", header: "Signed in", render: (s) => fmtDateTime(s.started_at) },
              { key: "la", header: "Last active", render: (s) => timeAgo(s.last_active_at) },
              { key: "a", header: "Actions", render: (s) => <Button size="sm" variant="danger-soft" loading={revoke.busy} onClick={() => void revoke.run(s.id)}>{s.current ? "Sign out here" : "Sign out"}</Button> },
            ]} />
            <InlineError error={revoke.error ?? revokeOthers.error} />
            {d.items.length > 1 ? <div style={{ marginTop: 12 }}><Button loading={revokeOthers.busy} onClick={() => void revokeOthers.run()}>Sign out all other sessions</Button></div> : null}
          </>
        )}
      </ResourceView>
      {dialog === "enrol" ? (
        <Dialog open onOpenChange={(o) => { if (!o) { setDialog(null); mfa.reload(); } }} title="Set up two-step verification" description="Scan the code with an authenticator app.">
          <MfaEnrol start={() => api.auth.mfaEnrolStart()} confirm={(c) => api.auth.mfaEnrolConfirm(c)} onFinished={() => { setDialog(null); mfa.reload(); toast.show("Two-step verification is on", "success"); }} />
        </Dialog>
      ) : null}
      {dialog === "disable" ? <Reauth title="Turn off two-step verification" confirm="Turn off" danger onClose={() => setDialog(null)}
        run={async (pw, code) => { await api.auth.mfaDisable(pw, code); setDialog(null); mfa.reload(); toast.show("Two-step verification is off", "success"); }} /> : null}
      {dialog === "codes" ? (
        newCodes ? (
          <Dialog open onOpenChange={(o) => { if (!o) { setDialog(null); mfa.reload(); } }} title="New recovery codes" description="Old codes no longer work. Store these somewhere safe.">
            <Notice tone="warning">Shown only now.</Notice>
            <ul className="hq-codes">{newCodes.map((c) => <li className="hq-mono" key={c}>{c}</li>)}</ul>
            <div className="hq-row" style={{ marginTop: 12 }}><Button onClick={() => void navigator.clipboard?.writeText(newCodes.join("\n"))}>Copy</Button><Button variant="primary" onClick={() => { setDialog(null); mfa.reload(); }}>Done</Button></div>
          </Dialog>
        ) : <Reauth title="Generate new recovery codes" confirm="Generate" onClose={() => setDialog(null)} run={async (pw, code) => { setNewCodes((await api.auth.mfaRecoveryCodes(pw, code)).recovery_codes); }} />
      ) : null}
    </>
  );
}

function Reauth({ title, confirm, danger, onClose, run }: { title: string; confirm: string; danger?: boolean; onClose: () => void; run: (pw: string, code: string) => Promise<void> }) {
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const a = useAction(async () => { await run(pw, code.trim()); });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description="Confirm it is you: your password and a current code from your authenticator."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? "danger-soft" : "primary"} loading={a.busy} disabled={!pw || !code.trim()} onClick={() => void a.run()}>{confirm}</Button></>}>
      <div className="hq-stack">
        <Input label="Password" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <Input label="6-digit code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
        <InlineError error={a.error} />
      </div>
    </Dialog>
  );
}
