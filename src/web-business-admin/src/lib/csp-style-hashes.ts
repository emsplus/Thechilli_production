import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Build-time only (next.config.ts): CSP hashes of the <style> elements a library injects at run time, which cannot
 * carry the per-request nonce. Today that is sonner (toasts): it appends an empty <style> and then fills it with one
 * fixed CSS string. Allowing exactly those two hashes keeps 'unsafe-inline' out of style-src-elem.
 * Throws when the library's injection can no longer be found, so an upgrade fails the build instead of silently
 * unstyling toasts (e2e/csp.spec.ts would also report the violation).
 */
export const sha256 = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

export function sonnerCss(source: string): string {
  const m = source.match(/__insertCSS\(("(?:[^"\\]|\\.)*")\)/);
  if (!m) throw new Error("CSP: sonner's __insertCSS(\"...\") call was not found; update src/lib/csp-style-hashes.ts");
  return JSON.parse(m[1]) as string;
}

export function injectedStyleHashes(fromDir: string = process.cwd()): string[] {
  const req = createRequire(`${fromDir}/package.json`);
  const file = req.resolve("sonner").replace(/index\.(m?js|cjs)$/, "index.mjs");
  return [sha256(""), sha256(sonnerCss(readFileSync(file, "utf8")))];
}
