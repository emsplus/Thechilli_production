"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Download, Pencil, UserPlus } from "lucide-react";
import { Badge, Button, EmptyState, Input, Notice, PageHeader, Select, Sheet, Skeleton, StatCard, Switch, Textarea } from "@chilli/ui";
import { DataTable, FilterBar, downloadCsv, toCsv, type DataColumn } from "@chilli/ui/data";
import { api, ApiError } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/datetime";
import { formatCompactMoney, formatCurrency, sumMoney } from "@/lib/money";
import type { Consent, Customer, HistoryBill } from "@/lib/types";
import { useLoader } from "@/lib/useLoader";
import { useAsk } from "@/lib/useAsk";
import { useNotify } from "@/lib/useNotify";
import { useCan } from "@/lib/useRole";
import { useCurrency } from "@/lib/taxConfig";
import { customerLabel } from "@/lib/customers";
import { msg, useLocale, useMsg } from "@/lib/i18n";
import { CUSTOMERS_MSG } from "./messages";

type Channel = Consent["channel"];
const CHANNELS: { id: Channel; label: string }[] = [{ id: "whatsapp", label: "WhatsApp" }, { id: "sms", label: "SMS" }, { id: "email", label: "Email" }];
const SOURCES = ["Verbal at counter", "Signed form", "Customer message", "Customer request"];
type T = (k: string, p?: Record<string, string | number>) => string;
const em = (e: unknown, t: T) => (e instanceof ApiError ? e.message : t("error"));
/** Marks a failure without a server message, so the text follows the language. */
const GENERIC = "\u0000";
type Tone = "success" | "warning" | "neutral";

function consentOf(c: Customer, ch: Channel, t: T): { tone: Tone; text: string; detail: string } {
  const x = c.consents.find((k) => k.channel === ch);
  if (!x) return { tone: "neutral", text: t("noConsent"), detail: t("neverAsked") };
  const when = `${formatDateTime(x.recorded_at)} · ${x.source}`;
  return x.granted ? { tone: "success", text: t("granted"), detail: t("grantedWhen", { when }) } : { tone: "warning", text: t("withdrawn"), detail: t("withdrawnWhen", { when }) };
}
const grantedOn = (c: Customer, ch: Channel) => c.consents.find((k) => k.channel === ch)?.granted === true;
/** Number text of a total for CSV and sorting (rupees, not paise). */
const spent = (c: Customer) => Number(c.total_spent);

/** The customers list + detail sheet. Rendered by /customers (all staff) and by Manage -> Customers (owner/manager). */
export function CustomersView({ embedded = false }: { embedded?: boolean }) {
  const { can } = useCan();
  const t = useMsg(CUSTOMERS_MSG);
  const { locale } = useLocale();
  const canWrite = can("crm.write");
  const currency = useCurrency();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => { const tm = setTimeout(() => setDq(q.trim()), 250); return () => clearTimeout(tm); }, [q]);
  const fetcher = useCallback(() => api.customers(dq || undefined), [dq]);
  const { data, error, loading, reload } = useLoader(fetcher);
  const [addOpen, setAddOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [consent, setConsent] = useState("all");
  const [visits, setVisits] = useState("all");

  const rows = useMemo(() => (data ?? []).filter((c) =>
    (consent === "all" || grantedOn(c, consent as Channel)) &&
    (visits === "all" || (visits === "repeat" ? c.orders >= 2 : visits === "one" ? c.orders === 1 : c.orders === 0))), [data, consent, visits]);
  const selected = useMemo(() => data?.find((c) => c.id === sel) ?? null, [data, sel]);
  const stats = useMemo(() => {
    const all = data ?? [];
    return { count: all.length, repeat: all.filter((c) => c.orders >= 2).length, total: sumMoney(all.map((c) => c.total_spent)) };
  }, [data]);

  const columns: DataColumn<Customer>[] = [
    { key: "name", header: t("colCustomer"), sortValue: (c) => customerLabel(c, locale).toLowerCase(), csv: (c) => c.name ?? "", render: (c) => (
      <button type="button" onClick={() => setSel(c.id)} aria-label={t("openDetails", { name: customerLabel(c, locale) })}
        className="min-h-11 max-w-64 whitespace-normal text-left font-semibold text-primary underline-offset-2 [overflow-wrap:anywhere] hover:underline">{customerLabel(c, locale)}</button>
    ) },
    { key: "phone", header: t("colPhone"), sortValue: (c) => c.phone ?? "", csv: (c) => c.phone ?? "", render: (c) => <span className="tnum">{c.phone ?? <span className="text-fg-muted">{t("noPhone")}</span>}</span> },
    { key: "visits", header: t("colVisits"), align: "end", sortValue: (c) => c.orders, render: (c) => <span className="tnum">{c.orders}</span> },
    { key: "spent", header: t("colSpent"), align: "end", sortValue: spent, csv: spent, render: (c) => <span className="ch-money" translate="no" title={formatCurrency(c.total_spent, currency)}>{formatCompactMoney(c.total_spent, currency, locale)}</span> },
    { key: "last", header: t("colLast"), sortValue: (c) => c.last_visit ?? "", csv: (c) => c.last_visit ?? "", render: (c) => (c.last_visit ? formatDate(c.last_visit) : "-") },
    { key: "consent", header: t("colConsent"), render: (c) => (
      <div className="flex gap-1.5">{CHANNELS.map((ch) => { const s = consentOf(c, ch.id, t); return <span key={ch.id} title={`${ch.label}: ${s.detail}`}><Badge tone={s.tone}><span className="sr-only">{t("consentSr", { ch: ch.label, text: s.text })}</span>{ch.label}</Badge></span>; })}</div>
    ) },
  ];

  function exportCsv() {
    const headers = ["Name", "Phone", "Email", "Visits", "Spent", "Last visit", ...CHANNELS.map((c) => `${c.label} consent`)];
    downloadCsv("customers.csv", toCsv(headers, rows.map((c) => [c.name ?? "", c.phone ?? "", c.email ?? "", c.orders, spent(c), c.last_visit ?? "", ...CHANNELS.map((ch) => consentOf(c, ch.id, (k, p) => msg("en", CUSTOMERS_MSG[k as keyof typeof CUSTOMERS_MSG], p)).text)])));
  }

  const add = canWrite && <Button variant="primary" iconStart={<UserPlus />} onClick={() => setAddOpen(true)}>{t("newCustomer")}</Button>;
  const filtering = dq !== "" || consent !== "all" || visits !== "all";

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <Button iconStart={<Download />} disabled={rows.length === 0} onClick={exportCsv}>{t("exportCsv")}</Button>
          {add}
        </div>
      ) : (
        <PageHeader title={t("title")} description={t("description")}
          actions={<><Button iconStart={<Download />} disabled={rows.length === 0} onClick={exportCsv}>{t("exportCsv")}</Button>{add}</>} />
      )}

      {data && !dq && data.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <StatCard label={t("statCustomers")} value={stats.count} />
          <StatCard label={t("statRepeat")} value={stats.repeat} />
          <StatCard label={t("statTotal")} value={<span title={formatCurrency(stats.total, currency)}>{formatCompactMoney(stats.total, currency, locale)}</span>} />
        </div>
      )}

      <div className="mb-3 max-w-md"><Input label={t("searchCustomers")} type="search" autoComplete="off" placeholder={t("searchPh")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="mb-4">
        <FilterBar label={t("filterCustomers")} activeCount={(consent !== "all" ? 1 : 0) + (visits !== "all" ? 1 : 0)} onReset={() => { setConsent("all"); setVisits("all"); }}>
          <Select label={t("colConsent")} value={consent} onChange={(e) => setConsent(e.target.value)}><option value="all">{t("anyone")}</option>{CHANNELS.map((c) => <option key={c.id} value={c.id}>{t("channelGranted", { ch: c.label })}</option>)}</Select>
          <Select label={t("visits")} value={visits} onChange={(e) => setVisits(e.target.value)}><option value="all">{t("anyNumber")}</option><option value="repeat">{t("twoOrMore")}</option><option value="one">{t("exactlyOne")}</option><option value="none">{t("noneYet")}</option></Select>
        </FilterBar>
      </div>
      {error && <div className="mb-4"><Notice tone="danger" title={t("loadFail")} action={data ? <Button size="sm" onClick={() => void reload()}>{t("retry")}</Button> : undefined}>{error}</Notice></div>}

      <DataTable caption={t("title")} columns={columns} rows={rows} getKey={(c) => c.id} stickyFirstColumn={false}
        status={loading ? "loading" : error && !data ? "error" : "ready"} onRetry={() => void reload()} errorTitle={t("loadFail")}
        empty={<EmptyState title={filtering ? t("noMatching") : t("noCustomers")} description={filtering ? t("noMatchingDesc") : t("noCustomersDesc")}
          {...(!filtering && canWrite ? { actionLabel: t("addFirst"), onAction: () => setAddOpen(true), actionVariant: "secondary" as const } : {})} />} />

      <CustomerFormSheet open={addOpen} onOpenChange={setAddOpen} onDone={() => void reload()} />
      <DetailSheet customer={selected} canWrite={canWrite} onClose={() => setSel(null)} onChanged={() => void reload()} />
    </>
  );
}

/* ------------------------------------------------------------------ add */
// Name and phone are each optional, but at least one is required (the server normalises the phone by country).
const makeSchema = (t: T) => z.object({
  name: z.string().trim().max(200),
  phone: z.string().trim().refine((v) => v === "" || /^\+?[\d\s()-]{7,20}$/.test(v), t("phoneInvalid")),
  email: z.string().trim().refine((v) => v === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), t("emailInvalid")),
  notes: z.string().trim().max(500, t("notesMax")),
}).refine((v) => v.name !== "" || v.phone !== "", { message: t("nameOrPhone"), path: ["name"] });
type Form = z.infer<ReturnType<typeof makeSchema>>;

const PHONE_BY_COUNTRY: Record<string, { code: string; placeholder: string; hint: string }> = {
  IN: { code: "+91", placeholder: "98765 43210", hint: "hintIN" },
};

/** Add a customer, or edit one (pass `customer`). Same fields and rules either way. */
function CustomerFormSheet({ open, onOpenChange, onDone, customer }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void; customer?: Customer | null }) {
  const edit = !!customer;
  const toast = useNotify();
  const t = useMsg(CUSTOMERS_MSG);
  const { locale } = useLocale();
  const schema = useMemo(() => makeSchema(t), [t]);
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { name: "", phone: "", email: "", notes: "" } });
  const [err, setErr] = useState<string | null>(null);
  const cc = PHONE_BY_COUNTRY.IN; // INR / India only
  // Fill the form when the sheet opens (or opens on another customer), not on every list refetch: a background reload
  // (search, consent change) hands a new `customer` object and used to wipe what was being typed.
  const custId = customer?.id;
  useEffect(() => { if (open) { reset({ name: customer?.name ?? "", phone: customer?.phone ?? "", email: customer?.email ?? "", notes: customer?.notes ?? "" }); void Promise.resolve().then(() => setErr(null)); } }, [open, reset, custId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet side="right" open={open} onOpenChange={onOpenChange} title={edit ? t("editCustomer") : t("newCustomer")} description={t("formDesc", { code: cc.code })}
      footer={<><Button onClick={() => onOpenChange(false)}>{t("cancel")}</Button><Button variant="primary" type="submit" form="customer-form" loading={isSubmitting}>{edit ? t("saveChanges") : t("addCustomer")}</Button></>}>
      <form id="customer-form" noValidate className="space-y-4" onSubmit={handleSubmit(async (v) => {
        setErr(null);
        try {
          if (customer) { const c = await api.updateCustomer(customer.id, { name: v.name || null, phone: v.phone || null, email: v.email || null, notes: v.notes || null }); toast.success(t("saved", { name: customerLabel(c, locale) })); }
          else { const c = await api.createCustomer({ name: v.name || null, phone: v.phone || null, ...(v.email ? { email: v.email } : {}), ...(v.notes ? { notes: v.notes } : {}) }); toast.success(t("added", { name: customerLabel(c, locale) })); }
          onOpenChange(false); onDone();
        }
        catch (e) { setErr(em(e, t)); }
      })}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label={t("name")} autoFocus autoComplete="off" error={errors.name?.message} {...register("name")} />
        <Input label={t("phone")} type="tel" inputMode="tel" placeholder={cc.placeholder} hint={t(cc.hint)} error={errors.phone?.message} {...register("phone")} />
        <Input label={t("emailOpt")} type="email" error={errors.email?.message} {...register("email")} />
        <Textarea label={t("notesOpt")} rows={3} placeholder={t("notesPh")} error={errors.notes?.message} {...register("notes")} />
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ detail */
function DetailSheet({ customer, canWrite, onClose, onChanged }: { customer: Customer | null; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
  const [ask, askNode] = useAsk();
  const toast = useNotify();
  const t = useMsg(CUSTOMERS_MSG);
  const { locale } = useLocale();
  const currency = useCurrency();
  const [hist, setHist] = useState<HistoryBill[] | null>(null);
  const [histErr, setHistErr] = useState<string | null>(null);
  const [source, setSource] = useState(SOURCES[0]);
  const [busy, setBusy] = useState<Channel | null>(null);
  const [last, setLast] = useState<Customer | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const c = customer ?? last;
  const id = customer?.id;

  useEffect(() => { if (customer) void Promise.resolve().then(() => setLast(customer)); }, [customer]);
  useEffect(() => {
    if (!id) return;
    let off = false;
    void Promise.resolve().then(() => { setHist(null); setHistErr(null); });
    api.customerHistory(id).then((h) => { if (!off) setHist(h); }).catch((e) => { if (!off) setHistErr(e instanceof ApiError ? e.message : GENERIC); });
    return () => { off = true; };
  }, [id]);

  async function toggle(ch: (typeof CHANNELS)[number], granted: boolean) {
    if (!c) return;
    const ok = await ask(granted
      ? { title: t("recordTitle", { ch: ch.label }), description: t("recordDesc", { name: customerLabel(c, locale), ch: ch.label, source: t(`source.${source}`) }), confirmLabel: t("recordConfirm") }
      : { title: t("withdrawTitle", { ch: ch.label }), description: t("withdrawDesc", { name: customerLabel(c, locale), ch: ch.label }), confirmLabel: t("withdrawConfirm"), destructive: true });
    if (!ok) return;
    setBusy(ch.id);
    try { await api.recordConsent(c.id, { channel: ch.id, granted, source: granted ? source : "Customer request" }); toast.success(granted ? t("recorded", { ch: ch.label }) : t("withdrew", { ch: ch.label })); onChanged(); }
    catch (e) { toast.error(em(e, t)); } finally { setBusy(null); }
  }

  function exportHistory() {
    if (!c || !hist) return;
    downloadCsv(`${customerLabel(c, locale).replace(/[^\p{L}\p{N}]+/gu, "-")}-history.csv`, toCsv(["Invoice", "Date", "Total", "Items"], hist.map((h) => [h.invoice_number, h.finalized_at, Number(h.total), h.items.join("; ")])));
  }

  return (
    <>
      <Sheet side="right" open={!!customer} onOpenChange={(o) => { if (!o) onClose(); }} title={c ? customerLabel(c, locale) : t("customer")} description={c ? [c.name ? c.phone : null, c.email].filter(Boolean).join(" · ") || undefined : undefined}>
        {c && (
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{c.notes ? c.notes : t("noNotes")}</p>
              {canWrite && <Button iconStart={<Pencil />} onClick={() => setEditOpen(true)}>{t("edit")}</Button>}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <StatCard label={t("visits")} value={c.orders} />
              <StatCard label={t("colSpent")} value={<span title={formatCurrency(c.total_spent, currency)}>{formatCompactMoney(c.total_spent, currency, locale)}</span>} />
              <StatCard label={t("colLast")} value={c.last_visit ? formatDate(c.last_visit) : "-"} />
            </div>

            <section aria-labelledby="consent-h">
              <h3 id="consent-h" className="text-base font-semibold">{t("colConsent")}</h3>
              {canWrite && <div className="mt-2"><Select label={t("sourceWhenGranting")} value={source} onChange={(e) => setSource(e.target.value)} hint={t("sourceHint")}>
                {SOURCES.map((s) => <option key={s} value={s}>{t(`source.${s}`)}</option>)}
              </Select></div>}
              <ul className="mt-2 divide-y divide-border">
                {CHANNELS.map((ch) => {
                  const s = consentOf(c, ch.id, t); const on = c.consents.find((k) => k.channel === ch.id)?.granted ?? false;
                  return (
                    <li key={ch.id}>
                      <Switch label={t("channelMarketing", { ch: ch.label })} hint={s.detail} checked={on} disabled={!canWrite || busy === ch.id} onChange={(e) => void toggle(ch, e.target.checked)} />
                    </li>
                  );
                })}
              </ul>
              <div className="mt-3"><Notice tone="info">{t("appendOnly")}</Notice></div>
            </section>

            <section aria-labelledby="hist-h">
              <div className="flex items-center justify-between gap-2">
                <h3 id="hist-h" className="text-base font-semibold">{t("purchaseHistory")}</h3>
                <Button size="sm" iconStart={<Download />} disabled={!hist || hist.length === 0} onClick={exportHistory}>{t("exportCsv")}</Button>
              </div>
              {histErr && <div className="mt-2"><Notice tone="danger">{histErr === GENERIC ? t("error") : histErr}</Notice></div>}
              {!hist && !histErr && <div className="mt-2 space-y-2" role="status" aria-label={t("loadingHistory")}><Skeleton height={48} /><Skeleton height={48} /></div>}
              {hist && hist.length === 0 && <p className="mt-2 text-sm text-fg-muted">{t("noPurchases")}</p>}
              {hist && hist.length > 0 && (
                <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                  {hist.map((h) => (
                    <li key={h.invoice_number} className="px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2"><span className="font-mono text-xs font-medium text-fg">{h.invoice_number}</span><span className="ch-money font-semibold" translate="no">{formatCurrency(h.total, currency)}</span></div>
                      <p className="text-xs text-fg-muted">{formatDateTime(h.finalized_at)}</p>
                      <p className="mt-0.5 text-sm text-fg-muted [overflow-wrap:anywhere]">{h.items.join(", ")}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
        {/* Inside the Sheet on purpose: a sibling overlay would count as an outside click and close this one. */}
        {askNode}
        <CustomerFormSheet open={editOpen} onOpenChange={setEditOpen} onDone={onChanged} customer={c} />
      </Sheet>
    </>
  );
}
