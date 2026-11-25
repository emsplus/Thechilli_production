"use client";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Select, Table, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { ROLES, type Role, type StaffUser } from "@/lib/api/types";
import { fmtDateTime } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/permissions";
import { useCan, useSession } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { InlineError, PageHeader, ResourceView, StatusBadge } from "@/components/ui";

const PW_HINT = "At least 10 characters with upper-case, lower-case and a digit.";

export default function UsersPage() {
  const can = useCan();
  const toast = useToast();
  const { state } = useSession();
  const res = useResource(() => api.staff.list(), "staff");
  const [dialog, setDialog] = useState<null | { kind: "new" } | { kind: "edit"; u: StaffUser } | { kind: "reset"; u: StaffUser } | { kind: "mfa"; u: StaffUser } | { kind: "signout"; u: StaffUser }>(null);
  const manage = can("staff.manage");
  const meId = state.status === "authed" ? state.me.id : "";
  const done = (msg: string) => { setDialog(null); toast.show(msg, "success"); res.reload(); };
  return (
    <>
      <PageHeader title="Platform users" subtitle="Chilli staff who can sign in to HQ." actions={manage ? <Button variant="primary" onClick={() => setDialog({ kind: "new" })}>Add user</Button> : undefined} />
      <ResourceView res={res} isEmpty={(d) => d.items.length === 0} empty={{ title: "No users", description: "This should never be empty: you are signed in." }}>
        {(d) => (
          <Table<StaffUser> caption="Platform users" getKey={(u) => u.id} rows={d.items} columns={[
            { key: "n", header: "Name", render: (u) => <>{u.name}{u.id === meId ? " (you)" : ""}</> }, { key: "e", header: "Email", render: (u) => u.email },
            { key: "r", header: "Role", render: (u) => ROLE_LABEL[u.role] }, { key: "s", header: "Status", render: (u) => <StatusBadge value={u.is_active ? "active" : "inactive"} /> },
            { key: "l", header: "Last sign-in", render: (u) => fmtDateTime(u.last_login_at) },
            { key: "a", header: "Actions", render: (u) => (manage ? <div className="hq-row"><Button size="sm" onClick={() => setDialog({ kind: "edit", u })}>Edit</Button><Button size="sm" onClick={() => setDialog({ kind: "reset", u })}>Reset password</Button>{u.id !== meId ? <Button size="sm" onClick={() => setDialog({ kind: "mfa", u })}>Reset 2-step</Button> : null}<Button size="sm" onClick={() => setDialog({ kind: "signout", u })}>Sign out everywhere</Button></div> : null) },
          ]} />
        )}
      </ResourceView>
      {dialog?.kind === "new" ? <NewUser onClose={() => setDialog(null)} onDone={() => done("User added")} /> : null}
      {dialog?.kind === "edit" ? <EditUser u={dialog.u} self={dialog.u.id === meId} onClose={() => setDialog(null)} onDone={() => done("User updated")} /> : null}
      {dialog?.kind === "mfa" ? <Confirm title={`Reset two-step verification for ${dialog.u.name}?`} text="Removes their authenticator and recovery codes and signs them out. Roles that require two-step must set it up again at next sign-in." confirm="Reset two-step" run={async () => { await api.staff.resetMfa(dialog.u.id); done("Two-step verification reset"); }} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "signout" ? <Confirm title={`Sign ${dialog.u.name} out everywhere?`} text="All of their sessions end immediately." confirm="Sign out" run={async () => { const r = await api.staff.revokeSessions(dialog.u.id); done(`Ended ${r.revoked} ${r.revoked === 1 ? "session" : "sessions"}`); }} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "reset" ? <ResetPw u={dialog.u} onClose={() => setDialog(null)} onDone={() => done("Password reset. The user must change it at next sign-in.")} /> : null}
    </>
  );
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  return <Select label="Role" value={value} onChange={(e) => onChange(e.target.value as Role)}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>;
}

function NewUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", email: "", role: "support" as Role, password: "" });
  const [touched, setTouched] = useState(false);
  const pwOk = f.password.length >= 10 && f.password.toLowerCase() !== f.password && /\d/.test(f.password);
  const bad = { name: f.name.trim().length < 2, email: !/^\S+@\S+\.\S+$/.test(f.email), pw: !pwOk };
  const { run, busy, error } = useAction(async () => { await api.staff.create({ ...f, email: f.email.trim(), name: f.name.trim() }); onDone(); });
  const submit = (e: FormEvent) => { e.preventDefault(); setTouched(true); if (!Object.values(bad).some(Boolean)) void run(); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add user" description="They must change the password at first sign-in."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-user" loading={busy}>Add user</Button></>}>
      <form id="new-user" className="hq-stack" onSubmit={submit} noValidate>
        <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={touched && bad.name ? "Enter a name." : undefined} />
        <Input label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={touched && bad.email ? "Enter a valid email." : undefined} />
        <RoleSelect value={f.role} onChange={(role) => setF({ ...f, role })} />
        <Input label="Temporary password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} hint={PW_HINT} error={touched && bad.pw ? PW_HINT : undefined} />
        <InlineError error={error} />
      </form>
    </Dialog>
  );
}

function EditUser({ u, self, onClose, onDone }: { u: StaffUser; self: boolean; onClose: () => void; onDone: () => void }) {
  const [role, setRole] = useState<Role>(u.role);
  const [active, setActive] = useState(u.is_active);
  const { run, busy, error } = useAction(async () => { await api.staff.update(u.id, { role, is_active: active }); onDone(); });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Edit ${u.name}`} description="Role changes sign the user out everywhere and are logged as a security event."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void run()}>Save</Button></>}>
      <div className="hq-stack">
        <RoleSelect value={role} onChange={setRole} />
        <label className="hq-check"><input type="checkbox" checked={active} disabled={self} onChange={(e) => setActive(e.target.checked)} /> Can sign in{self ? " (you cannot deactivate yourself)" : ""}</label>
        <InlineError error={error} />
      </div>
    </Dialog>
  );
}

function ResetPw({ u, onClose, onDone }: { u: StaffUser; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [touched, setTouched] = useState(false);
  const ok = pw.length >= 10 && pw.toLowerCase() !== pw && /\d/.test(pw);
  const { run, busy, error } = useAction(async () => { await api.staff.resetPassword(u.id, pw); onDone(); });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Reset password for ${u.name}`} description="All of their sessions end now."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger-soft" loading={busy} onClick={() => { setTouched(true); if (ok) void run(); }}>Reset password</Button></>}>
      <Input label="New temporary password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint={PW_HINT} error={touched && !ok ? PW_HINT : undefined} />
      <InlineError error={error} />
    </Dialog>
  );
}

function Confirm({ title, text, confirm, run, onClose }: { title: string; text: string; confirm: string; run: () => Promise<void>; onClose: () => void }) {
  const a = useAction(run);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description={text}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger-soft" loading={a.busy} onClick={() => void a.run()}>{confirm}</Button></>}>
      <InlineError error={a.error} />
    </Dialog>
  );
}
