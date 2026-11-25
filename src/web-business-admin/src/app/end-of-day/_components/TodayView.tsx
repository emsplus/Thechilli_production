"use client";

import { Button, Notice, Skeleton } from "@chilli/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Lock, Printer, RefreshCw} from "lucide-react";
import { Card, toast } from "@/components/ui";
import { KpiTile } from "@/app/reports/_components/parts";
import { SuccessCheckIllustration } from "@/components/illustrations";
import { api, ApiError } from "@/lib/api";
import { cmpMoney, formatCurrency, sumMoney, formatCompactMoney } from "@/lib/money";
import { taxPhrases } from "@/lib/taxWords";
import Link from "next/link";
import { billedOf, hasTakingsSplit, notReceivedOf } from "@/lib/takings";
import { downloadBlob, printBlob } from "@/lib/printing";
import type { ZReportData } from "@/lib/types";
import { CloseDayDialog } from "./CloseDayDialog";
import { ReportPaper, formatLocal } from "./ReportPaper";

const REFRESH_MS = 60_000;
const msg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback);

function Strip({ r }: { r: ZReportData }) {
  const m = (v: string) => formatCompactMoney(v, r.restaurant.currency); // one money format: "₹18,625.00" (no space), lakh / crore above 1,00,000
  const tx = taxPhrases(r.restaurant.country);
  const pay = (k: string) => r.summary.payments.find((p) => p.method === k)?.amount ?? "0";
  const upi = r.summary.payments.some((p) => p.method === "upi");
  const vat = r.summary.vat.shown ? r.summary.vat.total?.vat ?? "0" : null;
  const ub = r.open_items.unpaid_bills;
  const unpaid = ub.count > 0 || cmpMoney(ub.balance, 0) > 0;
  const split = hasTakingsSplit(r.deductions); // new server: takings = money received, billed_total = invoiced
  const notReceived = notReceivedOf(r.deductions);
  const unpaidNow = notReceived !== null && cmpMoney(notReceived, 0) > 0;
  const disc = sumMoney([r.deductions.item_discount, r.deductions.bill_discounts.amount]);
  return (
    <div data-testid="eod-stats" className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 max-sm:[&_.font-display]:text-2xl">
      {split && <KpiTile className="col-span-2 lg:col-span-1" label="Total takings (received)" value={m(r.deductions.total_takings)} hint="Money received: payments less refunds paid" />}
      <KpiTile className="col-span-2 lg:col-span-1" label={split ? "Billed (incl. unpaid bills)" : "Billed sales"} value={m(billedOf(r.deductions))} hint={r.restaurant.prices_include_tax ? `${tx.word} included` : r.deductions.vat !== null ? `${tx.word} added` : undefined} />
      {unpaidNow && <KpiTile className="col-span-2 lg:col-span-1" label="Unpaid bills" value={m(notReceived!)}
        hint={<span data-testid="eod-unpaid-new">Billed, not received yet. <Link href="/orders" className="font-semibold text-primary underline underline-offset-2">Take payment</Link></span>} />}
      {!unpaidNow && unpaid && <KpiTile className="col-span-2 lg:col-span-1" label="Unpaid" value={m(ub.balance)} hint={`${ub.count} ${ub.count === 1 ? "bill" : "bills"} billed, not yet collected. Included in billed sales.`} />}
      <KpiTile label="Orders" value={String(r.grand_total.orders)} hint={`${r.grand_total.items} items`} />
      <KpiTile label="Cash" value={m(pay("cash"))} />
      <KpiTile label="Card" value={m(pay("card"))} />
      {upi && <KpiTile label="UPI" value={m(pay("upi"))} />}
      {/* No tax tile at all when the restaurant charges none (the old "n/a, not registered" tax tile is gone). */}
      {vat !== null && <KpiTile label={tx.word} value={m(vat)} />}
      <KpiTile label="Discounts" value={m(disc)} />
      <KpiTile label="Voids" value={String(r.voids.count)} hint={r.voids.count ? m(r.voids.amount) : undefined} />
    </div>
  );
}

/** X report: the running day, auto-refreshing, plus the "close the day" flow and its success screen. */
export function TodayView() {
  const router = useRouter();
  const [report, setReport] = useState<ZReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);
  const [closing, setClosing] = useState<ZReportData | null>(null); // fresh X report shown in the dialog
  const [dialog, setDialog] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<ZReportData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const paused = useRef(false);
  const isPaused = dialog || submitting || done !== null;
  useEffect(() => { paused.current = isPaused; }, [isPaused]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setFetching(true);
    try { const r = await api.xReport(); setReport(r); setError(null); }
    catch (e) { if (!silent || !report) setError(msg(e, "Could not load today's report")); }
    finally { setFetching(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);
  useEffect(() => {
    const tick = () => { if (!paused.current && document.visibilityState === "visible") void load(true); };
    const id = setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", tick); document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); } catch (e) { toast.error(msg(e, "Something went wrong")); } finally { setBusy(null); }
  }
  const printX = () => run("print", async () => { await printBlob(await api.xSlipBlob()); });
  const downloadX = () => run("dl", async () => downloadBlob(await api.xSlipBlob(), "X-REPORT.pdf"));

  /** Re-reads the X report first, so the warnings in the dialog are the truth right now, not 50 seconds ago. */
  async function startClose() {
    setPreparing(true);
    try { const fresh = await api.xReport(); setReport(fresh); setClosing(fresh); setDialog(true); }
    catch (e) { toast.error(msg(e, "Could not check the day before closing")); }
    finally { setPreparing(false); }
  }

  async function confirmClose(key: string, autoPrint: boolean) {
    setSubmitting(true);
    try {
      const z = await api.closeDay(key);
      setDialog(false); setDone(z);
      toast.success(`${z.number_label ?? "Z-report"} closed`);
      if (autoPrint && z.id) { try { await printBlob(await api.zSlipBlob(z.id)); } catch (e) { toast.error(msg(e, "Closed, but the slip could not be printed. Use Print Z slip.")); } }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) toast.error("Only the owner or a manager can close the day.");
      else if (e instanceof ApiError && e.status === 409) toast.error(`${e.message}. Reload the page and check the day.`);
      else if (e instanceof ApiError && e.status === 0) toast.error("No connection. Nothing was lost: press the button again and the day closes only once.");
      else toast.error(msg(e, "Could not close the day"));
    } finally { setSubmitting(false); }
  }

  async function startNewDay() { setDone(null); setReport(null); await load(); }

  if (done) {
    const label = done.number_label ?? "Z-report";
    return (
      <Card className="mx-auto max-w-lg text-center" data-testid="close-success">
        <div className="mx-auto w-28"><SuccessCheckIllustration title="Day closed" /></div>
        <h2 className="mt-2 font-display text-2xl font-extrabold text-fg">{label} closed</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Takings <span className="tnum font-semibold text-fg">{formatCurrency(done.deductions.total_takings, done.restaurant.currency)}</span> from {done.grand_total.orders} {done.grand_total.orders === 1 ? "order" : "orders"}.
          {done.empty && " Nothing was sold, so this is an empty report."} The report is saved and cannot be changed.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <Button variant="primary" iconStart={<Printer />} loading={busy === "zprint"} disabled={busy !== null} onClick={() => void run("zprint", async () => { await printBlob(await api.zSlipBlob(done.id!)); })}>Print Z slip</Button>
          <Button variant="secondary" iconStart={<Download />} loading={busy === "zdl"} disabled={busy !== null} onClick={() => void run("zdl", async () => downloadBlob(await api.zSlipBlob(done.id!), `${label}.pdf`))}>Download PDF</Button>
          <Button variant="secondary" onClick={() => router.push(`/end-of-day?z=${done.id}`)}>View report</Button>
          <Button variant="secondary" onClick={() => void startNewDay()}>Start new day</Button>
        </div>
      </Card>
    );
  }

  if (!report && fetching) return <div role="status" aria-label="Loading today's report"><div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div><Skeleton className="mx-auto h-[36rem] max-w-[34rem] rounded-sm" /></div>;
  if (!report) return <Notice tone="danger" title="Could not load today's report" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{error}</Notice>;

  const tz = report.period.timezone;
  const incomplete = report.completeness && !report.completeness.data_complete;
  return (
    <div className={fetching ? "opacity-70 transition-opacity" : "transition-opacity"} aria-busy={fetching}>
      {error && <Notice tone="warning" className="mb-4" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>Could not refresh: {error}. Showing the last numbers.</Notice>}
      {incomplete && <Notice tone="warning" className="mb-4" title="Some sales are not on the server yet">{report.completeness?.incomplete_reason ?? "A device is holding unsynced sales."} Figures may grow once every device has synced.</Notice>}
      <Strip r={report} />
      <Card className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-display text-base font-bold text-fg">Today so far (X report)</p>
            <p className="tnum text-sm text-fg-muted">Since {formatLocal(report.period.from, tz)} · updated {formatLocal(report.generated_at, tz)}</p>
            <p className="text-xs text-fg-subtle">A reading only. Nothing is closed until you close the day.</p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
            <Button variant="secondary" iconStart={<RefreshCw className={fetching ? "animate-spin" : ""} />} onClick={() => void load()} disabled={fetching}>Refresh</Button>
            <Button variant="secondary" iconStart={<Printer />} loading={busy === "print"} disabled={busy !== null} onClick={() => void printX()}>Print X report</Button>
            <Button variant="secondary" iconStart={<Download />} loading={busy === "dl"} disabled={busy !== null} onClick={() => void downloadX()}>Download</Button>
            <Button variant="primary" iconStart={<Lock />} loading={preparing} onClick={() => void startClose()} className="col-span-2 sm:col-span-1">Close day &amp; print Z-report</Button>
          </div>
        </div>
      </Card>
      {report.empty && <Notice tone="info" className="mb-4">Nothing has been sold in this period yet.</Notice>}
      <ReportPaper report={report} />
      <CloseDayDialog open={dialog} onOpenChange={setDialog} report={closing} busy={submitting} onConfirm={(k, a) => void confirmClose(k, a)} />
    </div>
  );
}
