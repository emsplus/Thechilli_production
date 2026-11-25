import type { Metadata, Viewport } from "next";
import { NativeBootstrap } from "@/components/NativeBootstrap";
import { LockGate } from "@/components/LockGate";
import { CounterGate } from "@/components/CounterGate";
import { MOBILE_THEME, APPLIED_THEME, htmlThemeAttr } from "@/lib/mobileTheme";
import { SwRegister } from "@/components/SwRegister";
import { BOOT_GUARD_JS } from "@/lib/native/bootGuard";
import localFont from "next/font/local";
import "@chilli/tokens/tokens.css";
import "./globals.css";

// Self-hosted (SIL OFL, licences in src/fonts): no CDN, no runtime font request, works offline in the PWA and Capacitor.
const inter = localFont({ src: "../fonts/Inter-latin.woff2", weight: "400 700", variable: "--font-inter", display: "swap" });
// Devanagari companion, only fetched by the browser when Hindi text is on screen (DM Sans has no Devanagari glyphs).
const notoDeva = localFont({ src: "../fonts/NotoSansDevanagari-devanagari.woff2", weight: "400 800", variable: "--font-noto-deva", display: "swap", preload: false });
// Brand guide (2026-10-31): Poppins Bold for headings only (one weight, Latin, 7.8 KB).
const poppins = localFont({ src: "../fonts/Poppins-700-latin.woff2", weight: "700", variable: "--font-poppins", display: "swap" });

export const metadata: Metadata = { title: "Chilli Staff", description: "Chilli Staff: waiter / captain ordering", manifest: "/manifest.webmanifest", appleWebApp: { capable: true, title: "Chilli Staff" }, icons: { icon: "/icon-192.png", apple: "/icon-192.png" } };
// Light only (see mobileTheme.ts APPLIED_THEME): one theme-color, <meta name="color-scheme" content="light">. "auto" restores the light/dark pair.
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover",
  colorScheme: APPLIED_THEME === "light" ? "light" : "light dark",
  themeColor: APPLIED_THEME === "light" ? MOBILE_THEME.pageLight : [
    { media: "(prefers-color-scheme: light)", color: MOBILE_THEME.pageLight },
    { media: "(prefers-color-scheme: dark)", color: MOBILE_THEME.pageDark },
  ] };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme={htmlThemeAttr} className={`${inter.variable} ${notoDeva.variable} ${poppins.variable}`}>
      <body>
        {/* Boot guard (lib/native/bootGuard.ts): first script on the page; hides the native launch screen after 3 s, checks the WebView version, shows startup errors on screen. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_GUARD_JS }} />
        <a className="skip" href="#main">Skip to content</a>
        <SwRegister />
        <NativeBootstrap />
        {children}
        <LockGate />
        <CounterGate />
      </body>
    </html>
  );
}
