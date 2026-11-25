import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "@chilli/tokens/fonts.css";
import "@chilli/tokens/tokens.css";
import "@chilli/ui/styles.css";
import "@chilli/ui/data.css";
import "@chilli/ui/kds.css";
import "./globals.css";
import { SyncProvider } from "@/components/SyncProvider";
import { Providers } from "@/components/Providers";
import { AppShell } from "@/components/shell/app-shell";
import { EFFECTS_INIT_SCRIPT, SIDEBAR_INIT_SCRIPT, THEME_INIT_SCRIPT } from "@/components/theme/init-scripts";

// Fonts (style guide v1.0): Inter UI, Poppins headings, JetBrains Mono amounts, Montserrat tagline. Self-hosted woff2 from
// @chilli/tokens/fonts.css (no CDN, no build-time download); globals.css maps --nf-ui / --nf-display / --nf-code to them.

export const metadata: Metadata = {
  title: { default: "Chilli Agent by TheChilli.ai", template: "%s · Chilli Agent" },
  description: "TheChilli.ai: Chilli Agent billing, kitchen and back office for restaurants",
  icons: { icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icon.svg", type: "image/svg+xml" }], apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, title: "TheChilli.ai", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  // Light theme only: one theme colour and <meta name="color-scheme" content="light"> (form controls, scrollbars, date pickers, autofill).
  themeColor: "#F9FAFB",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Per-request CSP nonce from src/proxy.ts (reading headers also makes every page dynamic, which a nonce needs).
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <head>
        {/* Runs before first paint: pins the light theme (and forgets any saved dark choice), restores the sidebar state and effects level, so nothing flashes. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT + SIDEBAR_INIT_SCRIPT + EFFECTS_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full">
        <Providers>
          <SyncProvider />
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
