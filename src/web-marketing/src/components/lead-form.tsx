"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Notice, Select, Textarea, useToast } from "@chilli/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "./auth";
import { FormError } from "./ui";
import { useAction, useDebounced, useQuery } from "@/lib/hooks";
import { usePeople } from "@/lib/people";
import { can } from "@/lib/roles";
import type { DuplicateOut, LeadOut } from "@/lib/api/types";
import { STAGE_LABEL } from "@/lib/pipeline";
import { phoneError } from "@/lib/phone";

const TYPES = ["restaurant", "cafe", "bakery", "cloud_kitchen", "food_truck", "bar", "other"];

export function DuplicateWarning({ dups, onClaim, claiming }: { dups: DuplicateOut[]; onClaim?: (id: string) => void; claiming?: boolean }) {
  const { name } = usePeople();
  const { user } = useAuth();
  if (!dups.length) return null;
  return (
    <Notice tone="warning" title={`Similar lead${dups.length > 1 ? "s" : ""} found`}>
      <ul style={{ margin: 0, paddingInlineStart: 20 }}>
        {dups.map((d) => (
          <li key={d.id}>
            {d.business_name} ({STAGE_LABEL[d.stage]}), owned by {name(d.owner_id)}{" "}
            <Link href={`/leads/${d.id}`}>Open</Link>
            {onClaim && !d.owner_id && can(user?.role, "lead.claim") && <>{" · "}<Button size="sm" variant="ghost" disabled={claiming} onClick={() => onClaim(d.id)}>Claim it</Button></>}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** Add / edit lead. Duplicate check runs while typing; a 409 on save shows the matches with "Save anyway" (force). */
export function LeadForm({ lead }: { lead?: LeadOut }) {
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const { users } = usePeople();
  const campaigns = useQuery("campaigns", () => api.campaigns.list());
  const [f, setF] = useState({
    business_name: lead?.business_name ?? "", contact_name: lead?.contact_name ?? "", phone: lead?.phone ?? "", email: lead?.email ?? "", city: lead?.city ?? "",
    business_type: lead?.business_type ?? "restaurant", notes: lead?.notes ?? "", campaign_id: lead?.campaign_id ?? "", owner_id: lead?.owner_id ?? "", referral_code: "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const [dupsOnSave, setDupsOnSave] = useState<DuplicateOut[] | null>(null);
  const { busy, error, run } = useAction();
  const claim = useAction();

  const dPhone = useDebounced(f.phone), dEmail = useDebounced(f.email);
  const live = useQuery<DuplicateOut[]>(`dups:${dPhone}:${dEmail}`, async () => {
    if (dPhone.replace(/\D/g, "").length < 7 && !/.+@.+\..+/.test(dEmail)) return [];
    try { return (await api.leads.duplicates({ phone: dPhone || undefined, email: dEmail || undefined })).filter((d) => d.id !== lead?.id); } catch { return []; }
  });
  const dups = dupsOnSave ?? live.data ?? [];

  const fieldErr = (k: string) => error?.fieldErrors.find((x) => x.field === k)?.message;

  async function save(force: boolean) {
    const body = {
      business_name: f.business_name.trim(), contact_name: f.contact_name.trim(), phone: f.phone.trim() || null, email: f.email.trim() || null, city: f.city.trim() || null,
      business_type: f.business_type || null, notes: f.notes.trim() || null, campaign_id: f.campaign_id || null,
    };
    const saved = await run(async () => {
      try {
        return lead ? await api.leads.update(lead.id, body, force) : await api.leads.create({ ...body, owner_id: f.owner_id || null, referral_code: f.referral_code.trim() || null }, force);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.duplicates) { setDupsOnSave(e.duplicates); return undefined; }
        throw e;
      }
    });
    if (saved) { toast.show(lead ? "Lead updated" : "Lead added", "success"); router.push(`/leads/${saved.id}`); }
  }
  function submit(e: FormEvent) { e.preventDefault(); void save(false); }

  const salesOwners = users.filter((u) => u.role !== "onboarding_agent" && u.is_active);
  return (
    <form onSubmit={submit} className="stack" noValidate>
      <div className="grid form">
        <Input label="Business name" value={f.business_name} onChange={set("business_name")} required error={fieldErr("business_name")} />
        <Input label="Contact name" value={f.contact_name} onChange={set("contact_name")} required error={fieldErr("contact_name")} />
        <Input label="Phone" type="tel" inputMode="tel" autoComplete="off" value={f.phone} onChange={(e) => { setDupsOnSave(null); set("phone")(e); }} error={fieldErr("phone") ?? (f.phone.trim() ? phoneError(f.phone) ?? undefined : undefined)} hint="A phone or an email is required" />
        <Input label="Email" type="email" inputMode="email" value={f.email} onChange={(e) => { setDupsOnSave(null); set("email")(e); }} error={fieldErr("email")} />
        <Input label="City" value={f.city} onChange={set("city")} />
        <Select label="Business type" value={f.business_type} onChange={set("business_type")}>
          {TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
        </Select>
        <Select label="Campaign" value={f.campaign_id} onChange={set("campaign_id")}>
          <option value="">None</option>
          {(campaigns.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {!lead && <Input label="Referral code" value={f.referral_code} onChange={set("referral_code")} hint="Optional" />}
        {!lead && can(user?.role, "lead.assign") && (
          <Select label="Assign to" value={f.owner_id} onChange={set("owner_id")}>
            <option value="">Unassigned</option>
            {salesOwners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        )}
      </div>
      <Textarea label="Notes" value={f.notes} onChange={set("notes")} />
      <DuplicateWarning dups={dups} claiming={claim.busy} onClaim={async (id) => { if (user && await claim.run(() => api.leads.assign(id, user.id))) { toast.show("Lead claimed", "success"); router.push(`/leads/${id}`); } }} />
      <FormError error={error ?? claim.error} />
      <div className="row">
        <Button type="submit" variant="primary" loading={busy && !dupsOnSave} disabled={busy || !f.business_name || !f.contact_name || !!phoneError(f.phone)}>{lead ? "Save changes" : "Add lead"}</Button>
        {dupsOnSave && <Button type="button" disabled={busy} onClick={() => save(true)}>Save anyway</Button>}
        <Button type="button" variant="ghost" onClick={() => router.back()}>Cancel</Button>
      </div>
    </form>
  );
}
