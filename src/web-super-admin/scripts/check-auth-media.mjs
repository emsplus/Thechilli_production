#!/usr/bin/env node
// Validates public/auth-media/manifest.json and the files it lists (see docs/AUTH_MEDIA.md).
// Usage: node scripts/check-auth-media.mjs [path/to/manifest.json]   (exit 1 on any error)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const manifestPath = resolve(process.argv[2] ?? 'public/auth-media/manifest.json');
const publicDir = resolve(dirname(manifestPath), '..');
const MAX_IMG = 250 * 1024, MAX_VID = 2 * 1024 * 1024;
const errors = [], warnings = [];
const err = (m) => errors.push(m), warn = (m) => warnings.push(m);

/** Width x height from a WebP header (VP8, VP8L, VP8X), or null. */
function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1]; }
  return null;
}

function file(src, label) {
  if (typeof src !== 'string' || !src.startsWith('/auth-media/')) { err(`${label}: src must start with /auth-media/ (got ${JSON.stringify(src)})`); return null; }
  const p = join(publicDir, src);
  if (!existsSync(p)) { err(`${label}: file not found: ${p}`); return null; }
  return { path: p, size: statSync(p).size };
}

function image(src, label) {
  const f = file(src, label); if (!f) return;
  if (extname(src).toLowerCase() !== '.webp') err(`${label}: images must be WebP (${src})`);
  if (f.size > MAX_IMG) err(`${label}: ${src} is ${(f.size / 1024).toFixed(0)} KB, limit 250 KB`);
  const dim = extname(src).toLowerCase() === '.webp' ? webpSize(readFileSync(f.path)) : null;
  if (!dim) { warn(`${label}: could not read dimensions of ${src}`); return; }
  const [w, h] = dim;
  if (w < 1200 || h < 1500) err(`${label}: ${src} is ${w}x${h}, minimum 1200x1500`);
  const ratio = w / h;
  if (Math.abs(ratio - 0.8) > 0.02) warn(`${label}: ${src} is ${w}x${h}; 4:5 portrait (0.80) expected, got ${ratio.toFixed(2)}`);
}

let list = [];
if (!existsSync(manifestPath)) { console.error(`manifest not found: ${manifestPath}`); process.exit(1); }
try { list = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { console.error(`manifest is not valid JSON: ${e.message}`); process.exit(1); }
if (!Array.isArray(list)) { console.error('manifest must be an array'); process.exit(1); }
if (list.length === 0) warn('manifest is empty: the brand placeholder will be shown');
if (list.length > 6) warn(`${list.length} items: 3 to 4 per portal is the target`);

list.forEach((it, i) => {
  const label = `item ${i + 1}`;
  if (!it || typeof it !== 'object') return err(`${label}: must be an object`);
  if (it.type !== 'image' && it.type !== 'video') err(`${label}: type must be "image" or "video"`);
  if (typeof it.alt !== 'string') err(`${label}: alt must be a string ("" for decorative)`);
  if (it.credit !== undefined && typeof it.credit !== 'string') err(`${label}: credit must be a string`);
  if (!it.credit) warn(`${label}: no credit. Keep the licence link here for any photo not shot by Chilli`);
  if (it.type === 'image') image(it.src, label);
  if (it.type === 'video') {
    const f = file(it.src, label);
    if (f) {
      if (extname(it.src).toLowerCase() !== '.mp4') err(`${label}: video src must be the .mp4`);
      if (f.size > MAX_VID) err(`${label}: ${it.src} is ${(f.size / 1048576).toFixed(2)} MB, limit 2 MB`);
      const webm = file(it.src.replace(/\.mp4$/i, '.webm'), `${label} (webm twin)`);
      if (webm && webm.size > MAX_VID) err(`${label}: webm is ${(webm.size / 1048576).toFixed(2)} MB, limit 2 MB`);
    }
    if (!it.poster) err(`${label}: videos need a poster image`); else image(it.poster, `${label} poster`);
  }
});

for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);
console.log(`${list.length} item(s), ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
