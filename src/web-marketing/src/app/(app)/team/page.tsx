"use client";
import { useState } from "react";
import { Badge, Button, Card, Input, Select, Sheet, useToast, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { AsyncView, FormError, SubNav, NoAccess } from "@/components/ui";
import { TEAM_NAV } from "@/components/subnavs";
import { useAction, useQuery } from "@/lib/hooks";
import { can, ROLE_LABEL } from "@/lib/roles";
import { ROLES, type Role } from "@/lib/api/types";

export default function TeamPage() {
  const { user } = useAuth();
  const toast = useToast();
  const q = useQuery("team", () => api.users.list());
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", email: "", password: "", role: "salesperson" as Role });
  const create = useAction();
  const toggle = useAction();
  if (!can(user?.role, "team.manage")) return <NoAccess role={user?.role} what="Team management" />;
  async function save() {
    const r = await create.run(() => api.users.create({ name: f.name.trim(), email: f.email.trim(), password: f.password, role: f.role }));
    if (r) { toast.show("User created", "success"); setOpen(false); setF({ name: "", email: "", password: "", role: "salesperson" }); q.reload(); }
  }
  return (
    <div className="stack">
      <PageHeader title="Team" actions={<><Button variant="primary" onClick={() => setOpen(true)}>+ User</Button></>} />
      <SubNav items={TEAM_NAV} />
      <FormError error={toggle.error} />
      <AsyncView q={q} isEmpty={(d) => d.length === 0} empty={{ title: "No users" }}>
        {(rows) => (
          <Card><ul className="list">{rows.map((u) => (
            <li key={u.id}>
              <span className="grow"><span className="title">{u.name}</span> {!u.is_active && <Badge tone="neutral">inactive</Badge>}<br /><span className="small muted">{u.email} · {ROLE_LABEL[u.role]}</span></span>
              {u.id !== user?.id && <Button size="sm" variant="ghost" disabled={toggle.busy} onClick={async () => { if (await toggle.run(() => api.users.update(u.id, { is_active: !u.is_active }))) { toast.show(u.is_active ? "Deactivated" : "Reactivated", "success"); q.reload(); } }}>{u.is_active ? "Deactivate" : "Reactivate"}</Button>}
            </li>))}</ul></Card>
        )}
      </AsyncView>
      <Sheet open={open} onOpenChange={setOpen} title="New user" description="They sign in with this email and password."
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={create.busy} disabled={!f.name.trim() || !f.email.includes("@") || f.password.length < 10} onClick={save}>Create</Button></>}>
        <div className="stack-sm">
          <Input label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input label="Email" type="email" inputMode="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <Input label="Temporary password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} hint="At least 10 characters" />
          <Select label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select>
          <FormError error={create.error} />
        </div>
      </Sheet>
    </div>
  );
}
