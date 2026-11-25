import { describe, expect, it } from "vitest";
import { tableExtras, tableLive } from "./tableStatus";
import type { TableStatus } from "./extras";
import type { Order } from "./types";

const o = (table_id: string | null, status: string, subtotal: string, lines = 1): Order => ({ id: Math.random().toString(), client_uuid: "x", order_type: "indoor", table_id, status, lines: Array.from({ length: lines }, (_, i) => ({ id: String(i), item_id: "i", item_name: "n", unit_price: "1", quantity: 1, note: null })), subtotal });

describe("tableLive", () => {
  it("marks tables with an unpaid order, kitchen wins, totals add exactly", () => {
    const m = tableLive([o("t1", "open", "10.10"), o("t1", "sent_to_kitchen", "20.20", 2), o("t2", "open", "5.00"), o("t3", "billed", "9"), o("t4", "cancelled", "9"), o(null, "open", "9")]);
    expect(m.get("t1")).toEqual({ state: "kitchen", orders: 2, lines: 3, total: "30.30" });
    expect(m.get("t2")?.state).toBe("occupied");
    expect(m.has("t3")).toBe(false);
    expect(m.has("t4")).toBe(false);
    expect(m.size).toBe(2);
  });
});

describe("tableExtras (GET /tables/status): who took the table and its bill state", () => {
  const row = (id: string, status: TableStatus["status"], orders: NonNullable<TableStatus["orders"]>): TableStatus =>
    ({ table_id: id, label: id, seats: 4, area: "indoor", status, reservation: null, orders });
  it("a waiter-app order shows its waiter; bill asked and bill made are told apart; free tables are absent", () => {
    const m = tableExtras([
      row("T1", "occupied", [{ order_id: "o1", status: "open", waiter_name: "Ravi" }]),
      row("T2", "bill_requested", [{ order_id: "o2", status: "sent_to_kitchen", waiter_name: "Asha", bill_requested_at: "2026-11-02T10:00:00Z" }]),
      row("T3", "bill_printed", [{ order_id: "o3", status: "billed", waiter_name: "Ravi", bill_id: "b3" }]),
      row("T4", "free", []),
    ]);
    expect(m.get("T1")).toEqual({ waiters: ["Ravi"], billAsked: false, billMade: false, orderId: "o1" });
    expect(m.get("T2")).toMatchObject({ billAsked: true, billMade: false, orderId: "o2" });
    expect(m.get("T3")).toMatchObject({ billMade: true });
    expect(m.has("T4")).toBe(false);
  });
  it("older servers without orders on the row: nothing extra", () => {
    expect(tableExtras([{ table_id: "T1", label: "T1", seats: 2, area: "indoor", status: "occupied", reservation: null }]).size).toBe(0);
  });
});
