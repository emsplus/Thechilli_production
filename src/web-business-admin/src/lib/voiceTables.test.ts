/** Spoken tables (audit V-03 / V-04): "table 3" is T3 even when AC3 was created first; ambiguous numbers ask. */
import { describe, expect, test } from "vitest";
import menuJson from "./__fixtures__/voice/demo_menu.json";
import type { Category, DiningTable, MenuItem } from "./types";
import { buildVoiceMenu, parseOrder, tableCandidates } from "./voiceParse";

const items = (menuJson as unknown as { items: MenuItem[] }).items;
const cats = (menuJson as unknown as { categories: Category[] }).categories;
const vmenu = buildVoiceMenu(items, cats);
const byId = new Map(items.map((i) => [i.id, i]));

// The audited floor, in creation order: AC hall and garden FIRST, then T1-T5.
const t = (label: string, area: "indoor" | "outdoor"): DiningTable => ({ id: label, label, seats: 4, area });
const FLOOR = [t("AC1", "indoor"), t("AC2", "indoor"), t("AC3", "indoor"), t("G1", "outdoor"), t("G2", "outdoor"),
  t("T1", "indoor"), t("T2", "indoor"), t("T3", "indoor"), t("T4", "indoor"), t("T5", "indoor")];
const parse = (s: string, tables = FLOOR) => parseOrder(s, vmenu, { tables });
const dishes = (s: string) => parse(s).lines.map((l) => byId.get(l.itemId)!.name);

describe("table resolution", () => {
  test.each([
    ["ek butter chicken aur ek biryani table 3", "T3"],
    ["table 3 do butter chicken", "T3"],
    ["टेबल 3 पर एक दाल मखनी", "T3"],
    ["hey, table 2, ek chai", "T2"],
    ["table number 5 do samosa", "T5"],
    ["T3 ek masala chai", "T3"],
    ["AC 2 teen jeera rice", "AC2"],
    ["do samosa table AC3", "AC3"],
    ["table ac 1 ek chai", "AC1"],
    ["garden 1 ek chicken 65", "G1"],
  ])("%s -> %s", (said, want) => {
    const p = parse(said);
    expect(p.tableId).toBe(want);
    expect(p.tableChoices).toEqual([]);
  });

  test("'table N' never eats a dish word and the dishes stay", () => {
    expect(dishes("table 3 do butter chicken")).toEqual(["Butter Chicken"]);
    expect(dishes("garden 1 ek chicken 65")).toContain("Chicken 65");
  });

  test("a bare number after 'outdoor' followed by a dish is a quantity, not a table", () => {
    const p = parse("outdoor 2 samosa");
    expect(p.tableId).toBeNull();
    expect(p.lines[0]?.qty).toBe(2);
  });

  test("ambiguous: '3' with AC3 and G3 but no T3 asks (never the first in the list)", () => {
    const floor = [t("AC3", "indoor"), t("G3", "outdoor"), t("T1", "indoor")];
    const p = parse("table 3 ek chai", floor);
    expect(p.tableId).toBeNull();
    expect(p.tableChoices.sort()).toEqual(["AC3", "G3"]);
    expect(p.needsTable).toBe(true);
  });

  test("ambiguous numbers settle by the area said", () => {
    const floor = [t("AC3", "indoor"), t("G3", "outdoor")];
    expect(parse("outdoor table 3 ek chai", floor).tableId).toBe("G3");
  });

  test("one letter-prefixed table with that number is taken", () => {
    expect(parse("table 3 ek chai", [t("AC3", "indoor"), t("T1", "indoor")]).tableId).toBe("AC3");
  });

  test("tableCandidates: exact label, then the plain series, then the rest", () => {
    expect(tableCandidates("3", FLOOR).map((x) => x.id)).toEqual(["T3"]);
    expect(tableCandidates("Table 3", [t("Table 3", "indoor"), t("AC3", "indoor")]).map((x) => x.id)).toEqual(["Table 3"]);
    expect(tableCandidates("ac 3", FLOOR).map((x) => x.id)).toEqual(["AC3"]);
    expect(tableCandidates("9", FLOOR)).toEqual([]);
    expect(tableCandidates("3", [{ ...t("T3", "indoor"), is_active: false }, t("AC3", "indoor")]).map((x) => x.id)).toEqual(["AC3"]);
  });
});
