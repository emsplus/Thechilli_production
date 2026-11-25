"use client";

import { formatDateTime } from "@/lib/datetime";
import { Badge, type BadgeTone, Button, Input, Notice, PageHeader, Skeleton } from "@chilli/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ScrollText } from "lucide-react";
import { Card, EmptyState } from "@/components/ui";
import { api, ApiError, auth } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMsg } from "@/lib/i18n";
import type { AuditEntry } from "@/lib/types";
import { MANAGE_MSG } from "./shell-messages";

const PREFIXES = ["bill.", "payment.", "refund.", "stock.", "purchase.", "order.", "user.", "consent.", "ai."];
/** Known actions are translated; others fall back to a readable form of the raw action name. */
const label = (a: string, t: (key: string) => string) => (`a.${a}` in MANAGE_MSG ? t(`a.${a}`) : a.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase()));
function tone(a: string): BadgeTone {
  if (a.startsWith("refund.") || a.startsWith("order.cancel") || a.includes("wastage")) return "warning";
  if (a.startsWith("bill.") || a.startsWith("payment.") || a.startsWith("purchase.confirm")) return "success";
  if (a.startsWith("user.") || a.startsWith("auth.") || a.startsWith("consent.")) return "info";
  if (a.startsWith("ai.")) return "primary";
  return "neutral";
}
const when = (v: string) => formatDateTime(v, undefined, true);

/** A person-readable reference: the invoice / credit note number when the entry's detail carries one, else the short id. */
function humanRef(a: AuditEntry): string {
  const d = a.detail && typeof a.detail === "object" ? (a.detail as Record<string, unknown>) : {};
  for (const k of ["invoice_number", "credit_note_number", "replacement_invoice_number", "number"]) { const v = d[k]; if (typeof v === "string" || typeof v === "number") return String(v); }
  return a.entity_id ? a.entity_id.slice(0, 8) : "";
}

export function AuditView({ embedded = false }: { embedded?: boolean }) {
  const t = useMsg(MANAGE_MSG);
  const router = useRouter();
  const [prefix, setPrefix] = useState("");
  const [entity, setEntity] = useState("");
  const [dEntity, setDEntity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null); // "" = no server text, show the generic line
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const gen = useRef(0);

  useEffect(() => { const t = setTimeout(() => setDEntity(entity.trim()), 300); return () => clearTimeout(t); }, [entity]);
  const rangeBad = !!from && !!to && from > to;

  const fetchPage = useCallback((c: string | null) => api.auditLogs({ action: prefix, entity: dEntity, from_date: from, to_date: to, limit: 50, cursor: c }), [prefix, dEntity, from, to]);

  useEffect(() => {
    if (rangeBad) return;
    if (!auth.token) { router.replace("/login"); return; }
    const id = ++gen.current;
    void Promise.resolve().then(async () => {
      setLoading(true); setError(null);
      try { const r = await fetchPage(null); if (id === gen.current) { setItems(r.items); setCursor(r.next_cursor); setOpen(new Set()); } }
      catch (e) { if (id === gen.current) setError(e instanceof ApiError ? e.message : ""); }
      finally { if (id === gen.current) setLoading(false); }
    });
  }, [fetchPage, rangeBad, tick, router]);

  async function loadMore() {
    if (!cursor) return;
    const id = gen.current; setMore(true); setError(null);
    try { const r = await fetchPage(cursor); if (id === gen.current) { setItems((x) => [...x, ...r.items]); setCursor(r.next_cursor); } }
    catch (e) { setError(e instanceof ApiError ? e.message : "@more"); } finally { setMore(false); }
  }
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const entities = useMemo(() => [...new Set(items.map((i) => i.entity))], [items]);
  const filtered = !!(prefix || dEntity || from || to);

  return (
    <>
      {embedded ? <p className="mb-4 text-sm text-fg-muted">{t("auditDesc")}</p>
        : <PageHeader title={t("auditLog")} description={t("auditDesc")} />}

      <Card className="mb-4 space-y-4">
        <div role="group" aria-label={t("actionType")} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scrollbar-thin sm:mx-0 sm:flex-wrap sm:px-0 [&>button]:shrink-0">
          {["", ...PREFIXES].map((p) => (
            <button key={p || "all"} type="button" aria-pressed={prefix === p} onClick={() => setPrefix(p)}
              className={cn("h-11 rounded-full border px-3.5 pointer-fine:h-9 text-sm font-semibold transition-colors", prefix === p ? "border-primary bg-primary-soft text-primary-soft-fg" : "border-border-strong bg-surface text-fg-muted hover:bg-surface-2 hover:text-fg")}>
              {p ? t(`audit_${p.slice(0, -1)}` as Parameters<typeof t>[0]) : t("all")}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Input label={t("entity")} placeholder={t("entityEx")} list="audit-entities" value={entity} onChange={(e) => setEntity(e.target.value)} />
          <Input label={t("from")} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <Input label={t("to")} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        <datalist id="audit-entities">{entities.map((e) => <option key={e} value={e} />)}</datalist>
        {rangeBad && <Notice tone="danger">{t("badRange")}</Notice>}
        {filtered && <Button size="sm" variant="ghost" onClick={() => { setPrefix(""); setEntity(""); setFrom(""); setTo(""); }}>{t("clearFilters")}</Button>}
      </Card>

      {error !== null && <Notice tone="danger" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => setTick((n) => n + 1)}>{t("retry")}</Button>}>{error === "@more" ? t("moreFail") : error || t("auditLoadFail")}</Notice>}

      {loading ? (
        <Card padded={false}><div className="space-y-px" role="status" aria-label={t("loadingAudit")}>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-none" />)}</div></Card>
      ) : items.length === 0 && error === null ? (
        <Card><EmptyState icon={<ScrollText />} title={filtered ? t("noMatch") : t("noneYet")} hint={filtered ? t("tryOther") : t("willShow")} /></Card>
      ) : (
        <Card padded={false}>
          <ol className="divide-y divide-border">
            {items.map((a) => {
              const isOpen = open.has(a.id); const who = a.user_name || a.user_email || t("system");
              const hasDetail = a.detail != null && !(typeof a.detail === "object" && Object.keys(a.detail as object).length === 0);
              return (
                <li key={a.id}>
                  <button type="button" onClick={() => toggle(a.id)} aria-expanded={isOpen} disabled={!hasDetail && false}
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 sm:grid-cols-[11rem_13rem_minmax(0,1fr)_auto] sm:px-5">
                    <time dateTime={a.created_at} className="tnum order-2 text-xs text-fg-subtle sm:order-none sm:text-sm sm:text-fg-muted">{when(a.created_at)}</time>
                    <span className="order-1 sm:order-none"><Badge tone={tone(a.action)}>{label(a.action, t)}</Badge></span>
                    <span className="order-3 min-w-0 truncate text-sm text-fg-muted sm:order-none"><span className="font-medium text-fg">{who}</span> · <span className="font-mono text-xs">{a.entity} {humanRef(a)}</span></span>
                    <ChevronDown aria-hidden className={cn("order-1 size-4 text-fg-subtle transition-transform sm:order-none", isOpen && "rotate-180")} />
                    <span className="sr-only">{isOpen ? t("hideDetails") : t("showDetails")}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border bg-surface-2/50 px-4 py-3 sm:px-5">
                      <p className="mb-2 font-mono text-xs text-fg-subtle">{a.action}{a.user_email && a.user_name ? ` · ${a.user_email}` : ""}{a.entity_id ? ` · ${a.entity_id}` : ""}</p>
                      {hasDetail ? <pre className="max-h-72 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs leading-relaxed text-fg scrollbar-thin">{JSON.stringify(a.detail, null, 2)}</pre> : <p className="text-sm text-fg-muted">{t("noDetail")}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm text-fg-muted sm:px-5">
            <span aria-live="polite">{t(`entries${items.length === 1 ? "One" : "Many"}${cursor ? "" : "End"}`, { n: items.length })}</span>
            {cursor && <Button variant="secondary" loading={more} onClick={() => void loadMore()}>{t("loadMore")}</Button>}
          </div>
        </Card>
      )}
    </>
  );
}
