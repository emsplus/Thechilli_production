import type { NextConfig } from "next";
import path from "node:path";
import { BASE_HEADERS } from "./src/lib/security-headers";

const config: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    root: path.resolve(process.cwd(), ".."),
    resolveAlias: { react: "./node_modules/react", "react-dom": "./node_modules/react-dom" },
  },
  // Content-Security-Policy (per-request nonce, no 'unsafe-inline' scripts) and HSTS (https only, HSTS env) come from
  // src/proxy.ts; the API origins the forms post to are listed there.
  async headers() {
    return [{ source: "/:path*", headers: [...BASE_HEADERS, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] }];
  },
};
export default config;
