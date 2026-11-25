import { describe, expect, test } from "vitest";
import type { Category, MenuItem } from "@/lib/types";
import { buildVoiceMenu, parseOrder } from "@/lib/voiceParse";
import { mergeSameDishes } from "./voiceSheet";

// The same dish said again = one line with a higher quantity (owner, 2026-11-02; docs/VOICE_QA_REPORT.md B17).
const cats = [{ id: "c1", name: "Mains" }, { id: "c2", name: "Breads" }] as Category[];
const items = [
  { id: "bc", category_id: "c1", name: "Butter Chicken", price: "280", is_active: true, variants: [{ id: "h", name: "Half", price_delta: "0" }, { id: "f", name: "Full", price_delta: "180" }] },
  { id: "dm", category_id: "c1", name: "Dal Makhani", price: "220", is_active: true, variants: [] },
  { id: "gn", category_id: "c2", name: "Garlic Naan", price: "60", is_active: true, variants: [] },
] as unknown as MenuItem[];
const vm = buildVoiceMenu(items, cats);
/** As the sheet does it: parse, the default size for a dish said without one, then merge. */
function sheet(text: string) {
  const p = parseOrder(text, vm, {});
  const lines = p.lines.map((l) => ({ key: l.key, itemId: l.itemId, variantId: l.itemId === "bc" ? (l.defaulted || !l.variantId ? "h" : l.variantId) : null, note: l.note, qty: l.qty, ask: l.ask, pending: false, heard: l.heard, issues: l.issues as string[] }));
  return mergeSameDishes(lines).map((l) => `${l.itemId}${l.variantId ? `/${l.variantId}` : ""}x${l.qty}`);
}

describe("the same dish said again", () => {
  test.each([
    ["one butter chicken, one butter chicken", ["bc/hx2"]],
    ["two butter chicken and one butter chicken", ["bc/hx3"]],
    ["one butter chicken, one butter chican", ["bc/hx2"]],
    ["one butter chicken, one butter chicin", ["bc/hx2"]],
    ["one butter chicken, one butter chiken", ["bc/hx2"]],
    ["one butter chicken, ek बटर चिकन", ["bc/hx2"]],
    ["one butter chicken, one dal makhani, one butter chicken", ["bc/hx2", "dmx1"]],
  ])("%j -> %j", (t, want) => { expect(sheet(t)).toEqual(want); });

  test("a different size or note stays a separate line", () => {
    expect(sheet("one butter chicken full, one butter chicken")).toEqual(["bc/fx1", "bc/hx1"]);
    expect(sheet("one garlic naan, one garlic naan extra butter")).toHaveLength(2);
  });

  test("never merged: a dish still to choose, words still being heard, a line changed by hand", () => {
    const base = { variantId: null, note: null, heard: "x", issues: [] as string[], said: undefined as number | undefined };
    const lines = [
      { ...base, key: "a", itemId: "dm", qty: 1 }, { ...base, key: "b", itemId: "dm", qty: 1, pending: true },
      { ...base, key: "c", itemId: "dm", qty: 2 }, { ...base, key: "d", itemId: "dm", qty: 1, ask: true }, { ...base, key: "e", itemId: "dm", qty: 5 },
    ];
    expect(mergeSameDishes(lines, (k) => k === "e").map((l) => [l.key, l.qty])).toEqual([["a", 3], ["b", 1], ["d", 1], ["e", 5]]);
    expect(mergeSameDishes(lines, (k) => k === "e")[0].said).toBe(2);
  });
});
