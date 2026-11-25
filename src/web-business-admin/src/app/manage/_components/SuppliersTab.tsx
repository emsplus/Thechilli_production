"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Archive, Mail, Pencil, Phone, Plus, RotateCcw, Truck, User } from "lucide-react";
import { Badge, Button, Dialog, IconButton, Input, Notice, Switch } from "@chilli/ui";
import { Card, EmptyState, SegmentedControl, Skeleton, toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useLoader } from "@/lib/useLoader";
import type { Supplier } from "@/lib/types";
import { PurchasesView } from "./PurchasesView";
import { ExpensesView } from "./ExpensesView";
import { useTaxConfig } from "@/lib/taxConfig";
import { ScanInvoiceCard } from "./stock-flow";
import { EmailSettingsCard, SentEmails } from "./SupplierEmails";
import { ReorderEmailDialog } from "./ReorderEmailDialog";
import { useManage } from "./manage-context";

const fetchSuppliers = () => api.allSuppliers();
const fetchItems = () => api.allInventoryItems();
const schema = z.object({
  name: z.string().trim().min(1, "Enter the supplier's name").max(200, "Keep it under 200 characters"),
  trn: z.string().trim(),
  phone: z.string().trim().max(30, "Keep it under 30 characters"),
  email: z.string().trim().max(254, "Keep it under 254 characters").refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address"),
  contact_name: z.string().trim().max(120, "Keep it under 120 characters"),
  auto_reorder: z.boolean(),
});
type Form = z.infer<typeof schema>;

export function SuppliersTab({ view, invoice, from }: { view?: string; invoice?: string; from?: string }) {
  const { goto } = useManage();
  const sub = view === "invoices" ? "invoices" : view === "expenses" ? "expenses" : "suppliers";
  return (
    <>
      {sub === "suppliers" && <div className="mb-4"><ScanInvoiceCard from="suppliers" /></div>}
      <SegmentedControl label="Section" className="mb-4 max-w-full overflow-x-auto scrollbar-none" value={sub} onChange={(v) => goto("suppliers", v === "suppliers" ? undefined : v)}
        options={[{ value: "suppliers", label: "Suppliers", icon: <Truck /> }, { value: "invoices", label: "Purchase invoices" }, { value: "expenses", label: "Expenses" }]} />
      {sub === "suppliers" ? <SupplierList /> : sub === "expenses" ? <ExpensesView /> : <PurchasesView embedded initialInvoiceId={invoice} from={from} />}
    </>
  );
}

function SupplierList() {
  const taxLabel = useTaxConfig()?.tax_number_label ?? "Tax number";
  const { refresh } = useManage();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLoader(fetchSuppliers);
  const { data: stock } = useLoader(fetchItems);
  const [dialog, setDialog] = useState<{ supplier: Supplier | null } | null>(null);
  const [mail, setMail] = useState<{ supplierId: string } | null>(null);
  const [mailTick, setMailTick] = useState(0);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [archived, setArchived] = useState(false);
  const all = useMemo(() => data ?? [], [data]);
  const archivedCount = all.filter((s) => s.is_active === false).length;
  const list = all.filter((s) => archived || s.is_active !== false);
  const done = () => { void reload(); refresh(); };

  async function setActive(s: Supplier, on: boolean) {
    if (!on && !(await confirm({ title: `Archive ${s.name}?`, description: "It can no longer be chosen for new invoices. Existing invoices keep it. You can restore it later.", confirmLabel: "Archive", tone: "danger" }))) return;
    try { await api.patchSupplier(s.id, { is_active: on }); toast.success(on ? `${s.name} restored` : `${s.name} archived`); done(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : "Could not update the supplier"); }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">The people you buy ingredients from.</p>
        <Button variant="primary" iconStart={<Plus />} onClick={() => setDialog({ supplier: null })}>Add supplier</Button>
      </div>
      <EmailSettingsCard onLoaded={(x) => setConfigured(x.configured)} />
      {error && <div className="mb-4"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Retry</Button>}>{error}</Notice></div>}
      {archivedCount > 0 && <Switch label={`Show archived suppliers (${archivedCount})`} checked={archived} onChange={(e) => setArchived(e.target.checked)} className="mb-3 max-w-xs" />}
      {loading ? <div role="status" aria-label="Loading suppliers" className="space-y-2">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
        : list.length === 0 ? <Card><EmptyState icon={<Truck />} title="No suppliers yet" hint="Add a supplier, then upload their invoices to keep stock up to date." action={<Button variant="primary" iconStart={<Plus />} onClick={() => setDialog({ supplier: null })}>Add your first supplier</Button>} /></Card>
        : (
          <Card padded={false}>
            <ul className="divide-y divide-border">
              {list.map((s) => {
                const off = s.is_active === false;
                return (
                  <li key={s.id} className={cn("flex items-center gap-3 px-4 py-3", off && "opacity-70")}>
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-fg"><Truck aria-hidden className="size-5" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-fg">{s.name}{off && <Badge tone="neutral" className="ml-2 align-middle">Archived</Badge>}</p>
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-subtle">
                        {s.contact_name && <span className="inline-flex items-center gap-1"><User aria-hidden className="size-3" />{s.contact_name}</span>}
                        {s.phone && <span className="inline-flex items-center gap-1"><Phone aria-hidden className="size-3" />{s.phone}</span>}
                        {s.email && <span className="inline-flex min-w-0 items-center gap-1"><Mail aria-hidden className="size-3 shrink-0" /><span className="truncate">{s.email}</span></span>}
                        {s.trn && <span className="tnum">{taxLabel} {s.trn}</span>}
                        {!s.phone && !s.trn && !s.email && <span>No contact details</span>}
                      </p>
                      {s.email && s.auto_reorder === false && <p className="text-xs text-fg-subtle">Automatic re-order emails are off for this supplier</p>}
                    </div>
                    {!off && <IconButton label={s.email ? `Email ${s.name} now` : `Email ${s.name} now (add an email first)`} icon={<Mail />} disabled={!s.email || configured === false} onClick={() => setMail({ supplierId: s.id })} />}
                    {!off && <IconButton label={`Edit ${s.name}`} icon={<Pencil />} onClick={() => setDialog({ supplier: s })} />}
                    {off ? <IconButton label={`Restore ${s.name}`} icon={<RotateCcw />} onClick={() => void setActive(s, true)} /> : <IconButton label={`Archive ${s.name}`} icon={<Archive />} onClick={() => void setActive(s, false)} />}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      <SentEmails refreshKey={mailTick} />
      <SupplierDialog state={dialog} onClose={() => setDialog(null)} onDone={done} />
      <ReorderEmailDialog open={!!mail} onClose={() => setMail(null)} suppliers={all} items={(stock ?? []).filter((i) => i.is_active !== false)} supplierId={mail?.supplierId} onDone={() => setMailTick((n) => n + 1)} />
    </>
  );
}

function SupplierDialog({ state, onClose, onDone }: { state: { supplier: Supplier | null } | null; onClose: () => void; onDone: () => void }) {
  const supplier = state?.supplier ?? null;
  const open = state !== null;
  const cfg = useTaxConfig();
  const showTrn = true; // the supplier's GSTIN (the server validates it)
  const taxLabel = cfg?.tax_number_label ?? "Tax number";
  const { register, handleSubmit, reset, setError, control, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { name: "", trn: "", phone: "", email: "", contact_name: "", auto_reorder: true } });
  useEffect(() => { if (open) reset({ name: supplier?.name ?? "", trn: supplier?.trn ?? "", phone: supplier?.phone ?? "", email: supplier?.email ?? "", contact_name: supplier?.contact_name ?? "", auto_reorder: supplier?.auto_reorder ?? true }); }, [open, supplier, reset]);
  const hasEmail = !!useWatch({ control, name: "email" })?.trim();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={supplier ? `Edit ${supplier.name}` : "Add supplier"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="supplier-edit-form" loading={isSubmitting}>{supplier ? "Save changes" : "Add supplier"}</Button></>}>
      <form id="supplier-edit-form" noValidate className="space-y-4 py-2" onSubmit={handleSubmit(async (v) => {
        try {
          const contact = { phone: v.phone || null, email: v.email || null, contact_name: v.contact_name || null, auto_reorder: v.auto_reorder };
          if (supplier) await api.patchSupplier(supplier.id, { name: v.name, ...(showTrn ? { trn: v.trn || null } : {}), ...contact });
          else await api.addSupplier({ name: v.name, trn: showTrn ? v.trn || null : null, ...contact });
          toast.success(supplier ? `${v.name} updated` : `${v.name} added`); onClose(); onDone();
        } catch (e) {
          const m = e instanceof ApiError ? e.message : "Could not save the supplier";
          setError(/phone/i.test(m) ? "phone" : /email/i.test(m) ? "email" : "name", { message: m });
        }
      })}>
        <Input label="Supplier name" autoFocus error={errors.name?.message} {...register("name")} />
        <Input label="Phone" inputMode="tel" autoComplete="off" hint="Optional. Mobile or landline, e.g. 98765 43210." error={errors.phone?.message} {...register("phone")} />
        <Input label="Email" type="email" inputMode="email" autoComplete="off" hint="Optional. Re-order emails are sent here." error={errors.email?.message} {...register("email")} />
        <Input label="Contact person" autoComplete="off" hint="Optional. Used to greet them in emails." error={errors.contact_name?.message} {...register("contact_name")} />
        {hasEmail && <Switch label="Auto re-order emails" hint="Email this supplier automatically when its items run low." {...register("auto_reorder")} />}
        {showTrn && <Input label={taxLabel} autoComplete="off" placeholder="29ABCDE1234F1Z5" hint={`Optional. The supplier's ${taxLabel}, from their invoice.`} error={errors.trn?.message} {...register("trn")} />}
      </form>
    </Dialog>
  );
}
