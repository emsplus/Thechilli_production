"use client";

import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowLeft, Bike, Check, Search, ShoppingBag, Sun, User, UserPlus, Utensils, X } from "lucide-react";
import { Button, Button as UiButton, Dialog, Input } from "@chilli/ui";
import { toast } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { createOrFindCustomer, customerLabel, looksLikePhone, phoneHint, phoneProblem } from "@/lib/customers";
import { layoutTransition } from "@/lib/motion";
import { cn } from "@/lib/cn";
import type { Customer, DiningTable, OrderType, TableStatus } from "@/lib/types";
import { useCan } from "@/lib/useRole";
import { formatCurrency } from "@/lib/money";
import { AREA_LABEL } from "@/lib/tableWhere";

const COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" };
const ALL_TYPE_OPTIONS: { value: OrderType; label: string; icon: ReactNode }[] = [
  { value: "indoor", label: "Dine-in", icon: <Utensils /> },
  { value: "outdoor", label: "Outdoor", icon: <Sun /> },
  { value: "takeaway", label: "Takeaway", icon: <ShoppingBag /> },
  { value: "delivery", label: "Delivery", icon: <Bike /> },
];

/**
 * Compact order type chooser (radiogroup, arrow keys), sized for the 22rem summary column. Only the types the business runs
 * (capabilities.order_types, docs/BUSINESS_TYPES.md): a cloud kitchen sees Takeaway and Delivery. A ticket already on another
 * type keeps showing it so it can be changed.
 */
export function OrderTypePicker({ value, onChange, disabled }: { value: OrderType; onChange: (t: OrderType) => void; disabled: boolean }) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const { biz, ready } = useCan();
  // Until /auth/me has answered only the ticket's own type shows: a cloud kitchen must never see Dine-in flash up (and a restaurant
  // without the delivery module never sees Delivery), even for the moment before the capabilities arrive.
  const TYPE_OPTIONS = ALL_TYPE_OPTIONS.filter((o) => (ready && biz.order_types.includes(o.value)) || o.value === value);
  function onKey(e: KeyboardEvent, idx: number) {
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const j = (idx + dir + TYPE_OPTIONS.length) % TYPE_OPTIONS.length;
    onChange(TYPE_OPTIONS[j].value); refs.current[j]?.focus();
  }
  return (
    <div role="radiogroup" aria-label="Order type" className={cn("@container grid gap-1 rounded-2xl border border-border bg-surface-2 p-1", COLS[TYPE_OPTIONS.length] ?? "grid-cols-4")}>
      {TYPE_OPTIONS.map((o, idx) => {
        const on = o.value === value;
        return (
          <button key={o.value} ref={(el) => { refs.current[idx] = el; }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} disabled={disabled}
            onClick={() => onChange(o.value)} onKeyDown={(e) => onKey(e, idx)}
            className={cn("relative inline-flex h-11 min-w-0 items-center justify-center gap-1 rounded-xl px-1 text-[0.78rem] font-semibold transition-colors disabled:opacity-60 [&_svg]:size-3.5 [&_svg]:shrink-0",
              on ? "text-fg" : "text-fg-muted hover:text-fg")}>
            {on && <motion.span layoutId={`type-${id}`} className="absolute inset-0 rounded-xl bg-surface shadow-pop ring-1 ring-border" transition={layoutTransition} />}
            <span className="relative z-10 inline-flex min-w-0 items-center gap-1"><span aria-hidden className="@max-[22rem]:hidden">{o.icon}</span><span className="truncate">{o.label}</span></span>
          </button>
        );
      })}
    </div>
  );
}

const AREA_NAME: Partial<Record<OrderType, string>> = AREA_LABEL; // the same words everywhere: Indoor / Outdoor
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** One line under a table's name: its live state (C-02), or the other unplaced bill holding it. */
function tableLine(t: DiningTable, st: TableStatus | undefined, other: string[] | undefined, currency: string): { text: string; busy: boolean } {
  if (other?.length) return { text: `also ${other.join(", ")}`, busy: true };
  if (!st || st.status === "free") return { text: "Free", busy: false };
  if (st.status === "reserved") return { text: "Reserved", busy: false };
  const items = st.orders.reduce((n, o) => n + (o.item_count ?? 0), 0);
  const total = st.orders.reduce((n, o) => n + Number(o.subtotal ?? 0), 0);
  if (st.status === "bill_requested") return { text: "Bill asked", busy: true };
  return { text: items ? `${items} ${items === 1 ? "item" : "items"} · ${formatCurrency(total.toFixed(2), currency)}` : "Has order", busy: true };
}

/**
 * Table chooser (C-02, C-07, C-08): every table is visible in a wrapping grid grouped by area (never a hidden sideways
 * scroll), each with its live state (Free / "3 items · ₹540" / Bill asked / Reserved). Tapping the chosen table again
 * never un-chooses it; once chosen the grid folds into one row with a small "Change table".
 * `claims`: table id -> labels of OTHER unplaced tickets that already picked it (warning only, the server decides).
 */
export function TablePicker({ tables, value, onChange, disabled, claims, status, currency = "", startOpen = false }: {
  tables: DiningTable[]; value: string; onChange: (id: string) => void; disabled: boolean; claims?: Map<string, string[]>;
  status?: Map<string, TableStatus>; currency?: string; startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  if (tables.length === 0) return <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-fg">No tables set up yet. Add tables in Manage, Tables.</p>;
  const chosen = tables.find((t) => t.id === value);
  if (chosen && !open) {
    const line = tableLine(chosen, status?.get(chosen.id), undefined, currency);
    return (
      <div role="group" aria-label="Table" className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-border bg-surface-2/60 pl-1" data-testid="table-chosen">
        {/* The chosen table stays pressed: tapping it again changes nothing (C-08). */}
        <button type="button" aria-pressed="true" onClick={() => {}} disabled={disabled}
          className="flex min-h-11 min-w-0 items-center gap-1.5 truncate rounded-lg px-2 text-left text-sm font-semibold text-fg">
          <Check aria-hidden className="size-4 shrink-0 text-primary" />Table <span className="font-bold">{chosen.label}</span><span className="sr-only">,</span>{line.busy && <span className="truncate text-xs font-medium text-fg-muted"> · {line.text}</span>}
        </button>
        {!disabled && <button type="button" onClick={() => setOpen(true)} aria-label="Change table" className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-3 text-sm font-semibold text-primary hover:bg-surface">Change</button>}
      </div>
    );
  }
  const areas = [...new Set(tables.map((t) => t.area))];
  return (
    <div role="group" aria-label="Table" data-table-grid="">
      <p className="mb-1.5 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">
        <span>Table {value === "" && <span className="font-medium normal-case tracking-normal">(choose one)</span>}</span>
        {chosen && <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-lg px-2 text-sm font-semibold normal-case tracking-normal text-primary hover:bg-surface-2">Keep {chosen.label}</button>}
      </p>
      <div className="space-y-2">
        {areas.map((area) => (
          <div key={area}>
            {areas.length > 1 && <p className="mb-1 text-[0.7rem] font-semibold text-fg-muted">{AREA_NAME[area] ?? area}</p>}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(4.75rem,1fr))] gap-2">
              {tables.filter((t) => t.area === area).sort((a, b) => natural(a.label, b.label)).map((t) => {
                const on = t.id === value;
                const line = tableLine(t, status?.get(t.id), claims?.get(t.id), currency);
                return (
                  <button key={t.id} type="button" disabled={disabled} aria-pressed={on} data-table={t.label}
                    onClick={() => { setOpen(false); if (!on) onChange(t.id); }}
                    className={cn("flex min-h-14 min-w-0 flex-col items-center justify-center rounded-xl border px-1.5 text-sm font-bold transition-[background-color,transform] active:scale-[0.96] disabled:opacity-60",
                      on ? "border-2 border-brand bg-primary-soft/40 text-fg" : line.busy ? "border-warning/60 bg-warning-soft text-fg hover:bg-warning-soft/70" : "border-border-strong bg-surface text-fg hover:bg-surface-2")}>
                    <span className="block"><span className="sr-only">Table </span>{on && <Check aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />}{t.label}</span>
                    <span className={cn("max-w-full truncate text-[0.68rem] font-medium", line.busy ? "text-warning-fg" : "text-fg-subtle")}>{line.text}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const EMPTY_FORM = { name: "", phone: "", email: "" };
type FormErr = { name?: string; phone?: string; email?: string; form?: string };

/**
 * Attach a customer to a ticket: search the loaded list (works offline) or add a new one inline (needs the server).
 * Name and phone are each optional, at least one. A phone that already belongs to a customer selects that customer.
 * `onChange` may be async (placed orders save through the server); the dialog waits for it.
 */
export function CustomerPicker({ customers, value, onChange, onCreated, disabled, online, compact = false }: {
  customers: Customer[]; value: string; onChange: (id: string) => unknown; onCreated: (c: Customer) => void;
  disabled: boolean; online: boolean;
  /** Half-width beside the chosen table: the button reads "Customer" (its name stays "Add customer (optional)"). */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"search" | "new">("search");
  const [q, setQ] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [err, setErr] = useState<FormErr>({});
  const [saving, setSaving] = useState(false);
  const selected = customers.find((c) => c.id === value);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return customers;
    const digits = s.replace(/\D/g, "").replace(/^0+/, "");
    return customers.filter((c) => (c.name ?? "").toLowerCase().includes(s)
      || (!!c.phone && (c.phone.includes(s) || (digits.length >= 3 && c.phone.replace(/\D/g, "").includes(digits)))));
  }, [customers, q]);
  const typed = q.trim();

  function close() { setOpen(false); }
  function onOpenChange(o: boolean) {
    setOpen(o);
    if (!o) { setQ(""); setMode("search"); setErr({}); setForm(EMPTY_FORM); }
  }
  async function choose(id: string) {
    setSaving(true);
    try { await onChange(id); close(); } finally { setSaving(false); }
  }
  function startNew(prefill = "") {
    const p = prefill.trim();
    setForm({ ...EMPTY_FORM, ...(looksLikePhone(p) ? { phone: p } : { name: p }) });
    setErr({}); setMode("new");
  }
  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (list.length === 1 && typed) void choose(list[0].id);
    else if (list.length === 0 && typed && online) startNew(typed);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const name = form.name.trim(), phone = form.phone.trim(), email = form.email.trim();
    const next: FormErr = {};
    if (!name && !phone) next.form = "Enter a name or a phone number (or both).";
    const pp = phoneProblem(phone);
    if (pp) next.phone = pp;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) next.email = "Enter a valid email or leave it blank";
    setErr(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const { customer, existed } = await createOrFindCustomer({ name, phone, email });
      onCreated(customer);
      await onChange(customer.id);
      if (existed) toast.message(`Already a customer: ${customerLabel(customer)} — selected`);
      else toast.success(`${customerLabel(customer)} added`);
      onOpenChange(false);
    } catch (x) {
      setErr({ form: x instanceof ApiError ? (x.status === 0 ? "No connection. Adding a customer needs the server." : x.message) : "Could not add the customer" });
    } finally { setSaving(false); }
  }

  const sub = selected?.name && selected.phone ? selected.phone : null;
  return (
    <div>
      {value ? (
        <div className="flex min-h-11 items-center justify-between gap-1 rounded-lg bg-primary-soft pl-1 text-primary-soft-fg">
          <button type="button" disabled={disabled} onClick={() => setOpen(true)} aria-label={`Customer: ${selected ? customerLabel(selected) : "attached"}. Change customer`}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-semibold enabled:hover:bg-surface/40 disabled:cursor-default">
            <User className="size-4 shrink-0" aria-hidden /><span className="truncate">{selected ? customerLabel(selected) : "Customer attached"}</span>
            {sub && <span className="hidden truncate text-xs font-medium opacity-80 sm:inline">{sub}</span>}
          </button>
          {!disabled && <button type="button" aria-label="Remove customer" onClick={() => void onChange("")} className="grid size-11 shrink-0 place-items-center rounded-md hover:bg-surface/50"><X className="size-4" /></button>}
        </div>
      ) : (
        compact
          ? <button type="button" disabled={disabled} onClick={() => setOpen(true)} aria-label="Add customer (optional)" title="Add customer (optional)"
              className="grid size-11 place-items-center rounded-lg text-fg-muted hover:bg-surface hover:text-fg disabled:opacity-60"><UserPlus aria-hidden className="size-5" /></button>
          : <UiButton disabled={disabled} iconStart={<UserPlus aria-hidden />} onClick={() => setOpen(true)} className="w-full justify-start">Add customer (optional)</UiButton>
      )}
      <Dialog open={open} onOpenChange={onOpenChange}
        title={mode === "new" ? "New customer" : "Choose a customer"}
        description={mode === "new" ? "Name or phone, or both. They print on the bill, and the phone is used for WhatsApp." : "Their name and phone print on the bill and the bill can go on WhatsApp."}
        footer={mode === "new" ? <>
          <Button variant="secondary" iconStart={<ArrowLeft />} disabled={saving} onClick={() => { setMode("search"); setErr({}); }}>Back</Button>
          <Button variant="primary" type="submit" form="pos-new-customer" loading={saving} iconStart={<Check />}>Save and select</Button>
        </> : undefined}>
        {mode === "search" ? (
          <div className="pb-3">
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
              <input aria-label="Search customers" type="search" autoFocus placeholder="Search name or phone" value={q}
                onChange={(e) => setQ(e.target.value)} onKeyDown={onSearchKey} className="ch-input w-full pl-9" />
            </div>
            <div className="mt-3">
              {typed && list.length === 0 ? (
                <Button variant="primary" disabled={!online} iconStart={<UserPlus />} onClick={() => startNew(typed)} className="w-full min-h-12 justify-start">
                  <span className="truncate">Add &lsquo;{typed}&rsquo; as a new customer</span>
                </Button>
              ) : (
                <Button variant="secondary" disabled={!online} iconStart={<UserPlus />} onClick={() => startNew(typed && list.length === 0 ? typed : "")} className="w-full min-h-12 justify-start font-semibold">New customer</Button>
              )}
              {!online && <p className="mt-1.5 text-xs text-fg-muted">Adding a new customer needs a connection. You can still pick one from the list.</p>}
            </div>
            <ul className="mt-3 grid gap-2" aria-label="Customers">
              {list.length === 0 && <li className="py-5 text-center text-sm text-fg-muted">{customers.length === 0 ? "No customers yet." : "No customers match."}</li>}
              {list.slice(0, 60).map((c) => (
                <li key={c.id}>
                  <button type="button" disabled={saving} onClick={() => void choose(c.id)} aria-current={c.id === value || undefined}
                    className={cn("flex min-h-14 w-full flex-col items-start justify-center rounded-xl border px-4 text-left transition-colors hover:bg-surface-2 disabled:opacity-60",
                      c.id === value ? "border-primary bg-primary-soft/60" : "border-border bg-surface")}>
                    <span className="font-semibold text-fg">{customerLabel(c)}</span>
                    {c.name && c.phone && <span className="text-xs text-fg-muted">{c.phone}</span>}
                    {!c.phone && <span className="text-xs text-fg-subtle">No phone</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <form id="pos-new-customer" noValidate onSubmit={(e) => void save(e)} className="space-y-3 pb-3">
            {err.form && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger-fg">{err.form}</p>}
            <Input label="Name" autoComplete="off" autoFocus={!form.name || !!form.phone} placeholder="e.g. Priya Sharma" value={form.name} error={err.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            <Input label="Phone" type="tel" inputMode="tel" autoComplete="off" autoFocus={!!form.name && !form.phone} placeholder={phoneHint()} hint={`Mobile ${phoneHint()}`}
              value={form.phone} error={err.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            <Input label="Email (optional)" type="email" inputMode="email" autoComplete="off" value={form.email} error={err.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            <p className="text-xs text-fg-muted">Both are optional, but enter at least one. If the phone is already saved, that customer is selected.</p>
          </form>
        )}
      </Dialog>
    </div>
  );
}
