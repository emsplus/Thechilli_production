/**
 * Dish recognition on the full 44-dish demo menu (src/lib/__fixtures__/voice/demo_menu_44.json, the seed's menu): every
 * dish said 6+ ways (menu name, Hinglish spellings, recogniser slips, Devanagari), cross-dish confusion pairs and Half / Full.
 * Bar: >= 95% resolve to the right dish (and option), 0 confusions, < 5 ms per phrase.
 * VOICE_DISH_REPORT=1 prints every miss.
 */
import { describe, expect, test } from "vitest";
import menuJson from "./__fixtures__/voice/demo_menu_44.json";
import corpus from "./__fixtures__/voice/dish_variants.json";
import type { Category, MenuItem } from "./types";
import { buildVoiceMenu, parseOrder, type VoiceMenu } from "./voiceParse";

const items = (menuJson as unknown as { items: MenuItem[] }).items;
const cats = (menuJson as unknown as { categories: Category[] }).categories;
const byId = new Map(items.map((i) => [i.id, i]));
const byName = new Map(items.map((i) => [i.name, i]));

interface Got { item: string | null; variant: string | null; ask: string[] | null; unmatched: boolean; all: string[] }
export function resolve(text: string, menu: VoiceMenu): Got {
  const p = parseOrder(text, menu);
  const l = p.lines[0];
  const all = p.lines.filter((x) => !x.ask).map((x) => byId.get(x.itemId)!.name);
  if (!l) return { item: null, variant: null, ask: null, unmatched: true, all };
  const it = byId.get(l.itemId)!;
  if (l.ask) return { item: null, variant: null, ask: [l.itemId, ...l.alternatives].map((id) => byId.get(id)!.name), unmatched: false, all };
  return { item: it.name, variant: it.variants.find((v) => v.id === l.variantId)?.name ?? null, ask: null, unmatched: false, all };
}

const menu = buildVoiceMenu(items, cats);
const report = !!process.env.VOICE_DISH_REPORT;

describe("dish recognition, 44-dish demo menu", () => {
  test("speed: < 5 ms per phrase first, with nothing memoised yet (every dish word against every spoken word)", () => {
    const fresh = buildVoiceMenu(items, cats); // no memo yet: each phrase is matched from scratch
    const says = corpus.dishes.flatMap((d) => d.says);
    const ms: number[] = [];
    for (const s of says) { const t0 = performance.now(); parseOrder(`do ${s} aur ek ${s} full`, fresh); ms.push(performance.now() - t0); }
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)], mean = ms.reduce((a, b) => a + b, 0) / ms.length;
    if (report) process.stderr.write(`speed: ${says.length} phrases, mean ${mean.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${ms[ms.length - 1].toFixed(2)} ms\n`);
    expect(mean).toBeLessThan(5);
    expect(p95).toBeLessThan(5);
  });

  test("every dish said 6+ ways: >= 95% right, no cross-dish confusion", () => {
    let ok = 0, total = 0;
    const misses: string[] = [], confused: string[] = [];
    for (const d of corpus.dishes) {
      expect(byName.has(d.item), d.item).toBe(true);
      expect(d.says.length).toBeGreaterThanOrEqual(6);
      const want = (d as { variant?: string }).variant ?? (byName.get(d.item)!.variants[0]?.name ?? null);
      for (const s of d.says) {
        total++;
        const g = resolve(s, menu);
        if (g.item === d.item && g.variant === want && g.all.length === 1) { ok++; continue; }
        misses.push(`${s} -> ${g.item ?? (g.ask ? `ask[${g.ask.join("|")}]` : "unmatched")}${g.variant ? ` / ${g.variant}` : ""} (want ${d.item}${want ? ` / ${want}` : ""})`);
        if (g.all.some((n) => n !== d.item)) confused.push(`${s} -> ${g.all.join(" + ")}`);
      }
    }
    if (report) process.stderr.write(`dishes: ${ok}/${total} = ${(100 * ok / total).toFixed(1)}%\n  ${misses.join("\n  ")}\n`);
    expect(confused).toEqual([]);
    expect(ok / total).toBeGreaterThanOrEqual(0.95);
  });

  test("confusion pairs: never the other dish", () => {
    const bad: string[] = [];
    for (const c of corpus.confusions) {
      const g = resolve(c.say, menu);
      if (g.all.includes(c.not)) bad.push(`${c.say} -> ${c.not}`);
      if (c.item && g.item !== c.item) bad.push(`${c.say} -> ${g.item ?? (g.ask ? `ask[${g.ask.join("|")}]` : "unmatched")} (want ${c.item})`);
    }
    if (report && bad.length) console.log(`confusions:\n  ${bad.join("\n  ")}`);
    expect(bad).toEqual([]);
  });

  test("half / full", () => {
    const bad: string[] = [];
    for (const c of corpus.half_full) {
      const g = resolve(c.say, menu);
      if (g.item !== c.item || g.variant !== c.variant) bad.push(`${c.say} -> ${g.item} / ${g.variant} (want ${c.item} / ${c.variant})`);
    }
    if (report && bad.length) console.log(`half/full:\n  ${bad.join("\n  ")}`);
    expect(bad).toEqual([]);
  });
});

describe("suggested pronunciations (dishSuggest.ts)", () => {
  test("every dish gets Devanagari and Hinglish suggestions, and each one already resolves to its own dish", async () => {
    const { suggestFor } = await import("./dishSuggest");
    const bad: string[] = [];
    let n = 0;
    for (const it of items) {
      const sg = suggestFor(it.name);
      expect(sg.some((x) => x.kind === "devanagari"), it.name).toBe(true);
      expect(sg.length, it.name).toBeGreaterThanOrEqual(2);
      for (const x of sg) {
        n++;
        const g = resolve(x.text, menu);
        if (g.item !== it.name) bad.push(`${it.name}: ${x.kind} "${x.text}" -> ${g.item ?? (g.ask ? `ask[${g.ask.join("|")}]` : "unmatched")}`);
      }
    }
    if (report) process.stderr.write(`suggestions: ${n}, not resolving: ${bad.length}\n  ${bad.join("\n  ")}\n`);
    expect(bad).toEqual([]);
  });
});
