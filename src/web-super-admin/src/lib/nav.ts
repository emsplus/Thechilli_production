import type { Permission } from "./api/types";
import { canAll, type PermSet } from "./permissions";

export interface NavItem { href: string; label: string; need: readonly Permission[] }
export interface NavArea { id: string; label: string; href: string; items: NavItem[] }

/**
 * Chilli HQ navigation (docs/PRODUCT_UX_STRATEGY.md section 2.5): at most 7 areas, 2 levels deep. Visibility is purely
 * permission-driven (no locked or teaser items). Nothing in here may point at tenant operational data.
 */
export const NAV: NavArea[] = [
  { id: "overview", label: "Overview", href: "/", items: [{ href: "/", label: "Overview", need: ["tenants.read"] }, { href: "/analytics", label: "Analytics", need: ["analytics.read"] }] },
  {
    id: "businesses", label: "Businesses", href: "/businesses",
    items: [
      { href: "/businesses", label: "Businesses", need: ["tenants.read"] },
      { href: "/outlets", label: "Outlets", need: ["tenants.read"] },
      { href: "/onboarding", label: "Onboarding", need: ["onboarding.read"] },
    ],
  },
  {
    id: "billing", label: "Plans & billing", href: "/billing/plans",
    items: [
      { href: "/billing/plans", label: "Plans", need: ["catalog.read"] },
      { href: "/billing/subscriptions", label: "Subscriptions", need: ["subscriptions.read"] },
      { href: "/billing/invoices", label: "Invoices", need: ["invoices.read"] },
      { href: "/billing/payments", label: "Payments", need: ["payments.read"] },
    ],
  },
  {
    id: "growth", label: "Growth", href: "/growth",
    items: [
      { href: "/growth", label: "Growth", need: ["analytics.read"] },
      { href: "/platform/marketing", label: "Marketing team", need: ["marketing.read"] },
    ],
  },
  {
    id: "support", label: "Support", href: "/support/tickets",
    items: [
      { href: "/support/tickets", label: "Support tickets", need: ["tickets.read"] },
      { href: "/support/access", label: "Access grants", need: ["support_access.read"] },
    ],
  },
  {
    id: "platform", label: "Platform", href: "/platform/users",
    items: [
      { href: "/platform/users", label: "Platform users", need: ["staff.read"] },
      { href: "/platform/roles", label: "Roles & permissions", need: ["staff.read"] },
      { href: "/platform/features", label: "Features", need: ["catalog.read"] },
      { href: "/platform/entitlements", label: "Entitlements", need: ["entitlements.read"] },
      { href: "/platform/ai", label: "AI usage & cost", need: ["ai_usage.read"] },
      { href: "/platform/config", label: "Global config", need: ["config.read"] },
    ],
  },
  {
    id: "security", label: "Security & health", href: "/security/audit",
    items: [
      { href: "/security/audit", label: "Audit log", need: ["audit.read"] },
      { href: "/security/events", label: "Security events", need: ["security.read"] },
      { href: "/security/health", label: "System health", need: ["system.read"] },
    ],
  },
];

/** Areas and items the holder of `perms` may see. Areas with no visible item disappear. */
export function visibleNav(perms: PermSet): NavArea[] {
  return NAV.map((a) => ({ ...a, items: a.items.filter((i) => canAll(perms, i.need)) }))
    .filter((a) => a.items.length > 0)
    .map((a) => ({ ...a, href: a.items[0].href }));
}

/** Routes outside the manifest (detail pages, account) fall under the closest manifest prefix. */
export function permissionsForPath(pathname: string): readonly Permission[] | null {
  const items = NAV.flatMap((a) => a.items).sort((a, b) => b.href.length - a.href.length);
  const hit = items.find((i) => (i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(i.href + "/")));
  return hit ? hit.need : null;
}

export const pathAllowed = (pathname: string, perms: PermSet) => {
  const need = permissionsForPath(pathname);
  return need === null ? true : canAll(perms, need);
};
