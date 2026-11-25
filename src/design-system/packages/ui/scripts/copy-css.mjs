import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
for (const f of ['styles.css', 'data.css', 'kds.css', 'auth.css']) copyFileSync(`src/${f}`, `dist/${f}`);
