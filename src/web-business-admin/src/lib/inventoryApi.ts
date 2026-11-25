/**
 * Procurement and stock control: purchase orders, goods receipts, purchase returns, wastage, batches (FEFO / expiry),
 * stock counts, locations and the supplier ledger. Real contract: pos-service docs/INVENTORY.md (branch phase2/inventory),
 * routers app/api/v1/stock.py. Money and quantities are exact decimal strings. Servers without these routes answer
 * 404/405/501: callers hide the section (see isMissing). Documents belong to the request outlet (X-Outlet-Id).
 */
import { apiRequest, ApiError } from "./api";

/** 404 / 405 / 501: this server does not have the endpoint. Hide the section, do not show an error. */
export const isMissing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 501);

/** Server permissions used by this area (app/core/permissions.py). */
export const PERM = {
  manage: "inventory.manage", purchases: "purchases.manage", receive: "purchases.receive", wastage: "wastage.record", count: "inventory.count",
} as const;

export type SectionId = "orders" | "receipts" | "wastage" | "batches" | "counts" | "locations";
/** Which of the user's permissions let them OPEN a section (the API's GET gates). Any one is enough. */
export const SECTION_READ: Record<SectionId, readonly string[]> = {
  orders: [PERM.purchases, PERM.receive],
  receipts: [PERM.receive, PERM.purchases],
  wastage: [PERM.manage, PERM.wastage],
  batches: [PERM.manage, PERM.wastage, PERM.receive],
  counts: [PERM.count, PERM.manage],
  locations: [PERM.manage, PERM.purchases, PERM.receive, PERM.count, PERM.wastage],
};

export type PoStatus = "draft" | "sent" | "partially_received" | "closed" | "cancelled";
export const PO_STATUSES: PoStatus[] = ["draft", "sent", "partially_received", "closed", "cancelled"];
export const WASTE_REASONS = ["spoilage", "breakage", "theft", "expired", "staff_meal", "spillage", "other"] as const;
export const LOCATION_KINDS = ["store", "kitchen", "bar", "cold_room", "prep"] as const;

export interface StockLocation { id: string; outlet_id: string; name: string; kind: string; is_default: boolean; is_active: boolean }
export interface PoLine { id: string; position: number; item_id: string; unit_code: string; factor_to_base: string; quantity: string; unit_price: string; tax_rate: string; received_quantity: string }
export interface PurchaseOrder {
  id: string; outlet_id: string; supplier_id: string; number: string; status: PoStatus; expected_date: string | null; notes: string | null;
  subtotal: string; tax_total: string; total: string; sent_at: string | null; closed_at: string | null; cancelled_at: string | null; lines: PoLine[];
}
export interface PoLineInput { item_id: string; quantity: string; unit: string; unit_price: string; tax_rate: string }
export interface PoInput { supplier_id: string; expected_date: string | null; notes: string | null; lines: PoLineInput[] }

export interface GrnLine {
  id: string; po_line_id: string; item_id: string; unit_code: string; quantity: string; rejected_quantity: string; quantity_base: string;
  unit_price: string; unit_cost: string; tax_rate: string; net: string; tax_amount: string; batch_id: string | null; batch_no: string | null; expiry_date: string | null; returned_base: string;
}
export interface GoodsReceipt {
  id: string; outlet_id: string; po_id: string; supplier_id: string; location_id: string; number: string; received_on: string;
  supplier_invoice_no: string | null; note: string | null; subtotal: string; tax_total: string; total: string; lines: GrnLine[];
}
export interface GrnLineInput { po_line_id: string; quantity: string; rejected_quantity: string; unit_price?: string; tax_rate?: string; batch_no?: string | null; expiry_date?: string | null }
export interface GrnInput { idempotency_key: string; location_id?: string | null; received_on?: string | null; supplier_invoice_no?: string | null; note?: string | null; lines: GrnLineInput[] }

export interface ReturnLineOut { grn_line_id: string; item_id: string; quantity_base: string; unit_cost: string; net: string; tax_amount: string; batch_id: string | null }
export interface PurchaseReturn { id: string; grn_id: string; supplier_id: string; number: string; reason: string; subtotal: string; tax_total: string; total: string; lines: ReturnLineOut[] }

export interface StockBatch {
  id: string; item_id: string; item_name: string; unit: string; location_id: string; batch_no: string; expiry_date: string | null;
  received_at: string; unit_cost: string | null; qty_received: string; remaining: string; expired: boolean;
}
export interface WastageReport {
  total_value: string; by_reason: { reason_code: string; quantity_entries: number; value: string }[];
  by_item: { item_id: string; name: string; unit: string; quantity: string; value: string }[];
}
export interface CountLine { item_id: string; counted_base: string; expected_base: string | null; variance: string | null }
export interface StockCount { id: string; outlet_id: string; location_id: string; name: string | null; status: "open" | "posted" | string; posted_at: string | null; lines: CountLine[] }
export interface NegativeStock { item_id: string; item_name: string; unit: string; location_id: string; location_name: string; balance: string }
export interface LedgerEntry { id: string; entry_type: string; amount: string; entry_date: string; ref_type: string | null; ref_id: string | null; note: string | null; created_at: string; running_balance: string }
export interface SupplierLedger { supplier_id: string; supplier_name: string; balance: string; entries: LedgerEntry[] }
/** The fields of an inventory item this area needs (GET /inventory/items; tracks_batches is new on the server). */
export interface StockItem { id: string; name: string; base_unit: "g" | "ml" | "pcs"; is_active?: boolean; tracks_batches?: boolean; last_cost?: string | null; balance: string }

const qs = (o: Record<string, string | number | boolean | null | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = (body: unknown): RequestInit => ({ ...json(body), method: "PUT" });
const patch = (body: unknown): RequestInit => ({ ...json(body), method: "PATCH" });

export const inv = {
  items: () => apiRequest<StockItem[]>("/inventory/items?include_inactive=true&limit=500"),
  locations: (includeInactive = false) => apiRequest<StockLocation[]>(`/stock/locations${qs({ include_inactive: includeInactive })}`),
  createLocation: (b: { name: string; kind: string }) => apiRequest<StockLocation>("/stock/locations", json(b)),
  patchLocation: (id: string, b: { name?: string; kind?: string; is_active?: boolean }) => apiRequest<StockLocation>(`/stock/locations/${id}`, patch(b)),
  negativeStock: () => apiRequest<NegativeStock[]>("/inventory/negative-stock"),

  pos: (o: { status?: string; supplier_id?: string; limit?: number } = {}) => apiRequest<PurchaseOrder[]>(`/purchase-orders${qs({ limit: 200, ...o })}`),
  po: (id: string) => apiRequest<PurchaseOrder>(`/purchase-orders/${id}`),
  createPo: (b: PoInput) => apiRequest<PurchaseOrder>("/purchase-orders", json(b)),
  updatePo: (id: string, b: Partial<PoInput>) => apiRequest<PurchaseOrder>(`/purchase-orders/${id}`, put(b)),
  poAction: (id: string, a: "send" | "cancel" | "close") => apiRequest<PurchaseOrder>(`/purchase-orders/${id}/${a}`, { method: "POST" }),
  receive: (poId: string, b: GrnInput) => apiRequest<GoodsReceipt>(`/purchase-orders/${poId}/receipts`, json(b)),
  receipts: (o: { po_id?: string; supplier_id?: string; limit?: number } = {}) => apiRequest<GoodsReceipt[]>(`/goods-receipts${qs({ limit: 200, ...o })}`),
  returns: (limit = 200) => apiRequest<PurchaseReturn[]>(`/purchase-returns${qs({ limit })}`),
  createReturn: (b: { idempotency_key: string; grn_id: string; reason: string; lines: { grn_line_id: string; quantity: string; unit?: string }[] }) => apiRequest<PurchaseReturn>("/purchase-returns", json(b)),

  ledger: (supplierId: string) => apiRequest<SupplierLedger>(`/suppliers/${supplierId}/ledger?limit=100`),
  ledgerEntry: (supplierId: string, b: { idempotency_key: string; amount: string; kind: "payment" | "adjustment"; note?: string | null; entry_date?: string | null }) => apiRequest<LedgerEntry>(`/suppliers/${supplierId}/ledger`, json(b)),

  wastage: (o: { date_from?: string; date_to?: string; location_id?: string } = {}) => apiRequest<WastageReport>(`/inventory/wastage${qs(o)}`),
  recordWastage: (b: { idempotency_key: string; item_id: string; quantity: string; unit: string; reason_code: string; note?: string | null; location_id?: string | null; batch_id?: string | null }) => apiRequest<{ replayed: boolean }>("/inventory/wastage", json(b)),
  batches: (o: { item_id?: string; location_id?: string; expiring_within_days?: number; expired?: boolean; limit?: number } = {}) => apiRequest<StockBatch[]>(`/stock/batches${qs({ limit: 200, ...o })}`),
  writeOff: (id: string, b: { idempotency_key: string; note?: string | null }) => apiRequest<{ status: string; replayed: boolean }>(`/stock/batches/${id}/write-off`, json(b)),

  counts: (limit = 50) => apiRequest<StockCount[]>(`/stock/counts${qs({ limit })}`),
  count: (id: string) => apiRequest<StockCount>(`/stock/counts/${id}`),
  openCount: (b: { name?: string | null; location_id?: string | null }) => apiRequest<StockCount>("/stock/counts", json(b)),
  setCountLines: (id: string, lines: { item_id: string; counted: string; unit: string }[]) => apiRequest<StockCount>(`/stock/counts/${id}/lines`, put({ lines })),
  postCount: (id: string) => apiRequest<StockCount>(`/stock/counts/${id}/post`, { method: "POST" }),
};

/* ---------------------------------------------------------------- pure helpers (unit tested) */

const DAY = 86_400_000;
/** Whole days from `today` to the expiry date (negative = already expired). Dates are local calendar days, "YYYY-MM-DD". */
export function daysToExpiry(expiry: string | null | undefined, today: Date = new Date()): number | null {
  if (!expiry) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry);
  if (!m) return null;
  const a = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((a - b) / DAY);
}
export type ExpiryState = "none" | "ok" | "soon" | "expired";
/** expired: past (or the server says so); soon: within `soonDays`; none: no expiry date recorded. */
export function expiryState(b: Pick<StockBatch, "expiry_date" | "expired">, soonDays = 7, today: Date = new Date()): ExpiryState {
  const d = daysToExpiry(b.expiry_date, today);
  if (b.expired || (d !== null && d < 0)) return "expired";
  if (d === null) return "none";
  return d <= soonDays ? "soon" : "ok";
}
/** First-expiry-first-out order: earliest expiry first, batches without an expiry last, then oldest received. */
export function fefoSort<T extends Pick<StockBatch, "expiry_date" | "received_at">>(batches: T[]): T[] {
  return [...batches].sort((a, b) => {
    if (a.expiry_date && b.expiry_date && a.expiry_date !== b.expiry_date) return a.expiry_date < b.expiry_date ? -1 : 1;
    if (!!a.expiry_date !== !!b.expiry_date) return a.expiry_date ? -1 : 1;
    return a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0;
  });
}

const dec = (s: string | number) => { const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(s).trim()); if (!m) return 0n; return BigInt(`${m[1]}${m[2] || "0"}${(m[3] ?? "").padEnd(3, "0").slice(0, 3)}`); };
const undec = (n: bigint) => { const neg = n < 0n; const a = (neg ? -n : n).toString().padStart(4, "0"); const t = `${a.slice(0, -3)}.${a.slice(-3)}`.replace(/\.?0+$/, ""); return (neg ? "-" : "") + t; };
/** Quantity still to receive on a PO line (ordered - received), exact, never negative, "" -> "0". */
export function remainingQty(l: Pick<PoLine, "quantity" | "received_quantity">): string {
  const r = dec(l.quantity) - dec(l.received_quantity);
  return r > 0n ? undec(r) : "0";
}
/** "8.000" -> "8", "0.320" -> "0.32": the API sends fixed decimals, people read plain numbers. */
export const trimDec = (s: string | number) => { const n = Number(s); return Number.isFinite(n) ? String(+n.toFixed(4)) : String(s); };
/** A valid positive/zero quantity with up to 3 decimals, as the API accepts. */
export const isQty = (s: string, allowZero = false) => /^\d+(\.\d{1,3})?$/.test(s.trim()) && (allowZero || dec(s) > 0n);
/** Money / rate typed by a user: up to 4 decimals. */
export const isRate = (s: string) => /^\d+(\.\d{1,4})?$/.test(s.trim());
export const isPercent = (s: string) => /^\d{1,3}(\.\d{1,2})?$/.test(s.trim()) && Number(s) <= 100;

/** Which actions the PO status allows (mirrors the server rules in docs/INVENTORY.md). */
export function poActions(s: PoStatus, anyReceived: boolean): { edit: boolean; send: boolean; cancel: boolean; close: boolean; receive: boolean } {
  return {
    edit: s === "draft",
    send: s === "draft",
    cancel: (s === "draft" || s === "sent") && !anyReceived,
    close: s === "partially_received",
    receive: s === "sent" || s === "partially_received",
  };
}
export const poReceived = (po: PurchaseOrder) => po.lines.some((l) => dec(l.received_quantity) > 0n);

/** Builds the GRN body from the editor rows: skips rows with nothing accepted or rejected; batch/expiry only when given. */
export interface ReceiptRow { po_line_id: string; accepted: string; rejected: string; rate: string; batch_no: string; expiry: string }
export function buildReceiptLines(rows: ReceiptRow[]): GrnLineInput[] {
  return rows.filter((r) => isQty(r.accepted)).map((r) => ({
    po_line_id: r.po_line_id, quantity: r.accepted.trim(), rejected_quantity: isQty(r.rejected, true) ? r.rejected.trim() : "0",
    ...(r.rate.trim() ? { unit_price: r.rate.trim() } : {}), ...(r.batch_no.trim() ? { batch_no: r.batch_no.trim() } : {}), ...(r.expiry ? { expiry_date: r.expiry } : {}),
  }));
}

/** Total value of the lines from the editor (qty x price, tax excluded), exact to 4 decimals via integer math in thousandths. */
export function lineNet(qty: string, price: string): string {
  if (!isQty(qty) || !isRate(price)) return "0";
  const [pi, pf = ""] = price.trim().split(".");
  const p = BigInt(pi + pf.padEnd(4, "0"));      // 1e-4
  const n = (dec(qty) * p + 500n) / 1000n;       // 1e-4 units
  return `${n / 10000n}.${(n % 10000n).toString().padStart(4, "0")}`;
}

export const todayIso = (d: Date = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
