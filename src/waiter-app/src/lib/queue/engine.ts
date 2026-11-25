import { DEFAULT_BACKOFF, backoffDelay } from "./backoff";
import type { OpStore } from "./store";
import { SendError, needsServerOrderId, type LineInput, type NewOrder, type OpPayload, type OpStatus, type QueuedOp, type SyncOpIn, type SyncResultOut } from "./types";

export interface EngineDeps {
  store: OpStore;
  /**
   * Sends one batch (all ops share `outletId`, sent as X-Outlet-Id). Must throw SendError(status) on transport/HTTP failure of
   * the whole call; may omit an op from the results to say "not decided, keep it queued" (transient failure of that op only).
   */
  send(ops: SyncOpIn[], outletId: string | null): Promise<SyncResultOut[]>;
  newId(): string;
  deviceId(): string;
  restaurantId?(): string | null;
  userId?(): string | null;
  /** Shared counter tablet: send only the signed-in staff member's ops (each is recorded as the user whose token sends it). */
  scopeByUser?(): boolean;
  outletId?(): string | null;
  now?(): number;
  random?(): number;
  onChange?(): void;
}

export interface EnqueueItem { op: OpPayload; order_ref: string; label: string; dedupe_key: string }

const BATCH = 100;
const KEEP_SYNCED = 30;

/** Ops that never reach a terminal state by themselves: only these HTTP statuses are worth retrying automatically. */
export function isRetryable(status: number): boolean {
  return status === 0 || status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Durable outbox. Invariants:
 *  - op_id is generated once at enqueue time, persisted, and reused on every retry (server dedupes on it).
 *  - an op is "synced" only after the server said so; nothing is ever inferred locally.
 *  - ops of one order go strictly in order; a failed op blocks its successors until retried.
 *  - the same dedupe_key can never produce two ops (a second KOT tap returns the first).
 */
export class QueueEngine {
  private flushing: Promise<void> | null = null;
  private counter = 0;
  constructor(private d: EngineDeps) {}

  private now() { return this.d.now ? this.d.now() : Date.now(); }
  private changed() { this.d.onChange?.(); }

  /**
   * Milliseconds until a pending op may be tried again (0 = now). No backoff is longer than the cap, so a deadline further away than
   * that can only come from a wall clock set back since it was written: retrying at once is harmless, waiting out the rollback
   * (hours) would leave the orders unsent (clock rollback, D-06).
   */
  private dueIn(o: QueuedOp, now: number): number {
    const left = o.next_attempt_at - now;
    return left > DEFAULT_BACKOFF.capMs + 1000 ? 0 : Math.max(0, left);
  }

  async enqueue(items: EnqueueItem[]): Promise<QueuedOp[]> {
    const existing = await this.d.store.list();
    const byKey = new Map(existing.map((o) => [o.dedupe_key, o]));
    const out: QueuedOp[] = [];
    for (const it of items) {
      const dup = byKey.get(it.dedupe_key);
      if (dup) { out.push(dup); continue; }
      const op: QueuedOp = {
        op_id: this.d.newId(), seq: this.now() * 1000 + (this.counter++ % 1000), created_at: new Date(this.now()).toISOString(),
        order_ref: it.order_ref, dedupe_key: it.dedupe_key, restaurant_id: this.d.restaurantId?.() ?? undefined, user_id: this.d.userId?.() ?? undefined, outlet_id: this.d.outletId?.() ?? undefined,
        label: it.label, op: it.op, status: "pending", attempts: 0, next_attempt_at: 0,
      };
      await this.d.store.put(op);
      byKey.set(op.dedupe_key, op);
      out.push(op);
    }
    this.changed();
    return out;
  }

  /** A tab that died mid-request leaves ops "syncing": they are safe to resend (same op_id). */
  async recover() {
    for (const o of await this.d.store.list()) if (o.status === "syncing") await this.d.store.put({ ...o, status: "pending" });
    this.changed();
  }

  list() { return this.d.store.list(); }

  /** Milliseconds until the next pending op is due, or null if nothing is waiting. */
  async nextDueIn(): Promise<number | null> {
    const now = this.now();
    const t = (await this.d.store.list()).filter((o) => o.status === "pending" && this.mine(o)).map((o) => this.dueIn(o, now));
    return t.length ? Math.min(...t) : null;
  }

  /**
   * Ops belong to the restaurant they were taken in. They do NOT wait for the same outlet to be selected: every batch is sent
   * with the op's own outlet (X-Outlet-Id), so switching outlet never strands an order.
   */
  private mine(o: QueuedOp) {
    const r = this.d.restaurantId?.();
    if (o.restaurant_id && r && o.restaurant_id !== r) return false;
    if (!this.d.scopeByUser?.()) return true;
    const u = this.d.userId?.();
    return !o.user_id || !u || o.user_id === u;
  }

  /** Single-flight. Safe to call from anywhere. `force` ignores backoff (user pressed "retry now"). */
  flush(force = false): Promise<void> {
    this.flushing ??= this.run(force).finally(() => { this.flushing = null; this.changed(); });
    return this.flushing;
  }

  private async run(force: boolean) {
    // Ops that need the server order id (bill request, cancel) can only go after create_order synced: a second round picks them up.
    for (let round = 0; round < 3; round++) {
      const progressed = await this.runOnce(force);
      if (!progressed) return;
    }
  }

  /** Server id of an order whose create_order the server confirmed (or null). */
  private serverIdOf(all: QueuedOp[], ref: string): string | null {
    const id = all.find((o) => o.order_ref === ref && o.op.type === "create_order" && o.status === "synced")?.result?.order_id;
    return typeof id === "string" ? id : null;
  }

  private async runOnce(force: boolean): Promise<boolean> {
    const all = await this.d.store.list();
    const now = this.now();
    const blocked = new Set<string>();
    const todo: QueuedOp[] = [];
    for (let o of all) {
      if (o.status === "synced") continue;
      if (o.status !== "pending") { blocked.add(o.order_ref); continue; } // failed (or syncing elsewhere) blocks successors
      if (blocked.has(o.order_ref)) continue;
      if (!this.mine(o) || (!force && this.dueIn(o, now) > 0)) { blocked.add(o.order_ref); continue; }
      if (needsServerOrderId(o.op) && !o.op.server_order_id) {
        const sid = this.serverIdOf(all, o.order_ref);
        if (!sid) {
          const creating = all.some((x) => x.order_ref === o.order_ref && x.op.type === "create_order" && x.status !== "synced");
          if (!creating) { await this.d.store.put({ ...o, status: "failed", attempts: o.attempts + 1, error: "This order was never confirmed by the server, so there is nothing to send this to." }); }
          blocked.add(o.order_ref); // wait for create_order (this round or the next)
          continue;
        }
        o = { ...o, op: { ...o.op, server_order_id: sid } };
        await this.d.store.put(o);
      }
      todo.push(o);
      if (todo.length >= BATCH) break;
    }
    if (!todo.length) return false;
    for (const o of todo) await this.d.store.put({ ...o, status: "syncing" });
    this.changed();
    // One batch per outlet: the X-Outlet-Id header is per request, and an op must never run in another outlet than it was taken in.
    const groups = new Map<string, QueuedOp[]>();
    for (const o of todo) groups.set(o.outlet_id ?? "", [...(groups.get(o.outlet_id ?? "") ?? []), o]);
    let anySynced = false;
    for (const [outlet, ops] of groups) if (await this.sendGroup(ops, outlet || null)) anySynced = true;
    await this.prune();
    return anySynced;
  }

  private async sendGroup(todo: QueuedOp[], outletId: string | null): Promise<boolean> {
    let results: SyncResultOut[];
    try {
      results = await this.d.send(todo.map((o) => ({ op_id: o.op_id, device_id: this.d.deviceId(), client_created_at: o.created_at, op: o.op })), outletId);
    } catch (e) {
      const status = e instanceof SendError ? e.status : 0;
      const msg = e instanceof Error ? e.message : "Sync failed";
      // A 409 for the whole request says nothing about any single op (it can come from one of them): none is marked failed for good.
      const retry = isRetryable(status) || status === 409;
      for (const o of todo) {
        if (retry) {
          const attempts = o.attempts + (status === 401 ? 0 : 1); // an expired session is not the op's fault
          const delay = status === 401 ? 5000 : backoffDelay(attempts, this.d.random);
          await this.d.store.put({ ...o, status: "pending", attempts, error: msg, next_attempt_at: this.now() + delay });
        } else {
          await this.d.store.put({ ...o, status: "failed", attempts: o.attempts + 1, error: msg });
        }
      }
      return false;
    }
    const byId = new Map(results.map((r) => [r.op_id, r]));
    let synced = false;
    const joins: { op: QueuedOp; into: string }[] = [];
    for (const o of todo) {
      const r = byId.get(o.op_id);
      const attempts = o.attempts + 1;
      if (!r) { await this.d.store.put({ ...o, status: "pending", attempts, next_attempt_at: this.now() + backoffDelay(attempts, this.d.random) }); continue; }
      const status: OpStatus = r.status === "synced" ? "synced" : "failed";
      if (status === "synced") synced = true;
      const into = status === "failed" ? joinTarget(o, r) : null;
      if (into) joins.push({ op: o, into });
      await this.d.store.put({ ...o, status, attempts, ...(status === "synced" ? { synced_at: this.now() } : {}), error: r.detail ?? undefined, error_code: status === "failed" ? r.code ?? undefined : undefined, error_details: status === "failed" ? r.details ?? undefined : undefined, conflicts: r.conflicts ?? undefined, result: r.data ?? undefined });
    }
    for (const j of joins) if (await this.joinOpenOrder(j.op, j.into)) synced = true; // progress: the next round sends the add-items
    return synced;
  }

  /**
   * The table already had an open order on the server (another device, the counter, or this device while offline took it first):
   * the refused new order becomes "add these items to THAT order" (add_lines + KOT), keeping every line. The add's batch_uuid is
   * the refused order's client_uuid, so a replay can never add the items twice; one table never gets two orders.
   */
  private async joinOpenOrder(create: QueuedOp, into: string): Promise<boolean> {
    if (create.op.type !== "create_order") return false;
    const ref = create.order_ref;
    const group = (await this.d.store.list()).filter((o) => o.order_ref === ref && o.status !== "synced");
    if (group.some((o) => o.status === "syncing")) return false;
    // Every unsent step of the refused order follows it: the order itself becomes add_lines, its KOTs / later additions / bill
    // request point at the existing order. Same op ids (the server stored none of them: refusals are never stored).
    for (const o of group) {
      let op: OpPayload = o.op, dedupe = o.dedupe_key, label = o.label;
      if (op.type === "create_order") {
        op = { type: "add_lines", order_client_uuid: into, batch_uuid: ref, lines: op.order.lines, accept_price_changes: op.accept_price_changes };
        dedupe = `lines:${ref}`; label = "Add items (table already had an order)";
      } else if (op.type === "send_kot" || op.type === "add_lines" || op.type === "bill_request") {
        op = { ...op, order_client_uuid: into };
        if (dedupe === `kot:${ref}:first`) dedupe = `kot:${into}:${ref}`;
      } else continue; // a cancel of the refused order stays as it is and fails visibly ("never confirmed")
      await this.d.store.put({ ...o, op, order_ref: into, dedupe_key: dedupe, label, status: "pending", error: undefined, error_code: undefined, conflicts: undefined, next_attempt_at: 0 });
    }
    this.changed();
    return true;
  }

  private async prune() {
    const all = await this.d.store.list();
    // An order with a step still to send keeps ALL its synced steps: a later bill request / cancel finds the server order id in the
    // synced create_order, and without it the step failed with "never confirmed by the server" (many offline orders sent at once:
    // D-09 of docs/testing/BREAK_CHAOS_REPORT.md, the oldest orders lost their create_order before their follow-up steps went out).
    const open = new Set(all.filter((o) => o.status !== "synced").map((o) => o.order_ref));
    const synced = all.filter((o) => o.status === "synced" && !open.has(o.order_ref));
    // Keep a window of synced ops so dedupe_keys of recent KOTs keep protecting against a replayed tap.
    for (const o of synced.slice(0, Math.max(0, synced.length - KEEP_SYNCED))) await this.d.store.delete(o.op_id);
  }

  /** Re-queue a failed order. `acceptPriceChanges` re-sends the SAME op_id (the server never stores failures). */
  async retry(orderRef: string, acceptPriceChanges = false, separateOrder = false) {
    for (const o of await this.d.store.list()) {
      if (o.order_ref !== orderRef || o.status !== "failed") continue;
      let op: OpPayload = acceptPriceChanges && (o.op.type === "create_order" || o.op.type === "add_lines") ? { ...o.op, accept_price_changes: true } : o.op;
      // "Start a new order for this table": the same order, now explicitly a separate one (pos-service OrderIn.allow_second_order)
      if (separateOrder && op.type === "create_order" && op.order.table_id) op = { ...op, order: { ...op.order, allow_second_order: true } };
      await this.d.store.put({ ...o, op, status: "pending", error: undefined, error_code: undefined, error_details: undefined, conflicts: undefined, next_attempt_at: 0 });
    }
    this.changed();
  }

  /** Removes a failed order's unsent ops (waiter gives up; nothing reached the kitchen). */
  async discard(orderRef: string) {
    for (const o of await this.d.store.list()) if (o.order_ref === orderRef && o.status === "failed") await this.d.store.delete(o.op_id);
    this.changed();
  }

  /**
   * Void-before-KOT. Nothing is ever cancelled "locally only" once the server has seen the order:
   *  - the order was never sent (no attempt) -> its unsent ops are deleted ("dropped"; the kitchen never heard of it);
   *  - the server has the order -> unsent KOT/add-lines are deleted and a cancel_order op is queued ("cancel_queued").
   * "busy" = a request for this order is in flight right now; try again in a moment (we cannot know what the server did).
   */
  async cancelUnsent(orderRef: string, serverOrderId: string | null, kotSent = false, reason = "Cancelled by waiter before it was sent to the kitchen"): Promise<"dropped" | "cancel_queued" | "busy"> {
    const group = (await this.d.store.list()).filter((o) => o.order_ref === orderRef);
    if (group.some((o) => o.status === "syncing")) return "busy";
    const created = group.find((o) => o.op.type === "create_order");
    // attempts > 0 means a request may have reached the server before the connection dropped: it could hold the order already.
    // Then the order is NOT dropped; create_order is resent (same op_id, idempotent) and the cancel follows it.
    if (created && created.status !== "synced" && created.attempts === 0) {
      for (const o of group) if (o.status !== "synced") await this.d.store.delete(o.op_id);
      this.changed();
      return "dropped";
    }
    for (const o of group) if (o.status !== "synced" && (o.op.type === "send_kot" || o.op.type === "add_lines")) await this.d.store.delete(o.op_id);
    const unsent = !kotSent && !group.some((o) => o.op.type === "send_kot" && o.status === "synced");
    await this.enqueue([{ op: { type: "cancel_order", order_client_uuid: orderRef, server_order_id: serverOrderId, reason, unsent }, order_ref: orderRef, label: "Cancel order", dedupe_key: `cancel:${orderRef}` }]);
    return "cancel_queued";
  }

  /** Removes one line from a create_order / add_lines op that has never been attempted. The last line removed drops the whole op (and its KOT). */
  async removeLine(opId: string, lineIndex: number): Promise<"removed" | "dropped" | "busy" | "uncertain" | "gone"> {
    const all = await this.d.store.list();
    const o = all.find((x) => x.op_id === opId);
    if (!o || (o.op.type !== "create_order" && o.op.type !== "add_lines")) return "gone";
    if (o.status === "syncing") return "busy";
    if (o.status === "synced") return "gone";
    if (o.attempts > 0) return "uncertain"; // may already be on the server: editing it now would make the resend differ from what the server stored
    const lines = o.op.type === "create_order" ? o.op.order.lines : o.op.lines;
    if (lineIndex < 0 || lineIndex >= lines.length) return "gone";
    const rest = lines.filter((_, i) => i !== lineIndex);
    if (!rest.length) {
      if (o.op.type === "create_order") { await this.cancelUnsent(o.order_ref, null); return "dropped"; }
      const kotKey = `kot:${o.order_ref}:${o.op.batch_uuid}`;
      for (const x of all) if (x.op_id === o.op_id || x.dedupe_key === kotKey) await this.d.store.delete(x.op_id);
      this.changed();
      return "dropped";
    }
    const op = o.op.type === "create_order" ? { ...o.op, order: { ...o.op.order, lines: rest } } : { ...o.op, lines: rest };
    await this.d.store.put({ ...o, op });
    this.changed();
    return "removed";
  }
}

/** Server code of "this table already has an unpaid order" (pos-service order_rules.refuse_second_order). */
export const TABLE_HAS_OPEN_ORDER = "table_has_open_order";
/**
 * The order to add a refused new order's items to, or null. Only for a plain new order (not one the waiter explicitly started as
 * a separate order) and only when the existing order is still open / in the kitchen: an order that already has a bill waiting for
 * payment takes no more items, so the refusal stays visible (retry / discard) and nothing is lost silently.
 */
export function joinTarget(o: QueuedOp, r: SyncResultOut): string | null {
  if (o.op.type !== "create_order" || o.op.order.allow_second_order || r.code !== TABLE_HAS_OPEN_ORDER) return null;
  const d = r.details ?? {};
  const into = d.existing_order_client_uuid;
  const existing = (d.existing_order ?? {}) as { bill_id?: unknown; status?: unknown };
  if (typeof into !== "string" || !into || into === o.order_ref || existing.bill_id || (existing.status && existing.status !== "open" && existing.status !== "sent_to_kitchen")) return null;
  return into;
}

export type OrderSyncState = "queued" | "sending" | "confirmed" | "failed";

/**
 * What the UI may claim about an order. "confirmed" requires the create_order op to be synced by the server;
 * "queued"/"sending" are shown as pending, never as confirmed.
 */
export function orderSyncState(ops: QueuedOp[]): { order: OrderSyncState; kot: OrderSyncState | "none"; serverOrderId: string | null; error?: string; errorCode?: string; errorDetails?: Record<string, unknown> } {
  const create = ops.find((o) => o.op.type === "create_order");
  // Items added later (add_lines) are part of "the order" too: a failed addition is a failed order, never "Confirmed".
  const content = ops.filter((o) => o.op.type === "create_order" || o.op.type === "add_lines");
  const kots = ops.filter((o) => o.op.type === "send_kot");
  const failed = ops.find((o) => o.status === "failed");
  const worst = (list: QueuedOp[]): OrderSyncState => {
    if (list.some((o) => o.status === "failed")) return "failed";
    if (list.every((o) => o.status === "synced")) return "confirmed";
    if (list.some((o) => o.status === "syncing")) return "sending";
    return "queued";
  };
  const id = create?.result?.order_id;
  return {
    order: content.length ? worst(content) : "confirmed",
    kot: kots.length ? worst(kots) : "none",
    serverOrderId: typeof id === "string" ? id : null,
    error: failed?.error,
    errorCode: failed?.error_code,
    errorDetails: failed?.error_details,
  };
}

/** Ops that make up one KOT submission, with natural keys so a double tap / replay cannot duplicate them. */
export function buildKotOps(order: NewOrder, tableLabel?: string | null): EnqueueItem[] {
  const ref = order.client_uuid;
  return [
    // the table is kept in the label, so an order list card can always say "Table T2" even before the menu / table list is loaded
    { op: { type: "create_order", order, accept_price_changes: false }, order_ref: ref, label: tableLabel ? `New order · Table ${tableLabel}` : "New order", dedupe_key: `order:${ref}` },
    { op: { type: "send_kot", order_client_uuid: ref }, order_ref: ref, label: "KOT", dedupe_key: `kot:${ref}:first` },
  ];
}

/** Additional items on an existing order: add_lines + a KOT for just that batch. */
export function buildAddItemsOps(orderUuid: string, batchUuid: string, lines: LineInput[]): EnqueueItem[] {
  return [
    { op: { type: "add_lines", order_client_uuid: orderUuid, batch_uuid: batchUuid, lines, accept_price_changes: false }, order_ref: orderUuid, label: "Add items", dedupe_key: `lines:${batchUuid}` },
    { op: { type: "send_kot", order_client_uuid: orderUuid }, order_ref: orderUuid, label: "KOT", dedupe_key: `kot:${orderUuid}:${batchUuid}` },
  ];
}
