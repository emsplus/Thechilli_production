import type { NextConfig } from "next";
import path from "node:path";
import { BASE_HEADERS } from "./src/lib/security-headers";

const config: NextConfig = {
  turbopack: {
    // @chilli/tokens and @chilli/ui are linked from ../design-system, so Turbopack must be allowed to read the parent folder.
    root: path.resolve(process.cwd(), ".."),
    // The linked packages would otherwise resolve their own copy of React (a second instance breaks hooks): force the app's.
    resolveAlias: {
      react: "./node_modules/react",
      "react-dom": "./node_modules/react-dom",
    },
  },
  poweredByHeader: false,
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  async headers() {
    return [
      {
        source: "/:path*",
        // Content-Security-Policy (per-request nonce) and HSTS (https only) come from src/proxy.ts.
        headers: [
          ...BASE_HEADERS,
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
