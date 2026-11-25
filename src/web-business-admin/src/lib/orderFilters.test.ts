import { describe, expect, it } from "vitest";
import { billAwaitsPayment, countOrders, filterOrders, groupOf, orderCanBeBilled, ORDER_FILTERS, type OrderFilter } from "./orderFilters";

const o = (id: string, status: string, min: number, extra: Record<string, unknown> = {}) => ({ id, status, created_at: new Date(Date.UTC(2026, 9, 31, 10, min)).toISOString(), ...extra });
const orders = [o("paid1", "billed", 1), o("c1", "cancelled", 9, { cancel_reason: "Customer left" }), o("open1", "open", 2), o("k1", "sent_to_kitchen", 5), o("unpaid1", "billed", 3), o("void1", "billed", 8), o("paid2", "billed", 7),
  o("m1", "cancelled", 10, { kind: "merged", merged_into_number: 12 }), o("m2", "cancelled", 11, { cancel_reason: "Merged into order 3f2a9c10-1111-4222-8333-444455556666" })];
const bills: Record<string, { status?: string; balance_due: string }> = {
  paid1: { balance_due: "0.00" }, unpaid1: { balance_due: "120.00" }, void1: { status: "voided", balance_due: "0.00" }, paid2: { balance_due: "0" },
};
const billOf = (x: { id: string }) => bills[x.id];

describe("orders filter chips", () => {
  it("every order is in exactly one chip", () => {
    expect(orders.map((x) => groupOf(x, billOf(x)))).toEqual(["paid", "cancelled", "open", "kitchen", "unpaid", "cancelled", "paid", "merged", "merged"]);
  });
  it("'All (5)' left out the cancelled and voided orders: All now includes every order", () => {
    expect(filterOrders(orders, billOf, "all")).toHaveLength(orders.length);
    expect(countOrders(orders, billOf).all).toBe(orders.length);
  });
  it("the counts on the chips add up: All = the sum of the others", () => {
    const c = countOrders(orders, billOf, new Set(["open1"]));
    const others = (Object.keys(c) as OrderFilter[]).filter((k) => k !== "all").reduce((n, k) => n + c[k], 0);
    expect(others).toBe(c.all);
    expect(c).toEqual({ all: 9, open: 0, kitchen: 2, unpaid: 1, paid: 2, cancelled: 2, merged: 2 });
    // and per chip the list length equals its count
    for (const f of ORDER_FILTERS) expect(filterOrders(orders, billOf, f.value, new Set(["open1"]))).toHaveLength(c[f.value]);
  });
  it("property: any mix of orders, All = sum of the other chips and each chip list matches its count", () => {
    let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const statuses = ["open", "sent_to_kitchen", "billed", "cancelled"];
    for (let run = 0; run < 200; run++) {
      const list = Array.from({ length: Math.floor(rnd() * 20) }, (_, i) => o(`x${i}`, statuses[Math.floor(rnd() * 4)], i, rnd() < 0.2 ? { kind: "merged" } : {}));
      const b: Record<string, { status?: string; balance_due: string }> = {};
      for (const x of list) if (x.status === "billed") b[x.id] = rnd() < 0.5 ? { balance_due: "0.00" } : rnd() < 0.5 ? { balance_due: "10.00" } : { status: "voided", balance_due: "0.00" };
      const k = new Set(list.filter(() => rnd() < 0.3).map((x) => x.id));
      const c = countOrders(list, (x) => b[x.id], k);
      expect(c.open + c.kitchen + c.unpaid + c.paid + c.cancelled + c.merged).toBe(c.all);
      expect(c.all).toBe(list.length);
      for (const f of ORDER_FILTERS) expect(filterOrders(list, (x) => b[x.id], f.value, k)).toHaveLength(c[f.value]);
    }
  });
  it("merged orders are never in the Cancelled chip", () => {
    expect(filterOrders(orders, billOf, "cancelled").map((x) => x.id)).toEqual(["c1", "void1"]);
    expect(filterOrders(orders, billOf, "merged").map((x) => x.id)).toEqual(["m2", "m1"]);
  });
  it("running first, then paid, then cancelled / merged", () => {
    expect(filterOrders(orders, billOf, "all").map((x) => x.id)).toEqual(["k1", "unpaid1", "open1", "paid2", "paid1", "m2", "m1", "c1", "void1"]);
  });
});

describe("orders: kitchen tile reads the same tickets as the Kitchen board", () => {
  it("an open order holding an active ticket counts as In kitchen (was 0 while the board showed it)", () => {
    const ids = new Set(["open1"]);
    expect(countOrders(orders, billOf, ids).kitchen).toBe(2);
    expect(filterOrders(orders, billOf, "kitchen", ids).map((x) => x.id)).toEqual(["k1", "open1"]);
    expect(countOrders(orders, billOf).kitchen).toBe(1);
  });
});

describe("Take payment / Make bill offers", () => {
  it("Take payment on every awaiting bill: balance left, not voided or replaced", () => {
    expect(billAwaitsPayment({ balance_due: "120.00" })).toBe(true);
    expect(billAwaitsPayment({ status: "active", balance_due: "0.01" })).toBe(true);
    expect(billAwaitsPayment({ balance_due: "0.00" })).toBe(false);
    expect(billAwaitsPayment({ status: "voided", balance_due: "50.00" })).toBe(false);
    expect(billAwaitsPayment({ status: "superseded", balance_due: "50.00" })).toBe(false);
    expect(billAwaitsPayment(undefined)).toBe(false);
  });
  it("Make bill on every unbilled open / in-kitchen order, not on billed, cancelled or merged ones", () => {
    expect(orderCanBeBilled({ status: "open" })).toBe(true);
    expect(orderCanBeBilled({ status: "sent_to_kitchen" })).toBe(true);
    expect(orderCanBeBilled({ status: "sent_to_kitchen" }, { balance_due: "1" } as never)).toBe(false);
    expect(orderCanBeBilled({ status: "billed" })).toBe(false);
    expect(orderCanBeBilled({ status: "cancelled" })).toBe(false);
    expect(orderCanBeBilled({ status: "open", kind: "merged" })).toBe(false);
  });
});
