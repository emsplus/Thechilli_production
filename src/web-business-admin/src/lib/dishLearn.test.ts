import { beforeEach, describe, expect, test } from "vitest";
import menuJson from "./__fixtures__/voice/demo_menu_44.json";
import type { Category, MenuItem } from "./types";
import { buildVoiceMenu, parseOrder } from "./voiceParse";
import { DISH_EXPIRE_DAYS, DISH_LEARN_MAX, dishLessonAliases, dishLessons, forgetDish, learnDish, setDishLearnClock, touchDish } from "./dishLearn";

const items = (menuJson as unknown as { items: MenuItem[] }).items;
const cats = (menuJson as unknown as { categories: Category[] }).categories;
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
let now = Date.UTC(2026, 10, 2);
const DAY = 86_400_000;
const first = (text: string, aliases = dishLessonAliases()) => parseOrder(text, buildVoiceMenu(items, cats, aliases)).lines[0];

beforeEach(() => { store.clear(); now = Date.UTC(2026, 10, 2); setDishLearnClock(() => now); });

describe("on-device dish learning from corrections", () => {
  test("an unmatched phrase the owner placed goes straight to that dish next time, flagged learnt", () => {
    expect(first("ek sahi wala murg")).toBeUndefined(); // nothing on the menu fits
    learnDish("sahi wala murg", "butter-chicken", "butter-chicken-full");
    const l = first("ek sahi wala murg");
    expect([l.itemId, l.variantId, l.learnt]).toEqual(["butter-chicken", "butter-chicken-full", true]);
  });

  test("a local lesson wins over the server's lesson for the same phrase", () => {
    learnDish("house special", "paneer-tikka", null);
    const server = [{ phrase: "house special", menu_item_id: "chicken-tikka", variant_id: null }];
    expect(first("house special", [...server, ...dishLessonAliases()]).itemId).toBe("paneer-tikka");
  });

  test("text only, no digits; the newer choice for a phrase replaces the older", () => {
    learnDish("2 Dabba Chai", "masala-chai", null);
    learnDish("dabba chai", "filter-coffee", null);
    expect(dishLessons().map((x) => [x.phrase, x.itemId, x.uses])).toEqual([["dabba chai", "filter-coffee", 2]]);
    expect(JSON.parse(store.get("pos.dishLearned.v1")!).items[0]).not.toHaveProperty("audio");
  });

  test(`capped at ${DISH_LEARN_MAX} (the oldest goes) and dropped after ${DISH_EXPIRE_DAYS} days unused; a use keeps it`, () => {
    for (let i = 0; i < DISH_LEARN_MAX + 5; i++) learnDish(`phrase ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, "idli-sambar-3-pcs", null);
    expect(dishLessons()).toHaveLength(DISH_LEARN_MAX);
    expect(dishLessons()[0].phrase).toBe("phrase fa");
    forgetDish("phrase fa");
    expect(dishLessons().some((x) => x.phrase === "phrase fa")).toBe(false);

    store.clear(); setDishLearnClock(() => now);
    learnDish("old one", "idli-sambar-3-pcs", null);
    learnDish("used one", "idli-sambar-3-pcs", null);
    now += 40 * DAY; touchDish("used one");
    now += 30 * DAY; setDishLearnClock(() => now); // re-read from storage
    expect(dishLessons().map((x) => x.phrase)).toEqual(["used one"]);
  });

  test("lessons for a dish no longer on the menu wait", () => {
    learnDish("gone dish", "not-on-menu", null);
    expect(dishLessonAliases(new Set(items.map((i) => i.id)))).toEqual([]);
  });
});
