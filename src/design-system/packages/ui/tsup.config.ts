import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const USE_CLIENT = "'use client';";

export default defineConfig({
  // Four entry points so apps that never show a table or the kitchen screen do not pay for them.
  // Shared code (icons, locale, Money) is emitted once as chunk-*.js and imported by each entry.
  entry: { index: 'src/index.ts', data: 'src/data.ts', kds: 'src/kds.tsx', auth: 'src/auth.tsx' },
  format: ['esm'],
  dts: true,
  clean: true,
  minify: true,
  treeshake: true,
  splitting: true,
  target: 'es2020',
  external: ['react', 'react-dom', 'react/jsx-runtime', /^@radix-ui\//, '@chilli/tokens'],
  // esbuild drops a directive supplied via `banner` when bundling ("Module level directives cause
  // errors when bundled ... was ignored"), so prepend it to every finished JS file (entries and
  // shared chunks) instead.
  onSuccess: async () => {
    for (const f of readdirSync('dist').filter((n) => n.endsWith('.js'))) {
      const file = `dist/${f}`;
      const src = readFileSync(file, 'utf8');
      if (!src.startsWith(USE_CLIENT)) writeFileSync(file, `${USE_CLIENT}\n${src}`);
    }
  },
});
