import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";
import "@chilli/tokens/fonts.css";
import "@chilli/tokens/tokens.css";
import "@chilli/ui/styles.css";
import "@chilli/ui/auth.css";
import "./globals.css";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: { default: "TheChilli.ai Super Admin", template: "%s · TheChilli.ai Super Admin" },
  description: "TheChilli.ai platform administration",
  robots: { index: false, follow: false },
  icons: { icon: [{ url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/brand/apple-touch-icon.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F9FAFB", colorScheme: "light" }; // light theme only (owner decision 2026-11-01): one theme colour, <meta name="color-scheme" content="light">

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered per request: the CSP nonce (src/proxy.ts) is stamped on Next.js's scripts only at request time.
  await connection();
  return (
    <html lang="en-IN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
