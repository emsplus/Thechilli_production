"use client";
import { useState, type FormEvent } from "react";
import { Button, EmptyState, Input, useToast, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { DuplicateWarning } from "@/components/lead-form";
import { FormError, NoAccess, SubNav } from "@/components/ui";
import { can } from "@/lib/roles";
import { leadsNav } from "@/components/subnavs";
import { useAction } from "@/lib/hooks";
import { useAuth } from "@/components/auth";
import type { DuplicateOut } from "@/lib/api/types";

export default function DuplicatesPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<DuplicateOut[] | null>(null);
  const check = useAction();
  const claim = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await check.run(() => api.leads.duplicates({ phone: phone.trim() || undefined, email: email.trim() || undefined }));
    if (r) setResult(r);
  }
  if (!can(user?.role, "lead.write")) return <NoAccess role={user?.role} what="The duplicate check" needs="salespeople and marketing admins" />;
  return (
    <div className="stack">
      <PageHeader title="Duplicate check" description="Before you add a lead, see whether someone already owns it." />
      <SubNav items={leadsNav(user?.role)} />
      <form onSubmit={submit} className="stack" style={{ maxWidth: 480 }}>
        <Input label="Phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Input label="Email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <FormError error={check.error ?? claim.error} />
        <div><Button type="submit" variant="primary" loading={check.busy} disabled={!phone.trim() && !email.trim()}>Check</Button></div>
      </form>
      {result && (result.length === 0
        ? <EmptyState title="No duplicates" description="Nothing matches this phone or email. Safe to add." />
        : <DuplicateWarning dups={result} claiming={claim.busy} onClaim={async (id) => { if (user && await claim.run(() => api.leads.assign(id, user.id))) { toast.show("Lead claimed", "success"); setResult((r) => r?.map((d) => (d.id === id ? { ...d, owner_id: user.id } : d)) ?? null); } }} />)}
    </div>
  );
}
