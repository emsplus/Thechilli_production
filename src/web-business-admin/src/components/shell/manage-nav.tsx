"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, type ReactNode } from "react";
import { Boxes, ChefHat, HeartPulse, LayoutDashboard, MonitorSmartphone, Bike, Printer, Star, Store, Truck, UserCog, Users, UtensilsCrossed, Armchair, Wallet, type LucideIcon } from "lucide-react";
import { Skeleton } from "@chilli/ui";
import { cn } from "@/lib/cn";
import { useLocale, useMsg } from "@/lib/i18n";
import { useCan, useRole } from "@/lib/useRole";
import { MANAGE_MSG } from "@/app/manage/_components/shell-messages";
import { ICONS } from "./nav-items";
import { navLabel } from "./nav-labels";
import { MANAGE_GROUP_LABEL, visibleManageEntries, type ManageEntry, type ManageGroup, type NavGate } from "./nav-model";
import { useSignedInHere } from "./use-nav";

/** Manage's own icons for its tabs (kept from the original rail); the screens that have their own page use the shared nav icons. */
const TAB_ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard, menu: UtensilsCrossed, tables: Armchair, reviews: Star, customers: Users, recipes: ChefHat, inventory: Boxes, suppliers: Truck,
  staff: UserCog, restaurant: Store, billing: Wallet, printers: Printer, devices: MonitorSmartphone, delivery: Bike, system: HeartPulse,
};
const iconOf = (e: ManageEntry): LucideIcon => (e.kind === "tab" ? TAB_ICONS[e.id] : undefined) ?? ICONS[e.icon];

/** Label of an entry in the user's language (tabs: the Manage catalogue; screens: the nav labels; English wherever there is no translation). */
export function useEntryLabel() {
  const t = useMsg(MANAGE_MSG);
  const { locale } = useLocale();
  return (e: ManageEntry) => (e.kind === "tab" && `tab_${e.id}` in MANAGE_MSG ? t(`tab_${e.id}`) : navLabel(e.label, locale));
}

const groupsOf = (entries: readonly ManageEntry[]): { group: ManageGroup; items: ManageEntry[] }[] => {
  const out: { group: ManageGroup; items: ManageEntry[] }[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.group === e.group) last.items.push(e); else out.push({ group: e.group, items: [e] });
  }
  return out;
};

/** One item of the "Manage" panel (the original's left card): icon, label, attention count; active = peach pill. */
function RailLink({ icon: Icon, label, on, href, n, replace }: { icon: LucideIcon; label: string; on: boolean; href: string; n?: number; replace: boolean }) {
  return (
    <Link href={href} replace={replace} scroll={replace ? false : undefined} aria-current={on ? "page" : undefined}
      className={cn("relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-ring", on ? "bg-primary-soft text-primary-soft-fg ring-1 ring-primary/10" : "text-fg-muted hover:bg-surface-2 hover:text-fg")}>
      <Icon aria-hidden className="size-[1.15rem] shrink-0" />
      <span className="min-w-0 flex-1 leading-tight">{label}</span>
      {n ? <span className="tnum grid min-w-5 place-items-center rounded-full bg-warning-soft px-1.5 text-[0.7rem] font-bold text-warning-fg"><span className="sr-only">{n} need attention: </span>{n}</span> : null}
    </Link>
  );
}

/**
 * The inner navigation of Manage: on phones and tablets one picker, on desktop the original's "Manage" card with the groups
 * Operations and Set up. Renders two siblings (picker, card) so the caller's grid places them.
 * `onPick` is called for a tab entry on the Manage page itself (it switches tabs without a page change); everything else is a link.
 */
export function ManageNav({ entries, activeId, attention, onPick }: { entries: readonly ManageEntry[]; activeId: string | undefined; attention?: Record<string, number>; onPick?: (e: ManageEntry) => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const label = useEntryLabel();
  const onManage = pathname === "/manage" || pathname.startsWith("/manage/");
  const groups = useMemo(() => groupsOf(entries), [entries]);
  const { locale } = useLocale();
  const pick = (id: string) => {
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    if (e.kind === "tab" && onManage && onPick) onPick(e); else router.push(e.href);
  };
  return (
    <>
      {/* Phones and tablets: one picker for the section */}
      <label className="block lg:hidden">
        <span className="sr-only">Manage section</span>
        <select aria-label="Manage section" value={activeId ?? ""} onChange={(e) => pick(e.target.value)}
          className="h-11 w-full min-w-0 rounded-xl border border-border-strong bg-surface px-3 text-sm font-semibold text-fg focus-visible:outline-2 focus-visible:outline-ring">
          {activeId === undefined && <option value="" disabled>Manage</option>}
          {groups.map((g) => {
            const opts = g.items.map((x) => <option key={x.id} value={x.id}>{label(x)}</option>);
            const name = MANAGE_GROUP_LABEL[g.group];
            return name ? <optgroup key={g.group} label={navLabel(name, locale)}>{opts}</optgroup> : opts;
          })}
        </select>
      </label>
      {/* Desktop: the original's "Manage" card beside the content */}
      <nav aria-label="Manage sections" className="scrollbar-thin sticky top-[calc(var(--topbar-h)+1.5rem)] hidden max-h-[calc(100dvh-var(--topbar-h)-3rem)] overflow-y-auto rounded-2xl border border-border bg-surface p-2 shadow-card lg:block">
        {groups.map((g, i) => {
          const name = MANAGE_GROUP_LABEL[g.group];
          return (
            <section key={g.group} aria-label={name ? navLabel(name, locale) : undefined} className={i > 0 ? "mt-1" : undefined}>
              {name && <h2 className="px-3 pb-1 pt-3 text-[0.7rem] font-bold uppercase tracking-[0.12em] text-fg-subtle">{navLabel(name, locale)}</h2>}
              <ul className="space-y-0.5">
                {g.items.map((x) => (
                  <li key={x.id}><RailLink icon={iconOf(x)} label={label(x)} on={x.id === activeId} href={x.href} n={attention?.[x.id]} replace={x.kind === "tab" && onManage} /></li>
                ))}
              </ul>
            </section>
          );
        })}
      </nav>
    </>
  );
}

/**
 * Wraps a screen that has its own URL but lives under Manage (Reservations, Customers for cashier / waiter, Reports, Cash drawer, End of day):
 * the same inner navigation as the Manage page beside the screen, and on phones a "Manage" back link. The screen itself is untouched.
 * While the role is not known yet it draws a skeleton card (the screen never jumps sideways); a role with no Manage entry sees the bare screen.
 */
export function ManageFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const role = useRole();
  const { can, feature, has, ready } = useCan();
  const signedIn = useSignedInHere();
  const loading = role === null && signedIn;
  const gate: NavGate | undefined = ready ? { can, feature, has } : undefined;
  const entries = loading || role === null ? [] : visibleManageEntries(role, gate);
  const label = useEntryLabel();
  const active = entries.find((e) => e.kind === "page" && (pathname === e.href || pathname.startsWith(`${e.href}/`)));
  if (!loading && entries.length === 0) return <>{children}</>;
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-6">
      {loading ? <><Skeleton className="h-11 rounded-xl lg:hidden" /><Skeleton className="hidden h-96 rounded-2xl lg:block" /></> : (
        <>
          {/* Phones: where you are, with a way back (the top bar hides its "Manage ›" on a phone) */}
          <nav aria-label="Breadcrumb" className="-mb-3 flex items-center gap-1 text-sm font-semibold lg:hidden">
            <Link href="/manage" className="inline-flex min-h-11 min-w-11 items-center rounded-lg pr-1 text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring">Manage</Link>
            {active && <><span aria-hidden className="text-fg-subtle">›</span><span aria-current="page" className="text-fg">{label(active)}</span></>}
          </nav>
          <ManageNav entries={entries} activeId={active?.id} />
        </>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
