import type { QueuedOp } from "./offlineDb";

/** Synced ops kept on the device for the Sync screen's history (the newest ones). */
export const KEEP_SYNCED = 30;

/**
 * Which synced queue ops may be deleted. The newest `keep` synced ops stay, except that an op is NEVER deleted while the counter still
 * shows its order as "Offline": the ticket flips to its server state by reading the synced `create_order` result (order id) from the
 * queue, so pruning it first left the oldest tickets of a long offline spell flagged "Offline" for good (QA chaos D-09, more than ~15 orders
 * in one sync). `heldRefs` = order refs (ticket ids) whose ticket is still marked offline; once it flips, its ops become prunable again.
 */
export function prunableOps(ops: QueuedOp[], heldRefs: ReadonlySet<string>, keep: number = KEEP_SYNCED): string[] {
  const synced = ops.filter((o) => o.status === "synced");
  const free = synced.filter((o) => !heldRefs.has(o.order_ref));
  return free.slice(0, Math.max(0, synced.length - keep)).map((o) => o.op_id);
}

/** Order refs of the tickets (saved drafts) that are still flagged offline. Drafts are the page's own ticket objects (`data.order.offline`). */
export function offlineRefs(drafts: { id: string; data: unknown }[]): Set<string> {
  const out = new Set<string>();
  for (const d of drafts) {
    const order = (d.data as { order?: { offline?: boolean } | null } | null)?.order;
    if (order?.offline === true) out.add(d.id);
  }
  return out;
}
