// Size budgets: gzip size of what a consumer downloads for each entry point.
// JS budgets cover the entry file plus every shared chunk it (transitively) imports, so splitting
// code into chunks cannot hide bytes. Budgets only go up with a written reason, never to make a build pass.
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const budgets = [
  { file: 'dist/index.js', maxKB: 12, note: 'core JS + shared chunks, excludes react and radix', closure: true },
  { file: 'dist/data.js', maxKB: 8, note: 'data entry JS + shared chunks (DataTable, CSV, FilterBar)', closure: true },
  { file: 'dist/kds.js', maxKB: 6, note: 'kds entry JS + shared chunks (KdsTicket, KdsColumn)', closure: true },
  { file: 'dist/auth.js', maxKB: 3, note: 'auth entry JS + shared chunks (AuthSplit, AuthMedia carousel)', closure: true },
  { file: 'dist/styles.css', maxKB: 6, note: 'core component CSS' },
  { file: 'dist/data.css', maxKB: 2, note: 'data entry CSS (loaded with styles.css)' },
  { file: 'dist/kds.css', maxKB: 2, note: 'kds entry CSS (loaded with styles.css)' },
  { file: 'dist/auth.css', maxKB: 3, note: 'auth entry CSS (loaded with styles.css); 2 -> 3 KB on 2026-10-31 for the owner-requested sign-in layout (form column + saffron shape, optional photo carousel inside the shape)' },
  { file: '../tokens/dist/tokens.css', maxKB: 3, note: 'tokens CSS (style guide v1.0 scales, type roles and elevation included)' },
  { file: '../tokens/dist/fonts.css', maxKB: 1, note: 'self-hosted @font-face rules (new 2026-10-31, style guide v1.0)' },
  // Fonts (style guide v1.0 final: Inter UI/body, JetBrains Mono amounts, Poppins headings/wordmark, Montserrat tagline; self-hosted, no CDN). latin loads on
  // first paint; Inter latin-ext only when a page uses those glyphs (the rupee sign), so it is budgeted separately.
  { file: '../tokens/dist/fonts/inter-latin-wght-normal.woff2', maxKB: 48, note: 'Inter variable latin (400-600 in one file), first paint' },
  { file: '../tokens/dist/fonts/inter-latin-ext-wght-normal.woff2', maxKB: 84, note: 'Inter variable latin-ext, on demand (rupee sign): the variable file is large; a rupee-only subset is a follow-up' },
  { file: '../tokens/dist/fonts/jetbrains-mono-latin-wght-normal.woff2', maxKB: 40, note: 'JetBrains Mono latin (amounts, KOT, codes)' },
  { file: '../tokens/dist/fonts/jetbrains-mono-latin-ext-wght-normal.woff2', maxKB: 16, note: 'JetBrains Mono latin-ext (rupee sign), on demand' },
  { file: '../tokens/dist/fonts/poppins-latin-700-normal.woff2', maxKB: 8, note: 'Poppins 700 headings (Display, H1-H3)' },
  { file: '../tokens/dist/fonts/poppins-latin-800-normal.woff2', maxKB: 8, note: 'Poppins 800 wordmark text' },
  { file: '../tokens/dist/fonts/montserrat-latin-600-normal.woff2', maxKB: 19, note: 'Montserrat 600 tagline' },
];

/** Entry file plus all relative ./chunk imports, de-duplicated. */
function closure(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = readFileSync(entry, 'utf8');
  for (const m of src.matchAll(/from\s*["']\.\/([^"']+\.js)["']|import\s*["']\.\/([^"']+\.js)["']/g)) {
    closure(`dist/${m[1] ?? m[2]}`, seen);
  }
  return seen;
}

let failed = false;
for (const { file, maxKB, note, closure: withChunks } of budgets) {
  if (!existsSync(file)) { console.error(`missing ${file}, run build first`); process.exit(1); }
  const files = withChunks ? [...closure(file)] : [file];
  const bytes = gzipSync(Buffer.concat(files.map((f) => readFileSync(f)))).length;
  const kb = bytes / 1024;
  const ok = kb <= maxKB;
  if (!ok) failed = true;
  const extra = files.length > 1 ? ` [${files.length} files]` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file}: ${kb.toFixed(2)} KB gzip (budget ${maxKB} KB)${extra} ${note}`);
}
process.exit(failed ? 1 : 0);
