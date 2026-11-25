import { apiRequest as request } from "./api";

/**
 * Table QR codes and guest reviews (pos-service docs/TABLE_QR_REVIEWS.md). Every QR carries a signed token made by the server
 * (never a raw table id); "Regenerate" kills the old codes of that table. Reviews come from the review QR of a table (or the
 * restaurant-wide one): newest first, with averages per table.
 */
export interface QrLinks { menu_url: string; review_url: string }
export interface QrTable extends QrLinks { table_id: string; label: string; area: string; seats: number; gen: number; regenerated_at: string | null }
export interface QrSettings { menu_enabled: boolean; reviews_enabled: boolean; google_review_url: string | null }
export interface QrOverview extends QrSettings {
  restaurant_name: string;
  base_url: string;
  general: QrLinks & { gen: number };
  tables: QrTable[];
}
export interface Review {
  id: string; created_at: string; rating: number; comment: string | null; guest_name: string | null; guest_contact: string | null;
  table_id: string | null; table_label: string | null; read: boolean;
}
export interface TableAverage { table_id: string | null; table_label: string | null; count: number; average: number }
export interface ReviewList {
  items: Review[]; total: number; average: number | null; distribution: Record<"1" | "2" | "3" | "4" | "5", number>;
  per_table: TableAverage[]; unread_low: number;
}
/** `table`: a table id, "general" (the restaurant-wide QR) or "" (all). Dates are the restaurant's local days, inclusive. */
export interface ReviewFilter { table?: string; rating?: number | ""; maxRating?: number | ""; from?: string; to?: string; limit?: number; offset?: number }

export const LOW_RATING = 2;

/** Query string for GET /reviews (empty filters are left out). */
export function reviewQuery(f: ReviewFilter): string {
  const q = new URLSearchParams();
  if (f.table) q.set("table", f.table);
  if (f.rating) q.set("rating", String(f.rating));
  if (f.maxRating) q.set("max_rating", String(f.maxRating));
  if (f.from) q.set("date_from", f.from);
  if (f.to) q.set("date_to", f.to);
  if (f.limit) q.set("limit", String(f.limit));
  if (f.offset) q.set("offset", String(f.offset));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Rows for the CSV export (through src/lib/csv.ts, which neutralises spreadsheet formulas in guest text). */
export function reviewCsvRows(items: Review[], timeOf: (iso: string) => string): (string | number)[][] {
  return [["Date and time", "Table", "Rating", "Comment", "Guest name", "Guest phone or email"],
    ...items.map((r) => [timeOf(r.created_at), r.table_label ?? "Restaurant-wide QR", r.rating, r.comment ?? "", r.guest_name ?? "", r.guest_contact ?? ""])];
}

/** "T 1/A" -> "t-1-a": safe in a file name. */
export const fileSafe = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9\p{Script=Devanagari}]+/gu, "-").replace(/^-+|-+$/g, "") || "qr";
export const qrFileName = (kind: "menu" | "review", label: string | null, ext: "png" | "pdf") =>
  `${kind}-qr-${label ? `table-${fileSafe(label)}` : "restaurant"}.${ext}`;

export const stars = (n: number) => "★".repeat(Math.max(0, Math.min(5, n))) + "☆".repeat(5 - Math.max(0, Math.min(5, n)));

const post = <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const tableQr = {
  overview: () => request<QrOverview>("/table-qr"),
  regenerateTable: (tableId: string) => post<QrLinks & { table_id: string; label: string; gen: number }>(`/table-qr/tables/${encodeURIComponent(tableId)}/regenerate`),
  regenerateGeneral: () => post<QrLinks & { gen: number }>("/table-qr/general/regenerate"),
  settings: () => request<QrSettings>("/table-qr/settings"),
  saveSettings: (b: Partial<QrSettings>) => request<QrSettings>("/table-qr/settings", { method: "PUT", body: JSON.stringify(b) }),
};

export const reviews = {
  list: (f: ReviewFilter = {}) => request<ReviewList>(`/reviews${reviewQuery(f)}`),
  summary: () => request<{ unread_low: number }>("/reviews/summary"),
  markRead: (ids?: string[]) => post<{ marked: number; unread_low: number }>("/reviews/read", ids ? { ids } : {}),
};
