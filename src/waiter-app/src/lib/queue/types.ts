/** Wire shapes of pos-service POST /api/v1/sync/operations (see pos-service app/schemas/sync.py). */
export interface LineInput {
  item_id: string;
  variant_id?: string | null;
  quantity: number;
  note?: string | null;
  /** Modifier option ids (docs/MODIFIERS_OFFERS.md of pos-service): the complete choice. Omitted = the server's defaults. */
  modifiers?: string[];
  /** Price the waiter saw. A mismatch makes the server answer "conflict" instead of silently charging another price. */
  expected_unit_price?: string;
}

export type OrderType = "indoor" | "outdoor" | "takeaway" | "delivery";

export interface NewOrder {
  client_uuid: string; order_type: OrderType; table_id: string | null; customer_id?: string | null; lines: LineInput[];
  /** Counter token (takeaway/canteen) and a free-text order note. Sent to the server; pos-service versions that do not know them ignore them (docs/WAITER_API_ASSUMPTIONS.md). */
  token?: number | null; note?: string | null;
  /** The waiter explicitly started a separate order on a table that has one (pos-service OrderIn.allow_second_order). Omitted = the
   *  server refuses a second open order on the table (409 table_has_open_order) and the queue adds the items to that order instead. */
  allow_second_order?: boolean;
}

export type OpPayload =
  | { type: "create_order"; order: NewOrder; accept_price_changes: boolean }
  | { type: "add_lines"; order_client_uuid: string; batch_uuid: string; lines: LineInput[]; accept_price_changes: boolean }
  | { type: "send_kot"; order_client_uuid: string }
  // Waiter ops. shift_open/shift_close/bill_request go to POST /sync/operations as open_shift/close_shift/request_bill (docs/WAITER_API.md
  // of pos-service); cancel_order is a REST call (queue/rest.ts). Same queue, same op_id idempotency.
  | { type: "shift_open"; shift_uuid: string; outlet_id: string; opened_at: string }
  | { type: "shift_close"; shift_uuid: string; outlet_id: string; closed_at: string }
  | { type: "bill_request"; order_client_uuid: string; requested_at: string }
  /** `unsent`: the kitchen has no KOT yet, so the waiter-level POST /orders/{id}/cancel-unsent applies; otherwise POST /orders/{id}/cancel (cashier/manager). */
  | { type: "cancel_order"; order_client_uuid: string; server_order_id?: string | null; reason: string; unsent?: boolean }
  /** Staff attendance (POST /attendance/clock-in|out). `client_uuid` = the clock-in's key (also closes exactly that record);
   *  `at` = the phone's time of the tap, so a clock-in queued offline keeps its real time (server accepts up to 24 h old). */
  | { type: "clock_in"; client_uuid: string; at: string; device: string }
  | { type: "clock_out"; client_uuid: string | null; at: string; device: string };

/** Op types the server's POST /sync/operations understands. Everything else goes through queue/rest.ts. */
export const SYNC_OP_TYPES = ["create_order", "add_lines", "send_kot"] as const;
/** Waiter ops that also travel through /sync/operations but are newer than the first backend: sent in their own call so an older server's 422 cannot fail orders. */
export const EXT_SYNC_OP_TYPES = ["shift_open", "shift_close", "bill_request"] as const;
export const isSyncOp = (o: OpPayload): boolean => (SYNC_OP_TYPES as readonly string[]).includes(o.type);
export const isExtSyncOp = (o: OpPayload): boolean => (EXT_SYNC_OP_TYPES as readonly string[]).includes(o.type);
/** Wire form of an extended op. */
export function toWireOp(o: OpPayload): Record<string, unknown> {
  switch (o.type) {
    case "shift_open": return { type: "open_shift" };
    case "shift_close": return { type: "close_shift" };
    case "bill_request": return { type: "request_bill", order_client_uuid: o.order_client_uuid };
    default: return o as unknown as Record<string, unknown>;
  }
}
/** REST ops that act on an existing server order by id (resolved from the synced create_order). */
export const needsServerOrderId = (o: OpPayload): o is Extract<OpPayload, { type: "cancel_order" }> => o.type === "cancel_order";

export type OpStatus = "pending" | "syncing" | "synced" | "failed";

export interface QueuedOp {
  op_id: string;
  seq: number;
  created_at: string;
  /** Order client_uuid: groups dependent ops, which are sent strictly in order. */
  order_ref: string;
  /** When the server confirmed this op (ms since epoch). The Orders screen drops a fully synced order the server list no longer has only once the list was read after this moment. */
  synced_at?: number;
  /** Natural key: enqueueing the same key twice returns the first op (duplicate-KOT / double-tap guard). */
  dedupe_key: string;
  restaurant_id?: string;
  /** Who took it (JWT sub). Only used on a shared counter tablet: ops wait for their own waiter's PIN session. */
  user_id?: string;
  /** Outlet selected when the order was taken; sent as X-Outlet-Id, so the op only syncs while that outlet is selected. */
  outlet_id?: string;
  label: string;
  op: OpPayload;
  status: OpStatus;
  attempts: number;
  /** epoch ms; not sent before this (backoff). */
  next_attempt_at: number;
  error?: string;
  /** Stable server code of the refusal (e.g. not_available_for_business_type): the same text-free key the online endpoints return. */
  error_code?: string;
  /** Machine-readable details of the refusal (pos-service SyncResult.details), e.g. the unpaid order that blocks a table. */
  error_details?: Record<string, unknown>;
  conflicts?: { item: string; expected: string; current: string }[];
  result?: Record<string, unknown>;
}

export interface SyncOpIn { op_id: string; device_id: string; client_created_at: string; op: OpPayload }
export interface SyncResultOut {
  op_id: string;
  status: "synced" | "conflict" | "failed";
  detail: string | null;
  /** Stable error code (pos-service SyncResult.code); absent on older servers. */
  code?: string | null;
  conflicts: { item: string; expected: string; current: string }[] | null;
  data: Record<string, unknown> | null;
  /** Machine-readable details of a rule refusal (pos-service SyncResult.details), e.g. existing_order_client_uuid. */
  details?: Record<string, unknown> | null;
}

/** Transport failure classes the engine understands (the API client maps HTTP errors onto these). */
export class SendError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
