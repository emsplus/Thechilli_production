import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { DiscountInput, TaxConfig } from "./types";

export type OpStatus = "pending" | "syncing" | "synced" | "failed" | "conflict";

export type OpPayload =
  | { type: "create_order"; order: { client_uuid: string; order_type: string; table_id: string | null; customer_id?: string | null; allow_second_order?: boolean; lines: { item_id: string; variant_id?: string | null; quantity: number; note?: string | null; expected_unit_price?: string; modifiers?: string[] }[] }; accept_price_changes: boolean }
  | { type: "add_lines"; order_client_uuid: string; batch_uuid: string; lines: { item_id: string; variant_id?: string | null; quantity: number; note?: string | null; expected_unit_price?: string; modifiers?: string[] }[]; accept_price_changes: boolean }
  | { type: "send_kot"; order_client_uuid: string }
  | { type: "finalize_bill"; order_client_uuid: string; discount?: DiscountInput | null; service_charge?: boolean; apply_offers?: boolean }
  | { type: "payment"; order_client_uuid: string; method: "cash" | "card" | "other" | "upi" };

export interface QueuedOp {
  op_id: string;
  seq: number;
  created_at: string;
  order_ref: string; // order client_uuid, groups dependent ops
  restaurant_id?: string; // session that created the op; it only ever syncs under the same restaurant
  label: string;
  op: OpPayload;
  status: OpStatus;
  attempts: number;
  error?: string;
  conflicts?: { item: string; expected: string; current: string }[];
  result?: Record<string, unknown>;
}

export interface Snapshot {
  savedAt: string;
  restaurant_id?: string;
  categories: unknown[];
  items: unknown[];
  tables: unknown[];
  /** Legacy single-rate summary (kept so older code keeps reading it). */
  tax: { name: string; rate_percent: string; currency: string } | null;
  /** Full GST configuration (rates, rules, currency, service charge...) for pricing offline. */
  taxConfig?: TaxConfig | null;
  /** Phrases the voice ordering learnt (GET /menu/voice-aliases), so they keep matching offline. Absent in older snapshots. */
  voiceAliases?: unknown[];
  /** Modifier groups and the offers running when the menu was saved (phase4). Absent in older snapshots. */
  modifierGroups?: unknown[];
  offers?: unknown[];
}

/**
 * One open POS ticket (a bill in progress). `data` is the page's own ticket object (cart, order type, table, order/bill
 * state, idempotency keys); this layer stays type-agnostic. Scoped by restaurant like queue ops.
 */
export interface DraftRecord {
  id: string; // ticket id (= the order's client_uuid)
  restaurant_id?: string;
  no: number; // human ticket number, for ordering
  updated_at: string;
  data: unknown;
}

interface PosDB extends DBSchema {
  queue: { key: string; value: QueuedOp; indexes: { seq: number } };
  cache: { key: string; value: Snapshot };
  drafts: { key: string; value: DraftRecord; indexes: { no: number } };
}

let dbp: Promise<IDBPDatabase<PosDB>> | null = null;

export function getDb() {
  // v1: queue + cache. v2: drafts (open POS tickets). Upgrades only ADD stores: existing queued sales are never touched.
  dbp ??= openDB<PosDB>("pos-offline", 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore("queue", { keyPath: "op_id" }).createIndex("seq", "seq");
        db.createObjectStore("cache");
      }
      if (oldVersion < 2) db.createObjectStore("drafts", { keyPath: "id" }).createIndex("no", "no");
    },
    // An older tab still holds v1 open: close ours of it so the upgrade is never blocked, and reopen lazily.
    blocking() { void dbp?.then((d) => d.close()).catch(() => {}); dbp = null; },
  });
  return dbp;
}

export async function saveSnapshot(s: Snapshot) { try { await (await getDb()).put("cache", s, "snapshot"); } catch { /* storage unavailable */ } }
export async function loadSnapshot(): Promise<Snapshot | null> { try { return (await (await getDb()).get("cache", "snapshot")) ?? null; } catch { return null; } }

export async function listOps(): Promise<QueuedOp[]> { return (await getDb()).getAllFromIndex("queue", "seq"); }
export async function putOp(op: QueuedOp) { await (await getDb()).put("queue", op); }
export async function deleteOp(id: string) { await (await getDb()).delete("queue", id); }

export async function listDrafts(): Promise<DraftRecord[]> { return (await getDb()).getAllFromIndex("drafts", "no"); }
export async function putDraft(d: DraftRecord) { await (await getDb()).put("drafts", d); }
export async function deleteDraft(id: string) { await (await getDb()).delete("drafts", id); }

/** Open tickets of this restaurant that hold items but were never placed: they exist nowhere else (sign-out warning). */
export async function unplacedDraftCount(restaurantId: string | null): Promise<number> {
  try {
    return (await listDrafts()).filter((d) => {
      if (d.restaurant_id && restaurantId && d.restaurant_id !== restaurantId) return false;
      const t = d.data as { order?: unknown; prov?: unknown; bill?: unknown; lines?: unknown[] } | null;
      return !!t && !t.order && !t.prov && !t.bill && Array.isArray(t.lines) && t.lines.length > 0;
    }).length;
  } catch { return 0; }
}

/** Removes every local business record (logout / account switch). */
export async function wipeLocalData() {
  const db = await getDb();
  await Promise.all([db.clear("queue"), db.clear("cache"), db.clear("drafts")]);
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("pos.activeTicket")) localStorage.removeItem(k);
    for (const k of ["pos.taxConfig", "pos.restaurantName", "pos.restaurantSubtitle"]) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
