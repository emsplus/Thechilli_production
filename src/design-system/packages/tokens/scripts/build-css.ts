import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { buildCss, buildFontsCss, fontFiles } from '../src/css';

mkdirSync('dist/fonts', { recursive: true });
writeFileSync('dist/tokens.css', buildCss());
// Self-hosted fonts (no runtime CDN): copy the variable woff2 files out of @fontsource-variable into dist/fonts.
const require = createRequire(import.meta.url);
for (const f of fontFiles) {
  const pkgDir = dirname(require.resolve(`${f.pkg}/package.json`));
  copyFileSync(join(pkgDir, 'files', f.file), join('dist/fonts', f.file));
}
writeFileSync('dist/fonts.css', buildFontsCss());
console.log('wrote dist/tokens.css, dist/fonts.css and', fontFiles.length, 'woff2 files');
