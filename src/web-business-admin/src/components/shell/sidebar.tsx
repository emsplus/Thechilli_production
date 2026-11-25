"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useSyncExternalStore } from "react";
import { Button } from "@chilli/ui";
import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { useRestaurantMeta } from "@/lib/restaurantMeta";
import { useSyncStatus } from "@/lib/useSyncStatus";
import { useSignOut } from "@/lib/useSignOut";
import { cn } from "@/lib/cn";
import { ICONS, SYNC_ICON } from "./nav-items";
import { ACCOUNT_LEAF, SYNC_LEAF } from "./nav-model";
import { useNav } from "./use-nav";
import { useLocale } from "@/lib/i18n";
import { navLabel } from "./nav-labels";


import { SIDEBAR_KEY as KEY } from "@/components/theme/init-scripts";
const EVT = "pos-sidebar-change";

function useCollapsed() {
  const collapsed = useSyncExternalStore(
    (cb) => { window.addEventListener(EVT, cb); return () => window.removeEventListener(EVT, cb); },
    () => document.documentElement.getAttribute("data-sidebar") === "collapsed",
    () => false,
  );
  const toggle = useCallback(() => {
    const next = !collapsed;
    if (next) document.documentElement.setAttribute("data-sidebar", "collapsed"); else document.documentElement.removeAttribute("data-sidebar");
    try { localStorage.setItem(KEY, next ? "collapsed" : "expanded"); } catch { /* ignore */ }
    window.dispatchEvent(new Event(EVT));
  }, [collapsed]);
  return { collapsed, toggle };
}

/** Floating sidebar card (lg+): grouped nav, sliding copper active pill, sign out + collapse at the bottom. */
export function Sidebar() {
  const { locale } = useLocale();
  const pathname = usePathname();
  const signOut = useSignOut();
  const s = useSyncStatus();
  const attention = s.failed + s.conflict;
  const { collapsed, toggle } = useCollapsed();
  const nav = useNav();
  const meta = useRestaurantMeta();
  const activeLeaf = nav.activeHref;
  const syncActive = pathname.startsWith("/sync");
  const accountActive = pathname.startsWith("/account");

  return (
    <aside aria-label="Primary" className="shell-sidebar fixed bottom-3 left-3 top-3 z-40 hidden flex-col rounded-2xl border border-border bg-surface lg:flex">
      <div className="flex h-[var(--topbar-h)] shrink-0 items-center gap-3 px-4">
        <BrandMark className="size-11 shadow-md ring-1 ring-border" />
        <span className="shell-label min-w-0 leading-tight">
          <span className="block truncate font-display text-[1.05rem] font-extrabold tracking-tight text-fg" title={meta.name}>{meta.name}</span>
          {meta.subtitle && <span className="block truncate text-[0.7rem] font-medium text-fg-subtle">{meta.subtitle}</span>}
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4 scrollbar-thin">
        {nav.loading && (
          // A div, not a ul: a list with role=status has no listitem children (axe "listitem", seen while the role was still loading)
          <div aria-label="Loading menu" role="status" data-testid="nav-skeleton" className="mt-2 space-y-1">
            {Array.from({ length: 5 }, (_, i) => <div key={i} className="h-11 animate-pulse rounded-xl bg-surface-2" />)}
          </div>
        )}
        {nav.areas.map((a) => (
          <section key={a.id} aria-labelledby={`nav-${a.id}`} className="mt-2 first:mt-0">
            <h2 id={`nav-${a.id}`} className="shell-label px-3 pb-1 pt-2 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-fg-subtle">{navLabel(a.label, locale)}</h2>
            <ul className="space-y-0.5">
              {a.items.map((it) => {
                const Icon = ICONS[it.icon];
                const on = activeLeaf === it.href;
                return (
                  <li key={it.href}>
                    <Link href={it.href} aria-current={on ? "page" : undefined} title={collapsed ? it.label : undefined}
                      className={cn("relative flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors", on ? "bg-primary-soft text-primary-soft-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg")}>
                      <Icon aria-hidden className="size-5 shrink-0" />
                      <span className="shell-label">{navLabel(it.label, locale)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>
      <div className="shrink-0 space-y-1 px-3 pb-2">
        <Link href={SYNC_LEAF.href} aria-current={syncActive ? "page" : undefined} title={collapsed ? SYNC_LEAF.label : undefined}
          className={cn("flex h-10 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors", syncActive ? "bg-primary-soft text-primary-soft-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg")}>
          <SYNC_ICON aria-hidden className="size-5 shrink-0" />
          <span className="shell-label">{navLabel(SYNC_LEAF.label, locale)}</span>
          {attention > 0 && <span aria-label={`${attention} need attention`} className="ml-auto grid min-w-5 place-items-center rounded-full bg-danger-solid px-1.5 text-[0.7rem] font-bold text-white">{attention}</span>}
        </Link>
      </div>
      <div className="flex shrink-0 gap-1 border-t border-border p-3 [html[data-sidebar=collapsed]_&]:flex-col">
        <Button variant="ghost" onClick={() => void signOut()} title="Sign out" iconStart={<LogOut aria-hidden className="size-5 shrink-0" />} className="min-w-0 flex-1 justify-start">
          <span className="shell-label whitespace-nowrap">{navLabel("Sign out", locale)}</span>
        </Button>
        <Link href={ACCOUNT_LEAF.href} aria-label={ACCOUNT_LEAF.label} title={ACCOUNT_LEAF.label} aria-current={accountActive ? "page" : undefined}
          className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-colors [html[data-sidebar=collapsed]_&]:w-full", accountActive ? "bg-primary-soft text-primary-soft-fg" : "text-fg-subtle hover:bg-surface-2 hover:text-fg")}>
          <ICONS.account aria-hidden className="size-5" />
        </Link>
        <button type="button" onClick={toggle} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg [html[data-sidebar=collapsed]_&]:w-full">
          {collapsed ? <PanelLeftOpen aria-hidden className="size-5" /> : <PanelLeftClose aria-hidden className="size-5" />}
        </button>
      </div>
    </aside>
  );
}
