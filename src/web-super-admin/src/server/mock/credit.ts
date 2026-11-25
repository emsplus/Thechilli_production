import type * as T from "@/lib/api/types";
import { bonusFor, DAY_MS, feeSplit, project, MAX_ADJUST_PAISE, MAX_GRACE_PAISE, MAX_PER_BILL_PAISE, MAX_TRIAL_DAYS } from "@/lib/credit";

/**
 * Mock of platform-core's PAYG wallet (app/services/wallet.py + app/api/wallet.py admin routes): same envelopes, same
 * validation bounds, same idempotency and would_go_negative rules, an append-only ledger whose balance chain always holds.
 * Demo data only: Chilli's own credit per business, never a restaurant's operational data.
 */
export interface CreditStore {
  wallets: Record<string, T.WalletRow>;
  /** All tenants, append-only, ids increase with time. */
  ledger: (T.LedgerRow & { idem_key: string })[];
  tenantSettings: Record<string, Partial<Record<T.BillingSettingKey, unknown>>>;
  planSettings: Record<string, Partial<Record<T.BillingSettingKey, unknown>>>;
  receipts: (T.WalletReceipt & { tenant_id: string; ledger_id: number })[];
  seq: { ledger: number; receipt: number };
}

export const BILLING_DEFAULTS: T.BillingSettingsValues = {
  billing_model: "payg", trial_days: 7, per_bill_paise: 500, fee_gst_mode: "inclusive", charge_zero_bills: false,
  low_balance_paise: 10_000, grace_paise: 5_000, min_topup_paise: 0, bonus_tiers: [],
};
const FIELDS = Object.keys(BILLING_DEFAULTS) as T.BillingSettingKey[];
const TZ_OFFSET = "+05:30"; // BILLING_TIMEZONE Asia/Kolkata (no DST)

type Tenant = { id: string; slug: string; display_name: string; created_at: string; outlets: { id: string }[] };
type Res = { status: number; body: unknown; contentType?: string };
const err = (status: number, code: string, message: string): Res => ({ status, body: { error: { code, message } } });
const rs = (p: number) => `${p < 0 ? "-" : ""}₹${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, "0")}`;

// ------------------------------------------------------------------ seed
export function seedCredit(tenants: Tenant[], plans: { id: string; code: string }[], ago: (mins: number) => string): CreditStore {
  const c: CreditStore = { wallets: {}, ledger: [], tenantSettings: {}, planSettings: {}, receipts: [], seq: { ledger: 0, receipt: 0 } };
  const D = 1440;
  const pro = plans.find((p) => p.code === "pro");
  if (pro) c.planSettings[pro.id] = { bonus_tiers: [{ min_paise: 50_000, bonus_paise: 2_500 }], low_balance_paise: 20_000 };
  // [slug, trial started (days ago), trial days, suspended reason]
  const plan: [string, number, number, string | null][] = [
    ["saffron-table", 60, 7, null], ["dosa-junction", 5, 7, null], ["biryani-bazaar", 39, 7, null], ["cafe-monsoon", 52, 7, null],
    ["tandoor-tales", 34, 7, null], ["kesar-chai-adda", 1, 7, null], ["old-harbour-grill", 112, 7, "Business closed by the owner"],
  ];
  type Ev = { t: string; mins: number; kind: T.LedgerKind; amount: number; extra?: Partial<T.LedgerRow>; idem: string };
  const evs: Ev[] = [];
  for (const [slug, startDays, days, susp] of plan) {
    const t = tenants.find((x) => x.slug === slug); if (!t) continue;
    const start = ago(startDays * D);
    c.wallets[t.id] = { tenant_id: t.id, balance_paise: 0, trial_started_at: start, trial_ends_at: new Date(Date.parse(start) + days * DAY_MS).toISOString(), suspended_at: susp ? ago(12 * D) : null, suspended_reason: susp, last_state: null, created_at: start, updated_at: start };
  }
  const T_ = (slug: string) => tenants.find((x) => x.slug === slug)!;
  let bill = 0;
  const fees = (slug: string, n: number, fromDays: number, toDays: number, perBill = 500) => {
    const t = T_(slug); const [debit, base, gst] = feeSplit(perBill, "inclusive");
    for (let k = 0; k < n; k++) {
      const mins = Math.round(fromDays * D - ((fromDays - toDays) * D * k) / n) - 7; bill++;
      const inv = `${slug.split("-").map((w) => w[0].toUpperCase()).join("")}/2627/${String(1000 + k).padStart(6, "0")}`;
      const bid = `b${String(bill).padStart(7, "0")}`;
      evs.push({ t: t.id, mins, kind: "bill_fee", amount: -debit, idem: `bill_fee:${bid}`, extra: { source: "pos", actor: "service:pos-service", ref_type: "bill", ref_id: bid, fee_base_paise: base, fee_gst_paise: gst, meta: { invoice_number: inv, outlet_id: t.outlets[k % Math.max(1, t.outlets.length)]?.id ?? null } } });
    }
  };
  const topup = (slug: string, days: number, amount: number, ref: string, actor = "finance@chilli.test") => {
    const t = T_(slug); const rid = `00000000-0000-4000-9000-${String(++c.seq.receipt).padStart(12, "0")}`;
    const number = `CR/2627/${String(c.seq.receipt).padStart(6, "0")}`;
    evs.push({ t: t.id, mins: days * D, kind: "topup", amount, idem: `adm:seed-topup-${c.seq.receipt}`, extra: { source: "admin", actor, ref_type: "receipt", ref_id: rid, reason: "Bank transfer received", meta: { payment_ref: ref } } });
    c.receipts.push({ id: rid, number, tenant_id: t.id, ledger_id: 0, amount_paise: amount, bonus_paise: 0, payment_ref: ref, created_at: ago(days * D) });
    return rid;
  };
  const credit = (slug: string, days: number, kind: "promo" | "adjustment", amount: number, reason: string, actor = "super@chilli.test") =>
    evs.push({ t: T_(slug).id, mins: days * D - 1, kind, amount, idem: `adm:seed-${kind}-${evs.length}`, extra: { source: kind === "promo" ? "promo" : "admin", actor, ref_type: "op", ref_id: `seed-${evs.length}`, reason } });

  topup("saffron-table", 50, 200_000, "UTR402611873311"); credit("saffron-table", 50, "promo", 10_000, "Launch offer: first top-up");
  fees("saffron-table", 300, 49.5, 21); topup("saffron-table", 20, 100_000, "UTR402930017442"); fees("saffron-table", 120, 19.5, 0.05);
  const lastSaffron = evs.filter((e) => e.kind === "bill_fee" && e.t === T_("saffron-table").id).at(-1)!;
  evs.push({ ...lastSaffron, mins: lastSaffron.mins - 3, kind: "void_credit_back", amount: 500, idem: `void:${lastSaffron.extra!.ref_id}` });
  credit("saffron-table", 0.02, "adjustment", -2_500, "Launch promo was credited twice; reversing the duplicate");
  credit("dosa-junction", 3, "promo", 20_000, "Welcome credit agreed by sales", "admin@chilli.test");
  const rb = topup("biryani-bazaar", 31, 150_000, "UTR402518220190");
  evs.push({ t: T_("biryani-bazaar").id, mins: 31 * D - 0.5, kind: "promo", amount: 2_500, idem: `bonus:${rb}`, extra: { source: "promo", actor: "system:bonus_tier", ref_type: "receipt", ref_id: rb, reason: "Top-up bonus for ₹1500.00" } });
  c.receipts.at(-1)!.bonus_paise = 2_500;
  fees("biryani-bazaar", 293, 30.5, 0.1);
  topup("cafe-monsoon", 44, 50_000, "CASH-SLIP-0193"); fees("cafe-monsoon", 110, 43.5, 13);
  c.tenantSettings[T_("tandoor-tales").id] = { per_bill_paise: 400 };
  topup("tandoor-tales", 26, 500_000, "UTR402713390055"); credit("tandoor-tales", 22, "promo", 1_200, "Goodwill after printer outage (ticket)"); fees("tandoor-tales", 200, 25.5, 0.2, 400);
  topup("old-harbour-grill", 104, 30_000, "UTR401920048812"); fees("old-harbour-grill", 32, 103, 60);

  evs.sort((a, b) => b.mins - a.mins);
  for (const e of evs) {
    const w = c.wallets[e.t]; w.balance_paise += e.amount;
    const row = { id: ++c.seq.ledger, tenant_id: e.t, kind: e.kind, amount_paise: e.amount, balance_after_paise: w.balance_paise, source: "admin", ref_type: null, ref_id: null, fee_base_paise: null, fee_gst_paise: null, reason: null, actor: "system", meta: null, at: ago(e.mins), idem_key: e.idem, ...e.extra };
    c.ledger.push(row);
    const rec = row.ref_type === "receipt" && e.kind === "topup" ? c.receipts.find((r) => r.id === row.ref_id) : undefined;
    if (rec) rec.ledger_id = row.id;
    w.updated_at = row.at;
  }
  return c;
}

// ------------------------------------------------------------------ settings + view
export function effectiveSettings(c: CreditStore, tenantId: string, planId: string | null): T.EffectiveBillingSettings {
  const vals = { ...BILLING_DEFAULTS } as Record<T.BillingSettingKey, unknown>;
  const sources = Object.fromEntries(FIELDS.map((f) => [f, "default"])) as Record<T.BillingSettingKey, T.SettingSource>;
  for (const [scope, row] of [["plan", planId ? c.planSettings[planId] : undefined], ["tenant", c.tenantSettings[tenantId]]] as const) {
    if (!row) continue;
    for (const f of FIELDS) if (row[f] !== undefined && row[f] !== null) { vals[f] = row[f]; sources[f] = scope; }
  }
  const eff = vals as unknown as T.BillingSettingsValues;
  return { ...eff, sources, debit_per_bill_paise: feeSplit(eff.per_bill_paise, eff.fee_gst_mode)[0] };
}

const BANNERS: Record<string, [T.BillingBanner["level"], string]> = {
  trial: ["info", "Free trial: {days} day(s) left. After that each bill costs {fee} from your credit."],
  trial_ending: ["warning", "Free trial ends in {days} day(s). Top up credit to keep billing ({fee} per bill)."],
  low: ["warning", "Low credit: {balance} left (about {bills} bills). Top up to keep billing."],
  grace: ["critical", "Credit used up: {bills} more bill(s) allowed on grace. Top up credit now."],
  empty: ["critical", "Credit exhausted. Top up credit to continue billing."],
  suspended: ["critical", "Billing is paused by Chilli support. Please contact support."],
};

export function billingView(w: T.WalletRow, eff: T.EffectiveBillingSettings, nowMs = Date.now()): T.BillingBlock {
  const p = project({ balance_paise: w.balance_paise, trial_ends_at: w.trial_ends_at, suspended: !!w.suspended_at }, eff, nowMs);
  const metered = eff.billing_model === "payg";
  const days_left = metered ? Math.max(0, Math.ceil((Date.parse(w.trial_ends_at) - nowMs) / DAY_MS)) : 0;
  const key = p.state === "trial" && days_left <= 3 ? "trial_ending" : p.state === "low" && p.in_grace ? "grace" : p.state;
  let banner: T.BillingBanner | null = null;
  if (metered && BANNERS[key]) {
    const about = p.debit_paise ? Math.max(0, Math.floor(w.balance_paise / p.debit_paise)) : 0;
    const fmt: Record<string, string> = { days: String(days_left), fee: rs(p.debit_paise), balance: rs(w.balance_paise), bills: String(key === "low" ? about : p.bills_left ?? 0) };
    banner = { level: BANNERS[key][0], code: key, message: { en: BANNERS[key][1].replace(/\{(\w+)\}/g, (_, k: string) => fmt[k]) } };
  }
  return {
    state: p.state, model: eff.billing_model, trial_ends_at: w.trial_ends_at, days_left, balance_paise: w.balance_paise, per_bill_paise: p.debit_paise,
    fee_gst_mode: eff.fee_gst_mode, charge_zero_bills: eff.charge_zero_bills, low_balance_paise: eff.low_balance_paise, grace_paise: eff.grace_paise,
    min_topup_paise: eff.min_topup_paise, bonus_tiers: eff.bonus_tiers, can_bill: p.state !== "empty" && p.state !== "suspended", in_grace: p.in_grace,
    bills_left: p.bills_left, suspended_reason: p.state === "suspended" ? w.suspended_reason : null, banner, topup_online: false,
  };
}

const outRow = (r: CreditStore["ledger"][number]): T.LedgerRow => { const { idem_key: _drop, ...rest } = r; void _drop; return rest; };

/** Lazily creates the wallet like ensure_wallet(): trial from the tenant's creation. */
function ensureWallet(c: CreditStore, t: Tenant, eff: T.EffectiveBillingSettings): T.WalletRow {
  return (c.wallets[t.id] ??= { tenant_id: t.id, balance_paise: 0, trial_started_at: t.created_at, trial_ends_at: new Date(Date.parse(t.created_at) + eff.trial_days * DAY_MS).toISOString(), suspended_at: null, suspended_reason: null, last_state: null, created_at: t.created_at, updated_at: t.created_at });
}

export interface CreditCtx { c: CreditStore; t: Tenant; planId: string | null; actor: string; audit: (action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, meta: Record<string, unknown> | null) => void }
const ctxEff = (x: CreditCtx) => effectiveSettings(x.c, x.t.id, x.planId);

export function adminWallet(x: CreditCtx): T.AdminWallet {
  const eff = ctxEff(x); const w = ensureWallet(x.c, x.t, eff);
  const recent = x.c.ledger.filter((r) => r.tenant_id === x.t.id).slice(-20).reverse().map(outRow);
  return { tenant_id: x.t.id, tenant: x.t.display_name, slug: x.t.slug, billing: billingView(w, eff), wallet: { ...w, last_state: billingView(w, eff).state }, settings: eff, recent_ledger: recent };
}

const istMs = (d: string) => Date.parse(`${d}T00:00:00${TZ_OFFSET}`);
export function ledgerPage(x: CreditCtx, q: URLSearchParams): T.Page<T.LedgerRow> | Res {
  const from = q.get("from"), to = q.get("to"), kind = q.get("kind");
  for (const d of [from, to]) if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(istMs(d)))) return err(422, "validation_error", "Invalid request");
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200), offset = Math.max(Number(q.get("offset")) || 0, 0);
  if (Number(q.get("limit")) > 200) return err(422, "validation_error", "Invalid request");
  const lo = from ? istMs(from) : -Infinity, hi = to ? istMs(to) + DAY_MS : Infinity;
  const rows = x.c.ledger.filter((r) => r.tenant_id === x.t.id && (!kind || r.kind === kind) && Date.parse(r.at) >= lo && Date.parse(r.at) < hi).reverse();
  return { items: rows.slice(offset, offset + limit).map(outRow), total: rows.length, limit, offset };
}

function post(x: CreditCtx, w: T.WalletRow, kind: T.LedgerKind, amount: number, idem: string, extra: Partial<T.LedgerRow>) {
  w.balance_paise += amount; w.updated_at = new Date().toISOString();
  const row = { id: ++x.c.seq.ledger, tenant_id: x.t.id, kind, amount_paise: amount, balance_after_paise: w.balance_paise, source: "admin", ref_type: null, ref_id: null, fee_base_paise: null, fee_gst_paise: null, reason: null, actor: x.actor, meta: null, at: w.updated_at, idem_key: idem, ...extra };
  x.c.ledger.push(row);
  return row;
}

/** POST /admin/tenants/{t}/wallet/adjust (platform-core svc.adjust + AdjustIn validation). */
export function adjust(x: CreditCtx, body: Record<string, unknown>, idemKey: string | undefined): Res {
  if (!idemKey || idemKey.length < 8 || idemKey.length > 100) return err(422, "validation_error", "Invalid request");
  const kind = body.kind, amount = body.amount_paise, reason = typeof body.reason === "string" ? body.reason : "";
  const payRef = typeof body.payment_ref === "string" && body.payment_ref ? body.payment_ref : null;
  if (!["topup", "promo", "adjustment"].includes(kind as string) || typeof amount !== "number" || !Number.isInteger(amount) || Math.abs(amount) > MAX_ADJUST_PAISE || reason.length < 3 || reason.length > 500 || (payRef && payRef.length > 100)) return err(422, "validation_error", "Invalid request");
  const eff = ctxEff(x); const w = ensureWallet(x.c, x.t, eff);
  const key = `adm:${idemKey}`;
  const prior = x.c.ledger.find((r) => r.tenant_id === x.t.id && r.idem_key === key);
  if (prior) {
    if (prior.kind !== kind || prior.amount_paise !== amount) return err(409, "idempotency_key_reused", "This Idempotency-Key was used for a different adjustment");
    return { status: 200, body: { replayed: true, ledger: outRow(prior), receipt: x.c.receipts.find((r) => r.ledger_id === prior.id) ?? null, billing: billingView(w, eff) } };
  }
  if ((kind === "topup" || kind === "promo") && amount <= 0) return err(400, "invalid_amount", `A ${kind} must be a positive amount`);
  if (amount === 0) return err(400, "invalid_amount", "Amount must not be zero");
  if (amount < 0 && w.balance_paise + amount < 0 && body.allow_negative !== true) return err(409, "would_go_negative", `This would take the balance to ${rs(w.balance_paise + amount)}; pass allow_negative to confirm`);
  const before = w.balance_paise;
  let receipt: CreditStore["receipts"][number] | null = null, row;
  if (kind === "topup") {
    const rid = crypto.randomUUID(); const bonus = bonusFor(eff.bonus_tiers, amount);
    row = post(x, w, "topup", amount, key, { source: "admin", ref_type: "receipt", ref_id: rid, reason, meta: payRef ? { payment_ref: payRef } : null });
    receipt = { id: rid, number: `CR/2627/${String(++x.c.seq.receipt).padStart(6, "0")}`, tenant_id: x.t.id, ledger_id: row.id, amount_paise: amount, bonus_paise: bonus, payment_ref: payRef, created_at: row.at, tax_notice: "GST fields are placeholders computed from configuration and must be verified by a Chartered Accountant." };
    x.c.receipts.push(receipt);
    if (bonus > 0) post(x, w, "promo", bonus, `bonus:${rid}`, { source: "promo", actor: "system:bonus_tier", ref_type: "receipt", ref_id: rid, reason: `Top-up bonus for ${rs(amount)}` });
  } else {
    row = post(x, w, kind as T.LedgerKind, amount, key, { source: kind === "promo" ? "promo" : "admin", ref_type: "op", ref_id: idemKey.slice(0, 64), reason, meta: payRef ? { payment_ref: payRef } : null });
  }
  x.audit(`wallet.${kind as string}`, { balance_paise: before }, { balance_paise: w.balance_paise }, { amount_paise: amount, reason, payment_ref: payRef, receipt: receipt?.number ?? null, ledger_id: row.id });
  return { status: 201, body: { replayed: false, ledger: outRow(row), receipt, billing: billingView(w, eff) } };
}

export function setSuspended(x: CreditCtx, suspended: boolean, reason: unknown): Res {
  if (typeof reason !== "string" || reason.length < 3 || reason.length > 500) return err(422, "validation_error", "Invalid request");
  const eff = ctxEff(x); const w = ensureWallet(x.c, x.t, eff);
  if (suspended) { if (!w.suspended_at) { w.suspended_at = new Date().toISOString(); w.suspended_reason = reason; } } else { w.suspended_at = null; w.suspended_reason = null; }
  x.audit(suspended ? "wallet.suspended" : "wallet.resumed", null, null, { reason });
  return { status: 200, body: { billing: billingView(w, eff) } };
}

const overrideView = (row: CreditStore["tenantSettings"][string] | undefined) => Object.fromEntries(FIELDS.map((f) => [f, row?.[f] ?? null])) as Record<T.BillingSettingKey, unknown>;
export function getSettings(x: CreditCtx): T.TenantBillingSettings {
  const eff = ctxEff(x); const w = ensureWallet(x.c, x.t, eff);
  return { override: overrideView(x.c.tenantSettings[x.t.id]), effective: eff, defaults: { ...BILLING_DEFAULTS }, trial_started_at: w.trial_started_at, trial_ends_at: w.trial_ends_at };
}

const BOUNDS: Partial<Record<T.BillingSettingKey, [number, number]>> = { trial_days: [0, MAX_TRIAL_DAYS], per_bill_paise: [0, MAX_PER_BILL_PAISE], low_balance_paise: [0, 1e9], grace_paise: [0, MAX_GRACE_PAISE], min_topup_paise: [0, 1e9] };
/** PUT /admin/tenants/{t}/billing-settings: only sent fields change, null clears; trial_days moves the trial end. */
export function putSettings(x: CreditCtx, body: Record<string, unknown>): Res {
  const reason = body.reason;
  if (typeof reason !== "string" || reason.length < 3 || reason.length > 500) return err(422, "validation_error", "Invalid request");
  const values: Partial<Record<T.BillingSettingKey, unknown>> = {};
  for (const f of FIELDS) {
    if (!(f in body)) continue;
    const v = body[f];
    if (v !== null) {
      const b = BOUNDS[f];
      if (b && (typeof v !== "number" || !Number.isInteger(v) || v < b[0] || v > b[1])) return err(422, "validation_error", "Invalid request");
      if (f === "billing_model" && v !== "payg" && v !== "subscription") return err(422, "validation_error", "Invalid request");
      if (f === "fee_gst_mode" && v !== "inclusive" && v !== "exclusive") return err(422, "validation_error", "Invalid request");
      if (f === "charge_zero_bills" && typeof v !== "boolean") return err(422, "validation_error", "Invalid request");
    }
    values[f] = v;
  }
  const before = overrideView(x.c.tenantSettings[x.t.id]);
  const row = (x.c.tenantSettings[x.t.id] ??= {});
  for (const [f, v] of Object.entries(values)) row[f as T.BillingSettingKey] = v;
  const eff = ctxEff(x); const w = ensureWallet(x.c, x.t, eff);
  if ("trial_days" in values) w.trial_ends_at = new Date(Date.parse(w.trial_started_at) + eff.trial_days * DAY_MS).toISOString();
  x.audit("billing_settings.tenant_updated", before, overrideView(row), { reason });
  return { status: 200, body: { ...getSettings(x), trial_ends_at: w.trial_ends_at } };
}

/** GET /admin/tenants/{t}/usage?month&format: the statement; CSV = opening row, the month's lines, closing row. */
export function statement(x: CreditCtx, q: URLSearchParams, csvCell: (v: unknown) => string): Res {
  const month = q.get("month") ?? new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return err(422, "validation_error", "Invalid request");
  const [y, m] = month.split("-").map(Number);
  if (m < 1 || m > 12) return err(400, "invalid_month", "month must be YYYY-MM");
  const start = istMs(`${month}-01`), end = istMs(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`);
  const all = x.c.ledger.filter((r) => r.tenant_id === x.t.id);
  const before = all.filter((r) => Date.parse(r.at) < start).at(-1)?.balance_after_paise ?? 0;
  const rows = all.filter((r) => Date.parse(r.at) >= start && Date.parse(r.at) < end);
  const sum = (k: T.LedgerKind) => rows.filter((r) => r.kind === k).reduce((a, r) => a + r.amount_paise, 0);
  const closing = rows.at(-1)?.balance_after_paise ?? before;
  const fees = -sum("bill_fee"), backs = sum("void_credit_back");
  const body = {
    tenant_id: x.t.id, tenant: x.t.display_name, month, timezone: "Asia/Kolkata", period_start: new Date(start).toISOString(), period_end: new Date(end).toISOString(),
    opening_balance_paise: before, closing_balance_paise: closing,
    bills: { reported: rows.filter((r) => r.kind === "bill_fee").length, charged: rows.filter((r) => r.kind === "bill_fee").length, free_trial: 0, zero_total: 0, voided: rows.filter((r) => r.kind === "void_credit_back").length, credited_back: rows.filter((r) => r.kind === "void_credit_back").length },
    fees_paise: fees, fee_credit_backs_paise: backs, net_fees_paise: fees - backs,
    gst_in_net_fees_paise: rows.filter((r) => r.kind === "bill_fee").reduce((a, r) => a + (r.fee_gst_paise ?? 0), 0) - rows.filter((r) => r.kind === "void_credit_back").reduce((a, r) => a + (r.fee_gst_paise ?? 0), 0),
    topups_paise: sum("topup"), promo_paise: sum("promo"), adjustments_paise: sum("adjustment"),
    receipts: x.c.receipts.filter((r) => r.tenant_id === x.t.id && Date.parse(r.created_at) >= start && Date.parse(r.created_at) < end).map((r) => ({ id: r.id, number: r.number, amount_paise: r.amount_paise, bonus_paise: r.bonus_paise, created_at: r.created_at })),
    tax_notice: "GST fields are placeholders computed from configuration and must be verified by a Chartered Accountant.",
  };
  if (q.get("format") !== "csv") return { status: 200, body };
  const ist = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  const lines: unknown[][] = [["at", "kind", "reference", "detail", "amount_paise", "balance_after_paise"], ["", "opening_balance", "", "", "", before],
    ...rows.map((r) => [ist(r.at), r.kind, r.ref_id ?? "", (r.meta?.invoice_number as string | undefined) ?? r.reason ?? "", r.amount_paise, r.balance_after_paise]),
    ["", "closing_balance", "", "", "", closing]];
  return { status: 200, body: lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n", contentType: "text/csv; charset=utf-8" };
}

/** GET /admin/billing/usage?month&format: every business with a wallet, one statement summary each (CSV: one row each). */
export function allUsage(c: CreditStore, tenants: Tenant[], q: URLSearchParams, csvCell: (v: unknown) => string, ctx: (t: Tenant) => CreditCtx): Res {
  const withWallet = tenants.filter((t) => c.wallets[t.id]).sort((a, b) => a.slug.localeCompare(b.slug));
  const items: Record<string, unknown>[] = [];
  for (const t of withWallet) {
    const r = statement(ctx(t), new URLSearchParams(q.get("month") ? { month: q.get("month")! } : {}), csvCell);
    if (r.status !== 200) return r;
    items.push(r.body as Record<string, unknown>);
  }
  const month = (items[0]?.month as string | undefined) ?? q.get("month") ?? new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
  if (q.get("format") !== "csv") return { status: 200, body: { month, items } };
  const head = ["tenant_slug", "tenant", "month", "opening_balance_paise", "bills_reported", "bills_charged", "bills_free_trial", "fees_paise", "fee_credit_backs_paise",
    "net_fees_paise", "gst_in_net_fees_paise", "topups_paise", "promo_paise", "adjustments_paise", "closing_balance_paise"];
  const rows = items.map((s, i) => { const b = s.bills as Record<string, number>; return [withWallet[i].slug, s.tenant, month, s.opening_balance_paise, b.reported, b.charged, b.free_trial, s.fees_paise, s.fee_credit_backs_paise, s.net_fees_paise, s.gst_in_net_fees_paise, s.topups_paise, s.promo_paise, s.adjustments_paise, s.closing_balance_paise]; });
  return { status: 200, body: [head, ...rows].map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n", contentType: "text/csv; charset=utf-8" };
}

/** GET /admin/tenants/{t}/receipts: top-up receipts, newest first, with the (CA-unverified) GST split platform-core stores. */
export function receiptsPage(x: CreditCtx, q: URLSearchParams): T.Page<T.WalletReceiptRow> {
  const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50) || 50)), offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
  const all = x.c.receipts.filter((r) => r.tenant_id === x.t.id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((r): T.WalletReceiptRow => {
    const taxable = Math.round((r.amount_paise * 10_000) / 11_800);
    return { ...r, source: "admin", gst_mode: "inclusive", taxable_paise: taxable, gst_rate_bps: 1800, cgst_paise: Math.floor((r.amount_paise - taxable) / 2), sgst_paise: r.amount_paise - taxable - Math.floor((r.amount_paise - taxable) / 2),
      igst_paise: 0, sac_code: "998314", supplier_gstin: null, supplier_state_code: "29", buyer_gstin: null, buyer_state_code: "29", tax_needs_ca_verification: true, note: null, created_by: "finance@chilli.test" };
  });
  return { items: all.slice(offset, offset + limit), total: all.length, limit, offset };
}
