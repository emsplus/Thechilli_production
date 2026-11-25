"use client";
import { isOutletPath, orderHref } from "@/lib/routes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, auth } from "@/lib/api";
import { allowedModes, navItems, showTables } from "@/lib/capabilities";
import { useProfile } from "@/lib/capsStore";
import { counterState } from "@/lib/counter/state";
import { draftActions, useDraft } from "@/lib/draft";
import { MenuProvider, useMenu } from "@/lib/menu";
import { ReadyProvider, useReady } from "@/lib/notifications";
import { useIntegrity } from "@/lib/native/integrityState";
import { useOnline, useQueue } from "@/lib/sync";
import { defaultSessionGateway } from "@/lib/session";
import { useLang, useT, type Key } from "@/lib/i18n";
import { NavIcon } from "@/components/NavIcons";
import { registerDefaultVoice } from "@/lib/voiceProvider";
import { failedOrderCount, ordersWord, pendingOrderCount, shiftPending } from "@/lib/orderEntries";
import { BootScreen } from "@/components/BootScreen";
import { useRefreshAll } from "@/components/LiveStamp";

registerDefaultVoice(); // module scope: identical on server render and client, so the Mic button never hydrates differently

const NAV_LABEL: Record<string, Key> = { "/tables": "nav.tables", "/menu": "nav.menu", "/cart": "nav.cart", "/orders": "nav.orders", "/more": "nav.more" };

function Banners() {
  const online = useOnline();
  const integrity = useIntegrity();
  const { stale, ageHours, fromCache, refresh } = useMenu();
  const ops = useQueue();
  const failed = failedOrderCount(ops);
  return (
    <div role="status" aria-live="polite">
      {integrity.status === "lost" && <div className="banner err">This device cleared its saved data{`: about ${integrity.pendingLost} unsent order step(s) were lost. Check with the kitchen or cashier and re-enter them.`}</div>}
      {integrity.status === "unavailable" && <div className="banner err">Offline storage is unavailable. Orders cannot be saved while offline.</div>}
      {!online && <div className="banner">Offline. Orders are saved on this device and will send automatically.</div>}
      {stale && (
        <div className="banner">
          Menu may be out of date{ageHours !== null ? ` (saved ${Math.floor(ageHours)}h ago)` : ""}{fromCache ? ", could not refresh" : ""}. Prices are re-checked by the server.{" "}
          <button className="btn" onClick={() => void refresh()}>Refresh</button>
        </div>
      )}
      {failed > 0 && <div className="banner err"><Link href="/orders#failed-orders" onClick={(e) => { const el = document.getElementById("failed-orders"); if (el) { e.preventDefault(); el.scrollIntoView({ block: "start" }); el.focus({ preventScroll: true }); } }}>{ordersWord(failed)} could not be sent. Tap to review.</Link></div>}
    </div>
  );
}

/** One compact toast above the bottom nav (and the cart bar), never over tap targets; extra tickets collapse into "+N more". */
function ReadyToasts({ aboveCartbar }: { aboveCartbar: boolean }) {
  const { ready, dismiss } = useReady();
  if (!ready.length) return null;
  const k = ready[0];
  return (
    <div className={`toast${aboveCartbar ? " above-cartbar" : ""}`} role="alert">
      <div className="card row">
        <div className="grow"><strong>KOT #{k.number} is ready</strong><div className="small muted">{ready.length > 1 ? `+${ready.length - 1} more ready` : "Pick up from the kitchen"}</div></div>
        <Link className="btn" href={orderHref(k.order_id)} onClick={() => dismiss(k.id)}>View</Link>
        <button className="btn" onClick={() => dismiss(k.id)} aria-label={`Dismiss KOT ${k.number}`}>OK</button>
      </div>
    </div>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  const path = usePathname();
  const t = useT();
  const lang = useLang();
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const draft = useDraft();
  const ops = useQueue();
  const cartCount = draft.lines.reduce((s, l) => s + l.quantity, 0);
  const pending = pendingOrderCount(ops); // one unit everywhere: orders (header pill, Orders badge, banner)
  const shift = shiftPending(ops);
  const { ready } = useReady();
  const profile = useProfile();
  // A kitchen has no floor: its first tab is the new order (the menu), named for what the waiter does there.
  const nav = navItems(profile), newOrderFirst = !showTables(profile);
  const cartbar = path.startsWith("/menu") && cartCount > 0;
  // Pull down at the top of any screen = refresh from the server (orders, tables, menu).
  const refreshAll = useRefreshAll();
  const pullFrom = useRef<number | null>(null);
  const [pull, setPull] = useState<"idle" | "armed" | "busy">("idle");
  return (
    <div className={`shell${ready.length ? (cartbar ? " has-toast has-cartbar" : " has-toast") : ""}`}>
      <header className="top"><h1>{title}</h1><span role="status" className={`pill sync ${pending || shift ? "pending" : "synced"}`}>{pending ? `${ordersWord(pending)} to send` : shift ? "Shift saving" : "All sent"}</span></header>
      <ReadyToasts aboveCartbar={cartbar} />
      <main id="main" className="main"
        onTouchStart={(e) => { pullFrom.current = (document.scrollingElement?.scrollTop ?? 0) <= 0 && pull === "idle" ? e.touches[0].clientY : null; }}
        onTouchMove={(e) => { if (pullFrom.current !== null && e.touches[0].clientY - pullFrom.current > 90 && pull === "idle") setPull("armed"); }}
        onTouchEnd={() => { pullFrom.current = null; if (pull === "armed") { setPull("busy"); void refreshAll().finally(() => setPull("idle")); } }}>
        {pull !== "idle" && <div className="pullhint small muted" role="status">{pull === "armed" ? "Release to refresh" : "Refreshing..."}</div>}
        <Banners />{children}
      </main>
      <nav className="nav" aria-label="Main">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} aria-current={path.startsWith(n.href) ? "page" : undefined}>
            <span className="ico"><NavIcon href={n.href} /></span><span>{n.href === "/menu" && newOrderFirst ? t("nav.newOrder") : t(NAV_LABEL[n.href])}</span>{n.href === "/cart" && cartCount > 0 && <span className="badge" aria-label={`${cartCount} items`}>{cartCount}</span>}
            {n.href === "/orders" && pending > 0 && <span className="badge" aria-label={`${ordersWord(pending)} waiting to send`}>{pending}</span>}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export const AppShell = Frame;

/** Keeps the business profile fresh (sign-in and PIN sign-in already stored it; this catches an owner changing the business type
 *  while the app stays signed in, and an install from before profiles) and moves bills that the profile no longer allows. */
function ProfileSync() {
  const profile = useProfile();
  useEffect(() => {
    const load = () => { if (auth.token) void api.me().catch(() => { /* offline: the last known profile stays */ }); };
    load();
    const vis = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("online", load); document.addEventListener("visibilitychange", vis);
    return () => { window.removeEventListener("online", load); document.removeEventListener("visibilitychange", vis); };
  }, []);
  const key = `${allowedModes(profile).join(",")}`;
  useEffect(() => { draftActions.conform(); }, [key]);
  return null;
}

/** Auth + shift guard and shared data providers for every screen except /login. Mounted once in app/(app)/layout.tsx. */
export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Read from storage on the client only; server render and hydration see "checking".
  const gate = useSyncExternalStore(auth.subscribe, () => (!auth.hydrated || (auth.locked && !auth.token) ? "checking" : !auth.token ? (counterState.active ? "counter" : "login") : !defaultSessionGateway.currentShift() ? "outlet" : "ok"), () => "checking");
  // usePathname, NOT location.pathname: Next updates the address bar AFTER it renders the new route, so a render that reads
  // `location` sees the PREVIOUS url, decides "not on the outlet screen" and shows the splash; nothing then re-renders it, and the
  // app froze on the logo at /outlet/ (reproduced on the v1 APK). usePathname is part of the router state and re-renders.
  const pathname = usePathname();
  const onOutlet = isOutletPath(pathname ?? "");
  useEffect(() => {
    if (gate === "login") router.replace("/login");
    else if (gate === "counter") router.replace("/counter"); // shared tablet: back to "Tap your name"
    else if (gate === "outlet" && !onOutlet) router.replace("/outlet");
  }, [gate, onOutlet, router]);
  if (gate === "checking" || gate === "login" || gate === "counter" || (gate === "outlet" && !onOutlet)) return <BootScreen />;
  return <MenuProvider><ReadyProvider><ProfileSync />{children}</ReadyProvider></MenuProvider>;
}
