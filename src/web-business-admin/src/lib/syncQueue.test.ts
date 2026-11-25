import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedOp } from "./offlineDb";

// QA review L1: one operation the server refuses (422 / 409) used to keep the WHOLE queue pending for ever.
const store = new Map<string, QueuedOp>();
const calls: { ids: string[]; sentAt: string | undefined }[] = [];
let behaviour: (ops: { op_id: string; op: { order_client_uuid?: string; order?: { client_uuid: string } } }[]) => unknown = () => ({ results: [] });

vi.mock("./offlineDb", () => ({
  listOps: async () => [...store.values()].sort((a, b) => a.seq - b.seq),
  putOp: async (o: QueuedOp) => { store.set(o.op_id, { ...o }); },
  deleteOp: async (id: string) => { store.delete(id); },
  listDrafts: async () => [],
  unplacedDraftCount: async () => 0,
  wipeLocalData: async () => {},
}));
vi.mock("./api", async (orig) => {
  const real = await orig<typeof import("./api")>();
  return { ...real,
    auth: { token: "t", restaurantId: "r", userId: "u", accessToken: "x" },
    api: { restaurant: async () => ({}), me: async () => ({ role: "owner" }), heartbeat: async () => ({}),
      syncOperations: async (ops: never[]) => { calls.push({ ids: (ops as { op_id: string }[]).map((o) => o.op_id), sentAt: undefined }); return behaviour(ops); } } };
});

const op = (id: string, ref: string, seq: number, type = "create_order"): QueuedOp => ({
  op_id: id, seq, created_at: "2026-11-02T10:00:00Z", order_ref: ref, restaurant_id: "r", label: id, status: "pending", attempts: 0,
  op: { type, order_client_uuid: ref, order: { client_uuid: ref } } as never,
});

beforeEach(() => {
  store.clear(); calls.length = 0;
  const g = globalThis as Record<string, unknown>;
  g.window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal("navigator", { onLine: true, locks: undefined });
  g.localStorage = { getItem: () => "dev", setItem: () => {} };
});

describe("flush: a refused operation does not block the queue", () => {
  it("one 422 batch: the good order syncs, the refused one is marked failed with the reason and stays in the queue, its later step is not sent", async () => {
    const { ApiError } = await import("./api");
    const { flush } = await import("./sync");
    for (const o of [op("a1", "A", 1), op("a2", "A", 2, "send_kot"), op("b1", "B", 3), op("c1", "C", 4)]) store.set(o.op_id, o);
    behaviour = (ops) => {
      if (ops.length > 1 || ops[0].op_id === "a1") throw new ApiError(422, "Menu item is no longer available");
      return { results: [{ op_id: ops[0].op_id, status: "synced", detail: null, conflicts: null, data: { order_id: "srv" } }] };
    };
    await flush();
    expect(store.get("b1")!.status).toBe("synced");
    expect(store.get("c1")!.status).toBe("synced");
    const a1 = store.get("a1")!;
    expect(a1.status).toBe("failed");
    expect(a1.error).toMatch(/refused/);
    expect(a1.error).toMatch(/no longer available/);
    expect(store.get("a2")!.status).toBe("failed"); // follows a refused step of the same order: visible, not sent, not dropped
    expect(store.has("a1") && store.has("a2")).toBe(true);
    expect(calls[0].ids).toEqual(["a1", "a2", "b1", "c1"]); // the whole batch first ...
    expect(calls.slice(1).flatMap((c) => c.ids)).toEqual(["a1", "b1", "c1"]); // ... then one by one; a2 follows a refused step and is not sent again
    // the next flush has nothing left to send: the queue is no longer stuck
    calls.length = 0;
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("a connection error still keeps every op pending (nothing marked failed)", async () => {
    const { ApiError } = await import("./api");
    const { flush } = await import("./sync");
    for (const o of [op("x1", "X", 1), op("y1", "Y", 2)]) store.set(o.op_id, o);
    behaviour = () => { throw new ApiError(0, "Cannot reach server"); };
    await flush();
    expect([...store.values()].map((o) => o.status)).toEqual(["pending", "pending"]);
  });

  it("a 403 (permission / plan, the same for every op) keeps the ops pending too", async () => {
    const { ApiError } = await import("./api");
    const { flush } = await import("./sync");
    store.set("p1", op("p1", "P", 1));
    behaviour = () => { throw new ApiError(403, "Missing permission"); };
    await flush();
    expect(store.get("p1")!.status).toBe("pending");
  });
});
