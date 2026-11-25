import type { NextConfig } from "next";
import path from "node:path";
import { STATIC_HEADERS } from "./src/lib/security-headers";
import { injectedStyleHashes } from "./src/lib/csp-style-hashes";

// Deployment settings (Phase 9-10). Static security headers are computed at `next build` time and stored in the build's
// routes manifest. The Content-Security-Policy (per-request nonce) and HSTS (https only, HSTS env) come from src/proxy.ts.

export default function config(): NextConfig {
  return {
    // Inlined into src/proxy.ts at build time: hashes of the <style> tags libraries inject (see src/lib/csp-style-hashes.ts).
    env: { CSP_STYLE_HASHES: injectedStyleHashes().join(" ") },
    // No cacheComponents / partial prerendering: the nonce-based CSP (src/proxy.ts) needs every page rendered per request,
    // and a prerendered static shell would carry inline scripts without the nonce.
    turbopack: {
      // @chilli/tokens and @chilli/ui are linked from ../design-system, so Turbopack must be allowed to read the parent folder.
      root: path.resolve(process.cwd(), ".."),
      // The linked packages would otherwise resolve their own copy of React (a second instance breaks hooks): force the app's.
      resolveAlias: {
        react: "./node_modules/react",
        "react-dom": "./node_modules/react-dom",
      },
      rules: {
        "*.css": {
          loaders: ["@tailwindcss/turbopack"],
          as: "*.css",
        },
      },
    },
    // Docker image builds set NEXT_OUTPUT=standalone (node server.js). Left unset, `next build && next start` (local,
    // e2e) behaves exactly as before.
    output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
    poweredByHeader: false,
    // Lets a second dev server run next to another one in the same folder (NEXT_DIST_DIR=.next-alt).
    distDir: process.env.NEXT_DIST_DIR || undefined,
    // The old back-office pages now live in one panel. Temporary (307) so browsers never cache the hop.
    async redirects() {
      return [
        { source: "/menu", destination: "/manage?tab=menu", permanent: false },
        { source: "/inventory", destination: "/manage?tab=inventory", permanent: false },
        { source: "/recipes", destination: "/manage?tab=recipes", permanent: false },
        { source: "/purchases", destination: "/manage?tab=suppliers&view=invoices", permanent: false },
      ];
    },
    async headers() {
      return [
        { source: "/:path*", headers: STATIC_HEADERS },
        // the offline wake detector's model (lib/wakeDetector.ts): a versioned file name, cached for good (also in the Cache API)
        { source: "/voice-models/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
        {
          // The service worker must always be revalidated so app updates reach tablets promptly.
          source: "/sw.js",
          headers: [
            { key: "Content-Type", value: "application/javascript; charset=utf-8" },
            { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          ],
        },
      ];
    },
  };
}
