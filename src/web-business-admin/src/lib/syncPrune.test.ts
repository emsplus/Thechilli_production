import { describe, expect, it } from "vitest";
import type { QueuedOp } from "./offlineDb";
import { KEEP_SYNCED, offlineRefs, prunableOps } from "./syncPrune";

/** QA chaos D-09: more than ~15 offline orders in one sync left the oldest counter tickets flagged "Offline". */
const op = (ref: string, type: "create_order" | "send_kot" | "finalize_bill", seq: number, status: QueuedOp["status"] = "synced"): QueuedOp => ({
  op_id: `${ref}:${type}`, seq, created_at: "2026-11-02T10:00:00Z", order_ref: ref, label: ref, status, attempts: 1,
  op: { type } as unknown as QueuedOp["op"], result: type === "create_order" ? { order_id: `srv-${ref}` } : undefined,
});
const night = (n: number) => Array.from({ length: n }, (_, i) => `ord-${i + 1}`).flatMap((r, i) => [op(r, "create_order", i * 3), op(r, "send_kot", i * 3 + 1), op(r, "finalize_bill", i * 3 + 2)]);

describe("pruning of synced queue ops", () => {
  it("keeps the newest 30 synced ops, as before, when no ticket is flagged offline", () => {
    const ops = night(20); // 60 synced ops
    const gone = new Set(prunableOps(ops, new Set()));
    expect(gone.size).toBe(60 - KEEP_SYNCED);
    expect(gone.has("ord-1:create_order")).toBe(true);
    expect(gone.has("ord-20:finalize_bill")).toBe(false);
  });

  it("never deletes the create_order of a ticket that is still flagged offline (the D-09 case: 20 orders in one sync)", () => {
    const ops = night(20);
    const held = new Set(Array.from({ length: 20 }, (_, i) => `ord-${i + 1}`)); // none of the 20 tickets has flipped yet
    expect(prunableOps(ops, held)).toEqual([]);
    // old behaviour: the 30 oldest ops (orders 1 to 10) were deleted, their tickets stayed "Offline" for good
    const oldBehaviour = ops.slice(0, ops.length - KEEP_SYNCED).map((o) => o.op_id);
    expect(oldBehaviour).toContain("ord-1:create_order");
  });

  it("releases a ticket's ops once it has flipped (no longer held) and never touches unsynced ops", () => {
    const ops = [...night(20), op("ord-21", "create_order", 99, "pending")];
    const held = new Set(["ord-1", "ord-2"]);
    const gone = new Set(prunableOps(ops, held));
    expect(gone.has("ord-1:create_order")).toBe(false);
    expect(gone.has("ord-3:create_order")).toBe(true);
    expect(gone.has("ord-21:create_order")).toBe(false);
  });

  it("reads the held refs from saved tickets flagged offline", () => {
    const refs = offlineRefs([
      { id: "a", data: { order: { offline: true } } }, { id: "b", data: { order: { offline: false } } },
      { id: "c", data: { order: null } }, { id: "d", data: null }, { id: "e", data: {} },
    ]);
    expect([...refs]).toEqual(["a"]);
  });
});
