"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm, useWatch, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CircleAlert, CircleCheck, Clock, Pencil, Plus, Printer as PrinterIcon, RotateCcw, Send, Trash2 } from "lucide-react";
import { Badge, Button, Checkbox, Dialog, IconButton, Input, Notice, Select, Switch, type BadgeTone } from "@chilli/ui";
import { Card, EmptyState, SegmentedControl, Skeleton, toast, useConfirm } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { useLocale, useMsg } from "@/lib/i18n";
import { jobBusy, jobKindText, jobStateText, plainError } from "@/lib/printJobs";
import { usePoll } from "@/lib/usePoll";
import type { Category, PrintHub, PrintJob, PrinterCodepage, PrinterConfig, PrinterRole, PrinterStatus } from "@/lib/types";
import { PrintHubCard } from "./PrintHubCard";
import { PRINT_MSG } from "./devices-messages";
import { useManage } from "./manage-context";

const ROLE_TONE: Record<PrinterRole, BadgeTone> = { counter: "primary", kitchen: "warning", other: "neutral" };
const STATUS_TONE: Record<PrinterStatus, BadgeTone> = { online: "success", offline: "danger", unknown: "neutral" };
const CODEPAGES: PrinterCodepage[] = ["pc858", "cp1252", "cp437", "none"];
const JOB_TONE: Record<PrintJob["status"], BadgeTone> = { queued: "warning", sent: "info", printed: "success", failed: "danger" };
const JOB_ICON: Record<PrintJob["status"], React.ReactNode> = { queued: <Clock />, sent: <Send />, printed: <CircleCheck />, failed: <CircleAlert /> };
const HOST_RE = /^[A-Za-z0-9.\-:[\]_]{1,255}$/;
const em = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

type T = (key: string, params?: Record<string, string | number>) => string;
const connectionText = (p: PrinterConfig, t: T) => (p.connection === "lan" ? t("connLan", { host: p.host ?? "", port: p.port }) : t("connSystem", { queue: p.system_name ?? "" }));

const makeSchema = (t: T) => z.object({
  name: z.string().trim().min(1, t("vName")).max(100, t("vMax100")),
  role: z.enum(["counter", "kitchen", "other"]),
  connection: z.enum(["lan", "system"]),
  host: z.string().trim().max(255),
  port: z.string().regex(/^\d{1,5}$/, t("vPort")).refine((v) => Number(v) >= 1 && Number(v) <= 65535, t("vPort")),
  system_name: z.string().trim().max(255),
  columns: z.string().regex(/^\d{1,3}$/, t("vColumns")).refine((v) => Number(v) >= 24 && Number(v) <= 64, t("vColumns")),
  codepage: z.enum(["pc858", "cp1252", "cp437", "none"]),
  copies: z.string(),
  cut: z.boolean(),
  is_active: z.boolean(),
  auto_bill: z.boolean(),
  auto_kot: z.boolean(),
  kot_category_ids: z.array(z.string()),
}).superRefine((v, ctx) => {
  if (v.connection === "lan") {
    if (!v.host) ctx.addIssue({ code: "custom", path: ["host"], message: t("vHost") });
    else if (!HOST_RE.test(v.host)) ctx.addIssue({ code: "custom", path: ["host"], message: t("vHostBad") });
  } else if (!v.system_name) ctx.addIssue({ code: "custom", path: ["system_name"], message: t("vQueue") });
});
type Form = z.infer<ReturnType<typeof makeSchema>>;
const BLANK: Form = { name: "", role: "counter", connection: "lan", host: "", port: "9100", system_name: "", columns: "42", codepage: "pc858", copies: "1", cut: true, is_active: true, auto_bill: false, auto_kot: false, kot_category_ids: [] };

export function PrintersTab() {
  const t = useMsg(PRINT_MSG);
  const confirm = useConfirm();
  const { me } = useManage();
  const canManage = me.permissions ? me.permissions.includes("printing.manage") : true;
  const printers = usePoll(api.printers, 10_000);
  const [pairing, setPairing] = useState(false);
  const hubs = usePoll(api.printHubs, pairing ? 3000 : 15_000);
  const [jobsMs, setJobsMs] = useState(10_000);
  const fetchJobs = useCallback(() => api.printJobs({ limit: 30 }), []);
  const jobs = usePoll(fetchJobs, jobsMs);
  const cats = usePoll(api.categories, 0);
  const [dialog, setDialog] = useState<{ printer: PrinterConfig | null } | null>(null);
  // printer id -> the test job just sent, followed through the jobs list
  const [tests, setTests] = useState<Record<string, string>>({});

  const jobList = jobs.data ?? [];
  const fast = jobList.some(jobBusy);
  useEffect(() => { void Promise.resolve().then(() => setJobsMs(fast ? 2000 : 10_000)); }, [fast]);

  const hubOnline = (hubs.data ?? []).some((h) => h.online);
  const list = printers.data ?? [];
  const reloadAll = () => { void printers.reload(); void jobs.reload(); };

  async function toggle(p: PrinterConfig, field: "auto_bill" | "auto_kot", on: boolean) {
    try { await api.updatePrinter(p.id, { [field]: on }); await printers.reload(); }
    catch (e) { toast.error(em(e, t("saveChangeFail"))); }
  }
  async function test(p: PrinterConfig, codepage?: PrinterCodepage) {
    try {
      const r = await api.testPrinter(p.id, codepage);
      if (r.jobs[0]) setTests((t) => ({ ...t, [p.id]: r.jobs[0].id }));
      toast.success(t("testSent", { name: p.name }));
      void jobs.reload();
    } catch (e) { toast.error(em(e, t("testFail"))); }
  }
  async function remove(p: PrinterConfig) {
    if (!(await confirm({ title: t("delTitle", { name: p.name }), description: t("delDesc"), confirmLabel: t("delConfirm"), tone: "danger" }))) return;
    try { await api.deletePrinter(p.id); toast.success(t("deleted", { name: p.name })); reloadAll(); }
    catch (e) { toast.error(em(e, t("delFail"))); }
  }
  async function reprint(j: PrintJob) {
    if (!j.ref_id) return;
    try {
      if (j.kind === "bill") await api.printBill(j.ref_id, j.printer_id); else await api.printKot(j.ref_id, j.printer_id);
      toast.success(t("reprintOk", { name: j.printer_name ?? t("thePrinter") }));
      void jobs.reload();
    } catch (e) { toast.error(em(e, t("reprintFail"))); }
  }

  return (
    <div className="space-y-6">
      <PrintHubCard hubs={hubs.data} loading={hubs.loading} error={hubs.error} reload={hubs.reload} onPairingChange={setPairing} />

      <section aria-label={t("printers")} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-fg">{t("printers")}</h2>
            <p className="text-sm text-fg-muted">{t("printersDesc")}</p>
          </div>
          {canManage && <Button variant="primary" iconStart={<Plus />} onClick={() => setDialog({ printer: null })}>{t("addPrinter")}</Button>}
        </div>
        {printers.error && <Notice tone="danger" action={<Button variant="secondary" size="sm" onClick={() => void printers.reload()}>{t("retry")}</Button>}>{printers.error}</Notice>}
        {printers.loading && !printers.data ? <div role="status" aria-label={t("loadingPrinters")}><Skeleton className="h-40 rounded-2xl" /></div>
          : list.length === 0 ? (
            <Card><EmptyState icon={<PrinterIcon />} title={t("emptyTitle")} hint={t("emptyHint")}
              action={<Button variant="primary" iconStart={<Plus />} onClick={() => setDialog({ printer: null })}>{t("addFirst")}</Button>} /></Card>
          ) : (
            <ul className="space-y-3">
              {list.map((p) => (
                <PrinterCard key={p.id} p={p} categories={cats.data ?? []} hubOnline={hubOnline} job={jobList.find((j) => j.id === tests[p.id]) ?? null}
                  onToggle={(f, on) => toggle(p, f, on)} onTest={(cp) => void test(p, cp)} onEdit={() => setDialog({ printer: p })} onDelete={() => void remove(p)} />
              ))}
            </ul>
          )}
      </section>

      <RecentPrints jobs={jobs.data} loading={jobs.loading} error={jobs.error} onReprint={(j) => void reprint(j)} />
      <PrinterDialog state={dialog} categories={cats.data ?? []} hubs={hubs.data ?? []} onClose={() => setDialog(null)} onDone={reloadAll} />
    </div>
  );
}

function PrinterCard({ p, categories, hubOnline, job, onToggle, onTest, onEdit, onDelete }: {
  p: PrinterConfig; categories: Category[]; hubOnline: boolean; job: PrintJob | null;
  onToggle: (f: "auto_bill" | "auto_kot", on: boolean) => Promise<void>; onTest: (cp?: PrinterCodepage) => Promise<void> | void; onEdit: () => void; onDelete: () => void;
}) {
  const t = useMsg(PRINT_MSG);
  const { locale } = useLocale();
  const [cp, setCp] = useState<"" | PrinterCodepage>("");
  const [sending, setSending] = useState(false);
  // The switch follows the tap at once; the saved value takes over when the request is done.
  const [pending, setPending] = useState<Partial<Record<"auto_bill" | "auto_kot", boolean>>>({});
  const flip = async (f: "auto_bill" | "auto_kot", on: boolean) => { setPending((x) => ({ ...x, [f]: on })); try { await onToggle(f, on); } finally { setPending((x) => ({ ...x, [f]: undefined })); } };
  const st = p.status;
  const routed = categories.filter((c) => p.kot_category_ids.includes(c.id)).map((c) => c.name);
  return (
    <li data-testid="printer-card" data-printer={p.name}>
      <Card className={p.is_active ? "" : "opacity-75"}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <PrinterIcon aria-hidden className="size-5 text-fg-subtle" />
          <h3 className="min-w-0 flex-1 truncate font-display text-base font-bold text-fg">{p.name}</h3>
          <Badge tone={ROLE_TONE[p.role]}>{t(`role_${p.role}`)}</Badge>
          <span data-testid="printer-status" title={t(`hint_${st}`)}><Badge tone={STATUS_TONE[st]}><span aria-hidden className="size-2 rounded-full bg-current" />{t(`status_${st}`)}</Badge></span>
          {!p.is_active && <Badge tone="neutral">{t("notInUse")}</Badge>}
        </div>
        <p className="mt-1 pl-8 text-sm text-fg-muted">{t(p.copies === 1 ? "metaOne" : "metaMany", { conn: connectionText(p, t), columns: p.columns, copies: p.copies })}</p>
        {p.role === "kitchen" && <p className="mt-0.5 pl-8 text-sm text-fg-muted">{routed.length > 0 ? t("onlyCats", { list: routed.join(", ") }) : t("allCats")}</p>}

        <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
          <Switch label={t("autoBill")} checked={pending.auto_bill ?? p.auto_bill} onChange={(e) => void flip("auto_bill", e.target.checked)} />
          <Switch label={t("autoKot")} checked={pending.auto_kot ?? p.auto_kot} onChange={(e) => void flip("auto_kot", e.target.checked)} />
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="w-44"><Select label={t("testCodepage")} value={cp} onChange={(e) => setCp(e.target.value as "" | PrinterCodepage)}>
            <option value="">{t("cpOwn")}</option>
            {CODEPAGES.map((c) => <option key={c} value={c}>{t(`cp_${c}`)}</option>)}
          </Select></div>
          <Button variant="secondary" loading={sending} iconStart={<PrinterIcon />} onClick={async () => { setSending(true); try { await onTest(cp || undefined); } finally { setSending(false); } }}>{t("testPrint")}</Button>
          <div className="ml-auto flex gap-1.5">
            <IconButton variant="secondary" label={t("editAria", { name: p.name })} icon={<Pencil />} onClick={onEdit} />
            <IconButton variant="secondary" label={t("deleteAria", { name: p.name })} icon={<Trash2 />} onClick={onDelete} />
          </div>
        </div>

        {job && (
          <div data-testid="test-progress" className="mt-3 space-y-1 rounded-xl bg-surface-2/60 p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2 font-semibold text-fg">{t("testPage")} <Badge tone={JOB_TONE[job.status]}>{JOB_ICON[job.status]}{jobStateText(job.status, locale)}</Badge></p>
            {job.status === "queued" && <p className="text-fg-muted">{hubOnline ? t("queuedHub") : t("queuedNoHub")}</p>}
            {job.status === "sent" && <p className="text-fg-muted">{t("sentHub")}</p>}
            {job.status === "printed" && <p className="text-fg-muted">{t("printedHint")}</p>}
            {job.status === "failed" && <p className="text-danger-fg">{plainError(job.last_error, locale)}</p>}
            {job.status !== "failed" && job.last_error && <p className="text-fg-muted">{t("lastTry", { err: plainError(job.last_error, locale) })}</p>}
          </div>
        )}
      </Card>
    </li>
  );
}

function RecentPrints({ jobs, loading, error, onReprint }: { jobs: PrintJob[] | null; loading: boolean; error: string | null; onReprint: (j: PrintJob) => void }) {
  const t = useMsg(PRINT_MSG);
  const { locale } = useLocale();
  return (
    <section aria-label={t("recent")} className="space-y-3">
      <h2 className="font-display text-lg font-bold text-fg">{t("recent")}</h2>
      {error && <Notice tone="danger">{error}</Notice>}
      {loading && !jobs ? <Skeleton className="h-32 rounded-xl" /> : !jobs || jobs.length === 0 ? (
        <Card><p className="text-sm text-fg-muted">{t("nothingPrinted")}</p></Card>
      ) : (
        <div className="ch-table-wrap" role="region" aria-label={t("recentTable")} tabIndex={0}><table className="ch-table" data-testid="recent-prints">
          <thead><tr><th scope="col">{t("thTime")}</th><th scope="col">{t("thPrinter")}</th><th scope="col">{t("thWhat")}</th><th scope="col">{t("thStatus")}</th><th scope="col">{t("thProblem")}</th><th scope="col"><span className="ch-sr-only">{t("thActions")}</span></th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} data-testid="job-row" data-kind={j.kind} data-status={j.status}>
                <td className="whitespace-nowrap">{formatDateTime(j.created_at)}</td>
                <td>{j.printer_name ?? "-"}</td>
                <td>{j.reprint_no > 0 ? t("kindReprint", { kind: jobKindText(j.kind, locale), n: j.reprint_no }) : jobKindText(j.kind, locale)}</td>
                <td><Badge tone={JOB_TONE[j.status]}>{JOB_ICON[j.status]}{jobStateText(j.status, locale)}</Badge></td>
                <td className="max-w-xs text-fg-muted">{j.status === "failed" ? plainError(j.last_error, locale) : j.last_error ? t("retrying", { err: j.last_error }) : ""}</td>
                <td>{j.status === "failed" && j.ref_id && j.kind !== "test" && <Button variant="secondary" size="sm" iconStart={<RotateCcw />} onClick={() => onReprint(j)}>{t("reprint")}</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

function PrinterDialog({ state, categories, hubs, onClose, onDone }: { state: { printer: PrinterConfig | null } | null; categories: Category[]; hubs: PrintHub[]; onClose: () => void; onDone: () => void }) {
  const t = useMsg(PRINT_MSG);
  const schema = useMemo(() => makeSchema(t), [t]);
  const printer = state?.printer ?? null;
  const open = state !== null;
  const { register, control, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: BLANK });
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState(false);
  const queues = [...new Set(hubs.flatMap((h) => h.system_printers))].sort();
  useEffect(() => {
    if (!open) return;
    reset(printer ? {
      name: printer.name, role: printer.role, connection: printer.connection, host: printer.host ?? "", port: String(printer.port), system_name: printer.system_name ?? "", columns: String(printer.columns),
      codepage: printer.codepage, copies: String(printer.copies), cut: printer.cut, is_active: printer.is_active, auto_bill: printer.auto_bill, auto_kot: printer.auto_kot, kot_category_ids: printer.kot_category_ids,
    } : BLANK);
    void Promise.resolve().then(() => { setErr(null); setTyped(false); });
  }, [open, printer, reset]);
  const connection = useWatch({ control, name: "connection" });
  const role = useWatch({ control, name: "role" });
  const queue = useWatch({ control, name: "system_name" });
  // A queue name that no hub reported (or no hub yet) is typed by hand.
  const manual = typed || queues.length === 0 || (queue !== "" && !queues.includes(queue));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={printer ? t("editTitle", { name: printer.name }) : t("addTitle")} description={t("dialogDesc")}
      footer={<><Button variant="secondary" onClick={onClose}>{t("cancel")}</Button><Button variant="primary" type="submit" form="printer-form" loading={isSubmitting}>{printer ? t("saveChanges") : t("addPrinter")}</Button></>}>
      <form id="printer-form" noValidate className="space-y-4 py-2" onSubmit={handleSubmit(async (v) => {
        setErr(null);
        const body = {
          name: v.name, role: v.role, connection: v.connection, host: v.connection === "lan" ? v.host : null, port: Number(v.port), system_name: v.connection === "system" ? v.system_name : null,
          columns: Number(v.columns), codepage: v.codepage, copies: Number(v.copies), cut: v.cut, is_active: v.is_active, auto_bill: v.auto_bill, auto_kot: v.auto_kot,
          kot_category_ids: v.role === "kitchen" ? v.kot_category_ids : [],
        };
        try {
          if (printer) await api.updatePrinter(printer.id, body); else await api.createPrinter(body);
          toast.success(printer ? t("updated", { name: v.name }) : t("added", { name: v.name })); onClose(); onDone();
        } catch (e) {
          const m = em(e, t("saveFail"));
          if (e instanceof ApiError && e.status === 409) setError("name", { message: m }); else setErr(m);
        }
      })}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label={t("name")} placeholder={t("nameEx")} autoFocus error={errors.name?.message} {...register("name")} />
        <Controller control={control} name="role" render={({ field }) => (
          <SegmentedControl label={t("role")} block value={field.value} onChange={field.onChange} options={[{ value: "counter", label: t("role_counter") }, { value: "kitchen", label: t("role_kitchen") }, { value: "other", label: t("role_other") }]} />)} />
        <Controller control={control} name="connection" render={({ field }) => (
          <SegmentedControl label={t("connect")} block value={field.value} onChange={field.onChange} options={[{ value: "lan", label: t("connLanOpt") }, { value: "system", label: t("connUsbOpt") }]} />)} />
        {connection === "lan" ? (
          <div className="grid grid-cols-[1fr_6.5rem] gap-3">
            <Input label={t("host")} placeholder="192.168.1.50" inputMode="decimal" autoComplete="off" hint={t("hostHint")} error={errors.host?.message} {...register("host")} />
            <Input label={t("port")} inputMode="numeric" error={errors.port?.message} {...register("port")} />
          </div>
        ) : (
          <div className="space-y-2">
            {!manual ? (
              <Select label={t("queueSelect")} error={errors.system_name?.message} hint={t("queueSelectHint")} {...register("system_name")}>
                <option value="">{t("chooseQueue")}</option>
                {queues.map((q) => <option key={q} value={q}>{q}</option>)}
              </Select>
            ) : (
              <Input label={t("queueName")} autoComplete="off" placeholder="e.g. BIXOLON SRP-330II"
                hint={queues.length === 0 ? t("queueNone") : t("queueType")}
                error={errors.system_name?.message} {...register("system_name")} />
            )}
            {queues.length > 0 && <button type="button" className="text-sm font-semibold text-primary-soft-fg underline-offset-2 hover:underline" onClick={() => setTyped(!manual)}>{manual ? t("pickFromHub") : t("notListed")}</button>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input label={t("columns")} inputMode="numeric" hint={t("columnsHint")} error={errors.columns?.message} {...register("columns")} />
          <Select label={t("copies")} {...register("copies")}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
        </div>
        <Select label={t("codepage")} hint={t("codepageHint")} {...register("codepage")}>
          {CODEPAGES.map((c) => <option key={c} value={c}>{t(`cp_${c}`)}</option>)}
        </Select>
        {role === "kitchen" && (
          <fieldset className="rounded-xl border border-border p-3">
            <legend className="px-1 text-sm font-semibold text-fg">{t("catsLegend")}</legend>
            <p className="mb-1 text-xs text-fg-subtle">{t("catsHint")}</p>
            {categories.length === 0 ? <p className="text-sm text-fg-muted">{t("noCats")}</p> : (
              <Controller control={control} name="kot_category_ids" render={({ field }) => (
                <div className="max-h-48 overflow-y-auto">
                  {categories.map((c) => (
                    <Checkbox key={c.id} label={c.name} checked={field.value.includes(c.id)}
                      onChange={(e) => field.onChange(e.target.checked ? [...field.value, c.id] : field.value.filter((x) => x !== c.id))} />
                  ))}
                </div>)} />
            )}
          </fieldset>
        )}
        <div className="divide-y divide-border rounded-xl border border-border px-3">
          <Controller control={control} name="auto_bill" render={({ field }) => <Switch label={t("autoBill")} hint={t("whenBill")} checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />} />
          <Controller control={control} name="auto_kot" render={({ field }) => <Switch label={t("autoKot")} hint={t("whenKot")} checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />} />
          <Controller control={control} name="cut" render={({ field }) => <Switch label={t("cut")} checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />} />
          <Controller control={control} name="is_active" render={({ field }) => <Switch label={t("active")} hint={t("activeHint")} checked={field.value} onChange={(e) => field.onChange(e.target.checked)} />} />
        </div>
      </form>
    </Dialog>
  );
}
