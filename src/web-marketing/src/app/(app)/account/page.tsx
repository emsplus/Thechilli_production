"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Card, Input, PageHeader, useToast } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { FormError } from "@/components/ui";
import { useAction } from "@/lib/hooks";
import { ROLE_LABEL } from "@/lib/roles";

export default function AccountPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const { run, busy, error } = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    await run(async () => { await api.auth.changePassword(cur, next); toast.show("Password changed", "success"); setCur(""); setNext(""); });
  }
  return (
    <div className="stack">
      <PageHeader title="Account" />
      <div className="grid two">
        <Card as="section" aria-labelledby="me">
          <h2 id="me">You</h2>
          <p style={{ marginTop: 8 }}><strong>{user?.name}</strong></p>
          <p className="muted small">{user?.email}</p>
          <p className="muted small">{user && ROLE_LABEL[user.role]}</p>
        </Card>
        <Card as="section" aria-labelledby="help">
          <h2 id="help">Support</h2>
          <p className="small" style={{ marginTop: 8 }}>Stuck on a lead, an application or a commission? Ask your marketing admin. If sign-in fails, they can reset your password. See <Link href="/support">Support</Link> for common questions.</p>
        </Card>
      </div>
      <Card as="section" aria-labelledby="pw">
        <h2 id="pw">Change password</h2>
        <form onSubmit={submit} className="stack-sm" style={{ maxWidth: 400, marginTop: 12 }}>
          <Input label="Current password" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
          <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="At least 10 characters" />
          <FormError error={error} />
          <div><Button type="submit" variant="primary" loading={busy} disabled={!cur || next.length < 10}>Change password</Button></div>
        </form>
      </Card>
    </div>
  );
}
