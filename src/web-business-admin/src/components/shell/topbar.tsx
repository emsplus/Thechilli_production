"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { IconButton } from "@chilli/ui";
import { BrandMark } from "@/components/BrandMark";
import { cn } from "@/lib/cn";
import { useRestaurantMeta } from "@/lib/restaurantMeta";
import { NotificationBell } from "./notification-bell";
import { AI_ICON, titleFor } from "./nav-items";
import { useAiDrawer } from "./ai-drawer";
import { SyncStatus } from "./sync-status";
import { LocaleSwitch } from "./locale-switch";
import { navLabel } from "./nav-labels";
import { useLocale } from "@/lib/i18n";
import { TOPBAR_SLOT_ID } from "./topbar-slot";
import { ClockButton } from "./clock-button";

/** Top bar: section title (icon tile on lg), page slot, notifications (bill requests + alerts), sync pill, AI assistant. */
export function Topbar() {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const item = titleFor(pathname, pathname.startsWith("/manage") && !tab ? "overview" : tab);
  const Icon = item?.icon;
  const meta = useRestaurantMeta();
  const ai = useAiDrawer();
  const { locale } = useLocale();
  return (
    <div className="vt-topbar sticky top-0 z-30 flex h-[var(--topbar-h)] items-center gap-3 border-b border-border bg-surface px-3 pt-safe sm:px-5 lg:top-3 lg:mx-3 lg:mt-3 lg:rounded-2xl lg:border lg:pr-3">
      <BrandMark className="hidden size-9 shadow-sm sm:block lg:hidden" />
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon && <span className="hidden size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-soft-fg lg:grid"><Icon aria-hidden className="size-[1.1rem]" /></span>}
        {/* Where you are (area › page), not a heading: each page has exactly one h1 of its own. */}
        <p className="flex min-w-0 items-center gap-1.5 truncate font-display text-base font-bold text-fg lg:text-xl">
          {item?.area && <><span className="hidden truncate font-medium text-fg-muted sm:inline">{navLabel(item.area, locale)}</span><span aria-hidden className="hidden text-fg-subtle sm:inline">›</span></>}
          <span className="truncate">{item ? navLabel(item.label, locale) : meta.name}</span>
        </p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
        <div id={TOPBAR_SLOT_ID} className="flex items-center gap-2 empty:hidden" />
        <NotificationBell />
        <ClockButton />
        <LocaleSwitch />
        <SyncStatus />
        <IconButton label="AI assistant" icon={<AI_ICON aria-hidden className="size-5" />} aria-expanded={ai.open} onClick={ai.toggle} className={cn(ai.open && "bg-primary-soft text-primary-soft-fg")} />
      </div>
    </div>
  );
}
