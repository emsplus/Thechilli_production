import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { connection } from "next/server";
import "@chilli/tokens/fonts.css";
import "@chilli/tokens/tokens.css";
import "@chilli/ui/styles.css";
import "./globals.css";
import { Footer, Header } from "@/components/site";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Sign up for TheChilli.ai", template: "%s | TheChilli.ai" },
  description: "Apply for Chilli Agent: GST-ready billing, UPI payments and kitchen tickets for restaurants, cafes and cloud kitchens in India.",
  openGraph: { type: "website", siteName: "TheChilli.ai", locale: "en_IN" },
  alternates: { canonical: "./" },
  icons: { icon: [{ url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/brand/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/brand/apple-touch-icon.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#FFFFFF", colorScheme: "light" }; // light theme only (owner decision 2026-11-01): one theme colour, <meta name="color-scheme" content="light">

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered per request: the CSP nonce (src/proxy.ts) is stamped on Next.js's scripts only at request time.
  await connection();
  return (
    <html lang="en-IN">
      <body>
        <Header />
        <main id="main" className="main" tabIndex={-1}>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
