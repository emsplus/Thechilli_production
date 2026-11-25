import type { Role } from "@/lib/types";
import type { BizCapKey } from "@/lib/business";

/**
 * Pure navigation model (no React, no icons) so the role rules can be unit tested.
 * The sidebar is deliberately short (owner request): Chilli Agent, Orders, Kitchen, Inventory, Manage. Every other screen
 * (Reservations, Customers, Reports, Cash drawer, End of day, Menu, Staff, ...) is an entry of the Manage panel (MANAGE_ENTRIES).
 * Every existing route keeps its URL: items only point at them; the screens that have their own page keep it and are drawn
 * inside the Manage frame (components/shell/manage-frame.tsx) so they feel like they live under Manage.
 */
export type AreaId = "sell" | "admin";
/** null = role not loaded yet; "unknown" = could not ask (offline), show everything and let the server decide. */
export type NavRole = Role | "unknown" | null;

export type IconKey =
  | "today" | "alerts" | "overview" | "ai" | "counter" | "orders" | "kitchen" | "cash" | "tables" | "menu" | "stock" | "recipes" | "purchases"
  | "customers" | "reports" | "endOfDay" | "business" | "outlets" | "account" | "staff" | "devices" | "sync" | "audit" | "system"
  | "reservations" | "modifiers" | "offers" | "attendance" | "manage" | "delivery" | "sessions" | "reviews";

export interface NavLeaf {
  /** Real URL (may carry ?tab=). */
  href: string;
  label: string;
  icon: IconKey;
  roles: readonly Role[];
  /** Server permission that must also be held (GET /auth/me permissions). Hides the entry only; the API enforces. */
  perm?: string;
  /** Platform-core feature code the tenant must be entitled to. Absent from the entitlements map = allowed (legacy tenants). */
  feature?: string;
  /** Business-type capability (docs/BUSINESS_TYPES.md): Reservations need `reservations`, Tables `tables`, Delivery `delivery_orders`. */
  cap?: BizCapKey;
  /** For /manage tabs: which `tab` values make this item active. */
  tabs?: readonly string[];
  /** Other paths that make this item active (Manage covers every back-office page). */
  paths?: readonly string[];
}
export type ManageGroup = "main" | "operations" | "setup";
/** One entry of the Manage panel's inner navigation. `id` is the ?tab= value for a tab, a short key for a screen that has its own page. */
export interface ManageEntry extends NavLeaf { id: string; group: ManageGroup; kind: "tab" | "page" }
export const MANAGE_GROUP_LABEL: Record<ManageGroup, string | null> = { main: null, operations: "Operations", setup: "Set up" };
export interface NavArea { id: AreaId; label: string; icon: IconKey; items: readonly NavLeaf[] }

const ADMIN: readonly Role[] = ["owner", "manager"];
const FRONT: readonly Role[] = ["owner", "manager", "cashier", "waiter"];
const ALL: readonly Role[] = ["owner", "manager", "cashier", "waiter", "kitchen"];

/** Back-office screens that keep their own URL (bookmarks, notification links) but are listed inside Manage. */
const MANAGE_PAGE_PATHS = ["/reservations", "/customers", "/reports", "/cash", "/end-of-day"] as const;

/** Sidebar: three working screens, then Inventory (opens Manage's Inventory tab) and Manage (everything else). Alerts and Ask AI are the top bar's bell and sparkle. */
export const INVENTORY_LEAF: NavLeaf = { href: "/manage?tab=inventory", label: "Inventory", icon: "stock", roles: ADMIN, tabs: ["inventory"], perm: "inventory.manage", feature: "inventory" };
/** Manage is shown to every role that may open at least one of its entries (see `canSee`): owner / manager always, cashier and waiter for Customers, Reports, Cash drawer. */
export const MANAGE_LEAF: NavLeaf = { href: "/manage", label: "Manage", icon: "manage", roles: ALL, tabs: ["*"], paths: ["/modifiers", "/offers", "/attendance", "/procurement", "/audit", "/system", ...MANAGE_PAGE_PATHS] };

export const AREAS: readonly NavArea[] = [
  { id: "sell", label: "Sell", icon: "counter", items: [
    { href: "/pos", label: "Chilli Agent", icon: "counter", roles: FRONT, perm: "orders.create" },
    { href: "/orders", label: "Orders", icon: "orders", roles: FRONT },
    { href: "/kitchen", label: "Kitchen", icon: "kitchen", roles: ALL, perm: "kot.view" },
  ] },
  { id: "admin", label: "Admin", icon: "manage", items: [INVENTORY_LEAF, MANAGE_LEAF] },
];

/** Pages reached from the top bar (bell, sparkle), not the sidebar: only used for the page title. */
const TOPBAR_LEAVES: readonly NavLeaf[] = [
  { href: "/alerts", label: "Alerts", icon: "alerts", roles: ADMIN, perm: "reports.view" },
  { href: "/ai", label: "Ask AI", icon: "ai", roles: ADMIN, perm: "ai.use", feature: "ai.copilot" },
];

const mtab = (id: string, label: string, icon: IconKey, extra: Partial<NavLeaf> = {}, group: ManageGroup = "setup"): ManageEntry =>
  ({ id, kind: "tab", group, href: `/manage?tab=${id}`, label, icon, roles: ADMIN, tabs: [id], ...extra });
const mpage = (id: string, href: string, label: string, icon: IconKey, extra: Partial<NavLeaf>): ManageEntry => ({ id, kind: "page", group: "operations", href, label, icon, paths: [href], ...extra } as ManageEntry);

/**
 * The inner navigation of Manage, in order: Overview; Operations (the screens that used to be in the sidebar, each keeps its own URL);
 * Set up (the tabs). Customers appears once: the Customers tab for owner / manager, the /customers page for cashier / waiter (same screen).
 * Gating is exactly what it was: the screens carry their old sidebar rules (role, permission, business capability); the tabs keep the
 * panel's old rules (Tables / Delivery by business type, Reviews, Delivery and Billing by permission), owner / manager only.
 */
export const MANAGE_ENTRIES: readonly ManageEntry[] = [
  mtab("overview", "Overview", "overview", {}, "main"),
  mpage("reservations", "/reservations", "Reservations", "reservations", { roles: ADMIN, perm: "reservations.manage", cap: "reservations" }),
  mtab("customers", "Customers", "customers", { feature: "customers" }, "operations"),
  mpage("customers-page", "/customers", "Customers", "customers", { roles: ["cashier", "waiter"], perm: "crm.read", feature: "customers" }),
  mpage("reports", "/reports", "Reports", "reports", { roles: ["owner", "manager", "cashier"], perm: "reports.view", feature: "reports" }),
  mpage("cash", "/cash", "Cash drawer", "cash", { roles: FRONT, perm: "cashier.shift", feature: "cash_drawer" }),
  mpage("end-of-day", "/end-of-day", "End of day", "endOfDay", { roles: ADMIN, perm: "reports.close_day" }),
  mtab("menu", "Menu", "menu", { tabs: ["menu", "modifiers", "offers"] }),
  mtab("tables", "Tables", "tables", { cap: "tables" }),
  mtab("reviews", "Reviews", "reviews", { perm: "reports.view" }),
  mtab("recipes", "Recipes", "recipes"),
  // The sidebar's Inventory item (INVENTORY_LEAF) needs the permission and the plan; the tab itself stays as it always was.
  mtab("inventory", "Inventory", "stock"),
  mtab("suppliers", "Suppliers & Purchases", "purchases", { tabs: ["suppliers", "purchases"] }),
  mtab("staff", "Staff", "staff", { tabs: ["staff", "attendance"] }),
  mtab("restaurant", "Restaurant", "business", { tabs: ["restaurant", "outlets", "profile"] }),
  mtab("billing", "Billing", "cash", { perm: "billing.view" }),
  // What this restaurant may use: super admin grants, the owner switches (pos-service feature access). Owner only.
  mtab("features", "Features", "business", { roles: ["owner"], perm: "settings.owner" }),
  mtab("printers", "Printers", "devices"),
  // Signed-in devices, counter tablets (docs/STAFF_PIN_DEVICES_API.md). Own devices need no permission; staff / counter views need devices.manage.
  mtab("devices", "Devices", "sessions"),
  mtab("delivery", "Delivery", "delivery", { perm: "delivery.manage", cap: "delivery_orders" }),
  mtab("system", "System", "system", { tabs: ["system", "audit"] }),
];
/** Kept for the old name: the tab entries only. */
export const MANAGE_TABS: readonly ManageEntry[] = MANAGE_ENTRIES.filter((e) => e.kind === "tab");

/** Sync is for every role: kept as a small footer link (sidebar) / More entry, not an area item. */
export const SYNC_LEAF: NavLeaf = { href: "/sync", label: "Sync", icon: "sync", roles: ALL };
/** Own profile and password: every role, kept out of the areas like Sync. */
export const ACCOUNT_LEAF: NavLeaf = { href: "/account", label: "My account", icon: "account", roles: ALL };

/** What the server says this user and tenant may use. Both default to "allowed" so an older server (no permissions / entitlements in /auth/me) changes nothing. */
/** `has`: business-type capability; absent = everything a restaurant has (older callers and servers). */
export interface NavGate { can: (perm: string) => boolean; feature: (code: string) => boolean; has?: (cap: BizCapKey) => boolean }
const canSeeLeaf = (it: NavLeaf, role: NavRole, gate?: NavGate) =>
  (role === "unknown" || it.roles.includes(role ?? "cashier")) && (!gate || ((!it.perm || gate.can(it.perm)) && (!it.feature || gate.feature(it.feature)) && (!it.cap || !gate.has || gate.has(it.cap))));
/** Manage itself needs no role of its own: it is shown when the role may open at least one of its entries (cashier / waiter: Customers, Reports, Cash drawer). */
const canSee = (it: NavLeaf, role: NavRole, gate?: NavGate): boolean =>
  it === MANAGE_LEAF ? visibleManageEntries(role, gate).length > 0 : canSeeLeaf(it, role, gate);

/**
 * The Manage entries this user may open, in display order. "unknown" (offline) matches every role, so the two Customers entries
 * (tab and page) would both pass: the first one wins, an entry label is never listed twice.
 */
/** Owner 2026-11-13: these Manage entries are not shown (not needed). UI only: the pages, routes, API and data are untouched (an old link still opens). */
export const HIDDEN_MANAGE_ENTRY_IDS: ReadonlySet<string> = new Set(["suppliers", "devices", "system"]);

export function visibleManageEntries(role: NavRole, gate?: NavGate, opts?: { includeHidden?: boolean }): ManageEntry[] {
  const seen = new Set<string>();
  return MANAGE_ENTRIES.filter((e) => (opts?.includeHidden || !HIDDEN_MANAGE_ENTRY_IDS.has(e.id)) && canSeeLeaf(e, role, gate) && !seen.has(e.label) && !!seen.add(e.label));
}

export interface VisibleArea { id: AreaId; label: string; icon: IconKey; href: string; items: NavLeaf[] }

/** Areas the role may see, each with only its permitted items. An area with no visible item is hidden. */
export function visibleAreas(role: NavRole, gate?: NavGate): VisibleArea[] {
  const out: VisibleArea[] = [];
  for (const a of AREAS) {
    const items = a.items.filter((i) => canSee(i, role, gate));
    if (items.length) out.push({ id: a.id, label: a.label, icon: a.icon, href: items[0].href, items });
  }
  return out;
}

/**
 * Where a role lands after login and on "/". Owner/manager: Manage (its Overview carries the Today strip); cashier/waiter:
 * POS; kitchen: kitchen display. /today is kept only as a redirect to /manage for old links.
 */
export function landingFor(role: NavRole): string {
  if (role === "owner" || role === "manager") return "/manage";
  if (role === "kitchen") return "/kitchen";
  return "/pos";
}


const pathOf = (href: string) => href.split("?")[0];
const matchesPath = (p: string, base: string) => p === base || p.startsWith(base + "/");

/** The Manage tabs this user may open (the screens with their own page are in `visibleManageEntries`). */
export const visibleManageTabs = (role: NavRole, gate?: NavGate) => visibleManageEntries(role, gate).filter((e) => e.kind === "tab");

/** The Manage entry for a route (/manage?tab=..., or one of the screens behind Manage), for the inner navigation's active state. */
export function manageTabFor(pathname: string, tab?: string | null): ManageEntry | undefined {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (matchesPath(p, "/manage")) { const t = tab ?? "overview"; return MANAGE_ENTRIES.find((x) => x.kind === "tab" && x.tabs?.includes(t)) ?? MANAGE_ENTRIES[0]; }
  const t = ({ "/modifiers": "menu", "/offers": "menu", "/attendance": "staff", "/audit": "system", "/system": "system" } as Record<string, string>)[p];
  if (t) return MANAGE_ENTRIES.find((x) => x.kind === "tab" && x.tabs?.includes(t));
  return MANAGE_ENTRIES.find((x) => x.kind === "page" && matchesPath(p, x.href));
}

/** The leaf for a route. `tab` is the /manage ?tab= value (absent = overview, like ManagePanel). Inventory is the one Manage tab that has its own sidebar item. */
export function leafFor(pathname: string, tab?: string | null): { area: AreaId; leaf: NavLeaf } | undefined {
  if (matchesPath(pathname, "/sync")) return { area: "admin", leaf: SYNC_LEAF };
  if (matchesPath(pathname, "/account")) return { area: "admin", leaf: ACCOUNT_LEAF };
  const top = TOPBAR_LEAVES.find((l) => matchesPath(pathname, l.href));
  if (top) return { area: "sell", leaf: top };
  if (matchesPath(pathname, "/manage") && tab && INVENTORY_LEAF.tabs?.includes(tab)) return { area: "admin", leaf: INVENTORY_LEAF };
  // Tab items (href with ?tab=) only match through their tab, never by path.
  const all = AREAS.flatMap((a) => a.items.filter((leaf) => !leaf.href.includes("?")).map((leaf) => ({ area: a.id, leaf })));
  return all.find((x) => matchesPath(pathname, pathOf(x.leaf.href)) || x.leaf.paths?.some((p) => matchesPath(pathname, p)));
}

export const activeAreaId = (pathname: string, tab?: string | null): AreaId | undefined => leafFor(pathname, tab)?.area;

/**
 * Which sidebar / bottom-bar item is lit for a route. An Inventory tab that this user cannot see in the list (plan or permission)
 * lights Manage instead of nothing.
 */
export function activeHref(pathname: string, tab: string | null | undefined, visibleHrefs: readonly string[]): string | undefined {
  const h = leafFor(pathname, tab)?.leaf.href;
  if (h && visibleHrefs.includes(h)) return h;
  return matchesPath(pathname, "/manage") && visibleHrefs.includes(MANAGE_LEAF.href) ? MANAGE_LEAF.href : h;
}

/**
 * Bottom bar: at most 4 slots, then More. The same destinations as the sidebar, in the sidebar's order: Chilli Agent, Orders, Inventory and
 * Manage first, Kitchen when there is room (a cashier or waiter, who has no Inventory, gets Chilli Agent, Orders, Kitchen, Manage).
 * Everything not in a slot goes to the More sheet.
 */
export interface TabSlot { key: string; label: string; icon: IconKey; href: string; areaId: AreaId }
const BAR_PRIORITY = ["/pos", "/orders", INVENTORY_LEAF.href, MANAGE_LEAF.href, "/kitchen"];
export function bottomBar(role: NavRole, gate?: NavGate): { slots: TabSlot[]; more: VisibleArea[] } {
  const areas = visibleAreas(role, gate);
  const flat = areas.flatMap((a) => a.items.map((i) => ({ i, a })));
  const chosen = new Set(BAR_PRIORITY.filter((h) => flat.some((x) => x.i.href === h)).slice(0, 4));
  const pick = flat.filter((x) => chosen.has(x.i.href));
  const slots = pick.map(({ i, a }): TabSlot => ({ key: i.href, label: i.label, icon: i.icon, href: i.href, areaId: a.id }));
  const used = new Set(slots.map((s) => s.href));
  const more = areas.map((a) => ({ ...a, items: a.items.filter((i) => !used.has(i.href)) })).filter((a) => a.items.length);
  return { slots, more };
}
