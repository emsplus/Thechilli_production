/**
 * Management (MIS) reports: GST summary, payments, period sales, item ranking, outlet comparison, CSV.
 * Real contract: pos-service docs/REPORTS.md (branch phase2/reports). All under /reports, permission reports.view,
 * inclusive local dates `from`/`to`, money as exact decimal strings, optional `outlet_id`.
 * Servers without these endpoints answer 404/405/501: callers hide the section (see isMissing).
 */
import { ApiError, apiRequest, authedFetch, errorFrom } from "./api";

export interface MisMeta { from_date?: string; to_date?: string; currency?: string; timezone?: string }

export interface GstRate { code: string; rate_percent: string; taxable_value: string; tax: string; cgst: string | null; sgst: string | null; igst: string | null; gross: string }
export interface GstSummary extends MisMeta {
  tax_label?: string; by_rate: GstRate[]; split_available: boolean; note?: string;
  totals: { taxable_value: string; tax: string; gross: string; bills: number; credit_note_tax: string; credit_note_taxable_value: string; net_tax: string };
  /** GST paid on confirmed purchase invoices and expenses (input tax). Newer servers only: optional. */
  input_tax?: { purchases: string; expenses: string; total: string; invoices_missing_tax?: number } | null;
  /** Output GST after credit notes minus input tax; negative = more paid than collected. Newer servers only: optional. */
  net_payable?: string | null;
  warnings?: string[];
}

export interface PaymentMethodRow { method: string; payments: number; amount: string; share_percent: string | null }
export interface CashierRow { user_id: string; name: string; payments: number; total: string; by_method: Record<string, string>; refunds_count: number; refunds: string; net_collected: string }
export interface PaymentsReport extends MisMeta {
  by_method: PaymentMethodRow[]; by_cashier: CashierRow[];
  totals: { collected: string; refunds: string; net_collected: string; credit_note_transfers: string };
  voided: { orders: number; value: string }; unpaid: { bills: number; balance: string }; note?: string;
}

export interface PeriodRow { period: string; bills: number; subtotal: string; tax: string; gross_total: string; discounts: string; service_charge: string; refunds: string; net_total: string; average_bill: string }
export interface SalesSummary extends MisMeta {
  group_by: "day" | "month"; periods: PeriodRow[];
  totals: { bills: number; subtotal: string; tax: string; gross_total: string; discounts: string; service_charge: string; refunds: string; net_total: string; average_bill: string };
}

export interface RankedItem { rank: number; item: string; quantity: number; revenue_excl_tax: string }
export interface ItemRanking extends MisMeta { direction: "top" | "bottom"; by: "revenue" | "quantity"; limit: number; offset: number; total_items: number; items: RankedItem[] }

export interface OutletRow { outlet_id: string; outlet: string; code: string; currency: string; timezone: string; bills: number; gross_total: string; refunds: string; net_total: string; average_bill: string; discounts: string; discount_percent: string | null; refund_percent: string | null; rank: number }
export interface OutletComparison extends MisMeta { outlets: OutletRow[]; totals: { bills: number; gross_total: string; refunds: string; net_total: string; discounts: string } | null }

export interface OutletOption { id: string; name: string; is_active: boolean }

export type CsvKind = "daily_sales" | "item_sales" | "category_sales" | "gst_summary" | "payments_by_method" | "payments_by_cashier" | "daily_summary" | "monthly_summary" | "top_items" | "bottom_items" | "outlet_comparison";

export interface Scope { from: string; to: string; outletId?: string }

/** A server that does not have the report (older build, plan without it): hide the section instead of showing an error. */
export function isMissing(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);
}

/** Query string for a report: `from`/`to` always, `outlet_id` only for one outlet (empty = every outlet the user can see). */
export function reportQuery(s: Scope, extra: Record<string, string | number | undefined> = {}): string {
  const p = new URLSearchParams({ from: s.from, to: s.to });
  if (s.outletId) p.set("outlet_id", s.outletId);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") p.set(k, String(v));
  return `?${p.toString()}`;
}

/** Display name of a stored payment method ("upi" -> "UPI"); unknown values are shown as stored, title-cased. */
export function methodLabel(method: string): string {
  const m = method.toLowerCase();
  if (m === "upi") return "UPI";
  if (m === "cash" || m === "card" || m === "other") return m[0].toUpperCase() + m.slice(1);
  return method.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Methods that appear in any cashier's row, in the order of the overall method totals (so columns line up with the method table). */
export function cashierMethods(r: Pick<PaymentsReport, "by_method" | "by_cashier">): string[] {
  const order = r.by_method.map((m) => m.method);
  const extra = new Set<string>();
  for (const c of r.by_cashier) for (const m of Object.keys(c.by_method)) if (!order.includes(m)) extra.add(m);
  return [...order, ...[...extra].sort()];
}

export const misApi = {
  gst: (s: Scope) => apiRequest<GstSummary>(`/reports/gst-summary${reportQuery(s)}`),
  payments: (s: Scope) => apiRequest<PaymentsReport>(`/reports/payments${reportQuery(s)}`),
  sales: (s: Scope, groupBy: "day" | "month") => apiRequest<SalesSummary>(`/reports/sales-summary${reportQuery(s, { group_by: groupBy })}`),
  items: (s: Scope, direction: "top" | "bottom", by: "revenue" | "quantity", limit = 10) =>
    apiRequest<ItemRanking>(`/reports/top-items${reportQuery(s, { direction, by, limit })}`),
  outlets: (s: Scope) => apiRequest<OutletComparison>(`/reports/outlet-comparison${reportQuery(s)}`),
  /** Active outlets for the filter. Any signed-in user may read them; a failure just hides the filter. */
  async outletOptions(): Promise<OutletOption[]> {
    const rows = await apiRequest<OutletOption[]>("/outlets?include_inactive=false");
    return rows.filter((o) => o.is_active !== false).map((o) => ({ id: o.id, name: o.name, is_active: true }));
  },
  /** The server's own CSV (UTF-8 with BOM, formula-safe cells), fetched with the session. */
  async csvBlob(kind: CsvKind, s: Scope): Promise<Blob> {
    const res = await authedFetch(`/reports/csv${reportQuery(s, { kind })}`, {}, 60_000);
    if (!res.ok) throw await errorFrom(res, "Could not create the CSV");
    return res.blob();
  },
};
