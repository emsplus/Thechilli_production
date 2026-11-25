// Per-page first-load JS (gzip) from the static HTML of a production build. Budget: 150 KB gz per page.
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
const dir = ".next/server/app";
const BUDGET = 155 * 1024; // ~150 KB target
const EXCEPTIONS = {}; // per-page budget overrides (none since the app is sign-up only)
let worst = 0, bad = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) {
  const html = readFileSync(`${dir}/${f}`, "utf8");
  // noModule scripts are legacy polyfills that modern browsers never download: excluded.
  const srcs = [...new Set([...html.matchAll(/<script ([^>]*)>/g)].filter((m) => !/noModule/i.test(m[1])).map((m) => /src="(\/_next\/static\/[^"]+\.js)"/.exec(m[1])?.[1]).filter(Boolean))];
  const total = srcs.reduce((n, s) => n + gzipSync(readFileSync(".next" + s.slice("/_next".length))).length, 0);
  worst = Math.max(worst, total);
  if (total > (EXCEPTIONS[f] ?? BUDGET)) bad++;
  console.log(`${f.padEnd(22)} ${srcs.length} scripts  ${(total / 1024).toFixed(1)} KB gz`);
}
console.log(`worst ${(worst / 1024).toFixed(1)} KB gz, budget ~150 KB: ${bad ? "FAIL" : "ok"}`);
process.exit(bad ? 1 : 0);
