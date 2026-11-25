import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { friendlyError } from "@/lib/orderErrors";
import type { MenuItem } from "@/lib/types";
import { addLine, apiLine, defaultVariantId, otherVariant, setLineNote, setLineVariant, variantDelta } from "./tickets";
import { kotPrintMessage, lineIdsOf } from "./usePosActions";

const bc: MenuItem = { id: "bc", category_id: "c", name: "Butter Chicken", price: "280.00", is_active: true,
  variants: [{ id: "full", name: "Full", price_delta: "180.00" }, { id: "half", name: "Half", price_delta: "0.00" }] };
const chai: MenuItem = { id: "chai", category_id: "c", name: "Masala Chai", price: "40.00", is_active: true, variants: [] };

describe("Half / Full (C-03)", () => {
  it("defaults to the cheapest size, never to no size", () => {
    expect(defaultVariantId(bc)).toBe("half");
    expect(defaultVariantId(chai)).toBeNull();
  });
  it("offers the other size with the price difference", () => {
    expect(otherVariant(bc, "half")?.name).toBe("Full");
    expect(variantDelta(bc, "full")).toBe("+₹180");
    expect(variantDelta(bc, "half")).toBe("");
  });
  it("Change to Full re-prices the line and merges into an existing Full line", () => {
    let lines = addLine([], bc, "half");
    lines = setLineVariant(lines, lines[0].key, "full");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ variantId: "full", unit: "460.00", label: "Butter Chicken (Full)" });
    lines = addLine(lines, bc, "half");
    lines = setLineVariant(lines, lines[1].key, "full");
    expect(lines).toHaveLength(1);
    expect(lines[0].qty).toBe(2);
  });
});

describe("line notes (C-09)", () => {
  it("a note makes its own line and goes to the server", () => {
    let lines = addLine(addLine([], chai, null), chai, null);
    lines = setLineNote(lines, lines[0].key, "Less sugar");
    expect(lines[0].note).toBe("Less sugar");
    expect(apiLine(lines[0])).toMatchObject({ item_id: "chai", quantity: 2, note: "Less sugar" });
    lines = addLine(lines, chai, null);
    expect(lines).toHaveLength(2);
    lines = setLineNote(lines, lines[0].key, "");
    expect(lines).toHaveLength(1);
    expect(lines[0].qty).toBe(3);
  });
});

describe("kitchen print result (C-04)", () => {
  it("never says success when the printer failed", () => {
    expect(kotPrintMessage({ number: 4, print: { status: "failed" } })).toMatchObject({ tone: "error", title: "Printer did not respond" });
    expect(kotPrintMessage({ number: 4, print: { status: "no_printer" } }).title).toBe("Sent to kitchen screen (no printer set up)");
    expect(kotPrintMessage({ number: 4, print: { status: "sent" } }).title).toBe("Sent to kitchen printer");
    expect(kotPrintMessage({ number: 4 }).title).toBe("Kitchen ticket #4 sent");
  });
});

describe("server line ids", () => {
  it("maps cart keys to the response's lines in order, skipping known ones", () => {
    const lines = addLine(addLine([], chai, null), bc, "half");
    const ids = lineIdsOf(lines, { lines: [{ id: "a" }, { id: "b" }] as never });
    expect(ids).toEqual({ [lines[0].key]: "a", [lines[1].key]: "b" });
    const more = addLine([], chai, null, undefined, "No sugar");
    expect(lineIdsOf(more, { lines: [{ id: "a" }, { id: "b" }, { id: "c" }] as never }, ids)).toEqual({ ...ids, [more[0].key]: "c" });
  });
});

describe("plain-language errors (C-22)", () => {
  it("maps codes and raw texts, never shows raw detail", () => {
    expect(friendlyError(new ApiError(409, "x", "kitchen_ticket_required")).title).toBe("Send the order to the kitchen first");
    expect(friendlyError(new ApiError(409, "x", "table_has_open_order")).title).toBe("This table already has an order");
    expect(friendlyError(new ApiError(422, "Input should be less than or equal to 999")).title).toBe("That quantity is not possible");
    expect(friendlyError(new ApiError(404, "Menu item 1234 not found")).title).toBe("A dish is no longer on the menu");
    expect(friendlyError(new ApiError(0, "Cannot reach server"))).toMatchObject({ title: "No internet connection", retry: true });
    expect(friendlyError(new ApiError(500, "Internal server error")).title).toBe("The server had a problem");
    expect(friendlyError(new ApiError(403, "Missing permission: orders.cancel")).title).toBe("A manager must do this");
  });
});
