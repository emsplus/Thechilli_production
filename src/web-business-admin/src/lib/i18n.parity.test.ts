import { describe, expect, it } from "vitest";
import type { Msg } from "./i18n";

// Every screen catalog lives in a `messages.ts` / `*-messages.ts` file and is exported as `*_MSG`.
const modules = import.meta.glob<Record<string, unknown>>("../**/{messages,*-messages}.ts", { eager: true });
const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

const catalogs: [string, Record<string, Msg>][] = [];
for (const [file, mod] of Object.entries(modules))
  for (const [name, val] of Object.entries(mod)) if (name.endsWith("_MSG") && val && typeof val === "object") catalogs.push([`${file}:${name}`, val as Record<string, Msg>]);

describe("i18n catalogs", () => {
  it("finds the screen catalogs", () => { expect(catalogs.length).toBeGreaterThanOrEqual(15); });
  for (const [label, cat] of catalogs) {
    it(`${label}: en, hi and hinglish are all present with the same placeholders`, () => {
      const bad: string[] = [];
      for (const [key, m] of Object.entries(cat)) {
        for (const l of ["en", "hi", "hinglish"] as const) if (!m[l] || !m[l]!.trim()) bad.push(`${key}.${l} missing`);
        if (m.en && m.hi && params(m.en) !== params(m.hi)) bad.push(`${key} hi placeholders differ`);
        if (m.en && m.hinglish && params(m.en) !== params(m.hinglish)) bad.push(`${key} hinglish placeholders differ`);
        if (m.hi && !/[ऀ-ॿ]/.test(m.hi) && /[A-Za-z]{4,}/.test(m.en) && m.hi === m.en && m.en.split(" ").length > 3) bad.push(`${key} hi is untranslated`);
      }
      expect(bad).toEqual([]);
    });
  }
});
