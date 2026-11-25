import { describe, expect, test } from "vitest";
import { isVegOnlyMatch } from "@/lib/menuAdmin";
import { pickDefault } from "./voiceFlow";
import { blockers, doneHolds, doneVerdict, type DoneState } from "./voiceSheet";

// Voice follows the counter's "Veg only" filter (owner, 2026-11-02; docs/VOICE_QA_REPORT.md B20).
const items = {
  bc: { id: "bc", name: "Butter Chicken", food_type: "non_veg" }, mp: { id: "mp", name: "Matar Paneer", food_type: "veg" },
  cb: { id: "cb", name: "Chicken Biryani", food_type: "non_veg" }, vb: { id: "vb", name: "Veg Biryani", food_type: "veg" },
  eb: { id: "eb", name: "Egg Biryani", food_type: "egg" }, un: { id: "un", name: "Mystery", food_type: null },
} as const;
const nameOf = (id: string) => items[id as keyof typeof items].name;
const hidden = (vegOnly: boolean) => (id: string) => vegOnly && !isVegOnlyMatch(items[id as keyof typeof items] as never);
const line = (itemId: string, vegOnly: boolean, anyway = false) => ({ heard: itemId, itemId, qty: 1, issues: [] as string[], ...(hidden(vegOnly)(itemId) && !anyway ? { veto: "veg" as const } : {}) });
const state = (lines: DoneState["lines"]): DoneState => ({ lines, unmatched: [], tableAmbiguous: null, busyTable: null, command: null, billOk: true, hasOther: false });
const none = () => false;

describe("Veg only on", () => {
  test("a non-veg dish is not added; the message says why; the veg ones are added; done is never blocked", () => {
    const s = state([line("bc", true), line("mp", true)]);
    expect(blockers(s.lines, nameOf, none)).toEqual(["Butter Chicken is non-veg and Veg only is on: tap “Add anyway” or drop it"]);
    const v = doneVerdict(s, nameOf, none);
    expect(v).toMatchObject({ kind: "partial", added: 1 });
    expect(doneHolds(s, nameOf, none)[0].say).toMatch(/Add anyway.*Butter Chicken|Butter Chicken.*non-veg/);
  });
  test("egg and unmarked dishes are not veg either (the counter's rule)", () => {
    expect(line("eb", true).veto).toBe("veg");
    expect(line("un", true).veto).toBe("veg");
    expect(line("mp", true).veto).toBeUndefined();
  });
  test("'Add anyway' adds it (the filter stays on)", () => {
    expect(doneVerdict(state([line("bc", true, true)]), nameOf, none)).toMatchObject({ kind: "add" });
  });
  test("an ambiguous 'biryani' picks a dish the filter shows", () => {
    const menu = (veg: boolean) => ({ order: (id: string) => ["cb", "eb", "vb"].indexOf(id), name: nameOf, soldOut: hidden(veg) });
    expect(pickDefault(["cb", "eb", "vb"], "biryani", menu(true))).toBe("vb");
    expect(pickDefault(["cb", "eb", "vb"], "biryani", menu(false))).toBe("cb");
  });
});

describe("Veg only off: normal behaviour", () => {
  test("everything is added", () => {
    const s = state([line("bc", false), line("mp", false)]);
    expect(blockers(s.lines, nameOf, none)).toEqual([]);
    expect(doneVerdict(s, nameOf, none)).toMatchObject({ kind: "add" });
  });
  test("sold out still stays (existing rule), with its own words", () => {
    expect(blockers([line("mp", false)], nameOf, (id) => id === "mp")).toEqual(["Matar Paneer is sold out: choose another dish or drop it"]);
  });
});
