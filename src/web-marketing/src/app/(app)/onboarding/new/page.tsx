"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Select, useToast, PageHeader } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { FormError, NoAccess } from "@/components/ui";
import { useAction, useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can } from "@/lib/roles";

export default function NewApplicationPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const { users } = usePeople();
  const leads = useQuery("leads-for-app", () => api.leads.list({ limit: 200 }));
  const [leadId, setLeadId] = useState("");
  const [f, setF] = useState({ business_name: "", owner_name: "", owner_email: "", owner_phone: "", contract: "", agent_id: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const { busy, error, run } = useAction();
  if (!can(user?.role, "onboarding.create")) return <NoAccess role={user?.role} what="Starting an application" needs="onboarding agents and marketing admins" />;
  const admin = can(user?.role, "onboarding.contractValue");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const a = await run(() => api.onboarding.create({
      lead_id: leadId || null, business_name: leadId ? undefined : f.business_name.trim(), owner_name: f.owner_name.trim() || null, owner_email: f.owner_email.trim() || null,
      owner_phone: f.owner_phone.trim() || null, ...(admin ? { contract_value_minor: Math.round(Number(f.contract || 0) * 100), agent_id: f.agent_id || null } : {}),
    }));
    if (a) { toast.show("Application created", "success"); router.push(`/onboarding/${a.id}`); }
  }
  return (
    <div className="stack">
      <PageHeader title="New application" description="Link a lead, or enter the business name for a walk-in." />
      <form onSubmit={submit} className="stack" noValidate>
        <div className="grid form">
          <Select label="From lead" value={leadId} onChange={(e) => setLeadId(e.target.value)} hint={leads.error ? "Could not load leads" : undefined}>
            <option value="">No lead (walk-in)</option>
            {(leads.data ?? []).filter((l) => l.stage !== "won" && l.stage !== "lost").map((l) => <option key={l.id} value={l.id}>{l.business_name}</option>)}
          </Select>
          {!leadId && <Input label="Business name" value={f.business_name} onChange={set("business_name")} required error={error?.fieldErrors.find((x) => x.field === "business_name")?.message} />}
          <Input label="Owner name" value={f.owner_name} onChange={set("owner_name")} hint="Needed before the application can be ready" />
          <Input label="Owner email" type="email" inputMode="email" value={f.owner_email} onChange={set("owner_email")} error={error?.fieldErrors.find((x) => x.field === "owner_email")?.message} />
          <Input label="Owner phone" type="tel" inputMode="tel" value={f.owner_phone} onChange={set("owner_phone")} />
          {admin && <Input label="Contract value" type="number" inputMode="decimal" min={0} value={f.contract} onChange={set("contract")} hint="Commission base. Admin only." />}
          {admin && (
            <Select label="Assign agent" value={f.agent_id} onChange={set("agent_id")}>
              <option value="">Unassigned</option>
              {users.filter((u) => u.role === "onboarding_agent" && u.is_active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
          )}
        </div>
        <FormError error={error} />
        <div className="row"><Button type="submit" variant="primary" loading={busy} disabled={!leadId && !f.business_name.trim()}>Create application</Button><Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button></div>
      </form>
    </div>
  );
}
