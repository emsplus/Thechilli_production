"use client";

import { Badge, Button, Notice, Skeleton } from "@chilli/ui";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronRight, Download, Printer, ScrollText } from "lucide-react";
import { Card, EmptyState, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/money";
import { downloadBlob, printBlob } from "@/lib/printing";
import type { ZReportData, ZReportSummary } from "@/lib/types";
import { ReportPaper, formatLocal } from "./ReportPaper";

const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback);

export function ZHistory({ currency, timezone }: { currency: string; timezone: string }) {
  const [items, setItems] = useState<ZReportSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const first = useCallback(async () => {
    setLoading(true); setError(null);
    try { const p = await api.zReports(null); setItems(p.items); setCursor(p.next_cursor); }
    catch (e) { setError(msg(e, "Could not load the Z-reports")); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void Promise.resolve().then(first); }, [first]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    try { const p = await api.zReports(cursor); setItems((cur) => [...cur, ...p.items]); setCursor(p.next_cursor); }
    catch (e) { toast.error(msg(e, "Could not load more")); }
    finally { setMore(false); }
  }

  if (loading) return <div role="status" aria-label="Loading Z-reports" className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>;
  if (error) return <Notice tone="danger" title="Could not load history" action={<Button size="sm" variant="secondary" onClick={() => void first()}>Retry</Button>}>{error}</Notice>;
  if (items.length === 0) return <Card><EmptyState icon={<ScrollText />} title="No Z-reports yet" hint="Close your first day on the Today tab. Every closed day is kept here and can be reprinted." /></Card>;

  return (
    <div>
      <ul aria-label="Z-reports" className="space-y-2">
        {items.map((z) => (
          <li key={z.id}>
            <Link href={`/end-of-day?z=${z.id}`} aria-label={`Open ${z.number_label}`}
              className="group flex items-center gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-card transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-pop focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary-soft font-mono text-sm font-bold text-primary-soft-fg">{z.number_label}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="tnum font-display text-base font-bold text-fg">{formatCurrency(z.net_sales, currency)}</span>
                  {z.empty && <Badge tone="neutral">Empty day</Badge>}
                </span>
                <span className="tnum block text-xs text-fg-muted">{formatLocal(z.period_from, timezone)} to {formatLocal(z.period_to, timezone)}</span>
                <span className="block text-xs text-fg-subtle">{z.orders} {z.orders === 1 ? "order" : "orders"}{z.closed_by_name ? ` · closed by ${z.closed_by_name}` : ""}</span>
              </span>
              <ChevronRight aria-hidden className="size-5 shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ul>
      {cursor && <div className="mt-4 flex justify-center"><Button variant="secondary" loading={more} onClick={() => void loadMore()}>Load more</Button></div>}
    </div>
  );
}

export function ZDetail({ id }: { id: string }) {
  const [report, setReport] = useState<ZReportData | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let off = false;
    void Promise.resolve().then(async () => {
      setError(null);
      try { const r = await api.zReport(id); if (!off) setReport(r); }
      catch (e) { if (!off) setError({ status: e instanceof ApiError ? e.status : 0, message: msg(e, "Could not load the report") }); }
    });
    return () => { off = true; };
  }, [id, tick]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(msg(e, "Something went wrong")); } finally { setBusy(null); }
  }
  const label = report?.number_label ?? "Z-report";
  const print = () => run("print", async () => { await printBlob(await api.zSlipBlob(id)); });
  const download = () => run("dl", async () => downloadBlob(await api.zSlipBlob(id), `${label}.pdf`));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link href="/end-of-day?tab=history" className="inline-flex h-11 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-fg-muted hover:text-fg"><ArrowLeft aria-hidden className="size-4" />All Z-reports</Link>
        {report && (
          <div className="flex flex-wrap items-center gap-2">
            {report.empty && <Badge tone="neutral">Empty day</Badge>}
            <Button variant="secondary" iconStart={<Printer />} loading={busy === "print"} disabled={busy !== null} onClick={() => void print()}>Print</Button>
            <Button variant="secondary" iconStart={<Download />} loading={busy === "dl"} disabled={busy !== null} onClick={() => void download()}>Download PDF</Button>
          </div>
        )}
      </div>
      {error && (error.status === 404
        ? <Card><EmptyState icon={<ScrollText />} title="Report not found" hint="This Z-report does not exist for your restaurant." action={<Link href="/end-of-day?tab=history" className="inline-flex h-11 items-center rounded-xl bg-primary bg-primary-gradient px-5 text-sm font-semibold text-primary-fg">Back to history</Link>} /></Card>
        : <Notice tone="danger" title="Could not load the report" action={<Button size="sm" variant="secondary" onClick={() => setTick((n) => n + 1)}>Retry</Button>}>{error.message}</Notice>)}
      {!report && !error && <div role="status" aria-label="Loading report"><Skeleton className="mx-auto h-[40rem] max-w-[34rem] rounded-sm" /></div>}
      {report && <>
        <p className="mb-3 text-center text-xs text-fg-subtle">Saved when the day was closed. Printed copies are stamped REPRINT.</p>
        <ReportPaper report={report} />
      </>}
    </div>
  );
}
