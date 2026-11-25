import type { NextConfig } from "next";
import path from "node:path";
import { BASE_HEADERS } from "./src/lib/security-headers";

const config: NextConfig = {
  poweredByHeader: false,
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined, // Docker image (infra web.Dockerfile): next.config.ts imports ./src, absent in the pruned runtime
  // Content-Security-Policy (per-request nonce) and HSTS (https only) come from src/proxy.ts.
  async headers() {
    return [{ source: "/:path*", headers: [...BASE_HEADERS, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] }];
  },
  distDir: process.env.NEXT_DIST_DIR ?? ".next", // e2e builds mock and real variants side by side
  turbopack: {
    // @chilli/tokens and @chilli/ui are linked from ../design-system: allow Turbopack to read the parent folder.
    root: path.resolve(process.cwd(), ".."),
    // Linked packages must use the app's single React copy.
    resolveAlias: {
      react: "./node_modules/react",
      "react-dom": "./node_modules/react-dom",
    },
  },
};

export default config;
