import { describe, expect, it } from "vitest";
import type { Customer, DiningTable, Kot, Order } from "@/lib/types";
import { counterQueue, elapsed } from "./counter-queue";

const order = (id: string, status: string, extra: Partial<Order> = {}): Order => ({
  id, client_uuid: id, order_type: "indoor", table_id: null, status, subtotal: "100.00",
  lines: [{ id: "l", item_id: "i", item_name: "Naan", unit_price: "50.00", quantity: 2, note: null }], ...extra,
});
const kot = (order_id: string, number: number, status: string, created_at = "2026-10-31T10:00:00Z"): Kot => ({ id: `${order_id}-${number}`, order_id, number, status, created_at, payload: [] });

describe("counter ticket queue", () => {
  const tables: DiningTable[] = [{ id: "t4", label: "T4", seats: 4, area: "indoor" }];
  const customers = [{ id: "c1", name: "Emir", phone: null }] as unknown as Customer[];

  it("lists only open / in-kitchen orders, with table, customer and the newest KOT state", () => {
    const q = counterQueue([
      order("a", "sent_to_kitchen", { table_id: "t4", customer_id: "c1" }),
      order("b", "open", { order_type: "takeaway" }),
      order("c", "billed"), order("d", "cancelled"),
    ], [kot("a", 1, "served"), kot("a", 2, "preparing", "2026-10-31T10:05:00Z"), kot("a", 3, "cancelled")], tables, customers);
    expect(q.map((x) => x.orderId)).toEqual(["a", "b"]);
    expect(q[0]).toMatchObject({ where: "T4", customer: "Emir", status: "cooking", since: "2026-10-31T10:05:00Z", items: 2 });
    expect(q[1]).toMatchObject({ where: "Takeaway", customer: null, status: "new", since: null });
  });
  it("maps every kitchen state", () => {
    const q = counterQueue([order("a", "sent_to_kitchen"), order("b", "sent_to_kitchen"), order("c", "sent_to_kitchen")],
      [kot("a", 1, "pending"), kot("b", 2, "ready"), kot("c", 3, "served")], [], []);
    expect(q.map((x) => x.status)).toEqual(["sent", "ready", "served"]);
  });
  it("KOT only: a sent order is just sent (no cooking / ready / served) and the ticket-age warning follows Done", () => {
    const q = counterQueue([order("a", "sent_to_kitchen"), order("b", "sent_to_kitchen"), order("c", "sent_to_kitchen"), order("d", "sent_to_kitchen"), order("e", "open")],
      [kot("a", 1, "pending"), kot("b", 2, "preparing"), kot("c", 3, "ready"), { ...kot("d", 4, "served"), done_at: "2026-10-31T10:09:00Z" }], [], [], "kot_only");
    expect(q.map((x) => x.status)).toEqual(["sent", "sent", "sent", "sent", "new"]);
    expect(q.map((x) => x.working)).toEqual([true, true, true, false, false]); // pending / preparing / ready are still open; Done is not
  });
  it("formats the elapsed timer", () => {
    const now = Date.parse("2026-10-31T10:04:05Z");
    expect(elapsed("2026-10-31T10:00:00Z", now)).toBe("4:05");
    expect(elapsed("2026-10-31T08:52:00Z", now)).toBe("1 h 12 m");
    expect(elapsed(null, now)).toBe("");
  });
});
