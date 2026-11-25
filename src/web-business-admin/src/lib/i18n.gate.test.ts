import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { msg, resolveLocale, type Msg } from "./i18n";
import { navLabel } from "../components/shell/nav-labels";

const modules = import.meta.glob<Record<string, unknown>>("../**/{messages,*-messages}.ts", { eager: true });
const DEVANAGARI = /[ऀ-ॿ]/;

describe("English only (NEXT_PUBLIC_ENABLE_LANGUAGES off)", () => {
  it("ignores a stored Hindi or Hinglish choice and never auto-detects", () => {
    for (const stored of ["hi", "hinglish", "en", null, undefined, "hi-IN"]) expect(resolveLocale(stored, false)).toBe("en");
  });
  it("honours the stored choice only when the flag is on", () => {
    expect(resolveLocale("hi", true)).toBe("hi");
    expect(resolveLocale("hinglish", true)).toBe("hinglish");
    expect(resolveLocale("fr", true)).toBe("en");
  });
  it("every catalog message and nav label resolves to its English text with the flag off", () => {
    const bad: string[] = [];
    for (const [file, mod] of Object.entries(modules))
      for (const [name, cat] of Object.entries(mod)) {
        if (!name.endsWith("_MSG") || !cat || typeof cat !== "object") continue;
        for (const [key, m] of Object.entries(cat as Record<string, Msg>)) {
          const out = msg(resolveLocale("hi", false), m);
          if (out !== m.en || DEVANAGARI.test(out)) bad.push(`${file}:${name}.${key}`);
        }
      }
    expect(bad).toEqual([]);
    for (const label of ["Today", "Kitchen", "Settings", "Sign out", "Stock levels"]) expect(navLabel(label, resolveLocale("hinglish", false))).toBe(label);
  });
  it("no source file outside the translation catalogs contains Devanagari text", () => {
    const allowed = /(messages\.ts|nav-labels\.ts|locale-switch\.tsx|i18n\.tsx|money\.ts|\.test\.tsx?|PaySheet\.tsx|kitchen\/page\.tsx|reports\/page\.tsx|ReportNotices\.tsx)$/; // the last four hold inline catalogs
    const hits: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f) && !allowed.test(p) && DEVANAGARI.test(readFileSync(p, "utf8"))) hits.push(p); } };
    walk(join(__dirname, ".."));
    expect(hits).toEqual([]);
  });
});
