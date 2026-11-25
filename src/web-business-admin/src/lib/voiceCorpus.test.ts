/**
 * The shared voice-ordering corpus (src/lib/__fixtures__/voice/voice_corpus.json, a byte-identical copy of pos-service
 * tests/fixtures/voice/voice_corpus.json made by its scripts/sync_voice_fixtures.sh) against the on-device parser and the
 * frozen demo menu. The same cases run against pos-service voice_parse.py (tests/test_voice_corpus.py), so both parsers
 * are held to one labelled set. VOICE_EVAL_OUT=<file> also dumps every prediction for `python -m tests.voice_eval --preds`.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import corpusJson from "./__fixtures__/voice/voice_corpus.json";
import menuJson from "./__fixtures__/voice/demo_menu.json";
import type { Category, MenuItem } from "./types";
import { buildVoiceMenu, parseOrder, type ParsedOrder } from "./voiceParse";
import { detectCommand } from "./voiceCommands";

interface ExpLine { item?: string; variant?: string | null; qty?: number; note?: string; ask?: string[]; none?: boolean }
interface Case { id: string; cat: string; text: string; lines: ExpLine[]; command: string | null; gemini_sample: boolean }
interface Pred { lines: { item: string; variant: string | null; qty: number; note: string | null; confidence: number }[]; asks: { ask: string[]; qty: number | null }[]; command: string | null }

const cases = (corpusJson as unknown as { cases: Case[] }).cases;
const items = (menuJson as unknown as { items: MenuItem[] }).items;
const cats = (menuJson as unknown as { categories: Category[] }).categories;
const byId = new Map(items.map((i) => [i.id, i]));
const vmenu = buildVoiceMenu(items, cats);

export function predict(text: string): Pred {
  const cmd = detectCommand(text, vmenu);
  const p: ParsedOrder = parseOrder(cmd.rest, vmenu); // India only: no country option (ux/inr-final)
  const out: Pred = { lines: [], asks: [], command: cmd.command ?? (p.newBill ? "new_bill" : null) };
  for (const l of p.lines) {
    const it = byId.get(l.itemId)!;
    if (l.ask) { out.asks.push({ ask: [l.itemId, ...l.alternatives].map((id) => byId.get(id)!.name), qty: l.qty }); continue; }
    out.lines.push({ item: it.name, variant: it.variants.find((v) => v.id === l.variantId)?.name ?? null, qty: l.qty, note: l.note, confidence: l.confidence });
  }
  return out;
}

/** Same rules as pos-service tests/voice_eval.py score_case. */
function score(c: Case, p: Pred): { ok: number; total: number; exact: boolean } {
  const lines = p.lines.map((l) => ({ ...l, used: false })), asks = p.asks.map((a) => ({ ...a, used: false }));
  let ok = 0, nones = 0;
  for (const e of c.lines) {
    if (e.none) { nones++; continue; }
    if (e.ask) {
      const hit = asks.find((a) => !a.used && e.ask!.every((n) => a.ask.includes(n)) && (a.qty === null || a.qty === e.qty));
      if (hit) { hit.used = true; ok++; }
      continue;
    }
    const hit = lines.find((l) => !l.used && l.item === e.item && (l.variant ?? null) === (e.variant ?? null) && l.qty === e.qty
      && (!e.note || (l.note ?? "").toLowerCase().includes(e.note.toLowerCase())));
    if (hit) { hit.used = true; ok++; }
  }
  const extras = lines.filter((l) => !l.used).length + asks.filter((a) => !a.used).length;
  if (nones && extras === 0) ok += nones;
  return { ok, total: c.lines.length + extras, exact: ok === c.lines.length && extras === 0 && (p.command ?? null) === (c.command ?? null) };
}

test.each([
  ["ek butter chicken", "Butter Chicken", "Half", 1],
  ["ek butter chicken full", "Butter Chicken", "Full", 1],
  ["chicken biryani", "Chicken Biryani", "Half", 1],
  // "tandoori" alone fits Tandoori Chicken and Tandoori Roti; only the chicken has a Full option (same rule as voice_parse.py)
  ["full tandoori", "Tandoori Chicken", "Full", 1],
  ["do half tandoori", "Tandoori Chicken", "Half", 2],
] as const)("%s -> %s (%s) x%i", (text, item, variant, qty) => {
  const p = predict(text);
  expect([p.lines.map((l) => [l.item, l.variant, l.qty]), p.asks]).toEqual([[[item, variant, qty]], []]);
});

test("'ek tandoori' with no option still asks which dish", () => {
  expect(predict("ek tandoori").asks.map((a) => a.ask.sort())).toEqual([["Tandoori Chicken", "Tandoori Roti"]]);
});

describe("shared voice corpus (demo menu)", () => {
  const preds: Record<string, Pred> = {};
  for (const c of cases) preds[c.id] = predict(c.text);

  test("the lexicon is the one the corpus was built with (run pos-service scripts/sync_voice_fixtures.sh)", () => {
    const sha = createHash("sha256").update(readFileSync(path.join(import.meta.dirname, "voiceLexicon.json"))).digest("hex");
    expect(sha).toBe((corpusJson as unknown as { lexicon_sha256: string }).lexicon_sha256);
  });

  test("at least 250 dish utterances and 40 command utterances", () => {
    expect(cases.filter((c) => !c.cat.startsWith("command")).length).toBeGreaterThanOrEqual(250);
    expect(cases.filter((c) => c.cat.startsWith("command")).length).toBeGreaterThanOrEqual(40);
  });

  test("line accuracy per category", () => {
    const by = new Map<string, { ok: number; total: number; exact: number; n: number }>();
    const fails: string[] = [];
    for (const c of cases) {
      const s = score(c, preds[c.id]);
      for (const k of [c.cat, "ALL"]) {
        const b = by.get(k) ?? { ok: 0, total: 0, exact: 0, n: 0 };
        b.ok += s.ok; b.total += s.total; b.exact += s.exact ? 1 : 0; b.n++;
        by.set(k, b);
      }
      if (!s.exact) fails.push(`${c.id} ${JSON.stringify(c.text)} -> ${JSON.stringify(preds[c.id])}`);
    }
    if (process.env.VOICE_EVAL_OUT) writeFileSync(process.env.VOICE_EVAL_OUT, JSON.stringify(preds, null, 1));
    if (process.env.VOICE_EVAL_VERBOSE) console.log(fails.join("\n"));
    const all = by.get("ALL")!;
    // floor, not the target: the measured numbers are in pos-service docs/AI_VOICE_ORDERING.md
    expect(all.ok / all.total, `failing cases:\n${fails.slice(0, 40).join("\n")}`).toBeGreaterThanOrEqual(Number(process.env.VOICE_EVAL_FLOOR ?? 0.9));
    for (const cat of ["variant_default", "variant_explicit", "command", "command_false_positive"]) {
      const b = by.get(cat)!;
      expect(b.ok / b.total, cat).toBeGreaterThanOrEqual(Number(process.env.VOICE_EVAL_FLOOR ?? 0.9));
    }
  });
});
