import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * India-only product: every visible label for the sales tax says "GST" (docs/DECISIONS.md; see also taxWords.ts). A bare
 * "Tax" / "टैक्स" in a string literal or JSX text is a regression (a foreign tax word is already banned repo-wide by
 * scripts/check-inr-only.sh). The legal terms "tax invoice" and "tax number" are allowed, as is the lower-case id string
 * "tax" (e.g. a step id). Identifiers, API paths (tax-config, tax_breakdown) and {tax} placeholders are skipped by the lookarounds.
 */
const SRC = path.resolve(__dirname, "..");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const STR = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|>([^<>{}\n]+)</g;
const BAD = /(?<![\w\-/.{$])(?:[Tt]ax(?:es)?|TAX|टैक्स)(?![\w\-/}])/;
const ALLOWED = /(?:tax|Tax|TAX|टैक्स) (?:invoice|INVOICE|इनवॉइस|number|नंबर)/g;

describe("GST wording", () => {
  it("no visible string says Tax or टैक्स instead of GST", () => {
    const hits: string[] = [];
    for (const f of walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p) && !/\.(test|spec)\./.test(p))) {
      fs.readFileSync(f, "utf8").split("\n").forEach((ln, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(ln)) return;
        const line = ln.replace(/\$\{[^}]*\}/g, "");
        for (const m of line.matchAll(STR)) {
          const s = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").replace(ALLOWED, "");
          if (s.trim() !== "tax" && BAD.test(s)) hits.push(`${path.relative(SRC, f)}:${i + 1}: ${s.slice(0, 100)}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
