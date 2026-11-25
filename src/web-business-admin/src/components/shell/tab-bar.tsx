"use client";

import Link from "next/link";
import { useState } from "react";
import { Ellipsis, LogOut } from "lucide-react";
import { Button, Sheet } from "@chilli/ui";
import { useSignOut } from "@/lib/useSignOut";
import { useSyncStatus } from "@/lib/useSyncStatus";
import { cn } from "@/lib/cn";
import { BrandMark } from "@/components/BrandMark";
import { useRestaurantMeta } from "@/lib/restaurantMeta";
import { ICONS } from "./nav-items";
import { ACCOUNT_LEAF, SYNC_LEAF, type NavLeaf } from "./nav-model";
import { useNav } from "./use-nav";
import { useLocale } from "@/lib/i18n";
import { navLabel } from "./nav-labels";

/** Phone/tablet bottom bar: max 5 slots (role based, see nav-model bottomBar) with the rest in a More sheet. */
export function TabBar() {
  const { locale } = useLocale();
  const [more, setMore] = useState(false);
  const signOut = useSignOut();
  const meta = useRestaurantMeta();
  const s = useSyncStatus();
  const attention = s.failed + s.conflict;
  const nav = useNav();
  const here = nav.activeHref;
  const rest: NavLeaf[] = [...nav.bar.more.flatMap((a) => a.items), ACCOUNT_LEAF, SYNC_LEAF];
  const moreActive = !!here && rest.some((i) => i.href === here) && !nav.bar.slots.some((t) => t.href === here);

  const base = "relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[0.7rem] font-semibold transition-colors";
  return (
    <>
      <nav aria-label="Primary" className="vt-tabbar fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] z-40 mx-auto max-w-xl rounded-2xl border border-border bg-surface lg:hidden">
        <ul className="flex h-[var(--tabbar-h)] px-1.5">
          {nav.loading && Array.from({ length: 4 }, (_, i) => <li key={`sk${i}`} data-testid="tab-skeleton" className="flex flex-1 items-center justify-center"><span aria-hidden className="h-8 w-10 animate-pulse rounded-xl bg-surface-2" /></li>)}
          {nav.bar.slots.map((it) => {
            const active = here === it.href;
            const Icon = ICONS[it.icon];
            return (
              <li key={it.key} className="flex flex-1">
                <Link href={it.href} aria-current={active ? "page" : undefined} className={cn(base, active ? "text-primary-soft-fg" : "text-fg-subtle active:text-fg")}>
                  {active && <span aria-hidden className="absolute inset-x-0.5 top-1.5 bottom-1.5 rounded-2xl bg-primary-soft" />}
                  <Icon aria-hidden className="vt-tab-icon relative size-6" />
                  <span className="vt-tab-label relative flex min-h-[2.2em] items-start justify-center px-0.5 text-center leading-[1.1]">{navLabel(it.label, locale)}</span>
                </Link>
              </li>
            );
          })}
          <li className="flex flex-1">
            <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog" className={cn(base, moreActive ? "text-primary-soft-fg" : "text-fg-subtle active:text-fg")}>
              {moreActive && <span aria-hidden className="absolute inset-x-0.5 top-1.5 bottom-1.5 rounded-2xl bg-primary-soft" />}
              <span className="relative"><Ellipsis aria-hidden className="vt-tab-icon size-6" />{attention > 0 && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-danger-solid ring-2 ring-surface" />}</span>
              <span className="vt-tab-label relative flex min-h-[2.2em] items-start justify-center px-0.5 text-center leading-[1.1]">More</span>
            </button>
          </li>
        </ul>
      </nav>
      <Sheet open={more} onOpenChange={setMore} title="More">
        <div className="mb-3 flex items-center gap-3 rounded-2xl bg-surface-2 p-3">
          <BrandMark className="size-12 shadow-md" />
          <div className="min-w-0 leading-tight">
            <p className="truncate font-display text-base font-extrabold text-fg">{meta.name}</p>
            {meta.subtitle && <p className="truncate text-xs font-medium text-fg-subtle">{meta.subtitle}</p>}
          </div>
        </div>
        <ul className="grid grid-cols-3 gap-2 pb-2">
          {rest.map((it) => {
            const Icon = ICONS[it.icon];
            const active = here === it.href;
            return (
              <li key={it.href}>
                <Link href={it.href} onClick={() => setMore(false)} aria-current={active ? "page" : undefined}
                  className={cn("flex h-24 flex-col items-center justify-center gap-2 rounded-2xl border text-sm font-semibold transition-[background-color,border-color,transform] active:scale-[0.97]", active ? "border-primary/40 bg-primary-soft text-primary-soft-fg" : "border-border bg-surface-2/60 text-fg hover:bg-surface-2")}>
                  <Icon aria-hidden className="size-6" />
                  {navLabel(it.label, locale)}
                  {it.href === "/sync" && attention > 0 && <span className="sr-only">, {attention} need attention</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        <Button variant="danger-soft" iconStart={<LogOut />} onClick={() => { setMore(false); void signOut(); }} className="mb-3 mt-2 w-full">Sign out</Button>
      </Sheet>
    </>
  );
}
