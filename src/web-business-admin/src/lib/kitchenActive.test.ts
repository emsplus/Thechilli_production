import { describe, expect, it } from "vitest";
import { inKitchenOrderIds, isActiveTicket } from "./kitchenActive";

const kot = (order_id: string, status = "pending", done_at: string | null = null) => ({ order_id, status, done_at });

describe("kitchen / Orders agree on what is in the kitchen", () => {
  it("a ticket of a billed order is not active (it leaves the board when the bill is made)", () => {
    expect(isActiveTicket(kot("a"), { status: "billed" })).toBe(false);
    expect(isActiveTicket(kot("a"), { status: "sent_to_kitchen" })).toBe(true);
    expect(isActiveTicket(kot("a"), undefined)).toBe(true);
    expect(isActiveTicket(kot("a", "served"), { status: "sent_to_kitchen" })).toBe(false);
    expect(isActiveTicket(kot("a", "pending", "2026-11-03T10:00:00Z"), { status: "open" })).toBe(false);
  });
  it("In kitchen counts an order with an active ticket even when its own status lags (the 'In kitchen: 0' bug)", () => {
    const orders = [{ id: "a", status: "open" }, { id: "b", status: "billed" }, { id: "c", status: "sent_to_kitchen" }, { id: "d", status: "cancelled" }];
    const ids = inKitchenOrderIds(orders, [kot("a"), kot("b"), kot("d")]);
    expect([...ids].sort()).toEqual(["a", "c"]);
  });
  it("without ticket data (no kitchen permission) it falls back to the order status", () => {
    expect([...inKitchenOrderIds([{ id: "c", status: "sent_to_kitchen" }, { id: "a", status: "open" }], null)]).toEqual(["c"]);
  });
});
