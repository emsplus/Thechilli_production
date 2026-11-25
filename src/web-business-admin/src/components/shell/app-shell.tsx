"use client";

import { usePathname } from "next/navigation";
import { Suspense, useSyncExternalStore, type ReactNode } from "react";
import { AiDrawerProvider } from "./ai-drawer";
import { ChilliBanner } from "./chilli-banner";
import { EntitlementBanner } from "./entitlement-banner";
import { Sidebar } from "./sidebar";
import { TabBar } from "./tab-bar";
import { Topbar } from "./topbar";
import { useRole } from "@/lib/useRole";
import { kitchenMode, useKitchenFullScreen } from "@/lib/kitchenMode";
import { auth } from "@/lib/api";
import { isFullBleed, isKnownRoute } from "./routes";

const onStorage = (cb: () => void) => { window.addEventListener("storage", cb); return () => window.removeEventListener("storage", cb); };
/** Signed in on this device? null on the server (unknown). */
const useSignedIn = () => useSyncExternalStore(onStorage, () => !!auth.token, () => null);

/** Routes that render without the shell. */
const BARE = ["/login", "/register", "/forgot-password", "/reset-password", "/staff-login", "/accept-invite"];
const KITCHEN = "/kitchen"; // full-screen kiosk for the kitchen role (or by choice), inside the shell for everyone else: see lib/kitchenMode

/**
 * Wraps every route except /login, /register and the /kitchen kiosk (kitchen role, or full screen by choice). Desktop (lg+): collapsible sidebar (Chilli Agent, Orders, Kitchen, Inventory, Manage) + flat top bar.
 * Phone/tablet: top bar + bottom bar. Pages render only their own content.
 * Bottom space a page must leave on < lg: var(--tabbar-space) (main already pads for it).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const role = useRole();
  const full = useKitchenFullScreen();
  const kiosk = (pathname === KITCHEN || pathname.startsWith(KITCHEN + "/")) && kitchenMode(role, full) === "kiosk";
  const signedIn = useSignedIn();
  // Unknown URL: the 404 page (app/not-found.tsx). Signed in, it sits inside the shell; signed out (or not known yet) it
  // stands alone, because the shell's own requests would send a signed-out visitor to /login.
  const lost = !isKnownRoute(pathname) && signedIn !== true;
  if (kiosk || lost || BARE.some((p) => pathname === p || pathname.startsWith(p + "/"))) return <>{children}</>;
  return (
    <AiDrawerProvider>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg">Skip to content</a>
      <Suspense fallback={null}><Sidebar /></Suspense>
      <div className="shell-main flex min-h-dvh min-w-0 flex-col">
        <Suspense fallback={null}><Topbar /></Suspense>
        <EntitlementBanner />
        <ChilliBanner />
        <main id="main-content" tabIndex={-1} data-width={isFullBleed(pathname) ? "full" : "content"} className="page-width mx-auto w-full min-w-0 flex-1 [overflow-x:clip] px-3 pb-[calc(var(--tabbar-space)+1rem)] pt-4 outline-none sm:px-5 sm:pt-5 lg:pb-8 lg:pr-6">
          {children}
        </main>
      </div>
      <Suspense fallback={null}><TabBar /></Suspense>
    </AiDrawerProvider>
  );
}
