/* App-shell service worker. API calls are NEVER cached here: business data lives in IndexedDB (menu snapshot, queue). */
const VERSION = "v2"; // v2: brand refresh (red theme, logo), so old orange shells are dropped
const STATIC = `waiter-static-${VERSION}`;
const PAGES = `waiter-pages-${VERSION}`;
const SHELL_URLS = ["/login", "/tables", "/menu", "/cart", "/orders", "/history", "/more", "/outlet", "/icon-192.png", "/brand/logo-mark.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const pages = await caches.open(PAGES);
    const stat = await caches.open(STATIC);
    for (const url of SHELL_URLS) {
      try {
        const res = await fetch(url, { cache: "reload", redirect: "follow" });
        if (!res.ok || res.redirected) continue;
        await pages.put(url, res.clone());
        if ((res.headers.get("content-type") || "").includes("text/html")) {
          const html = await res.text();
          for (const a of new Set(html.match(/\/_next\/static\/[^"'\\\s)]+/g) || [])) { try { await stat.add(a); } catch { /* skip */ } }
        }
      } catch { /* offline during install: runtime caching fills in */ }
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (![STATIC, PAGES].includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // API is cross-origin or non-GET: never touched

  if (url.pathname.startsWith("/_next/static/")) { // content-hashed: cache first
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(STATIC)).put(req, res.clone());
      return res;
    })());
    return;
  }
  if (req.mode === "navigate") { // network first with a short timeout (slow Wi-Fi), fall back to the cached shell
    event.respondWith((async () => {
      try {
        const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
        if (res.ok) (await caches.open(PAGES)).put(url.pathname, res.clone());
        return res;
      } catch {
        return (await caches.match(url.pathname)) || (await caches.match("/tables")) || (await caches.match("/login")) || Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => (await caches.match(req)) || fetch(req))());
});
