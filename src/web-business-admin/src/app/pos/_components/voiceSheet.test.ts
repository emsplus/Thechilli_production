import { describe, expect, test } from "vitest";
import type { MenuItem } from "@/lib/types";
import { blockers, commandView, doneVerdict, fromClarifications, holdMessage, isSoft, lineSize, pickCommand, sizeSwitch, understoodBy, type DoneState } from "./voiceSheet";

const bc = { id: "bc", category_id: "c", name: "Butter Chicken", price: "280.00", is_active: true,
  variants: [{ id: "h", name: "Half", price_delta: "0.00" }, { id: "f", name: "Full", price_delta: "180.00" }] } as MenuItem;
const naan = { id: "n", category_id: "c", name: "Garlic Naan", price: "60.00", is_active: true, variants: [] } as unknown as MenuItem;
const three = { ...bc, id: "t", variants: [{ id: "s", name: "Small", price_delta: "0.00" }, { id: "m", name: "Medium", price_delta: "40.00" }, { id: "l", name: "Large", price_delta: "90.50" }] } as MenuItem;

describe("sizes", () => {
  test("Half by default with a one-tap 'Full +₹180'; on Full the switch goes back to Half", () => {
    expect(lineSize(bc, null, true)).toEqual({ variantId: "h", defaulted: true });
    expect(sizeSwitch(bc, "h")).toEqual({ current: "Half", to: [{ id: "f", name: "Full", label: "Full +₹180" }] });
    expect(sizeSwitch(bc, "f")).toEqual({ current: "Full", to: [{ id: "h", name: "Half", label: "Half" }] });
  });
  test("a size that was said is kept", () => {
    expect(lineSize(bc, "f", false)).toEqual({ variantId: "f", defaulted: false });
  });
  test("a dish without sizes has no switch", () => {
    expect(sizeSwitch(naan, null)).toBeNull();
    expect(lineSize(naan, null, false)).toEqual({ variantId: null, defaulted: false });
  });
  test("three sizes: two switches with their price difference", () => {
    expect(sizeSwitch(three, "s")!.to.map((x) => x.label)).toEqual(["Medium +₹40", "Large +₹90.50"]);
  });
});

describe("clarifications", () => {
  const has = (id: string) => ["cb", "mb", "vb", "bc"].includes(id);
  test("ambiguous dishes become asks with every option; never dropped", () => {
    const r = fromClarifications({ clarifications: [
      { heard_text: "ek biryani", reason: "ambiguous_item", options: [{ item_id: "cb", item_name: "Chicken Biryani" }, { item_id: "mb", item_name: "Mutton Biryani" }, { item_id: "vb", item_name: "Veg Biryani" }], quantity: 1, note: null },
      { heard_text: "dedh butter chicken", reason: "fractional_quantity", options: [{ item_id: "bc", item_name: "Butter Chicken" }], quantity: null, note: null },
      { heard_text: "teen", reason: "quantity_without_dish", options: [], quantity: 3, note: null },
      { heard_text: "ek pizza", reason: "ambiguous_item", options: [{ item_id: "gone1", item_name: "Old" }, { item_id: "gone2", item_name: "Old2" }], quantity: 1, note: null },
    ] }, has);
    expect(r.asks).toEqual([{ heard: "ek biryani", qty: 1, note: null, options: ["cb", "mb", "vb"], reason: "ambiguous_item" }]);
    expect(r.check.map((c) => c.options)).toEqual([["bc"]]);
    expect(r.unmatched).toEqual(["teen", "ek pizza"]);
  });
  test("older servers without clarifications", () => {
    expect(fromClarifications({}, has)).toEqual({ asks: [], check: [], unmatched: [] });
  });
});

test("blockers: a dish to choose and a sold-out dish, in words", () => {
  const b = blockers([{ ask: true, heard: "ek biryani", itemId: "cb" }, { heard: "chai", itemId: "chai" }, { heard: "naan", itemId: "n" }],
    (id) => ({ chai: "Masala Chai" } as Record<string, string>)[id] ?? id, (id) => id === "chai");
  expect(b).toEqual(["Choose the dish for “ek biryani”", "Masala Chai is sold out: choose another dish or drop it"]);
});

test("commands: confirm buttons; cancel is a danger action; the device wins over the server", () => {
  expect(commandView("place").button).toBe("Place and send to kitchen");
  expect(commandView("kot").button).toBe("Add and send to kitchen");
  expect(commandView("clear").tone).toBe("danger");
  expect(pickCommand(null, "kot")).toBe("kot");
  expect(pickCommand("place", "clear")).toBe("place");
  expect(pickCommand(null, null)).toBeNull();
});

test("understoodBy: device vs server vs AI", () => {
  expect(understoodBy("live", undefined).short).toBe("Understood on device");
  expect(understoodBy("typed", false).short).toBe("Understood on device");
  expect(understoodBy("ai-text", false).short).toBe("Understood by the server");
  expect(understoodBy("ai-text", true)).toEqual({ short: "Checked with AI", ai: true });
  expect(understoodBy("ai-audio", undefined).short).toBe("Checked with AI");
  expect(understoodBy("live", false, 2).short).toBe("Understood by the server");
});

describe("done: add everything that can be added (voiceSheet.ts doneVerdict)", () => {
  const names: Record<string, string> = { a: "Butter Chicken", b: "Garlic Naan", c: "Lamb Karahi", d: "Tandoori Chicken" };
  const nameOf = (id: string) => names[id] ?? id;
  const none = () => false;
  const base: DoneState = { lines: [], unmatched: [], tableAmbiguous: null, busyTable: null, command: null, billOk: true, hasOther: false };
  const line = (itemId: string, over: Partial<DoneState["lines"][number]> = {}) => ({ itemId, heard: names[itemId].toLowerCase(), qty: 1, issues: [], ...over });

  test("the owner's case: 3 dishes, one with a soft flag, then done -> all 3 are added, the doubtful one is marked", () => {
    const v = doneVerdict({ ...base, lines: [line("a", { qty: 2 }), line("b", { issues: ["not sure about this dish"] }), line("c")] }, nameOf, none);
    expect(v).toEqual({ kind: "add", check: ["Garlic Naan"] });
  });
  test("every soft flag adds: homophone / big quantity / option", () => {
    for (const issue of ["check the quantity (heard “to”)", "check the quantity (25)", "check the option", "option “jumbo” not on the menu: regular chosen", "not sure about this dish"]) {
      expect(doneVerdict({ ...base, lines: [line("a", { issues: [issue] })] }, nameOf, none).kind, issue).toBe("add");
    }
  });
  test("a clean order adds with nothing to check", () => {
    expect(doneVerdict({ ...base, lines: [line("a"), line("b")] }, nameOf, none)).toEqual({ kind: "add", check: [] });
  });
  test("a dish still to choose stays: the clear ones are added, the message names the dish", () => {
    const v = doneVerdict({ ...base, lines: [line("a"), line("b"), line("c", { ask: true, heard: "ek tandoori" })] }, nameOf, none);
    expect(v.kind).toBe("partial");
    if (v.kind !== "partial") return;
    expect(v.added).toBe(2);
    expect(holdMessage(v.holds, v.added)).toBe("Added 2 items. Choose the dish for “ek tandoori” to add the rest.");
  });
  test("a sold-out dish and an unmatched phrase stay, the rest is added", () => {
    const v = doneVerdict({ ...base, lines: [line("a"), line("b")], unmatched: ["flibbertigibbet"] }, nameOf, (id) => id === "b");
    expect(v.kind).toBe("partial");
    if (v.kind === "partial") { expect(v.added).toBe(1); expect(v.holds.map((h) => h.say)).toEqual(["choose another dish for Garlic Naan, it is sold out", "pick a dish for “flibbertigibbet” or drop it"]); }
  });
  test("nothing can be added: nothing is, and the message says 'Almost there: choose the dish for “x” first'", () => {
    const v = doneVerdict({ ...base, lines: [line("a", { ask: true, heard: "ek biryani" })] }, nameOf, none);
    expect(v).toMatchObject({ kind: "hold", message: "Almost there: choose the dish for “ek biryani” first" });
  });
  test("a table to choose / a busy table / a billed bill hold the whole order (nothing is added)", () => {
    const lines = [line("a")];
    expect(doneVerdict({ ...base, lines, tableAmbiguous: "3" }, nameOf, none)).toMatchObject({ kind: "hold", message: "Almost there: choose the table for “3” first" });
    expect(doneVerdict({ ...base, lines, busyTable: "T3" }, nameOf, none).kind).toBe("hold");
    expect(doneVerdict({ ...base, lines, billOk: false }, nameOf, none).kind).toBe("hold");
  });
  test("a spoken command is never run by done: the sheet keeps its confirm tap (nothing is added)", () => {
    for (const command of ["place", "kot", "clear"] as const) expect(doneVerdict({ ...base, lines: [line("a")], command }, nameOf, none)).toEqual({ kind: "command" });
  });
  test("nothing understood: just stop listening; only a customer / table on the sheet: stay", () => {
    expect(doneVerdict(base, nameOf, none)).toEqual({ kind: "empty" });
    expect(doneVerdict({ ...base, hasOther: true }, nameOf, none)).toEqual({ kind: "stay" });
  });
  test("a soft flag is only a flag on a dish that can be added", () => {
    expect(isSoft({ issues: ["x"] }, false)).toBe(true);
    expect(isSoft({ issues: ["x"], ask: true }, false)).toBe(false);
    expect(isSoft({ issues: ["x"] }, true)).toBe(false);
    expect(isSoft({ issues: [] }, false)).toBe(false);
  });
});
