#!/usr/bin/env node
// Fingerprint of every LIGHT colour of the waiter app (CSS, JS constants, Android resources, iOS colours, image assets).
// Owner rule for the light-only task: light stays exactly as it was. The dark parts are ignored on purpose.
//   node scripts/light-fingerprint.mjs                 print the fingerprint of the working tree
//   node scripts/light-fingerprint.mjs --ref <git ref> print the fingerprint of a commit
//   node scripts/light-fingerprint.mjs --check         compare the working tree with scripts/light-baseline.json (exit 1 on a difference)
// scripts/light-baseline.json was generated from the commit before the light-only change (5fb179f).
// Owner-approved exception (2026-11, light-polish task, D23 / B5): the baseline's css:src/app/globals.css group had ONE `rgba(255,255,255,.22)` removed
// (the pressed category chip's count badge is now a white pill with red text). 
// Second owner-approved exception: ONE `rgba(17,24,32,.32)` removed (the cart bar a.cartbar2 shadow, now var(--m-btn-shadow); the bar itself is the primary button style). Every other entry is still the 5fb179f value.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : null;

const git = (...a) => execFileSync("git", ["-C", root, ...a], { maxBuffer: 1 << 28 });
const walk = (dir) => readdirSync(path.join(root, dir)).flatMap((n) => { const rel = `${dir}/${n}`; return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel]; });
const list = (dir) => ref ? git("ls-tree", "-r", "--name-only", ref, "--", dir).toString().split("\n").filter(Boolean) : (existsSync(path.join(root, dir)) ? walk(dir) : []);
const read = (p) => ref ? git("show", `${ref}:${p}`) : readFileSync(path.join(root, p));
const text = (p) => read(p).toString("utf8");
const md5 = (b) => createHash("md5").update(b).digest("hex");

const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const colours = (s) => (s.match(COLOUR) ?? []).map((c) => c.toLowerCase().replace(/\s+/g, "")).sort();
/** Remove every `@media (prefers-color-scheme: dark) { ... }` block (balanced braces). */
function stripDark(css) {
  let out = "", i = 0;
  for (;;) {
    const m = css.indexOf("@media (prefers-color-scheme: dark)", i);
    if (m < 0) return out + css.slice(i);
    out += css.slice(i, m);
    let d = 0, j = css.indexOf("{", m);
    for (; j < css.length; j++) { if (css[j] === "{") d++; else if (css[j] === "}" && --d === 0) { j++; break; } }
    i = j;
  }
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");

const fp = {};
// CSS: every colour of the light parts, as a sorted multiset, plus the whole variable list of the light :root block.
fp["css:src/app/globals.css"] = colours(stripComments(stripDark(text("src/app/globals.css"))));
fp["css:@chilli/tokens light"] = (() => { const p = "node_modules/@chilli/tokens/dist/tokens.css"; if (ref || !existsSync(path.join(root, p))) return null; const s = text(p); return colours(stripComments(s.slice(0, s.indexOf("@media")))); })();
// JS constants (the dark one is excluded).
fp["js:MOBILE_THEME"] = text("src/lib/mobileTheme.ts").split("\n").filter((l) => /^\s+\w+:\s*"#/.test(l) && !/pageDark/.test(l)).map((l) => l.replace(/\/\/.*$/, "").trim());
fp["js:capacitor.config.ts"] = colours(stripComments(text("capacitor.config.ts").replace(/\/\/.*$/gm, "")));
fp["pwa:manifest"] = colours(text("src/app/manifest.ts"));
// Android resources: day values only (values-night is ignored).
for (const f of ["colors.xml", "ic_launcher_background.xml", "styles.xml"]) fp[`android:values/${f}`] = colours(stripComments(text(`android/app/src/main/res/values/${f}`)));
// iOS literal colours that are light (cover, page light) and the launch storyboard.
fp["ios:SceneDelegate light colours"] = text("ios/App/App/SceneDelegate.swift").split("\n").filter((l) => /pageLight|Chilli Red/.test(l)).map((l) => (l.match(/0x[0-9a-fA-F]{2}/g) ?? []).join(",")).filter(Boolean);
fp["ios:LaunchScreen colour"] = (text("ios/App/App/Base.lproj/LaunchScreen.storyboard").match(/<color key="backgroundColor"[^>]*>/g) ?? []);
// Image assets (icons, splash, brand art): byte hashes of the day variants.
const assets = [...list("ios/App/App/Assets.xcassets"), ...list("android/app/src/main/res"), ...list("public")]
  .filter((p) => /\.(png|webp|jpg|jpeg|svg|ico)$/i.test(p) && !/values-night|-night|dark/i.test(p));
fp["assets"] = Object.fromEntries(assets.sort().map((p) => [p, md5(read(p))]));

const out = JSON.stringify(fp, null, 1) + "\n";
if (args.includes("--check")) {
  const baseline = JSON.parse(readFileSync(path.join(root, "scripts/light-baseline.json"), "utf8"));
  const now = JSON.parse(out);
  const bad = [];
  for (const k of Object.keys(baseline)) {
    if (baseline[k] === null || now[k] === null) continue; // external package not readable here
    if (JSON.stringify(baseline[k]) !== JSON.stringify(now[k])) bad.push(k);
  }
  if (bad.length) { console.error("LIGHT COLOURS CHANGED in:\n  " + bad.join("\n  ")); process.exit(1); }
  console.log(`light colours unchanged (${Object.keys(baseline).length} groups, ${Object.keys(baseline.assets).length} assets)`);
} else process.stdout.write(out);
