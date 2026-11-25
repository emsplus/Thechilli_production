"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Badge, Button, Card, Dialog, formatINR, Input, Money, RadioGroup, Select, Table, useToast, type BadgeTone } from "@chilli/ui";
import { downloadCsv } from "@chilli/ui/data";
import { api, ApiError } from "@/lib/api";
import type { AdminWallet, BillingState, LedgerKind, LedgerRow, SettingSource } from "@/lib/api/types";
import { KIND_LABEL, LEDGER_KINDS, MAX_GRACE_PAISE, MAX_PER_BILL_PAISE, planTrialExtension, previewAdjust, project, reasonError, STATE_LABEL, stepUpHint, type AdjustMode, type FeeRules, type StepUpHint } from "@/lib/credit";
import { ledgerCsv, ledgerDetail, rupeesInput } from "@/lib/credit-export";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { useAction, useResource } from "@/lib/useResource";
import { DefList, InlineError, Notice, Pager, ReasonDialog, TextArea } from "./ui";

/**
 * "Chilli credit" panel on the business page: Chilli's own prepaid PAYG credit for this business (platform-core
 * /admin/tenants/{t}/wallet, docs/PAYG_BILLING.md). Every change goes form -> review (resulting balance and state, computed
 * like the server does) -> confirm; the server's answer replaces the preview. Actions follow the permission matrix:
 * wallet.adjust moves money, billing_settings.manage changes trial / fee / grace, tenants.suspend pauses billing.
 */
const STATE_TONE: Record<BillingState, BadgeTone> = { trial: "info", active: "success", low: "warning", empty: "danger", suspended: "danger" };
const SOURCE_LABEL: Record<SettingSource, string> = { default: "platform default", plan: "from plan", tenant: "set for this business" };
export const CreditStateBadge = ({ state }: { state: BillingState }) => <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>;
const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

type Dlg = null | { kind: "add" } | { kind: "adjust" } | { kind: "trial" } | { kind: "fees" } | { kind: "suspend" } | { kind: "resume" };

export function CreditPanel({ tenantRef, tenantName }: { tenantRef: string; tenantName: string }) {
  const can = useCan();
  const toast = useToast();
  const res = useResource(() => api.credit.wallet(tenantRef), `credit:${tenantRef}`);
  const mayAdjust = can("wallet.adjust"), maySettings = can("billing_settings.manage"), maySuspend = can("tenants.suspend");
  const anyWrite = mayAdjust || maySettings || maySuspend;
  // Only a hint: the server asks for a code per action and the app-wide dialog answers it. Nothing here is locked.
  const mfa = useResource(() => api.auth.mfaStatus(), "credit-mfa", anyWrite);
  const hint: StepUpHint = stepUpHint(mfa.data);
  const [dlg, setDlg] = useState<Dlg>(null);
  // The dialogs are mounted only while open, so the design system cannot return focus on its own: put it back on the button that opened them.
  const opener = useRef<HTMLElement | null>(null);
  const show = (d: NonNullable<Dlg>) => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDlg(d); };
  useEffect(() => {
    if (dlg !== null) return;
    const el = opener.current; opener.current = null;
    if (el) setTimeout(() => { if (el.isConnected && !el.hasAttribute("disabled")) el.focus(); }, 0);
  }, [dlg]);
  const [ledgerTick, setLedgerTick] = useState(0);
  const done = (msg: string) => { setDlg(null); toast.show(msg, "success"); res.reload(); setLedgerTick((t) => t + 1); };

  if (res.error && !res.data) {
    return <Card as="section"><h2 className="hq-card-title">Chilli credit</h2><InlineError error={res.error} /><Button size="sm" onClick={res.reload}>Try again</Button></Card>;
  }
  const w = res.data;
  return (
    <Card as="section" aria-labelledby="credit-title" className="hq-credit">
      <div className="hq-pagehead" style={{ marginBottom: 8 }}>
        <div className="hq-row"><h2 className="hq-card-title" id="credit-title" style={{ margin: 0 }}>Chilli credit</h2>{w ? <CreditStateBadge state={w.billing.state} /> : null}</div>
        {w ? (
          <div className="hq-actions">
            {mayAdjust ? <Button size="sm" variant="primary" onClick={() => show({ kind: "add" })}>Add credit</Button> : null}
            {mayAdjust ? <Button size="sm" onClick={() => show({ kind: "adjust" })}>Deduct / adjust</Button> : null}
            {maySettings && w.billing.model === "payg" ? <Button size="sm" onClick={() => show({ kind: "trial" })}>Extend trial</Button> : null}
            {maySettings ? <Button size="sm" onClick={() => show({ kind: "fees" })}>Fee and grace</Button> : null}
            {maySuspend && w.billing.state !== "suspended" ? <Button size="sm" variant="danger-soft" onClick={() => show({ kind: "suspend" })}>Pause billing</Button> : null}
            {maySuspend && w.billing.state === "suspended" ? <Button size="sm" onClick={() => show({ kind: "resume" })}>Resume billing</Button> : null}
          </div>
        ) : null}
      </div>
      {!w ? <p className="hq-muted">Loading credit…</p> : (
        <>
          {w.billing.banner ? <Notice tone={w.billing.banner.level === "info" ? "info" : "warning"} title="Shown to the business:">{w.billing.banner.message.en}</Notice> : null}
          {anyWrite ? <StepUpNote hint={hint} /> : null}
          <Summary w={w} />
          <LedgerSection tenantRef={tenantRef} slug={w.slug} tick={ledgerTick} />
        </>
      )}
      {w && (dlg?.kind === "add" || dlg?.kind === "adjust") ? <AdjustDialog w={w} tenantRef={tenantRef} group={dlg.kind} onClose={() => setDlg(null)} onDone={done} /> : null}
      {w && dlg?.kind === "trial" ? <TrialDialog w={w} tenantRef={tenantRef} onClose={() => setDlg(null)} onDone={done} /> : null}
      {w && dlg?.kind === "fees" ? <FeeDialog w={w} tenantRef={tenantRef} onClose={() => setDlg(null)} onDone={done} /> : null}
      {w && (dlg?.kind === "suspend" || dlg?.kind === "resume") ? (
        <ReasonDialog open onOpenChange={(o) => !o && setDlg(null)}
          title={dlg.kind === "suspend" ? "Pause billing" : "Resume billing"}
          description={dlg.kind === "suspend" ? `${tenantName} will not be able to create NEW bills until billing is resumed. Orders, KOTs, reports, voids and day close keep working. Balance stays ${moneyText(w.billing.balance_paise)}.` : `${tenantName} can create bills again. Balance stays ${moneyText(w.billing.balance_paise)}; state after resuming: ${STATE_LABEL[project({ balance_paise: w.billing.balance_paise, trial_ends_at: w.wallet.trial_ends_at, suspended: false }, w.settings).state]}.`}
          confirmLabel={dlg.kind === "suspend" ? "Pause billing" : "Resume billing"} safe={dlg.kind === "resume"}
          onConfirm={async (reason) => {
            try { await api.credit[dlg.kind](tenantRef, reason); done(dlg.kind === "suspend" ? "Billing paused" : "Billing resumed"); } catch (e) { return e as ApiError; }
          }} />
      ) : null}
    </Card>
  );
}

/** Plain-text rupees for sentences; <Money> elsewhere. Same design-system helper underneath (lakh / crore grouping). */
const moneyText = (p: number) => formatINR(p, { alwaysDecimals: true });

function StepUpNote({ hint }: { hint: StepUpHint }) {
  if (hint === "none") return null;
  if (hint === "tip") return <p className="hq-sub" style={{ marginBottom: 12 }}>Tip: credit changes are safer with two-step verification. <Link className="hq-link" href="/account/security">Turn it on</Link>.</p>;
  return <p className="hq-sub" style={{ marginBottom: 12 }}>Each credit change asks you to confirm with a fresh code from your authenticator app.</p>;
}

function Summary({ w }: { w: AdminWallet }) {
  const b = w.billing, s = w.settings;
  const src = (k: keyof typeof s.sources) => <small className="hq-muted"> ({SOURCE_LABEL[s.sources[k]]})</small>;
  const trialOpen = b.days_left > 0; // by the date, not the state: a paused business can still have trial days left
  const trial = b.model !== "payg" ? "Subscription model (no trial metering)" : trialOpen ? `${fmtDate(b.trial_ends_at)} (${b.days_left} ${b.days_left === 1 ? "day" : "days"} left)` : `Ended ${fmtDate(b.trial_ends_at)}`;
  return (
    <div className="hq-stack">
      <div className="hq-grid">
        <div><p className="hq-kpi__l">Balance</p><p className="hq-kpi__v"><Money value={b.balance_paise} alwaysDecimals /></p></div>
        <div><p className="hq-kpi__l">Bills left (incl. grace)</p><p className="hq-kpi__v">{b.bills_left ?? "–"}</p></div>
        <div><p className="hq-kpi__l">Per-bill fee</p><p className="hq-kpi__v"><Money value={b.per_bill_paise} alwaysDecimals /></p></div>
      </div>
      <DefList items={[
        ["Trial ends", trial],
        ["Fee setting", <span key="f"><Money value={s.per_bill_paise} alwaysDecimals /> GST {s.fee_gst_mode}{src("per_bill_paise")}</span>],
        ["Grace overdraft", <span key="g"><Money value={s.grace_paise} alwaysDecimals />{src("grace_paise")}</span>],
        ["Low-credit warning below", <span key="l"><Money value={s.low_balance_paise} alwaysDecimals />{src("low_balance_paise")}</span>],
        ["Top-up bonus", s.bonus_tiers.length ? <span key="t">{s.bonus_tiers.map((t) => `${moneyText(t.min_paise)}+ gets ${moneyText(t.bonus_paise)}`).join("; ")}{src("bonus_tiers")}</span> : "None"],
        ["Billing paused", b.state === "suspended" ? (b.suspended_reason ?? "Yes") : "No"],
      ]} />
    </div>
  );
}

// ------------------------------------------------------------------ ledger
function LedgerSection({ tenantRef, slug, tick }: { tenantRef: string; slug: string; tick: number }) {
  const toast = useToast();
  const [kind, setKind] = useState<LedgerKind | "">("");
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [month, setMonth] = useState(() => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7));
  const q = { kind, from: from || undefined, to: to || undefined, limit: 25, offset };
  const page = useResource(() => api.credit.ledger(tenantRef, q), `ledger:${tenantRef}:${kind}:${from}:${to}:${offset}:${tick}`);
  const badRange = !!(from && to && from > to);
  const exportLedger = useAction(async () => {
    let rows: LedgerRow[] = [];
    for (let off = 0; off < 10_000; off += 200) {
      const p = await api.credit.ledger(tenantRef, { ...q, limit: 200, offset: off });
      rows = rows.concat(p.items);
      if (rows.length >= p.total || p.items.length === 0) break;
    }
    downloadCsv(`chilli-credit-ledger-${slug}${from ? `-from-${from}` : ""}${to ? `-to-${to}` : ""}${kind ? `-${kind}` : ""}`, ledgerCsv(rows));
    toast.show(`Ledger exported (${rows.length} lines)`, "success");
  });
  const exportStatement = useAction(async () => {
    const text = await api.credit.statementCsv(tenantRef, month);
    downloadCsv(`chilli-usage-${slug}-${month}`, text);
    toast.show("Statement downloaded", "success");
  });
  const set = <V,>(f: (v: V) => void) => (v: V) => { f(v); setOffset(0); };
  return (
    <>
      <h3 className="hq-h2" style={{ fontSize: "var(--text-base)" }}>Ledger</h3>
      <div className="hq-filters">
        <Select label="Kind" value={kind} onChange={(e) => set(setKind)(e.target.value as LedgerKind | "")}>
          <option value="">All kinds</option>
          {LEDGER_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </Select>
        <Input label="From" type="date" value={from} onChange={(e) => set(setFrom)(e.target.value)} />
        <Input label="To" type="date" value={to} onChange={(e) => set(setTo)(e.target.value)} error={badRange ? "Must be on or after From" : undefined} />
        {kind || from || to ? <Button size="sm" onClick={() => { setKind(""); setFrom(""); setTo(""); setOffset(0); }}>Clear filters</Button> : null}
        <Button size="sm" loading={exportLedger.busy} disabled={badRange || !page.data?.total} onClick={() => void exportLedger.run()}>Export ledger (CSV)</Button>
      </div>
      <InlineError error={exportLedger.error} />
      {page.error ? <InlineError error={page.error} /> : null}
      {!page.data ? <p className="hq-muted">Loading ledger…</p> : (
        <>
          <Table<LedgerRow> caption="Credit ledger" getKey={(r) => String(r.id)} rows={page.data.items} empty={<p className="hq-muted">No ledger lines{kind || from || to ? " match these filters" : " yet"}.</p>} columns={[
            { key: "at", header: "When", render: (r) => <span className="hq-nowrap">{fmtDateTime(r.at)}</span> },
            { key: "k", header: "Kind", render: (r) => <span className="hq-nowrap">{KIND_LABEL[r.kind] ?? r.kind}</span> },
            { key: "a", header: "Amount", align: "end", render: (r) => <Money value={r.amount_paise} alwaysDecimals /> },
            { key: "b", header: "Balance after", align: "end", render: (r) => <Money value={r.balance_after_paise} alwaysDecimals /> },
            { key: "d", header: "Detail", render: (r) => ledgerDetail(r) || "–" },
            { key: "by", header: "By", render: (r) => <span className="hq-mono">{r.actor}</span> },
          ]} />
          <Pager page={page.data} onOffset={setOffset} />
        </>
      )}
      <div className="hq-filters" style={{ marginTop: 16 }}>
        <Input label="Statement month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} hint="Opening balance, the month's lines, closing balance (IST)." />
        <Button size="sm" loading={exportStatement.busy} disabled={!/^\d{4}-\d{2}$/.test(month)} onClick={() => void exportStatement.run()}>Download statement (CSV)</Button>
      </div>
      <InlineError error={exportStatement.error} />
    </>
  );
}

// ------------------------------------------------------------------ dialogs
function ReviewTable({ rows }: { rows: [string, ReactNode, boolean?][] }) {
  return (
    <table className="hq-totals" style={{ maxWidth: "none", marginBottom: 12 }}>
      <tbody>{rows.map(([k, v, total]) => <tr key={k} className={total ? "is-total" : undefined}><th scope="row">{k}</th><td>{typeof v === "string" ? <span className="hq-plain">{v}</span> : v}</td></tr>)}</tbody>
    </table>
  );
}
const stateAfter = (p: { state: BillingState; bills_left: number | null }) => <span className="hq-plain">{STATE_LABEL[p.state]}{p.bills_left !== null ? ` · ${p.bills_left} bills left` : ""}</span>;
const facts = (w: AdminWallet) => ({ balance_paise: w.wallet.balance_paise, trial_ends_at: w.wallet.trial_ends_at, suspended: !!w.wallet.suspended_at });
const rulesOf = (w: AdminWallet): FeeRules & { bonus_tiers: AdminWallet["settings"]["bonus_tiers"] } => ({ ...w.settings });

/** Two-step dialog shell: form, then review with a confirm button. Back keeps what was typed. */
function StepDialog({ title, description, review, onReview, onBack, confirmLabel, danger, busy, confirmDisabled, onConfirm, onClose, children }: {
  title: string; description: string; review: ReactNode | null; onReview: () => void; onBack: () => void; confirmLabel: string; danger?: boolean; busy: boolean; confirmDisabled?: boolean; onConfirm: () => void; onClose: () => void; children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={review ? `Review: ${title.toLowerCase()}` : title} description={review ? "Check the result before confirming. Recorded in the audit log with your reason." : description}
      footer={review
        ? <><Button onClick={onBack} disabled={busy}>Back</Button><Button variant={danger ? "danger-soft" : "primary"} loading={busy} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button></>
        : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onReview}>Review</Button></>}>
      {review ?? children}
    </Dialog>
  );
}

function AdjustDialog({ w, tenantRef, group, onClose, onDone }: { w: AdminWallet; tenantRef: string; group: "add" | "adjust"; onClose: () => void; onDone: (m: string) => void }) {
  const [mode, setMode] = useState<AdjustMode>(group === "add" ? "topup" : "deduct");
  const [amount, setAmount] = useState(""), [reason, setReason] = useState(""), [payRef, setPayRef] = useState("");
  const [touched, setTouched] = useState(false), [reviewing, setReviewing] = useState(false), [allowNeg, setAllowNeg] = useState(false);
  const [idem] = useState(newKey); // one key per dialog open: a double click or retry replays, never credits twice
  const amt = rupeesInput(amount), rErr = reasonError(reason);
  const preview = amt.ok ? previewAdjust(mode, amt.paise, facts(w), rulesOf(w)) : null;
  const a = useAction(async () => {
    const out = await api.credit.adjust(tenantRef, { kind: preview!.kind, amount_paise: preview!.amount_paise, reason: reason.trim(), payment_ref: mode === "topup" && payRef.trim() ? payRef.trim() : null, allow_negative: allowNeg || undefined }, idem);
    onDone(`${out.replayed ? "Already applied" : "Done"}. New balance ${moneyText(out.billing.balance_paise)}${out.receipt ? `, receipt ${out.receipt.number}` : ""}.`);
  });
  const negBlocked = !!preview?.goes_negative && !allowNeg;
  const serverNeg = a.error?.code === "would_go_negative";
  const label = { topup: "Add top-up", promo: "Add promo credit", deduct: "Deduct", add_back: "Add correction" }[mode];
  return (
    <StepDialog title={group === "add" ? "Add credit" : "Deduct or adjust credit"} description={group === "add" ? "Top-up = money received (a numbered receipt is issued, bonus tiers apply). Promo = free credit." : "Correct the balance. A deduction cannot take the balance below zero unless you confirm it explicitly."}
      onReview={() => { setTouched(true); if (amt.ok && !rErr) setReviewing(true); }} onBack={() => { setReviewing(false); a.clear(); }}
      confirmLabel={label} danger={preview ? preview.amount_paise < 0 : false} busy={a.busy} confirmDisabled={negBlocked} onClose={onClose}
      onConfirm={() => { if (!negBlocked) void a.run(); }}
      review={reviewing && preview ? (
        <>
          <ReviewTable rows={[
            ["Current balance", <Money key="c" value={preview.before_paise} alwaysDecimals />],
            [mode === "topup" ? "Top-up" : mode === "promo" ? "Promo credit" : "Adjustment", <Money key="a" value={preview.amount_paise} alwaysDecimals />],
            ...(preview.bonus_paise ? [["Tier bonus (promo line)", <Money key="b" value={preview.bonus_paise} alwaysDecimals />] as [string, ReactNode]] : []),
            ["Resulting balance", <Money key="r" value={preview.after_paise} alwaysDecimals />, true],
            ["State after", stateAfter(preview.projection)],
          ]} />
          <p className="hq-sub">Reason: {reason.trim()}{mode === "topup" && payRef.trim() ? ` · Payment ref ${payRef.trim()}` : ""}</p>
          {preview.goes_negative || serverNeg ? (
            <Notice tone="warning" title="Balance goes below zero.">
              {serverNeg ? a.error!.message : `The server refuses this unless you confirm it: the balance would be ${moneyText(preview.after_paise).replace("\u2212", "\u2212\u2060")}.`}
              <label className="hq-check" style={{ marginTop: 8 }}><input type="checkbox" checked={allowNeg} onChange={(e) => setAllowNeg(e.target.checked)} /> I confirm the balance may go below zero</label>
            </Notice>
          ) : null}
          {a.error && !serverNeg ? <InlineError error={a.error} /> : null}
          {negBlocked ? <p className="hq-sub">Tick the confirmation above to continue.</p> : null}
        </>
      ) : null}>
      <div className="hq-stack">
        <RadioGroup legend="Type" orientation="horizontal" value={mode} onValueChange={(v) => setMode(v as AdjustMode)}
          options={group === "add" ? [{ value: "topup", label: "Top-up (money received)" }, { value: "promo", label: "Promo (free credit)" }] : [{ value: "deduct", label: "Deduct" }, { value: "add_back", label: "Add correction" }]} />
        <Input label="Amount (₹)" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} hint={`Current balance ${moneyText(w.wallet.balance_paise)}`} error={touched && !amt.ok ? amt.error : undefined} />
        {mode === "topup" ? <Input label="Payment reference (optional)" maxLength={100} value={payRef} onChange={(e) => setPayRef(e.target.value)} hint="Bank UTR, cheque or cash slip number" /> : null}
        <TextArea label="Reason" value={reason} onChange={setReason} hint="Required. Recorded in the audit log and on the ledger line." error={touched ? rErr : undefined} />
        {preview ? <p className="hq-sub">Resulting balance: <strong>{moneyText(preview.after_paise)}</strong>{preview.bonus_paise ? ` (incl. ${moneyText(preview.bonus_paise)} bonus)` : ""}</p> : null}
      </div>
    </StepDialog>
  );
}

function TrialDialog({ w, tenantRef, onClose, onDone }: { w: AdminWallet; tenantRef: string; onClose: () => void; onDone: (m: string) => void }) {
  const [days, setDays] = useState("7"), [reason, setReason] = useState(""), [touched, setTouched] = useState(false), [reviewing, setReviewing] = useState(false);
  const plan = planTrialExtension(w.wallet.trial_started_at, w.wallet.trial_ends_at, /^\d+$/.test(days) ? Number(days) : NaN);
  const rErr = reasonError(reason);
  const a = useAction(async () => {
    if (!plan.ok) return;
    const out = await api.credit.putSettings(tenantRef, { trial_days: plan.trial_days, reason: reason.trim() });
    onDone(`Trial now ends ${fmtDate(out.trial_ends_at)}.`);
  });
  const after = plan.ok ? project({ ...facts(w), trial_ends_at: plan.new_end }, w.settings) : null;
  return (
    <StepDialog title="Extend trial" description="Bills are free until the trial ends. The new end is saved as this business's trial length (days from its trial start)."
      onReview={() => { setTouched(true); if (plan.ok && !rErr) setReviewing(true); }} onBack={() => { setReviewing(false); a.clear(); }}
      confirmLabel="Extend trial" busy={a.busy} onConfirm={() => void a.run()} onClose={onClose}
      review={reviewing && plan.ok && after ? (
        <>
          <ReviewTable rows={[
            ["Trial started", fmtDate(w.wallet.trial_started_at)], ["Current trial end", fmtDateTime(w.wallet.trial_ends_at)],
            ["New trial end", fmtDateTime(plan.new_end), true], ["Trial length", `${plan.trial_days} days from start (was ${w.settings.trial_days}, ${SOURCE_LABEL[w.settings.sources.trial_days]})`],
            ["Balance", <Money key="b" value={w.wallet.balance_paise} alwaysDecimals />], ["State after", stateAfter(after)],
          ]} />
          <p className="hq-sub">Reason: {reason.trim()}</p>
          <InlineError error={a.error} />
        </>
      ) : null}>
      <div className="hq-stack">
        <p className="hq-sub">Trial {w.billing.state === "trial" ? "ends" : "ended"} {fmtDateTime(w.wallet.trial_ends_at)}. Days are added to the later of that and now.</p>
        <Input label="Extend by (days)" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} error={touched && !plan.ok ? plan.error : undefined} hint={plan.ok ? `New end: ${fmtDateTime(plan.new_end)}` : undefined} />
        <TextArea label="Reason" value={reason} onChange={setReason} hint="Required. Recorded in the audit log." error={touched ? rErr : undefined} />
      </div>
    </StepDialog>
  );
}

function FeeDialog({ w, tenantRef, onClose, onDone }: { w: AdminWallet; tenantRef: string; onClose: () => void; onDone: (m: string) => void }) {
  const s = w.settings;
  const own = (k: "per_bill_paise" | "grace_paise") => s.sources[k] === "tenant";
  const toRs = (p: number) => (p / 100).toFixed(2);
  const [fee, setFee] = useState(own("per_bill_paise") ? toRs(s.per_bill_paise) : "");
  const [grace, setGrace] = useState(own("grace_paise") ? toRs(s.grace_paise) : "");
  const [reason, setReason] = useState(""), [touched, setTouched] = useState(false), [reviewing, setReviewing] = useState(false);
  // Blank = inherit (clears this business's override). "0" is a real value (free bills / no grace), so it is allowed here.
  const parse = (t: string, max: number) => (t.trim() === "" ? { ok: true as const, paise: null } : /^0*(\.0{0,2})?$/.test(t.trim()) ? { ok: true as const, paise: 0 } : (() => { const r = rupeesInput(t, max); return r.ok ? { ok: true as const, paise: r.paise } : r; })());
  const f = parse(fee, MAX_PER_BILL_PAISE), g = parse(grace, MAX_GRACE_PAISE), rErr = reasonError(reason);
  const body = useMemo(() => {
    const b: { per_bill_paise?: number | null; grace_paise?: number | null } = {};
    if (f.ok && (f.paise !== (own("per_bill_paise") ? s.per_bill_paise : null))) b.per_bill_paise = f.paise;
    if (g.ok && (g.paise !== (own("grace_paise") ? s.grace_paise : null))) b.grace_paise = g.paise;
    return b;
  }, [f, g]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = Object.keys(body).length > 0;
  const a = useAction(async () => {
    await api.credit.putSettings(tenantRef, { ...body, reason: reason.trim() });
    onDone("Fee and grace saved for this business.");
  });
  // Preview with the inherited value when an override is cleared: the plan/default value is not known here when the
  // current value IS the override, so the review says "inherited" and the server's answer shows the number.
  const newFee = body.per_bill_paise === undefined ? s.per_bill_paise : body.per_bill_paise;
  const newGrace = body.grace_paise === undefined ? s.grace_paise : body.grace_paise;
  const after = newFee !== null && newGrace !== null ? project(facts(w), { ...s, per_bill_paise: newFee, grace_paise: newGrace }) : null;
  const show = (v: number | null | undefined, cur: number) => (v === undefined ? <span><Money value={cur} alwaysDecimals /> (unchanged)</span> : v === null ? "Inherit plan / platform default" : <Money value={v} alwaysDecimals />);
  return (
    <StepDialog title="Per-bill fee and grace" description="Overrides for this business only. Leave a field blank to inherit the plan or platform default."
      onReview={() => { setTouched(true); if (f.ok && g.ok && !rErr && changed) setReviewing(true); }} onBack={() => { setReviewing(false); a.clear(); }}
      confirmLabel="Save for this business" busy={a.busy} onConfirm={() => void a.run()} onClose={onClose}
      review={reviewing ? (
        <>
          <ReviewTable rows={[
            ["Per-bill fee", show(body.per_bill_paise, s.per_bill_paise)], ["Grace overdraft", show(body.grace_paise, s.grace_paise)],
            ["GST on the fee", s.fee_gst_mode === "inclusive" ? "Included in the fee" : "Added on top (18% assumed in this preview)"],
            ["Balance (unchanged)", <Money key="b" value={w.wallet.balance_paise} alwaysDecimals />, true],
            ["State after", after ? stateAfter(after) : "Shown after saving (inherited values come from the server)"],
          ]} />
          <p className="hq-sub">Reason: {reason.trim()}</p>
          <InlineError error={a.error} />
        </>
      ) : null}>
      <div className="hq-stack">
        <Input label="Per-bill fee (₹)" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} placeholder={toRs(s.per_bill_paise)}
          hint={`Now ${moneyText(s.per_bill_paise)} (${SOURCE_LABEL[s.sources.per_bill_paise]}). Blank = inherit, 0 = bills are free.`} error={touched && !f.ok ? f.error : undefined} />
        <Input label="Grace overdraft (₹)" inputMode="decimal" value={grace} onChange={(e) => setGrace(e.target.value)} placeholder={toRs(s.grace_paise)}
          hint={`Now ${moneyText(s.grace_paise)} (${SOURCE_LABEL[s.sources.grace_paise]}). Bills allowed below zero before new bills are refused.`} error={touched && !g.ok ? g.error : undefined} />
        <TextArea label="Reason" value={reason} onChange={setReason} hint="Required. Recorded in the audit log." error={touched ? rErr : undefined} />
        {touched && !changed ? <p className="hq-sub">Nothing changed yet.</p> : null}
      </div>
    </StepDialog>
  );
}
