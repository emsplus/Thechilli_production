import type { EntryOut, Role } from "./api/types";

export interface Area { key: string; label: string; href: string; roles: readonly Role[]; /** extra path prefixes that belong to this area */ also?: readonly string[] }

const ALL: readonly Role[] = ["marketing_admin", "salesperson", "onboarding_agent"];

/** Top-level areas, max 6 (PRODUCT_UX_STRATEGY 2.4). Order is nav order. */
export const AREAS: readonly Area[] = [
  { key: "my-day", label: "My day", href: "/", roles: ALL, also: ["/follow-ups"] },
  { key: "leads", label: "Leads", href: "/leads", roles: ALL, also: ["/demos"] },
  { key: "onboarding", label: "Onboarding", href: "/onboarding", roles: ALL },
  { key: "campaigns", label: "Campaigns", href: "/campaigns", roles: ALL },
  { key: "earnings", label: "Earnings", href: "/earnings", roles: ALL, also: ["/reports"] },
  { key: "team", label: "Team", href: "/team", roles: ["marketing_admin"] },
];

/** Secondary destinations that are not top-level areas (MK-5): one click from every page via "More" (desktop and phone). */
export const MORE_LINKS: readonly { key: string; label: string; href: string }[] = [
  { key: "follow-ups", label: "Follow-ups", href: "/follow-ups" },
  { key: "demos", label: "Demos", href: "/demos" },
  { key: "reports", label: "Reports", href: "/reports" },
  { key: "support", label: "Support", href: "/support" },
  { key: "account", label: "Account", href: "/account" },
];

export const ROLE_LABEL: Record<Role, string> = {
  marketing_admin: "Marketing admin", salesperson: "Salesperson", onboarding_agent: "Onboarding agent",
};

export function visibleAreas(role: Role | null | undefined): Area[] {
  return role ? AREAS.filter((a) => a.roles.includes(role)) : [];
}

/** Bottom bar: at most `max` direct items; anything beyond that moves under "More" (360px fits 5 columns). */
export function splitBottomNav<T>(areas: readonly T[], max = 4): { primary: T[]; more: T[] } {
  return areas.length <= max + 1 ? { primary: [...areas], more: [] } : { primary: areas.slice(0, max), more: areas.slice(max) };
}

/** Longest-prefix match so /leads/pipeline highlights Leads. */
export function areaForPath(pathname: string): Area | undefined {
  const under = (p: string, prefix: string) => (prefix === "/" ? p === "/" : p === prefix || p.startsWith(prefix + "/"));
  let best: { area: Area; len: number } | undefined;
  for (const area of AREAS) {
    for (const prefix of [area.href, ...(area.also ?? [])]) {
      if (under(pathname, prefix) && (!best || prefix.length > best.len)) best = { area, len: prefix.length };
    }
  }
  return best?.area;
}

export function canAccessPath(role: Role | null | undefined, pathname: string): boolean {
  if (!role) return false;
  const area = areaForPath(pathname);
  if (!area) return true; // account, 404
  return area.roles.includes(role);
}

const ADMIN: readonly Role[] = ["marketing_admin"];
const SALES: readonly Role[] = ["marketing_admin", "salesperson"];
const ONBOARDING: readonly Role[] = ["marketing_admin", "onboarding_agent"];

/** UI mirror of the marketing-service permission matrix (DESIGN section 4). The server stays the authority. */
export const PERMISSIONS = {
  "lead.write": SALES, // create, edit, stage, demos, activities
  "lead.assign": ADMIN,
  "lead.claim": ["salesperson"],
  "lead.delete": ADMIN,
  "onboarding.create": ONBOARDING,
  "onboarding.edit": ONBOARDING, // checklist, provision, cancel
  "onboarding.assign": ADMIN,
  "onboarding.contractValue": ADMIN,
  "invitation.create": ALL,
  "referral.manage": SALES,
  "campaign.edit": ADMIN,
  "campaign.stats": SALES,
  "commission.decide": ADMIN,
  "commission.rules": ADMIN,
  "team.manage": ADMIN,
  "audit.read": ADMIN,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;
export const can = (role: Role | null | undefined, p: Permission): boolean => !!role && (PERMISSIONS[p] as readonly Role[]).includes(role);

/** Maker-checker: only an admin decides, and never on their own entry. Only pending (approve/reject) or approved (pay). */
export function canDecideEntry(role: Role | null | undefined, userId: string | undefined, entry: EntryOut): boolean {
  return can(role, "commission.decide") && !!userId && entry.user_id !== userId && entry.kind === "commission";
}
export function nextEntryActions(role: Role | null | undefined, userId: string | undefined, entry: EntryOut): ("approve" | "reject" | "pay")[] {
  if (!canDecideEntry(role, userId, entry)) return [];
  if (entry.status === "pending") return ["approve", "reject"];
  if (entry.status === "approved") return ["pay"];
  return [];
}
