#!/usr/bin/env node
// Static server that behaves like Capacitor Android's WebViewLocalServer (html5mode): the native export `out/` is served from
// the root, a request whose LAST path segment has no "." (including "/menu/" and "/orders/_/") is answered with /index.html
// (the ROOT page, i.e. the splash), a path with an extension is looked up as a file, anything else is 404. No directory index.
// This is what the Android WebView gets at https://localhost. Usage: node scripts/serve-capacitor-like.mjs [dir=out] [port=4173]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const dir = join(process.cwd(), process.argv[2] ?? "out");
const port = Number(process.argv[3] ?? process.env.PORT ?? 4173);
if (!existsSync(join(dir, "index.html"))) { console.error(`${dir}/index.html missing: run "pnpm build:native" (NATIVE=1) first`); process.exit(1); }
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = decodeURIComponent(url.pathname);
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const file = path === "/" || !last.includes(".") ? join(dir, "index.html") : normalize(join(dir, path));
  if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`capacitor-like server on http://localhost:${port} (${dir})`));
