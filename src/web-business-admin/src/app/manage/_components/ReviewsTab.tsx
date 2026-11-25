"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCheck, Download, UserRound } from "lucide-react";
import { Badge, Button, EmptyState, Input, Notice, Select, Skeleton, StatCard } from "@chilli/ui";
import { FilterBar } from "@chilli/ui/data";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { downloadCsv } from "@/lib/csv";
import { formatDateTime, relativeTime } from "@/lib/datetime";
import { useMsg } from "@/lib/i18n";
import { LOW_RATING, reviewCsvRows, reviews, stars, tableQr, type Review, type ReviewFilter, type ReviewList } from "@/lib/tableQr";
import { useNotify } from "@/lib/useNotify";
import type { DiningTable } from "@/lib/types";
import { QR_MSG } from "./qr-messages";

const PAGE = 50;
/** `rating`: "" (any), "low" (1-2 stars) or "1".."5". Dates: yyyy-mm-dd, the restaurant's days. */
interface Filters { table: string; rating: string; from: string; to: string }
const EMPTY: Filters = { table: "", rating: "", from: "", to: "" };

/**
 * Manage > Reviews (reports.view: owner, manager): what guests sent from a table's review QR. Filters (table, rating, dates),
 * average and count, average per table, CSV export. Unread low ratings (1-2 stars) count in the top bar bell until this page
 * has shown them; the page marks the low ratings it shows as read.
 */
export function ReviewsTab() {
  const tr = useMsg(QR_MSG);
  const toast = useNotify();
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [f, setF] = useState<Filters>(EMPTY);
  const [data, setData] = useState<ReviewList | null>(null);
  const [items, setItems] = useState<Review[]>([]);
  const [unseen, setUnseen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [off, setOff] = useState(false);
  const [now, setNow] = useState(0);

  useEffect(() => { api.allTables().then(setTables).catch(() => { /* the table filter then lists none */ }); }, []);
  useEffect(() => { const t = () => setNow(Date.now()); t(); const i = setInterval(t, 60_000); return () => clearInterval(i); }, []);
  useEffect(() => { tableQr.settings().then((s) => setOff(!s.reviews_enabled)).catch(() => { /* older server */ }); }, []);

  const query = useMemo<ReviewFilter>(() => ({ table: f.table, from: f.from, to: f.to,
    rating: f.rating && f.rating !== "low" ? Number(f.rating) : "", maxRating: f.rating === "low" ? LOW_RATING : "" }), [f]);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const d = await reviews.list({ ...query, limit: PAGE });
      setData(d); setItems(d.items);
      const low = d.items.filter((r) => !r.read);
      setUnseen(new Set(low.map((r) => r.id)));
      const lowIds = low.filter((r) => r.rating <= LOW_RATING).map((r) => r.id);
      if (low.length) void reviews.markRead(low.map((r) => r.id)).catch(() => { /* stays unread: the bell keeps counting it */ });
      if (lowIds.length) window.dispatchEvent(new Event("chilli:reviews-read"));
    } catch (e) { setError(e instanceof ApiError ? e.message : tr("reviewsLoadFail")); }
    finally { setLoading(false); }
  }, [query, tr]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function loadMore() {
    setMore(true);
    try {
      const d = await reviews.list({ ...query, limit: PAGE, offset: items.length });
      setItems((x) => [...x, ...d.items]);
      const fresh = d.items.filter((r) => !r.read).map((r) => r.id);
      if (fresh.length) { setUnseen((s) => new Set([...s, ...fresh])); void reviews.markRead(fresh).catch(() => {}); }
    } catch (e) { toast.error(e instanceof ApiError ? e.message : tr("reviewsLoadFail")); }
    finally { setMore(false); }
  }

  async function exportCsv() {
    try {
      const d = data && data.total <= items.length ? { items } : await reviews.list({ ...query, limit: 5000 });
      downloadCsv(`reviews-${new Date().toISOString().slice(0, 10)}.csv`, reviewCsvRows(d.items, (iso) => formatDateTime(iso)));
    } catch (e) { toast.error(e instanceof ApiError ? e.message : tr("reviewsLoadFail")); }
  }

  async function markAll() {
    try { await reviews.markRead(); setUnseen(new Set()); window.dispatchEvent(new Event("chilli:reviews-read")); void load(); }
    catch (e) { toast.error(e instanceof ApiError ? e.message : tr("reviewsLoadFail")); }
  }

  const active = (f.table ? 1 : 0) + (f.rating ? 1 : 0) + (f.from ? 1 : 0) + (f.to ? 1 : 0);
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const activeTables = tables.filter((t) => t.is_active !== false);

  return (
    <div className="space-y-4" data-testid="reviews-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">{tr("reviewsIntro")}</p>
        <div className="flex flex-wrap gap-2">
          {data && data.unread_low > 0 && <Button variant="secondary" iconStart={<CheckCheck />} onClick={() => void markAll()}>{tr("markAllRead")}</Button>}
          <Button iconStart={<Download />} disabled={!data || data.total === 0} onClick={() => void exportCsv()}>{tr("exportCsv")}</Button>
        </div>
      </div>
      {off && <Notice tone="warning">{tr("reviewsOff")}</Notice>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label={tr("avgRating")} loading={loading && !data} value={data?.average != null ? <span data-testid="reviews-average">{data.average.toFixed(1)} <span aria-hidden className="text-warning-fg">★</span></span> : "-"} hint={data?.average != null ? tr("outOf5", { n: data.average.toFixed(1) }) : undefined} />
        <StatCard label={tr("reviewCount")} loading={loading && !data} value={<span data-testid="reviews-total">{data?.total ?? 0}</span>} />
        <StatCard label={tr("lowNew")} loading={loading && !data} value={data?.unread_low ?? 0} />
      </div>
      <FilterBar label={tr("filterReviews")} activeCount={active} onReset={() => setF(EMPTY)}>
        <Select label={tr("table")} value={f.table} onChange={set("table")}>
          <option value="">{tr("allTables")}</option>
          <option value="general">{tr("generalQr")}</option>
          {activeTables.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </Select>
        <Select label={tr("rating")} value={f.rating} onChange={set("rating")}>
          <option value="">{tr("anyRating")}</option>
          <option value="low">{tr("lowOnly")}</option>
          {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n === 1 ? tr("oneStar") : tr("nStars", { n })}</option>)}
        </Select>
        <Input label={tr("from")} type="date" value={f.from} max={f.to || undefined} onChange={set("from")} />
        <Input label={tr("to")} type="date" value={f.to} min={f.from || undefined} onChange={set("to")} />
      </FilterBar>
      {error && <Notice tone="danger" title={tr("reviewsLoadFail")} action={<Button size="sm" onClick={() => void load()}>{tr("retry")}</Button>}>{error}</Notice>}
      {data && data.per_table.length > 1 && (
        <section aria-labelledby="per-table" className="rounded-xl border border-border bg-surface p-3">
          <h2 id="per-table" className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">{tr("perTable")}</h2>
          <ul className="flex flex-wrap gap-2" data-testid="per-table">
            {data.per_table.map((p) => (
              <li key={p.table_id ?? "general"} className="rounded-lg border border-border px-3 py-1.5 text-sm">
                <span className="font-semibold">{p.table_label ?? tr("generalQr")}</span>{" "}
                <span className="tnum">{p.average.toFixed(1)}</span><span aria-hidden className="text-warning-fg"> ★</span>{" "}
                <span className="text-fg-muted">({p.count === 1 ? tr("reviewOne") : tr("reviewsN", { n: p.count })})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {loading && !data ? (
        <div role="status" aria-label={tr("loadingReviews")} className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} height={88} />)}</div>
      ) : data && data.total === 0 ? (
        active ? <p className="text-sm text-fg-muted">{tr("noMatch")}</p> : <EmptyState title={tr("noReviews")} description={tr("noReviewsDesc")} />
      ) : (
        <ol className="space-y-3" data-testid="review-list">
          {items.map((r) => {
            const low = r.rating <= LOW_RATING;
            return (
              <li key={r.id} className={cn("rounded-xl border bg-surface p-4", low ? "border-danger/40" : "border-border")} data-testid="review-item" data-rating={r.rating}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="flex items-center gap-2">
                    <span className={cn("text-lg leading-none tracking-wider", low ? "text-danger-fg" : "text-warning-fg")} aria-hidden>{stars(r.rating)}</span>
                    <span className="sr-only">{tr("outOf5", { n: r.rating })}</span>
                    {unseen.has(r.id) && <Badge tone={low ? "danger" : "info"}>{tr("newBadge")}</Badge>}
                  </p>
                  <p className="text-sm text-fg-muted">
                    <span className="font-semibold text-fg">{r.table_label ? `${tr("table")} ${r.table_label}` : tr("generalQr")}</span>{" · "}
                    <time dateTime={r.created_at} title={formatDateTime(r.created_at)}>{now ? relativeTime(r.created_at, now) : formatDateTime(r.created_at)}</time>
                  </p>
                </div>
                <p className={cn("mt-2 whitespace-pre-line break-words", r.comment ? "text-fg" : "text-fg-muted italic")}>{r.comment ?? tr("noComment")}</p>
                {(r.guest_name || r.guest_contact) && (
                  <p className="mt-2 text-sm text-fg-muted"><UserRound aria-hidden className="mr-1 inline size-3.5" />{[r.guest_name, r.guest_contact].filter(Boolean).join(" · ")}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {data && items.length < data.total && <Button variant="secondary" loading={more} onClick={() => void loadMore()}>{tr("loadMore")}</Button>}
    </div>
  );
}
