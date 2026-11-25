"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, EmptyState, Input, Notice, NumberStepper, PageHeader, Select, useToast, Checkbox } from "@chilli/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/components/auth";
import { DocumentsCard } from "@/components/documents-card";
import { AsyncView, FormError, NoAccess } from "@/components/ui";
import { useAction, useQuery } from "@/lib/hooks";
import { can } from "@/lib/roles";
import { CHECKLIST_LABEL, isWizardStep, WIZARD_STEPS, type WizardStep } from "@/lib/onboarding";
import type { AppOut, BusinessKind, ChecklistKey, ChecklistOut, ChecklistPayloads } from "@/lib/api/types";

const LABEL: Record<WizardStep, string> = { owner: "Owner details", ...CHECKLIST_LABEL };

export default function WizardPage() {
  const { id, step } = useParams<{ id: string; step: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const data = useQuery(`wiz:${id}`, async () => {
    const [app, list] = await Promise.all([api.onboarding.get(id), api.onboarding.checklist(id)]);
    return { app, list };
  });
  if (!isWizardStep(step)) return <EmptyState title="Unknown step" actionLabel="Back to application" onAction={() => router.push(`/onboarding/${id}`)} />;
  if (!can(user?.role, "onboarding.edit")) return <NoAccess role={user?.role} what="Editing the checklist" needs="onboarding agents and marketing admins" />;
  return (
    <AsyncView q={data} rows={4}>
      {({ app, list }) => <Step key={`${step}:${data.data?.list.find((i) => i.key === step)?.updated_at ?? ""}`} app={app} list={list} step={step} />}
    </AsyncView>
  );
}

function Step({ app, list, step }: { app: AppOut; list: ChecklistOut[]; step: WizardStep }) {
  const router = useRouter();
  const toast = useToast();
  const idx = WIZARD_STEPS.indexOf(step);
  const locked = app.status === "provisioned" || app.status === "cancelled";
  const { user } = useAuth();
  const { busy, error, run } = useAction();
  const item = list.find((i) => i.key === step);
  const next = WIZARD_STEPS[idx + 1];
  const goNext = () => router.push(next ? `/onboarding/${app.id}/wizard/${next}` : `/onboarding/${app.id}`);

  async function save<K extends ChecklistKey>(key: K, payload: ChecklistPayloads[K]) {
    if (await run(() => api.onboarding.saveChecklistItem(app.id, key, payload))) { toast.show("Saved", "success"); goNext(); }
  }
  async function saveOwner(body: { owner_name: string | null; owner_email: string | null; owner_phone: string | null }) {
    if (await run(() => api.onboarding.update(app.id, body))) { toast.show("Saved", "success"); goNext(); }
  }

  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <PageHeader title={LABEL[step]} description={`${app.business_name} · step ${idx + 1} of ${WIZARD_STEPS.length}`} actions={<><Link href={`/onboarding/${app.id}`}><Button variant="ghost">Back to checklist</Button></Link></>} />
      <ol className="steps" aria-label="Progress">
        {WIZARD_STEPS.map((s, i) => <li key={s} className={i < idx ? "done" : i === idx ? "cur" : ""} aria-current={i === idx ? "step" : undefined}><span className="ch-sr-only">{LABEL[s]}</span></li>)}
      </ol>
      {locked && <Notice tone="info">This application is {app.status}. The checklist is locked.</Notice>}
      <FormError error={error} />
      {step === "owner" && <OwnerForm app={app} busy={busy} locked={locked} onSave={saveOwner} />}
      {step === "business_type" && <BusinessTypeForm d={item?.data as Partial<ChecklistPayloads["business_type"]>} busy={busy} locked={locked} onSave={(p) => save("business_type", p)} />}
      {step === "outlet" && <OutletForm d={item?.data as Partial<ChecklistPayloads["outlet"]>} busy={busy} locked={locked} onSave={(p) => save("outlet", p)} />}
      {step === "menu" && <MenuForm d={item?.data as Partial<ChecklistPayloads["menu"]>} busy={busy} locked={locked} onSave={(p) => save("menu", p)} />}
      {step === "staff" && <StaffForm d={item?.data as Partial<ChecklistPayloads["staff"]>} busy={busy} locked={locked} onSave={(p) => save("staff", p)} />}
      {step === "documents" && <><DocumentsCard appId={app.id} canEdit={!locked} canDecide={user?.role === "marketing_admin" && !locked} /><div><Button variant="primary" onClick={goNext}>Back to checklist</Button></div></>}
      {next && <p className="small wizard-skip"><Link href={`/onboarding/${app.id}/wizard/${next}`}>Skip to {LABEL[next]}</Link></p>}
    </div>
  );
}

interface FormProps<P> { d: Partial<P> | undefined; busy: boolean; locked: boolean; onSave: (p: P) => void }
function Form({ children, onSubmit, busy, locked, label = "Save and continue", ok = true }: { children: ReactNode; onSubmit: () => void; busy: boolean; locked: boolean; label?: string; ok?: boolean }) {
  return (
    <form className="stack" noValidate onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }} className="stack">{children}</fieldset>
      {!locked && <div><Button type="submit" variant="primary" size="lg" loading={busy} disabled={!ok}>{label}</Button></div>}
    </form>
  );
}

function OwnerForm({ app, busy, locked, onSave }: { app: AppOut; busy: boolean; locked: boolean; onSave: (b: { owner_name: string | null; owner_email: string | null; owner_phone: string | null }) => void }) {
  const [f, setF] = useState({ name: app.owner_name ?? "", email: app.owner_email ?? "", phone: app.owner_phone ?? "" });
  return (
    <Form busy={busy} locked={locked} ok={!!f.name.trim() && f.email.includes("@")} onSubmit={() => onSave({ owner_name: f.name.trim() || null, owner_email: f.email.trim() || null, owner_phone: f.phone.trim() || null })}>
      <Input label="Owner name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <Input label="Owner email" type="email" inputMode="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required hint="Required to send the invite and mark the application ready" />
      <Input label="Owner phone" type="tel" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
    </Form>
  );
}

function BusinessTypeForm({ d, ...p }: FormProps<ChecklistPayloads["business_type"]>) {
  const [type, setType] = useState<BusinessKind>(d?.business_type ?? "restaurant");
  const [cuisine, setCuisine] = useState(d?.cuisine ?? "");
  return (
    <Form {...p} onSubmit={() => p.onSave({ business_type: type, cuisine: cuisine.trim() || null })}>
      <Select label="Business type" value={type} onChange={(e) => setType(e.target.value as BusinessKind)}>
        {["restaurant", "cafe", "bakery", "cloud_kitchen", "food_truck", "bar", "other"].map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
      </Select>
      <Input label="Cuisine" value={cuisine} onChange={(e) => setCuisine(e.target.value)} hint="Optional" />
    </Form>
  );
}

function OutletForm({ d, ...p }: FormProps<ChecklistPayloads["outlet"]>) {
  const [f, setF] = useState({ name: d?.name ?? "", city: d?.city ?? "", country: d?.country ?? "IN", address: d?.address_line ?? "", tables: String(d?.expected_tables ?? "") });
  return (
    <Form {...p} ok={!!f.name.trim() && !!f.city.trim() && f.country.length === 2}
      onSubmit={() => p.onSave({ name: f.name.trim(), city: f.city.trim(), country: f.country.toUpperCase(), address_line: f.address.trim() || null, expected_tables: f.tables ? Number(f.tables) : null })}>
      <Input label="Outlet name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
      <Input label="City" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} required />
      <Input label="Country code" value={f.country} maxLength={2} onChange={(e) => setF({ ...f, country: e.target.value })} hint="Two letters, e.g. IN" required />
      <Input label="Address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
      <Input label="Tables (dine-in only)" type="number" inputMode="numeric" min={0} value={f.tables} onChange={(e) => setF({ ...f, tables: e.target.value })} />
    </Form>
  );
}

function MenuForm({ d, ...p }: FormProps<ChecklistPayloads["menu"]>) {
  const [source, setSource] = useState<ChecklistPayloads["menu"]["source"]>(d?.source ?? "upload");
  const [count, setCount] = useState(d?.item_count ?? 0);
  const [ready, setReady] = useState(d?.ready ?? false);
  return (
    <Form {...p} onSubmit={() => p.onSave({ source, item_count: count, ready })}>
      <p className="muted small">Only the item count and source are stored here. The menu itself is built in the business app, not in Partner.</p>
      <Select label="Menu source" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
        <option value="upload">Photo or file upload</option><option value="manual">Entered manually</option><option value="pos_import">Imported from existing billing software</option>
      </Select>
      <NumberStepper label="Number of items" value={count} onChange={setCount} min={0} max={100000} />
      <Checkbox label="Menu reviewed with the owner and ready" checked={ready} onChange={(e) => setReady(e.target.checked)} />
    </Form>
  );
}

const ROLES = ["owner", "manager", "cashier", "waiter", "kitchen"] as const;
function StaffForm({ d, ...p }: FormProps<ChecklistPayloads["staff"]>) {
  const [count, setCount] = useState(d?.staff_count ?? 0);
  const [roles, setRoles] = useState<ChecklistPayloads["staff"]["planned_roles"]>(d?.planned_roles ?? []);
  return (
    <Form {...p} onSubmit={() => p.onSave({ staff_count: count, planned_roles: roles })}>
      <p className="muted small">Counts and roles only. No names or pay details are stored here.</p>
      <NumberStepper label="Staff who will use the system" value={count} onChange={setCount} min={0} max={10000} />
      <fieldset className="ch-fieldset"><legend className="ch-label">Planned roles</legend><div className="row">{ROLES.map((r) => <Checkbox key={r} label={r} checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />)}</div></fieldset>
    </Form>
  );
}
