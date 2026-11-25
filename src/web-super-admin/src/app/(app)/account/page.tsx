"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button, Card, Input, useToast } from "@chilli/ui";
import { http } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/permissions";
import { useSession } from "@/lib/session";
import { useAction } from "@/lib/useResource";
import { DefList, InlineError, Notice, PageHeader } from "@/components/ui";

export default function AccountPage() {
  const { state, signOut } = useSession();
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [touched, setTouched] = useState(false);
  const ok = next.length >= 10 && next.toLowerCase() !== next && /\d/.test(next);
  const { run, busy, error } = useAction(async () => {
    await http.post("/auth/change-password", { current_password: cur, new_password: next });
    toast.show("Password changed. Sign in again.", "success");
    await signOut();
  });
  if (state.status !== "authed") return null;
  const me = state.me;
  const submit = (e: FormEvent) => { e.preventDefault(); setTouched(true); if (cur && ok) void run(); };
  return (
    <>
      <PageHeader title="Your account" />
      {me.must_change_password ? <Notice tone="warning">Your password was set by an admin. Change it now.</Notice> : null}
      <Card as="section"><DefList items={[["Name", me.name], ["Email", me.email], ["Role", ROLE_LABEL[me.role]], ["Last sign-in", fmtDateTime(me.last_login_at)]]} /></Card>
      <h2 className="hq-h2">Security</h2>
      <Card as="section"><p className="hq-sub" style={{ margin: 0 }}>Two-step verification, recovery codes and the devices you are signed in on.</p><p style={{ marginBottom: 0 }}><Link className="hq-link" href="/account/security">Open security settings</Link></p></Card>
      <h2 className="hq-h2">Change password</h2>
      <Card as="section"><form className="hq-stack" onSubmit={submit} noValidate style={{ maxWidth: "26rem" }}>
        <Input label="Current password" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} error={touched && !cur ? "Enter your current password." : undefined} />
        <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="At least 10 characters with upper-case, lower-case and a digit." error={touched && !ok ? "Use at least 10 characters with upper-case, lower-case and a digit." : undefined} />
        <InlineError error={error} />
        <div><Button type="submit" variant="primary" loading={busy}>Change password</Button></div>
      </form></Card>
    </>
  );
}
