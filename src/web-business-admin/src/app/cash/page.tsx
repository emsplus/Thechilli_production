"use client";

import { formatDateTime } from "@/lib/datetime";
import { useEffect, useRef, useState } from "react";
import { Banknote, TriangleAlert } from "lucide-react";
import { Button, Dialog, Input, Notice, PageHeader, Skeleton, Textarea } from "@chilli/ui";
import { Card, EmptyState, toast } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { setCashSession, useCashSession } from "@/lib/cashSession";
import { cashVariance, needsVarianceReason, validAmount } from "@/lib/cash";
import { FLOAT_HISTORY, unusualFloat } from "@/lib/cashFloat";
import { ShiftOpenBanner } from "@/components/shell/shift-banner";
import { formatCurrency } from "@/lib/money";
import { useCurrency } from "@/lib/taxConfig";
import { uuid } from "@/lib/uuid";
import { useCan } from "@/lib/useRole";
import type { CashSession } from "@/lib/types";

const msg = (e: unknown, fb: string) => (e instanceof ApiError ? e.message : fb);

/** Opening floats of the shifts before `before` (ISO instant, default now), newest first, at most FLOAT_HISTORY. Empty when the list is not available. */
function useRecentFloats(before?: string): string[] {
  const [rows, setRows] = useState<CashSession[]>([]);
  useEffect(() => { let off = false; void api.cashSessionsRecent().then((r) => { if (!off) setRows(r); }, () => {}); return () => { off = true; }; }, []);
  const cut = before ? Date.parse(before) : Infinity;
  return [...rows].filter((r) => Date.parse(r.opened_at) < cut).sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at)).slice(0, FLOAT_HISTORY).map((r) => r.opening_float);
}

/** Cash drawer: open a shift with an opening float, close it with the counted cash and, when it does not match, a reason. */
export default function CashPage() {
  const { can, ready } = useCan();
  const cur = useCurrency();
  const money = (v: string) => formatCurrency(v, cur);
  // Shared with Today: one cached request, refreshed every 60 s, no retry loop on "no drawer open" (404 = null).
  const q = useCashSession(ready);
  const session = q.data === undefined ? (q.error ? null : "loading") : q.data;
  const error = q.error ? msg(q.error, "Could not load the cash drawer") : null;
  const setSession = setCashSession;
  const [dialog, setDialog] = useState<"open" | "close" | null>(null);
  const [last, setLast] = useState<CashSession | null>(null);
  const prevFloats = useRecentFloats(session && session !== "loading" && session !== "unsupported" && session.status === "open" ? session.opened_at : undefined);

  const load = () => q.refetch().catch(() => { /* shown through q.error */ });

  if (!ready || session === "loading") return <Skeleton className="h-40 rounded-2xl" />;
  if (!can("cashier.shift") || session === "unsupported") {
    return <><PageHeader title="Cash drawer" /><Card><EmptyState icon={<Banknote />} title="Cash drawer is not available" hint={!can("cashier.shift") ? "Your account does not run a cash drawer." : "This server does not track cash sessions yet."} /></Card></>;
  }
  const open = session && session.status === "open" ? session : null;

  return (
    <>
      <PageHeader title="Cash drawer" description="Open a shift with the starting cash, close it with what you count." />
      <div className="mb-4 empty:hidden"><ShiftOpenBanner hideLink /></div>
      {error && <div className="mb-4"><Notice tone="danger" action={<Button variant="primary" size="sm" onClick={() => void load()}>Retry</Button>}>{error}</Notice></div>}
      <Card className="space-y-3">
        {open ? (
          <>
            <p className="flex flex-wrap items-center gap-2 font-display text-xl font-bold text-fg">Shift open
              {unusualFloat(open.opening_float, prevFloats) && <span data-testid="unusual-float-chip" className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-0.5 font-sans text-xs font-semibold text-warning-fg"><TriangleAlert aria-hidden className="size-3.5" />Unusual opening amount</span>}
            </p>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-fg-muted">Since</dt><dd className="font-medium">{formatDateTime(open.opened_at)}</dd></div>
              <div><dt className="text-fg-muted">Opening float</dt><dd className="tnum font-medium">{money(open.opening_float)}</dd></div>
              <div><dt className="text-fg-muted">Cash expected now</dt><dd data-testid="cash-expected" className="tnum font-medium">{money(open.expected_cash ?? open.opening_float)}</dd></div>
            </dl>
            <Button variant="primary" onClick={() => setDialog("close")}>Close shift</Button>
          </>
        ) : (
          <>
            <p className="font-display text-xl font-bold text-fg">No shift open</p>
            <p className="text-sm text-fg-muted">Payments are not blocked without a shift, but the till cannot be reconciled.</p>
            <Button variant="primary" onClick={() => setDialog("open")}>Open shift</Button>
          </>
        )}
      </Card>
      {last && last.status === "closed" && (
        <Card className="mt-4" data-testid="last-close"><p className="font-semibold text-fg">Last shift closed</p>
          <p className="text-sm text-fg-muted">Expected {money(last.expected_cash ?? "0")}, counted {money(last.counted_cash ?? "0")}, variance <span className="tnum font-semibold">{money(last.variance ?? "0")}</span>{last.variance_reason ? `: ${last.variance_reason}` : ""}</p></Card>
      )}
      {dialog === "open" && <OpenDialog money={money} previous={prevFloats} onClose={() => setDialog(null)} onDone={(s) => { setSession(s); setDialog(null); toast.success("Shift opened"); }} />}
      {dialog === "close" && open && <CloseDialog session={open} money={money} onClose={() => setDialog(null)} onDone={(s) => { setLast(s); setSession(null); setDialog(null); toast.success("Shift closed"); }} />}
    </>
  );
}

function OpenDialog({ money, previous, onClose, onDone }: { money: (v: string) => string; previous: string[]; onClose: () => void; onDone: (s: CashSession) => void }) {
  const [amount, setAmount] = useState("");
  const [confirming, setConfirming] = useState(false); // an unusual amount asks once more (a confirm step, never a block)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useRef(uuid());
  const ok = validAmount(amount);
  const odd = ok ? unusualFloat(amount.trim(), previous) : null;
  async function submit() {
    setBusy(true); setErr(null);
    try { onDone(await api.openCashSession({ opening_float: amount.trim(), idempotency_key: key.current })); }
    catch (e) { setErr(msg(e, "Could not open the shift")); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }} title="Open shift" description="How much cash is in the drawer to start?"
      footer={confirming && odd
        ? <><Button variant="primary" onClick={() => setConfirming(false)} disabled={busy} data-testid="float-change">Change the amount</Button><Button variant="primary" loading={busy} onClick={() => void submit()} data-testid="float-confirm">Open with {money(amount.trim())}</Button></>
        : <><Button variant="primary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={() => (odd ? setConfirming(true) : void submit())}>Open shift</Button></>}>
      <div className="space-y-3 pb-3">
        <Input label="Opening float" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => { setAmount(e.target.value); setConfirming(false); }} error={amount && !ok ? "Enter an amount like 500 or 500.50" : undefined} />
        {confirming && odd && <p role="alert" data-testid="float-warning" className="rounded-lg bg-warning-soft px-3 py-2 text-sm font-medium text-warning-fg">
          {odd.reason === "limit" ? `${money(amount.trim())} is more than ${money(odd.limit)}.` : `${money(amount.trim())} is more than 3 times your usual opening amount (about ${money(odd.average ?? "0")}).`} Is this the cash in the drawer? Check the amount before you open the shift.</p>}
        {err && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger-fg">{err}</p>}
      </div>
    </Dialog>
  );
}

function CloseDialog({ session, money, onClose, onDone }: { session: CashSession; money: (v: string) => string; onClose: () => void; onDone: (s: CashSession) => void }) {
  const expected = session.expected_cash ?? session.opening_float;
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = validAmount(counted);
  const variance = ok ? cashVariance(counted.trim(), expected) : null;
  const needReason = ok && needsVarianceReason(counted.trim(), expected);
  const reasonOk = !needReason || reason.trim().length >= 3;
  async function submit() {
    setBusy(true); setErr(null);
    try { onDone(await api.closeCashSession(session.id, { counted_cash: counted.trim(), variance_reason: needReason ? reason.trim() : undefined })); }
    catch (e) { setErr(msg(e, "Could not close the shift")); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }} title="Close shift" description={`The till should hold ${money(expected)}.`}
      footer={<><Button variant="primary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} disabled={!ok || !reasonOk} onClick={() => void submit()}>Close shift</Button></>}>
      <div className="space-y-3 pb-3">
        <Input label="Cash counted" inputMode="decimal" autoComplete="off" value={counted} onChange={(e) => setCounted(e.target.value)} error={counted && !ok ? "Enter an amount like 1200 or 1200.50" : undefined} />
        {variance !== null && <p data-testid="cash-variance" role="status" className={needReason ? "font-semibold text-warning-fg" : "font-semibold text-success-fg"}>{needReason ? `${Number(variance) < 0 ? "Short" : "Over"} by ${money(variance.replace("-", ""))}` : "Matches the till"}</p>}
        {needReason && <Textarea label="Why does it not match?" value={reason} rows={2} maxLength={300} onChange={(e) => setReason(e.target.value)} hint="Required when the count differs." />}
        {err && <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm font-medium text-danger-fg">{err}</p>}
      </div>
    </Dialog>
  );
}
