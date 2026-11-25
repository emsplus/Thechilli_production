import { describe, expect, it } from "vitest";
import { stageOf } from "./tickets";
import type { Ticket } from "./types";

// A waiter's order that the kitchen already has is opened on the counter with kot "sent": it is in the kitchen stage, so "Make bill"
// is offered straight away instead of asking for another kitchen ticket.
const base = { id: "t", no: 1, lines: [], type: "dine_in", tableId: "T1", customerId: "", order: { id: "o" }, kot: null } as unknown as Ticket;

describe("server order already in the kitchen", () => {
  it("is in the kitchen stage when opened with kot 'sent'", () => {
    expect(stageOf({ ...base, kot: "sent" })).toBe("kitchen");
  });
  it("is only placed (not in the kitchen) when kot is null", () => {
    expect(stageOf(base)).toBe("placed");
  });
});
