"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ReceiptText, RefreshCw } from "lucide-react";
import { Button, DateInput, IconButton, Notice, Select } from "@chilli/ui";
import { Card, CardHeader, EmptyState, Skeleton, toast } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { formatDate, formatDateTime, formatMonthYear } from "@/lib/datetime";
import { downloadBlob } from "@/lib/printing";
import { billingApi, billsLeft, chilli, isBlocked, ordersLeft, daysText, kindLabel, KIND_LABEL, monthOf, shiftMonth, signedChilli, type LedgerPage, type UsageStatement } from "@/lib/billing";
import { RechargeButton, RechargeWatcher } from "./recharge";
import { StateChip, UNAVAILABLE_TEXT, useWallet, WalletBanner } from "./wallet-parts";

const PAGE = 20;
const errText = (e: unknown, what: string) => (e instanceof ApiError && e.status !== 0 ? e.message : `Cannot reach the server. ${what} will show when you are back online.`);

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2/60 p-3">
      <dt className="text-xs font-medium text-fg-muted">{label}</dt>
      <dd className="tnum mt-0.5 font-semibold text-fg">{value}</dd>
      {hint && <dd className="text-xs text-fg-subtle">{hint}</dd>}
    </div>
  );
}

/** One row of the monthly statement table (label left, Chilli right). */
const Line = ({ k, v, strong }: { k: string; v: string; strong?: boolean }) => (
  <div className={`flex items-baseline justify-between gap-3 py-1.5 ${strong ? "border-t border-border pt-2 font-semibold text-fg" : "text-fg-muted"}`}>
    <span>{k}</span><span className="tnum text-right text-fg">{v}</span>
  </div>
);

function Statement() {
  const [month, setMonth] = useState(() => monthOf(new Date()));
  const [data, setData] = useState<UsageStatement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [csvBusy, setCsvBusy] = useState(false);
  const thisMonth = monthOf(new Date());

  useEffect(() => {
    let off = false;
    void Promise.resolve().then(async () => {
      setLoading(true); setErr(null);
      try { const s = await billingApi.usage(month); if (!off) setData(s); }
      catch (e) { if (!off) { setData(null); setErr(errText(e, "The statement")); } }
      finally { if (!off) setLoading(false); }
    });
    return () => { off = true; };
  }, [month]);

  async function csv() {
    setCsvBusy(true);
    try { downloadBlob(await billingApi.usageCsv(month), `chilli-statement-${month}.csv`); }
    catch (e) { toast.error(errText(e, "The statement")); } finally { setCsvBusy(false); }
  }

  const b = data?.bills;
  return (
    <Card data-testid="credit-statement">
      <CardHeader title="Monthly statement" description="Bills and Chilli added in the month (India time)."
        action={<Button size="sm" variant="secondary" iconStart={<Download />} loading={csvBusy} disabled={!data} onClick={() => void csv()}>CSV</Button>} />
      <div className="mb-3 flex items-center gap-2">
        <IconButton label="Previous month" icon={<ChevronLeft />} onClick={() => setMonth((m) => shiftMonth(m, -1))} />
        <span className="min-w-32 text-center font-semibold text-fg" aria-live="polite">{formatMonthYear(month)}</span>
        <IconButton label="Next month" icon={<ChevronRight />} disabled={month >= thisMonth} onClick={() => setMonth((m) => shiftMonth(m, 1))} />
      </div>
      {loading ? <Skeleton className="h-40 rounded-xl" /> : err ? <Notice tone="danger">{err}</Notice> : data && b && (
        <div className="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2">
          <div>
            <Line k="Opening balance" v={chilli(data.opening_balance_paise)} />
            <Line k="Recharges" v={signedChilli(data.topups_paise)} />
            {data.promo_paise !== 0 && <Line k="Bonus Chilli" v={signedChilli(data.promo_paise)} />}
            {data.adjustments_paise !== 0 && <Line k="Adjustments" v={signedChilli(data.adjustments_paise)} />}
            <Line k="Bills" v={signedChilli(-data.fees_paise)} />
            {data.fee_credit_backs_paise !== 0 && <Line k="Returned (voided bills)" v={signedChilli(data.fee_credit_backs_paise)} />}
            <Line k="Closing balance" v={chilli(data.closing_balance_paise)} strong />
          </div>
          <div>
            <Line k="Bills made" v={String(b.reported)} />
            <Line k="Charged" v={String(b.charged)} />
            {b.free_trial > 0 && <Line k="Free (trial)" v={String(b.free_trial)} />}
            {b.zero_total > 0 && <Line k="Free (zero total)" v={String(b.zero_total)} />}
            {b.voided > 0 && <Line k="Voided" v={String(b.voided)} />}
            <Line k="Chilli used" v={chilli(data.net_fees_paise)} strong />
          </div>
        </div>
      )}
    </Card>
  );
}

function Ledger() {
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<LedgerPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setPage(await billingApi.ledger({ kind: kind || undefined, from: from || undefined, to: to || undefined, limit: PAGE, offset })); }
    catch (e) { setErr(errText(e, "Chilli movements")); } finally { setLoading(false); }
  }, [kind, from, to, offset]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const filter = (f: () => void) => { f(); setOffset(0); };

  const total = page?.total ?? 0;
  return (
    <Card padded={false} data-testid="credit-ledger">
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <CardHeader title="Chilli movements" description="Every recharge and every bill, newest first." className="mb-3" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Kind" value={kind} onChange={(e) => filter(() => setKind(e.target.value))}>
            <option value="">All</option>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
          <DateInput label="From" value={from} max={to || undefined} onChange={(e) => filter(() => setFrom(e.target.value))} />
          <DateInput label="To" value={to} min={from || undefined} onChange={(e) => filter(() => setTo(e.target.value))} />
        </div>
      </div>
      <div className="mt-3">
        {err ? <div className="px-4 pb-4 sm:px-5"><Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>}>{err}</Notice></div>
          : loading && !page ? <div className="px-4 pb-4 sm:px-5"><Skeleton className="h-32 rounded-xl" /></div>
          : !page?.items.length ? <EmptyState compact icon={<ReceiptText />} title="No movements" hint="Recharges and bills appear here." />
          : (
            <ul className="divide-y divide-border border-t border-border" aria-busy={loading}>
              {page.items.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3 sm:px-5" data-testid="ledger-row">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-fg">{kindLabel(r.kind)}{r.reason ? <span className="font-normal text-fg-muted"> · {r.reason}</span> : null}</p>
                    <p className="text-xs text-fg-subtle">{formatDateTime(r.at)}{r.ref_type === "bill" && r.meta && typeof r.meta.invoice_number === "string" ? ` · Bill ${r.meta.invoice_number}` : ""}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`tnum font-semibold ${r.amount_paise < 0 ? "text-fg" : "text-success-fg"}`}>{signedChilli(r.amount_paise)}</p>
                    <p className="tnum text-xs text-fg-subtle">Balance {chilli(r.balance_after_paise)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>
      {total > PAGE && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm sm:px-5">
          <span className="tnum text-fg-muted">{offset + 1} to {Math.min(offset + PAGE, total)} of {total}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={offset === 0 || loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>Newer</Button>
            <Button size="sm" variant="secondary" disabled={offset + PAGE >= total || loading} onClick={() => setOffset((o) => o + PAGE)}>Older</Button>
          </span>
        </div>
      )}
    </Card>
  );
}

/**
 * Manage > Billing: the restaurant's Chilli (docs/CHILLI_WALLET.md): trial days left or the balance, Recharge, the state banner
 * (trial / low / grace / blocked / suspended, the server's English message), the monthly statement (CSV) and the ledger. Needs billing.view
 * (owner, manager); Recharge needs billing.topup (owner) and the server's `topup_online`.
 */
export function BillingView({ canTopUp }: { canTopUp: boolean }) {
  const { load, reload } = useWallet(true);
  // Bonus Chilli (recharge bonus and free credit from Chilli support) are ledger rows of kind "promo": total them so they are visible
  // next to the balance, also during the free trial when only the trial days are in big type.
  const [bonus, setBonus] = useState<{ total: number; count: number } | null>(null);
  const balanceNow = load.state === "ok" ? load.data.billing?.balance_paise : undefined;
  useEffect(() => {
    let off = false;
    billingApi.ledger({ kind: "promo", limit: 200 }).then((pg) => {
      if (!off) setBonus({ total: pg.items.reduce((n, r) => n + r.amount_paise, 0), count: pg.total });
    }).catch(() => { if (!off) setBonus(null); });
    return () => { off = true; };
  }, [balanceNow]);

  if (load.state === "missing") return <Card><EmptyState compact icon={<ReceiptText />} title="Chilli is not available here" hint="This server does not have the Chilli balance yet." /></Card>;

  const b = load.state === "ok" ? load.data.billing : null;
  const trial = b?.state === "trial";
  return (
    <div className="space-y-4">
      <Card data-testid="credit-summary">
        <CardHeader title="Chilli" description="Free for the trial, then 5 Chilli per bill. 1 rupee = 1 Chilli."
          action={<IconButton label="Refresh" icon={<RefreshCw />} onClick={() => void reload()} />} />
        {load.state === "loading" ? <Skeleton className="h-28 rounded-xl" />
          : load.state === "error" ? <Notice tone="danger" action={<Button size="sm" variant="secondary" onClick={() => void reload()}>Retry</Button>}>{load.message}</Notice>
          : !b ? <Notice tone="info">{UNAVAILABLE_TEXT}</Notice>
          : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-sm font-medium text-fg-muted">{trial ? "Free trial" : "Balance"} <StateChip b={b} /></p>
                  {trial
                    ? <p className="tnum font-display text-4xl font-extrabold tracking-tight text-fg" data-testid="credit-trial">{daysText(b.days_left)} left</p>
                    : <p className="tnum font-display text-4xl font-extrabold tracking-tight text-fg" data-testid="credit-balance">{chilli(b.balance_paise)}</p>}
                  {trial && <p className="tnum mt-1 text-sm text-fg-muted" data-testid="credit-balance">{chilli(b.balance_paise)} in your account</p>}
                </div>
                <RechargeButton b={b} mayTopUp={canTopUp} />
              </div>
              <RechargeWatcher onPaid={() => void reload()} />
              {b.state === "trial" && <WalletBanner b={b} />}{/* low / grace / blocked / paused are in the banner at the top of every screen */}
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <Fact label="Each bill uses" value={chilli(b.per_bill_paise)} />
                {trial
                  ? <Fact label="Free trial ends" value={b.trial_ends_at ? formatDate(b.trial_ends_at) : "-"} hint="No Chilli are used until then" />
                  : b.state === "grace" || isBlocked(b)
                    ? <Fact label="Orders left before billing stops" value={String(isBlocked(b) ? 0 : ordersLeft(b) ?? "-")} hint={`${b.grace_orders ?? 20} orders after your Chilli reach 0`} />
                    : <Fact label="Bills left (about)" value={String(billsLeft(b) ?? "-")} />}
                {bonus && bonus.count > 0 && <Fact label="Bonus Chilli received" value={signedChilli(bonus.total)} hint={`${bonus.count} ${bonus.count === 1 ? "credit" : "credits"}, included in your balance`} />}
                <Fact label="Low balance alert" value={b.low_balance_paise != null ? `At ${chilli(b.low_balance_paise)} or less` : "-"} />
                <Fact label="Smallest recharge" value={chilli(b.min_topup_paise ?? 200_000)} hint="Pay in rupees" />
              </dl>
              {(load.data.source === "cached" || b.source === "stale") && <p className="text-xs text-fg-subtle">Last known figures. Live details are temporarily unavailable.</p>}
              {typeof b.pending_bills === "number" && b.pending_bills > 0 && <p className="text-xs text-fg-subtle">{b.pending_bills} recent {b.pending_bills === 1 ? "bill is" : "bills are"} still being counted (already taken off the balance).</p>}
            </div>
          )}
      </Card>
      <Statement />
      <Ledger />
    </div>
  );
}
