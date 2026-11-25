/**
 * Client-side GST estimate: a PURE mirror of the server engine (apps/api/app/services/tax.py `compute_invoice`).
 * No React, no `@/` aliases (imported directly by the Playwright agreement tests). All arithmetic is BigInt on
 * integer paise: never floats.
 *
 * Same rules as the server:
 *   1. line amount = round_half_up(unit_price * quantity)            (the menu amount: gross if prices include GST)
 *   2. discount (percent of the item total, or a fixed amount) is spread over the item lines with the
 *      largest-remainder method (ties by index) BEFORE GST is derived
 *   3. service charge = round_half_up(post-discount items * pct / 100); eat-in only; joins the standard-rated group
 *   4. lines (and the service charge) are grouped by tax code; GST is rounded ONCE per group:
 *        inclusive: vat = round(gross * r / (100 + r)); net = gross - vat
 *        exclusive: vat = round(net * r / 100);          gross = net + vat
 *      each group's GST is spread back over its lines with the same largest-remainder method
 *   5. subtotal = sum(net) (excl. GST), tax_amount = sum(vat), total = sum(gross) (what the customer pays)
 * The server recomputes everything at finalisation; this is only for live totals and offline provisional receipts.
 */

export type TaxKind = "hot_food" | "cold_food" | "standard";
export type TaxCode = "standard" | "zero" | "none";

export interface EstimateConfig {
  country: string;
  currency: string;
  prices_include_tax: boolean;
  vat_registered: boolean;
  service_charge_percent: string;
  rates: { code: string; rate_percent: string }[];
  rules: { eat_in: string; takeaway: Record<string, string>; eat_in_order_types: string[] };
}

export interface EstimateLineIn {
  description: string;
  quantity: number;
  unit_price: string;
  tax_kind?: TaxKind | string | null;
  item_id?: string | null;
}

export interface DiscountInput { type: "percent" | "amount"; value: string; reason: string }

export interface EstimateLine {
  description: string; quantity: number; unit_price: string;
  line_total: string; discount: string; gross: string; net: string; vat: string;
  tax_code: string; rate_percent: string; item_id?: string | null;
}
export interface EstimateBreakdownRow { code: string; rate_percent: string; net: string; vat: string; gross: string }
export interface EstimateInvoice {
  lines: EstimateLine[];
  discount_amount: string; discount_reason: string | null;
  service_charge_amount: string; service_charge_percent: string; service_charge: EstimateLine | null;
  subtotal: string; tax_amount: string; total: string;
  tax_breakdown: EstimateBreakdownRow[];
  currency: string; prices_include_tax: boolean; vat_registered: boolean; country: string;
}

export class EstimateError extends Error {}

// ---------------------------------------------------------------- decimal <-> BigInt paise
/** Decimal string -> value scaled by 10^scale, rounded half up (non-negative values; sign handled). */
function scaled(v: string | number, scale: number): bigint {
  const s = String(v).trim().replace(/,/g, "");
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) throw new EstimateError(`Invalid number: ${s}`);
  const frac = m[3] ?? "";
  const keep = frac.slice(0, scale).padEnd(scale, "0");
  let n = BigInt((m[2] || "0") + keep);
  if (frac.length > scale && frac.charCodeAt(scale) >= 53) n += 1n; // round half up on the first dropped digit
  return m[1] ? -n : n;
}
const paise = (v: string | number) => scaled(v, 2);
function fmt(c: bigint): string {
  const neg = c < 0n;
  const s = (neg ? -c : c).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}
/** round_half_up(n / d) for n >= 0, d > 0. */
const divRound = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);

/** Python `allocate`: split `total` paise proportionally to `weights`; shares add up exactly (largest remainder, ties by index). */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const n = weights.length;
  const wsum = weights.reduce((a, b) => a + b, 0n);
  if (n === 0 || total === 0n || wsum === 0n) return weights.map(() => 0n);
  const floors = weights.map((w) => (total * w) / wsum);
  const rems = weights.map((w) => (total * w) % wsum);
  let left = total - floors.reduce((a, b) => a + b, 0n);
  const order = weights.map((_, i) => i).sort((a, b) => (rems[a] === rems[b] ? a - b : rems[a] > rems[b] ? -1 : 1));
  for (const i of order) { if (left <= 0n) break; floors[i] += 1n; left -= 1n; }
  return floors;
}

// ---------------------------------------------------------------- rules
const CODE_ORDER: Record<string, number> = { standard: 0, zero: 1, none: 2 };

/** True when the order type is consumed on the premises. */
export function isEatIn(orderType: string, config: Pick<EstimateConfig, "rules">): boolean {
  return (config.rules.eat_in_order_types ?? ["indoor", "outdoor"]).includes(orderType);
}

/** Tax code of one line (mirrors tax.line_tax_code). */
export function lineTaxCode(config: EstimateConfig, orderType: string, taxKind?: string | null): TaxCode {
  if (!config.vat_registered) return "none";
  if (isEatIn(orderType, config)) return (config.rules.eat_in.replace(/^all\s+/, "") || "standard") as TaxCode;
  return (config.rules.takeaway[taxKind || "standard"] ?? "standard") as TaxCode;
}

/** The configured service-charge percent when it applies to this order type, else "0". */
export function serviceChargePercentFor(config: EstimateConfig, orderType: string): string {
  return isEatIn(orderType, config) ? config.service_charge_percent || "0" : "0";
}

export function validateDiscount(d: DiscountInput): DiscountInput {
  if (d.type !== "percent" && d.type !== "amount") throw new EstimateError("Discount type must be 'percent' or 'amount'");
  if (scaled(d.value, 2) <= 0n) throw new EstimateError("Discount value must be positive");
  if (d.type === "percent" && scaled(d.value, 2) > 10000n) throw new EstimateError("Discount cannot exceed 100%");
  // The reason is optional (server: empty = the label "Discount"); when given it must be 3-200 characters.
  const given = (d.reason ?? "").trim();
  if (given.length > 0 && (given.length < 3 || given.length > 200)) throw new EstimateError("Discount reason must be 3-200 characters");
  const reason = given || "Discount";
  return { type: d.type, value: d.value, reason };
}

/** Discount as a percentage of the item total (used for the cashier limit), as a decimal string with 2 places. */
export function discountPercentOf(d: Pick<DiscountInput, "type" | "value">, itemTotal: string): string {
  if (d.type === "percent") return fmt(scaled(d.value, 2));
  const base = paise(itemTotal);
  return base > 0n ? fmt(divRound(paise(d.value) * 10000n, base)) : "0.00";
}

/** Sum of the line amounts (round_half_up(unit * qty)), i.e. the "items" subtotal before any discount. */
export function itemTotal(lines: Pick<EstimateLineIn, "quantity" | "unit_price">[]): string {
  return fmt(lines.reduce((a, l) => a + paise(mulExact(l.unit_price, l.quantity)), 0n));
}
/** unit * quantity as an exact decimal string. */
function mulExact(unit: string, qty: number): string {
  const u = scaled(unit, 6); // exact for any API price (<= 2 dp)
  const p = u * BigInt(Math.round(qty));
  const s = p.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

// ---------------------------------------------------------------- the engine
export function computeInvoice(
  lines: EstimateLineIn[], config: EstimateConfig, orderType: string,
  discount: DiscountInput | null = null, serviceChargeOn = true,
): EstimateInvoice {
  const inclusive = config.prices_include_tax;
  const registered = config.vat_registered;
  const rateOf = (code: string): bigint => { // percent in hundredths
    if (code === "none") return 0n;
    const r = config.rates.find((x) => x.code === code);
    if (!r) throw new EstimateError(`No GST rate configured for code '${code}'`);
    return scaled(r.rate_percent, 2);
  };

  const codes = lines.map((l) => lineTaxCode(config, orderType, l.tax_kind));
  const amounts = lines.map((l) => paise(mulExact(l.unit_price, l.quantity)));
  const base = amounts.reduce((a, b) => a + b, 0n);

  // 1. discount
  let discTotal = 0n;
  let reason: string | null = null;
  let shares = lines.map(() => 0n);
  if (discount) {
    const d = validateDiscount(discount);
    discTotal = d.type === "percent" ? divRound(base * scaled(d.value, 2), 10000n) : paise(d.value);
    if (discTotal > base) throw new EstimateError("Discount cannot exceed the bill total");
    shares = allocate(discTotal, amounts);
    reason = d.reason;
  }
  const after = amounts.map((a, i) => a - shares[i]);

  // 2. service charge (eat-in only; the caller's toggle can remove it for this bill)
  const scPct = serviceChargeOn ? scaled(serviceChargePercentFor(config, orderType), 2) : 0n;
  const afterSum = after.reduce((a, b) => a + b, 0n);
  const scAmount = scPct > 0n ? divRound(afterSum * scPct, 10000n) : 0n;
  const scCode: TaxCode = registered ? "standard" : "none";

  // 3. group by tax code
  const entries: { code: string; amount: bigint }[] = lines.map((_, i) => ({ code: codes[i], amount: after[i] }));
  let scIndex = -1;
  if (scAmount > 0n) { scIndex = entries.length; entries.push({ code: scCode, amount: scAmount }); }
  const groups = new Map<string, number[]>();
  entries.forEach((e, i) => groups.set(e.code, [...(groups.get(e.code) ?? []), i]));

  const net = entries.map(() => 0n);
  const vat = entries.map(() => 0n);
  const breakdown: EstimateBreakdownRow[] = [];
  const orderedCodes = [...groups.keys()].sort((a, b) => (CODE_ORDER[a] ?? 9) - (CODE_ORDER[b] ?? 9) || (a < b ? -1 : a > b ? 1 : 0));
  for (const code of orderedCodes) {
    const idx = groups.get(code)!;
    const rate = rateOf(code);
    const amts = idx.map((i) => entries[i].amount);
    const total = amts.reduce((a, b) => a + b, 0n);
    let gVat: bigint, gNet: bigint, gGross: bigint;
    if (inclusive) { gVat = divRound(total * rate, 10000n + rate); gNet = total - gVat; gGross = total; }
    else { gVat = divRound(total * rate, 10000n); gNet = total; gGross = total + gVat; }
    const vats = allocate(gVat, amts);
    idx.forEach((i, k) => { vat[i] = vats[k]; net[i] = inclusive ? amts[k] - vats[k] : amts[k]; });
    breakdown.push({ code, rate_percent: fmt(rate), net: fmt(gNet), vat: fmt(gVat), gross: fmt(gGross) });
  }

  const outLine = (i: number, description: string, quantity: number, unit: string, shown: bigint, disc: bigint, item_id?: string | null): EstimateLine => ({
    description, quantity, unit_price: unit, line_total: fmt(shown), discount: fmt(disc),
    gross: fmt(net[i] + vat[i]), net: fmt(net[i]), vat: fmt(vat[i]), tax_code: entries[i].code,
    rate_percent: fmt(rateOf(entries[i].code)), item_id: item_id ?? null,
  });
  const out = lines.map((l, i) => outLine(i, l.description, l.quantity, fmt(paise(l.unit_price)), amounts[i], shares[i], l.item_id));
  const scLine = scIndex >= 0 ? outLine(scIndex, "Service charge", 1, fmt(scAmount), scAmount, 0n) : null;
  const sum = (k: "net" | "vat" | "gross") => breakdown.reduce((a, b) => a + paise(b[k]), 0n);
  return {
    lines: out,
    discount_amount: fmt(discTotal), discount_reason: reason,
    service_charge_amount: fmt(scAmount), service_charge_percent: scAmount > 0n ? fmt(scPct) : "0.00", service_charge: scLine,
    subtotal: fmt(sum("net")), tax_amount: fmt(sum("vat")), total: fmt(sum("gross")),
    tax_breakdown: breakdown,
    currency: config.currency, prices_include_tax: inclusive, vat_registered: registered, country: config.country,
  };
}

/** Never throws: null when the config cannot price the lines (missing rate, bad discount). */
export function tryComputeInvoice(...args: Parameters<typeof computeInvoice>): { invoice: EstimateInvoice | null; error: string | null } {
  try { return { invoice: computeInvoice(...args), error: null }; }
  catch (e) { return { invoice: null, error: e instanceof Error ? e.message : "Could not estimate" }; }
}
