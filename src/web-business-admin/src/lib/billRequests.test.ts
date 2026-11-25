import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillRequest } from "./types";

const h = vi.hoisted(() => ({ list: [] as unknown[], fail: null as null | { status: number }, store: new Map<string, string>() }));
vi.mock("./api", () => {
  class ApiError extends Error { constructor(public status: number) { super(`HTTP ${status}`); } }
  return {
    ApiError,
    auth: { token: "t", userId: "u1" },
    api: { billRequests: async () => { if (h.fail) throw new ApiError(h.fail.status); return h.list; } },
  };
});
// node test environment: a minimal localStorage
vi.stubGlobal("localStorage", { getItem: (k: string) => h.store.get(k) ?? null, setItem: (k: string, v: string) => void h.store.set(k, v), removeItem: (k: string) => void h.store.delete(k) });

import { arrivedSince, isReminder, markBillRequestsRead, pruneSeen, refreshBillRequests, reminderText, requestKey, requestLabel, resetBillRequests, splitQueue, unreadOf } from "./billRequests";

const req = (id: string, at = "2026-11-02T10:00:00Z", table: string | null = "T1"): BillRequest => ({
  order_id: id, table_id: table ? `tid-${table}` : null, table_label: table, token_number: 7, requested_at: at, requested_by: "w", requested_by_name: "Ravi",
  waiter_id: "w", waiter_name: "Ravi", item_count: 2, subtotal: "500.00", note: null });

describe("bill request helpers", () => {
  it("labels a request by table, else token", () => {
    expect(requestLabel(req("a"))).toBe("Table T1");
    expect(requestLabel(req("a", undefined, null))).toBe("Token 7");
    expect(requestLabel({ table_label: null, token_number: null })).toBe("Order");
  });
  it("unread = not seen; a NEW request on the same order (new time) is unread again", () => {
    const seen = new Set([requestKey(req("a"))]);
    expect(unreadOf([req("a"), req("b")], seen).map((r) => r.order_id)).toEqual(["b"]);
    expect(unreadOf([req("a", "2026-11-02T11:00:00Z")], seen)).toHaveLength(1);
  });
  it("arrivals: none on the first load, then only the new ones", () => {
    expect(arrivedSince(null, [req("a")])).toEqual([]);
    expect(arrivedSince([req("a")], [req("a"), req("b")]).map((r) => r.order_id)).toEqual(["b"]);
  });
  it("read marks of answered requests are pruned", () => {
    expect([...pruneSeen(new Set([requestKey(req("a")), requestKey(req("gone"))]), [req("a")])]).toEqual([requestKey(req("a"))]);
  });
});

describe("bill request store", () => {
  beforeEach(() => { resetBillRequests(); h.list = []; h.fail = null; h.store.clear(); });
  const snap = async () => { const m = await import("./billRequests"); return m; };

  it("loads, marks read per user (stored), and a request opened before the list loaded is read after it", async () => {
    markBillRequestsRead(["a"]); // e.g. /pos?order=a opened on a hard load
    h.list = [req("a"), req("b")];
    await refreshBillRequests();
    const stored = JSON.parse(h.store.get("chilli.billRequests.seen.u1") ?? "[]") as string[];
    expect(stored).toEqual([requestKey(req("a"))]);
    markBillRequestsRead("all");
    expect((JSON.parse(h.store.get("chilli.billRequests.seen.u1")!) as string[]).sort()).toEqual([requestKey(req("a")), requestKey(req("b"))].sort());
    // the bill was made: the request leaves the queue and its read mark is dropped
    h.list = [req("b")];
    await refreshBillRequests();
    expect(JSON.parse(h.store.get("chilli.billRequests.seen.u1")!)).toEqual([requestKey(req("b"))]);
    expect((await snap()).unreadOf(h.list as BillRequest[], new Set(JSON.parse(h.store.get("chilli.billRequests.seen.u1")!) as string[]))).toEqual([]);
  });

  it("a user without bills.finalize (403) gets nothing and no error loop", async () => {
    h.fail = { status: 403 };
    await expect(refreshBillRequests()).resolves.toBeUndefined();
    expect(h.store.size).toBe(0);
  });
});

describe("bell guards", () => {
  it("plays no sound, polls at most every 10 s, and never shows the word POS", async () => {
    const { readFileSync } = await import("node:fs");
    const { BILL_POLL_MS } = await import("./billRequests");
    expect(BILL_POLL_MS).toBeLessThanOrEqual(10_000);
    for (const f of ["src/lib/billRequests.ts", "src/components/shell/notification-bell.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/new Audio|AudioContext|\.play\(|vibrate\(/);
      expect(src.replace(/\/pos\?/g, "")).not.toMatch(/\bPOS\b/);
    }
    // polling stops while the tab is hidden
    expect(readFileSync("src/lib/billRequests.ts", "utf8")).toMatch(/if \(!document\.hidden\) void refreshBillRequests\(\)/);
  });
});

// ------------------------------------------------------------------ payment reminders (billed, unpaid: "Remind the counter")
const rem = (id: string, at = "2026-11-03T10:00:00Z", by: string | null = "Ramesh"): BillRequest => ({
  ...req(id, at, "T2"), kind: "payment_reminder", bill_id: `b-${id}`, invoice_number: "INV/2026-27/000123", balance_due: "760.00", table_area: "indoor", requested_by_name: by });
const inr = (v: string) => `₹${v}`;

describe("payment reminders", () => {
  it("only kind payment_reminder is a reminder; an older server's rows (no kind) stay bill requests", () => {
    expect(isReminder(rem("a"))).toBe(true);
    expect(isReminder(req("a"))).toBe(false);
    expect(isReminder({ kind: "bill_request" })).toBe(false);
    const { requests, reminders } = splitQueue([req("a"), rem("b"), req("c")]);
    expect(requests.map((r) => r.order_id)).toEqual(["a", "c"]);
    expect(reminders.map((r) => r.order_id)).toEqual(["b"]);
  });
  it("says it in plain words: table, bill, balance, who asked", () => {
    expect(reminderText(rem("a"), inr)).toBe("Table T2 is waiting to pay: bill INV/2026-27/000123, ₹760.00 (asked by Ramesh)");
    expect(reminderText({ ...rem("a"), requested_by_name: null, waiter_name: "Asha" }, inr)).toContain("(asked by Asha)");
    expect(reminderText({ ...rem("a"), requested_by_name: null, waiter_name: null }, inr)).toBe("Table T2 is waiting to pay: bill INV/2026-27/000123, ₹760.00");
    expect(reminderText({ ...rem("a"), table_label: null, token_number: 12 }, inr)).toMatch(/^Token 12 is waiting to pay/);
  });
  it("a second reminder for the same bill (new time) is unread and 'arrives' again, so the chime plays again", () => {
    const first = rem("a"), again = rem("a", "2026-11-03T10:05:00Z");
    expect(unreadOf([again], new Set([requestKey(first)]))).toHaveLength(1);
    expect(arrivedSince([first], [again]).map(requestKey)).toEqual([requestKey(again)]);
  });
});

describe("payment reminders in the store", () => {
  beforeEach(() => { resetBillRequests(); h.list = []; h.fail = null; h.store.clear(); });
  it("a reminder is read per user like a bill request, and leaves the list (with its read mark) once the bill is paid", async () => {
    h.list = [rem("a"), req("b")];
    await refreshBillRequests();
    markBillRequestsRead(["a"]);
    expect(JSON.parse(h.store.get("chilli.billRequests.seen.u1")!)).toEqual([requestKey(rem("a"))]);
    h.list = [req("b")]; // paid at the counter: the server no longer lists it
    await refreshBillRequests();
    expect(JSON.parse(h.store.get("chilli.billRequests.seen.u1")!)).toEqual([]);
  });
  it("a reminder that appears between two polls is an arrival", async () => {
    const m = await import("./billRequests");
    h.list = [req("b")];
    await m.refreshBillRequests();
    h.list = [req("b"), rem("c")];
    expect(m.arrivedSince([req("b")], h.list as BillRequest[]).filter(isReminder).map((r) => r.order_id)).toEqual(["c"]);
  });
});
