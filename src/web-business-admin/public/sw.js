/* App-shell service worker. API calls are never cached here: business data lives in IndexedDB. */
const VERSION = "v9"; // v9: new shell (mic switch, in-app scan camera); old caches are dropped
const SHELL = `pos-shell-${VERSION}`;
const STATIC = `pos-static-${VERSION}`;
const MEDIA = `pos-media-${VERSION}`;
// Brand: the placeholder Chilli badge (BrandMark itself is inline SVG) + receipt line-art, precached for offline use.
// Sign-in carousel files (public/auth-media/) are cached at runtime when first shown.
const BRAND = ["/icon.svg", "/apple-touch-icon.png", "/brand/chilli-mark.svg", "/brand/receipt-logo.png"];
const PAGES = ["/login", "/register", "/pos", "/orders", "/kitchen", "/manage", "/customers", "/reports", "/end-of-day", "/ai", "/alerts", "/audit", "/system", "/sync"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    const stat = await caches.open(STATIC);
    for (const url of [...PAGES, "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", ...BRAND]) {
      try {
        const res = await fetch(url, { cache: "reload" });
        if (!res.ok) continue;
        await shell.put(url, res.clone());
        if (res.headers.get("content-type")?.includes("text/html")) {
          const html = await res.text();
          const assets = new Set(html.match(/\/_next\/static\/[^"'\\\s)]+/g) || []);
          for (const a of assets) { try { await stat.add(a); } catch { /* skip */ } }
        }
      } catch { /* offline during install: runtime caching will fill in */ }
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // "voice-models-v1": the offline wake detector's model (lib/wakeDetector.ts), kept across app updates (36 MB, versioned name)
    for (const k of await caches.keys()) if (![SHELL, STATIC, MEDIA, "voice-models-v1"].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/")) {  // content-hashed => cache-first
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(STATIC)).put(req, res.clone());
      return res;
    })());
    return;
  }

  if (url.pathname.startsWith("/auth-media/") && /\.webp$/.test(url.pathname)) {  // sign-in photos (not hashed) => network-first, cached for offline
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try { const res = await fetch(req); if (res.ok) cache.put(url.pathname, res.clone()); return res; }
      catch (e) { const hit = await cache.match(url.pathname); if (hit) return hit; throw e; }
    })());
    return;
  }

  if (url.pathname.startsWith("/brand/") && /\.(webp|png|svg)$/.test(url.pathname)) {  // brand assets => cache-first
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(url.pathname);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(url.pathname, res.clone());
      return res;
    })());
    return;
  }

  if (url.pathname.startsWith("/api/v1/media/")) {  // menu photos: immutable, content-hashed URLs => cache-first
    event.respondWith((async () => {
      const cache = await caches.open(MEDIA);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) {
        cache.put(req, res.clone());
        // keep the cache bounded on small devices: drop the oldest entries beyond 300 photos
        const keys = await cache.keys();
        if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) await cache.delete(k);
      }
      return res;
    })());
    return;
  }

  if (req.mode === "navigate") {  // network-first, fall back to the cached page (or the POS shell)
    event.respondWith((async () => {
      try {
        const res = await withTimeout(fetch(req), 4000);
        if (res.ok) (await caches.open(SHELL)).put(url.pathname, res.clone());
        return res;
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match(url.pathname)) || (await cache.match("/pos")) || Response.error();
      }
    })());
    return;
  }

  if (PAGES.includes(url.pathname) || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/icon-")) {
    event.respondWith(fetch(req).catch(async () => (await (await caches.open(SHELL)).match(url.pathname)) || Response.error()));
  }
});
