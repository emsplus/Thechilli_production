import { Armchair, Bike, Bell, BookOpen, Building2, ChartColumn, ClipboardCheck, ClipboardList, Flame, HeartPulse, House, Monitor, MonitorSmartphone, Package, RefreshCw, ScrollText, ShoppingCart, ShoppingBasket, SquareMenu, Sparkles, UserCog, Users, Gauge, Banknote, MapPin, UserRound, CalendarClock, SlidersHorizontal, BadgePercent, Clock, Settings2, Star, type LucideIcon } from "lucide-react";
import { leafFor, type IconKey } from "./nav-model";

/** Icon per nav-model key (kept out of nav-model.ts so that file stays pure and testable). */
export const ICONS: Record<IconKey, LucideIcon> = {
  today: House, alerts: Bell, overview: Gauge, ai: Sparkles, counter: ShoppingCart, orders: ClipboardList, kitchen: Flame, cash: Banknote, tables: Armchair,
  menu: SquareMenu, stock: Package, recipes: BookOpen, purchases: ShoppingBasket, customers: Users, reports: ChartColumn, endOfDay: ClipboardCheck,
  business: Building2, outlets: MapPin, account: UserRound, staff: UserCog, devices: Monitor, sync: RefreshCw, audit: ScrollText, system: HeartPulse,
  reservations: CalendarClock, modifiers: Settings2, offers: BadgePercent, attendance: Clock, manage: SlidersHorizontal, delivery: Bike, sessions: MonitorSmartphone, reviews: Star,
};
export const AI_ICON = ICONS.ai;
export const SYNC_ICON = RefreshCw;

/** Page names of the back-office routes that live behind Manage but have their own URL. */
const BACK_OFFICE: Record<string, string> = {
  "/procurement": "Orders & receiving", "/audit": "Audit log", "/system": "System health", "/modifiers": "Modifier groups", "/offers": "Offers", "/attendance": "Attendance",
  // Screens listed in Manage's Operations group; they keep their own URL.
  "/reservations": "Reservations", "/customers": "Customers", "/reports": "Reports", "/cash": "Cash drawer", "/end-of-day": "End of day",
};

/**
 * Title for the top bar: the page name ("POS"). Back-office pages with their own URL behind Manage show "Manage › <page>" (the
 * area is hidden on phones), so /procurement or /audit never shows a bare "Manage" without a page name (UI review BA-8).
 */
export function titleFor(pathname: string, tab?: string | null): { label: string; area?: string; icon: LucideIcon } | undefined {
  const hit = leafFor(pathname, tab);
  if (!hit) return undefined;
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  // /manage itself keeps "Manage": its own section menu and heading name the section (one visible title).
  const section = hit.leaf.href === "/manage" ? BACK_OFFICE[p] : undefined;
  if (section) return { label: section, area: hit.leaf.label, icon: ICONS[hit.leaf.icon] };
  return { label: hit.leaf.label, icon: ICONS[hit.leaf.icon] };
}
