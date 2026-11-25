import { describe, expect, it, test, vi } from "vitest";
import type { Category, DiningTable, MenuItem } from "./types";
import { buildVoiceMenu } from "./voiceParse";
import { directDecision, rateOk } from "./voiceDirect";

// Direct mode (owner, 2026-11-02; docs/VOICE_QA_REPORT.md B19): dishes into the selected bill without "Hey Zonov".
const cats = [{ id: "c1", name: "Mains" }, { id: "c2", name: "Drinks" }, { id: "c3", name: "Breads" }] as Category[];
const items = [
  { id: "bc", category_id: "c1", name: "Butter Chicken", price: "280", is_active: true, variants: [{ id: "h", name: "Half", price_delta: "0" }, { id: "f", name: "Full", price_delta: "180" }] },
  { id: "mp", category_id: "c1", name: "Matar Paneer", price: "240", is_active: true, variants: [] },
  { id: "sl", category_id: "c2", name: "Sweet Lassi", price: "80", is_active: true, variants: [] },
  { id: "bn", category_id: "c3", name: "Butter Naan", price: "50", is_active: true, variants: [] },
] as unknown as MenuItem[];
const vm = buildVoiceMenu(items, cats, [{ phrase: "lassi", menu_item_id: "sl", variant_id: null }] as never);
const tables = [{ id: "t4", label: "T4", area: "indoor" }, { id: "t5", label: "T5", area: "indoor" }] as unknown as DiningTable[];
const d = (t: string, billHasLines = true) => directDecision(t, vm, { tables, billHasLines });

describe("dishes are added", () => {
  test.each([
    ["one butter chicken", [["bc", 1]]],
    ["ek butter chicken full", [["bc", 1]]],
    ["two lassi", [["sl", 2]]],
    ["do matar paneer aur ek butter naan", [["mp", 2], ["bn", 1]]],
  ])("%j", (t, want) => {
    const r = d(t);
    expect(r.kind).toBe("add");
    if (r.kind === "add") expect(r.lines.map((l) => [l.itemId, l.qty])).toEqual(want);
  });
  test("bill targeting: 'bill 2 me ek butter chicken', 'bill number 3 add two lassi'", () => {
    const a = d("bill 2 me ek butter chicken");
    expect(a).toMatchObject({ kind: "add", billNo: 2 });
    const b = d("bill number 3 add two lassi");
    expect(b).toMatchObject({ kind: "add", billNo: 3 });
    if (b.kind === "add") expect(b.lines.map((l) => [l.itemId, l.qty])).toEqual([["sl", 2]]);
  });
  test("table targeting: 'table 4 me ek matar paneer' -> T4; an unknown table is ignored, never created", () => {
    expect(d("table 4 me ek matar paneer")).toMatchObject({ kind: "add", table: { id: "t4", label: "T4" } });
    expect(d("table 9 me ek matar paneer")).toMatchObject({ kind: "ignore" });
  });
});

describe("chatter and doubtful phrases are ignored", () => {
  test.each([
    "the butter chicken was really good", "we need more ketchup", "kya haal hai bhai", "lassi", "hello", "", "table five wants the bill",
    "send me the report", "two coffee",
  ])("%j", (t) => { expect(d(t).kind).toBe("ignore"); });
});

describe("commands and undo without the wake phrase", () => {
  test("place / send only when the bill has dishes", () => {
    expect(d("place order")).toEqual({ kind: "command", command: "place" });
    expect(d("kitchen bhejo")).toEqual({ kind: "command", command: "kot" });
    expect(d("place order", false).kind).toBe("ignore");
    expect(d("cancel").kind).toBe("ignore");
  });
  test("undo", () => { expect(d("undo")).toEqual({ kind: "undo" }); expect(d("galti")).toEqual({ kind: "undo" }); });
});

test("rate limit: a few adds per 2 s", () => {
  expect(rateOk([], 1000)).toBe(true);
  expect(rateOk([900, 950, 990], 1000)).toBe(false);
  expect(rateOk([900, 950, 990], 3500)).toBe(true);
});

describe("Direct mode default", () => {
  it("is off until someone switches it on (room talk must never add dishes by itself)", async () => {
    const { DIRECT_DEFAULT, directOn, setDirectOn } = await import("./voiceDirect");
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    expect(DIRECT_DEFAULT).toBe(false);
    expect(directOn()).toBe(false);
    setDirectOn(true);
    expect(directOn()).toBe(true);
    vi.unstubAllGlobals();
  });
});
