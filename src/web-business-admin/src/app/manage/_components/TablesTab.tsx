"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Archive, Download, Pencil, Plus, QrCode, RotateCcw, Users } from "lucide-react";
import { Badge, Button, EmptyState, IconButton, Input, Notice, SegmentedControl, Select, Sheet, Skeleton, Switch } from "@chilli/ui";
import { DataTable, FilterBar, downloadCsv, toCsv, type DataColumn } from "@chilli/ui/data";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatCurrency } from "@/lib/money";
import { TABLE_STATE_LABEL, tableExtras, tableLive, type TableExtra, type TableLive, type TableState } from "@/lib/tableStatus";
import { useCurrency } from "@/lib/taxConfig";
import { useAsk } from "@/lib/useAsk";
import { useNotify } from "@/lib/useNotify";
import { useMsg } from "@/lib/i18n";
import { usePoll } from "@/lib/usePoll";
import { useCan } from "@/lib/useRole";
import type { DiningTable, Order } from "@/lib/types";
import { extras, type TableStatus } from "@/lib/extras";
import { timeIn } from "@/lib/frontdesk";
import { useManage } from "./manage-context";
import { TABLES_MSG } from "./tables-messages";
import { QR_MSG } from "./qr-messages";
import { TableQrPanel } from "./TableQrPanel";

/** Tables, plus what the server says is happening at each one. Orders failing to load must not hide the tables. */
async function fetchFloor(): Promise<{ tables: DiningTable[]; live: Map<string, TableLive> | null; held: Map<string, NonNullable<TableStatus["reservation"]>>; extra: Map<string, TableExtra> }> {
  const [tables, live, status] = await Promise.all([
    api.allTables(),
    Promise.all([api.orders("open"), api.orders("sent_to_kitchen")]).then(([a, b]) => tableLive([...a, ...b] as Order[])).catch(() => null),
    extras.tableStatus().catch(() => [] as TableStatus[]), // reservations: only on servers that have them
  ]);
  const held = new Map(status.filter((t) => t.status === "reserved" && t.reservation).map((t) => [t.table_id, t.reservation!] as const));
  return { tables, live, held, extra: tableExtras(status) };
}

const makeSchema = (tr: (k: string) => string) => z.object({
  label: z.string().trim().min(1, tr("enterLabel")).max(50, tr("labelMax")),
  seats: z.string().regex(/^\d{1,2}$/, tr("seatsRange")).refine((v) => Number(v) >= 1, tr("seatsRange")),
  area: z.enum(["indoor", "outdoor"]),
});
type Form = z.infer<ReturnType<typeof makeSchema>>;

/** Table tiles: state told by fill AND label. Free = white outline, in use (an open order / with the kitchen) = light Chilli tint with a Chilli Red border and
 *  dark text (owner approval 2026-11-03, BREAK_UI_REPORT D07: no near-black tile in a light-only product; the state badge says "Order open" / "With kitchen"),
 *  reserved = dashed outline. */
const TONE: Record<TableState, { tile: string; badge: "success" | "warning" | "info" }> = {
  free: { tile: "bg-surface border-border-strong", badge: "success" },
  occupied: { tile: "bg-primary-soft border-primary", badge: "warning" },
  kitchen: { tile: "bg-primary-soft border-primary", badge: "info" },
  reserved: { tile: "bg-surface-2 border-border-strong border-dashed", badge: "info" },
};

export function TablesTab() {
  const { refresh } = useManage();
  const tr = useMsg(TABLES_MSG);
  const [ask, askNode] = useAsk();
  const toast = useNotify();
  const { can } = useCan();
  const canEdit = can("tables.manage");
  const currency = useCurrency();
  // 10 s: a table taken in the waiter app shows here without a reload (usePoll skips hidden tabs).
  const { data, error, loading, reload } = usePoll(fetchFloor, 10_000);
  const [form, setForm] = useState<{ table: DiningTable | null } | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [view, setView] = useState<"plan" | "list">("plan");
  const [area, setArea] = useState("all");
  const [status, setStatus] = useState("all");

  const all = useMemo(() => data?.tables ?? [], [data]);
  const live = data?.live ?? null;
  const held = data?.held;
  const extra = data?.extra;
  // A billed table waiting for payment is still held (pos-service docs/ORDER_RULES.md), as the waiter app shows it.
  const stateOf = (t: DiningTable): TableState => live?.get(t.id)?.state ?? (extra?.get(t.id)?.billMade ? "occupied" : held?.has(t.id) ? "reserved" : "free");
  const archivedCount = all.filter((t) => t.is_active === false).length;
  const list = useMemo(() => all
    .filter((t) => archived || t.is_active !== false)
    .filter((t) => area === "all" || t.area === area)
    .filter((t) => status === "all" || stateOf(t) === status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })), [all, archived, area, status, live]);
  const active = activeCount(area, status);
  const done = () => { void reload(); refresh(); };
  const selected = all.find((t) => t.id === detail) ?? null;

  async function setActive(t: DiningTable, on: boolean) {
    if (!on && !(await ask({ title: tr("archiveTitle", { label: t.label }), description: tr("archiveDesc"), confirmLabel: tr("archive"), destructive: true }))) return;
    setBlocked(null);
    try { await api.patchTable(t.id, { is_active: on }); toast.success(tr(on ? "restored" : "archived", { label: t.label })); setDetail(null); done(); }
    catch (e) {
      const m = e instanceof ApiError ? e.message : tr("updateFail");
      if (e instanceof ApiError && e.status === 409) setBlocked(m);
      toast.error(m);
    }
  }

  function exportCsv() {
    downloadCsv("tables.csv", toCsv(["Table", "Seats", "Area", "Status", "Open amount", "Active"],
      list.map((t) => [t.label, t.seats, t.area, live ? TABLE_STATE_LABEL[stateOf(t)] : "", live?.get(t.id) ? Number(live.get(t.id)!.total) : "", t.is_active === false ? "No" : "Yes"])));
  }

  const areaName = (a: string, lower = false) => a === "indoor" || a === "outdoor" ? tr(lower ? `${a}Lc` : a) : a;
  const columns: DataColumn<DiningTable>[] = [
    { key: "label", header: tr("colTable"), sortValue: (t) => t.label.toLowerCase(), csv: (t) => t.label, render: (t) => <button type="button" className="min-h-11 font-semibold text-primary underline-offset-2 hover:underline" aria-label={tr("openDetails", { label: t.label })} onClick={() => setDetail(t.id)}>{t.label}</button> },
    { key: "seats", header: tr("colSeats"), align: "end", sortValue: (t) => t.seats, render: (t) => t.seats },
    { key: "area", header: tr("colArea"), sortValue: (t) => t.area, render: (t) => <span className="capitalize">{areaName(t.area)}</span> },
    { key: "state", header: tr("colStatus"), sortValue: (t) => stateOf(t), render: (t) => live ? <Badge tone={TONE[stateOf(t)].badge}>{tr(`state.${stateOf(t)}`)}</Badge> : <span className="text-fg-muted">{tr("notAvailable")}</span> },
    { key: "open", header: tr("colOpen"), align: "end", sortValue: (t) => Number(live?.get(t.id)?.total ?? 0), render: (t) => live?.get(t.id) ? <span className="ch-money" translate="no">{formatCurrency(live.get(t.id)!.total, currency)}</span> : "" },
    ...(canEdit ? [{ key: "act", header: tr("colActions"), align: "end" as const, render: (t: DiningTable) => <div className="flex justify-end gap-1">{rowActions(t)}</div> }] : []),
  ];
  function rowActions(t: DiningTable) {
    return t.is_active === false
      ? <IconButton label={tr("restoreTable", { label: t.label })} icon={<RotateCcw />} onClick={() => void setActive(t, true)} />
      : <><IconButton label={tr("editTable", { label: t.label })} icon={<Pencil />} onClick={() => setForm({ table: t })} /><IconButton label={tr("archiveTable", { label: t.label })} icon={<Archive />} onClick={() => void setActive(t, false)} /></>;
  }

  const counts = { free: 0, occupied: 0, kitchen: 0, reserved: 0 } as Record<TableState, number>;
  for (const t of all) if (t.is_active !== false) counts[stateOf(t)]++;
  const areas = (["indoor", "outdoor"] as const).map((a) => ({ a, tables: list.filter((t) => t.area === a) })).filter((g) => g.tables.length > 0);

  return (
    <>
      {selected ? null : askNode}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">{tr("intro")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button iconStart={<Download />} disabled={list.length === 0} onClick={exportCsv}>{tr("exportCsv")}</Button>
          {canEdit && <QrButton />}
          {canEdit && <Button variant="primary" iconStart={<Plus />} onClick={() => setForm({ table: null })}>{tr("addTable")}</Button>}
        </div>
      </div>
      {error && <div className="mb-4"><Notice tone="danger" title={tr("loadFail")} action={<Button size="sm" onClick={() => void reload()}>{tr("retry")}</Button>}>{error}</Notice></div>}
      {!error && data && !live && <div className="mb-4"><Notice tone="warning" title={tr("noStatusTitle")}>{tr("noStatusBody")}</Notice></div>}
      {blocked && <div className="mb-4"><Notice tone="warning" title={tr("blockedTitle")}>{blocked}</Notice></div>}

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <SegmentedControl legend={tr("view")} value={view} onValueChange={(v) => setView(v as typeof view)} options={[{ value: "plan", label: tr("floorPlan") }, { value: "list", label: tr("list") }]} />
        {live && <p role="status" className="text-sm text-fg-muted" data-testid="table-counts">{tr("counts", { free: counts.free, open: counts.occupied, kitchen: counts.kitchen })}{counts.reserved > 0 ? ` · ${counts.reserved} ${tr("state.reserved").toLowerCase()}` : ""}</p>}
      </div>
      <div className="mb-3">
        <FilterBar label={tr("filterTables")} activeCount={active} onReset={() => { setArea("all"); setStatus("all"); }}>
          <Select label={tr("area")} value={area} onChange={(e) => setArea(e.target.value)}><option value="all">{tr("allAreas")}</option><option value="indoor">{tr("indoor")}</option><option value="outdoor">{tr("outdoor")}</option></Select>
          <Select label={tr("status")} value={status} onChange={(e) => setStatus(e.target.value)} disabled={!live}><option value="all">{tr("anyStatus")}</option><option value="free">{tr("state.free")}</option><option value="occupied">{tr("state.occupied")}</option><option value="kitchen">{tr("state.kitchen")}</option><option value="reserved">{tr("state.reserved")}</option></Select>
        </FilterBar>
      </div>
      {archivedCount > 0 && <div className="mb-3 max-w-xs"><Switch label={tr("showArchived", { n: archivedCount })} checked={archived} onChange={(e) => setArchived(e.target.checked)} /></div>}

      {loading ? (
        <div role="status" aria-label={tr("loadingTables")} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} height={112} />)}</div>
      ) : all.length === 0 ? (
        <EmptyState title={tr("noTables")} description={tr("noTablesDesc")} {...(canEdit ? { actionLabel: tr("addFirst"), onAction: () => setForm({ table: null }), actionVariant: "secondary" as const } : {})} />
      ) : list.length === 0 ? (
        <EmptyState title={tr("noMatch")} description={tr("noMatchDesc")} />
      ) : view === "list" ? (
        <DataTable caption={tr("caption")} columns={columns} rows={list} getKey={(t) => t.id} stickyFirstColumn={false} />
      ) : (
        areas.map(({ a, tables }) => (
          <section key={a} aria-label={a === "indoor" ? tr("indoorTables") : tr("outdoorTables")} className="mb-6">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">{a === "indoor" ? tr("indoor") : tr("outdoor")}</h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
              {tables.map((t) => {
                const off = t.is_active === false;
                const st = stateOf(t);
                const lv = live?.get(t.id);
                const ex = off ? undefined : extra?.get(t.id);
                const exText = ex ? [ex.waiters.length ? tr("takenBy", { name: ex.waiters.join(", ") }) : "", ex.billMade ? tr("billMade") : ex.billAsked ? tr("billAsked") : ""].filter(Boolean) : [];
                return (
                  <li key={t.id}>
                    <button type="button" onClick={() => setDetail(t.id)} aria-label={[tr("tileAria", { label: t.label, seats: t.seats, state: off ? tr("archivedLc") : live ? tr(`state.${st}`) : tr("statusNA") }), lv ? formatCurrency(lv.total, currency) : "", !lv && held?.get(t.id) ? tr("reservedFor", { guest: held.get(t.id)!.guest_name, party: held.get(t.id)!.party_size, time: timeIn(held.get(t.id)!.starts_at) }) : "", ...exText].filter(Boolean).join(", ")} /* the accessible name carries every visible word (WCAG 2.5.3 Label in Name): the open total and the reservation too */
                      data-bill-asked={ex?.billAsked && !ex.billMade ? "true" : undefined}
                      className={cn("flex min-h-28 w-full flex-col items-start gap-1 rounded-xl border p-3 text-left active:scale-[0.99]", off ? "border-border bg-surface-2 opacity-70" : TONE[st].tile, ex?.billAsked && !ex.billMade && "ring-2 ring-warning")}>
                      <span className="w-full font-mono text-lg font-bold text-fg [overflow-wrap:anywhere]">{t.label}</span>{" "}
                      <span aria-hidden className="flex items-center gap-1.5 text-sm text-fg-muted"><Users aria-hidden className="size-3.5" />{tr("seatsN", { n: t.seats })}</span>{" "}
                      <span aria-hidden className="mt-auto flex w-full flex-wrap items-center justify-between gap-1">
                        {off ? <Badge>{tr("archivedBadge")}</Badge> : live ? <Badge tone={TONE[st].badge}>{tr(`state.${st}`)}</Badge> : <span className="text-xs text-fg-muted">{tr("noStatus")}</span>}
                        {lv && <span className="ch-money text-sm font-semibold" translate="no">{formatCurrency(lv.total, currency)}</span>}
                        {exText.length > 0 && <span className="w-full truncate text-xs text-fg-muted" data-testid="table-extra">{exText.join(" · ")}</span>}
                        {!lv && held?.get(t.id) && <span className="w-full truncate text-xs text-fg-muted" data-testid="reserved-for">{tr("reservedFor", { guest: held.get(t.id)!.guest_name, party: held.get(t.id)!.party_size, time: timeIn(held.get(t.id)!.starts_at) })}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      <Sheet side="right" open={selected !== null} onOpenChange={(o) => { if (!o) setDetail(null); }} title={selected ? tr("tableTitle", { label: selected.label }) : tr("tableGeneric")}
        description={selected ? tr("seatsArea", { seats: selected.seats, area: areaName(selected.area, true) }) : undefined}
        footer={selected && canEdit ? <>
          {selected.is_active === false
            ? <Button iconStart={<RotateCcw />} onClick={() => void setActive(selected, true)}>{tr("restoreTable", { label: selected.label })}</Button>
            : <><Button variant="danger-soft" iconStart={<Archive />} onClick={() => void setActive(selected, false)}>{tr("archiveTable", { label: selected.label })}</Button><Button variant="primary" iconStart={<Pencil />} onClick={() => { setForm({ table: selected }); setDetail(null); }}>{tr("editTable", { label: selected.label })}</Button></>}
        </> : undefined}>
        {selected ? askNode : null /* inside the sheet: a sibling confirm would count as an outside click */}
        {selected && (() => {
          const lv = live?.get(selected.id);
          const st = stateOf(selected);
          return (
            <div className="space-y-3">
              {selected.is_active === false ? <Badge>{tr("archivedBadge")}</Badge> : live ? <Badge tone={TONE[st].badge}>{tr(`state.${st}`)}</Badge> : <Notice tone="warning">{tr("statusUnavailable")}</Notice>}
              {lv ? (() => {
                const [before, after] = tr("liveSummary", { orders: tr(lv.orders === 1 ? "orderOne" : "orderMany", { n: lv.orders }), lines: tr(lv.lines === 1 ? "lineOne" : "lineMany", { n: lv.lines }), total: "\u0000" }).split("\u0000");
                return <p className="text-sm">{before}<span className="ch-money font-semibold" translate="no">{formatCurrency(lv.total, currency)}</span>{after}</p>;
              })()
                : live && selected.is_active !== false && !extra?.get(selected.id) ? <p className="text-sm text-fg-muted">{tr("noOrder")}</p> : null}
              {(() => { const ex = extra?.get(selected.id); return ex && (ex.waiters.length > 0 || ex.billAsked || ex.billMade) ? <p className="text-sm" data-testid="table-extra-detail">{[ex.waiters.length ? tr("takenBy", { name: ex.waiters.join(", ") }) : "", ex.billMade ? tr("billMade") : ex.billAsked ? tr("billAsked") : ""].filter(Boolean).join(" · ")}</p> : null; })()}
              {selected.is_active !== false && extra?.get(selected.id)?.orderId && !extra.get(selected.id)!.billMade && <Link href={`/pos?order=${extra.get(selected.id)!.orderId}`} className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-2 hover:underline">{tr("openBill")}</Link>}
              {selected.is_active !== false && <Link href="/pos" className="inline-flex min-h-11 items-center font-semibold text-primary underline-offset-2 hover:underline">{tr("openPos")}</Link>}
            </div>
          );
        })()}
      </Sheet>
      <TableSheet state={form} onClose={() => setForm(null)} onDone={done} />
    </>
  );
}

/** Menu QR and review QR for every table (docs: pos-service TABLE_QR_REVIEWS.md). */
function QrButton() {
  const tq = useMsg(QR_MSG);
  const { can } = useCan();
  const [open, setOpen] = useState(false);
  return <>
    <Button iconStart={<QrCode />} onClick={() => setOpen(true)} data-testid="table-qr-open">{tq("qrCodes")}</Button>
    <TableQrPanel open={open} onClose={() => setOpen(false)} canSettings={can("settings.manage")} />
  </>;
}

const activeCount = (area: string, status: string) => (area !== "all" ? 1 : 0) + (status !== "all" ? 1 : 0);

function TableSheet({ state, onClose, onDone }: { state: { table: DiningTable | null } | null; onClose: () => void; onDone: () => void }) {
  const toast = useNotify();
  const tr = useMsg(TABLES_MSG);
  const schema = useMemo(() => makeSchema(tr), [tr]);
  const table = state?.table ?? null;
  const open = state !== null;
  const { register, control, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { label: "", seats: "4", area: "indoor" } });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    reset(table ? { label: table.label, seats: String(table.seats), area: table.area === "outdoor" ? "outdoor" : "indoor" } : { label: "", seats: "4", area: "indoor" });
    void Promise.resolve().then(() => setErr(null));
  }, [open, table, reset]);
  return (
    <Sheet side="right" open={open} onOpenChange={(o) => { if (!o) onClose(); }} title={table ? tr("editTable", { label: table.label }) : tr("addSheetTitle")} description={tr("sheetDesc")}
      footer={<><Button onClick={onClose}>{tr("cancel")}</Button><Button variant="primary" type="submit" form="table-form" loading={isSubmitting}>{table ? tr("saveChanges") : tr("addTable")}</Button></>}>
      <form id="table-form" noValidate className="space-y-4" onSubmit={handleSubmit(async (v) => {
        setErr(null);
        try {
          if (table) await api.patchTable(table.id, { label: v.label, seats: Number(v.seats), area: v.area });
          else await api.createTable(v.label, Number(v.seats), v.area);
          toast.success(tr(table ? "updated" : "added", { label: v.label })); onClose(); onDone();
        } catch (e) { const m = e instanceof ApiError ? e.message : tr("saveFail"); if (e instanceof ApiError && e.status === 409) setError("label", { message: m }); else setErr(m); }
      })}>
        {err && <Notice tone="danger">{err}</Notice>}
        <Input label={tr("label")} placeholder={tr("labelPh")} autoFocus autoComplete="off" error={errors.label?.message} {...register("label")} />
        <Input label={tr("seats")} inputMode="numeric" error={errors.seats?.message} {...register("seats")} />
        <Controller control={control} name="area" render={({ field }) => (
          <SegmentedControl legend={tr("area")} value={field.value} onValueChange={field.onChange} options={[{ value: "indoor", label: tr("indoor") }, { value: "outdoor", label: tr("outdoor") }]} />)} />
      </form>
    </Sheet>
  );
}
