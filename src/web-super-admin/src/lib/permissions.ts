import type { Permission, Role } from "./api/types";

/**
 * Mirror of platform-core `ROLE_PERMISSIONS` (docs/DESIGN.md permission matrix). The server is the authority and the UI
 * trusts the `permissions` list from /auth/me; this copy exists for the mock backend, tests and as a fallback.
 */
const ALL: Permission[] = [
  "staff.read", "staff.manage", "service_clients.manage", "tenants.read", "tenants.write", "tenants.suspend",
  "onboarding.read", "onboarding.manage", "catalog.read", "catalog.manage", "subscriptions.read", "subscriptions.manage",
  "entitlements.read", "entitlements.override", "invoices.read", "invoices.manage", "payments.read", "payments.manage",
  "tickets.read", "tickets.manage", "support_access.grant", "support_access.use", "support_access.read",
  "audit.read", "security.read", "ai_usage.read", "system.read", "config.read", "config.write",
  "analytics.read", "analytics.export", "marketing.read",
  "wallet.read", "wallet.adjust", "billing_settings.manage", // PAYG credit (docs/PAYG_BILLING.md 7.3)
];
// platform_admin can suspend billing and change billing settings but never moves money (PAYG decision D11).
const ADMIN_EXCLUDED = new Set<Permission>(["staff.manage", "service_clients.manage", "config.write", "support_access.use", "wallet.adjust"]);

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  super_admin: ALL.filter((p) => p !== "support_access.use"),
  platform_admin: ALL.filter((p) => !ADMIN_EXCLUDED.has(p)),
  support: [
    "tenants.read", "onboarding.read", "catalog.read", "subscriptions.read", "entitlements.read", "tickets.read",
    "tickets.manage", "support_access.use", "support_access.read", "system.read", "wallet.read",
  ],
  finance: [
    "tenants.read", "catalog.read", "subscriptions.read", "entitlements.read", "invoices.read", "invoices.manage",
    "payments.read", "payments.manage", "ai_usage.read", "analytics.read", "analytics.export", "marketing.read",
    "wallet.read", "wallet.adjust",
  ],
};

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super admin", platform_admin: "Platform admin", support: "Support", finance: "Finance",
};

export type PermSet = ReadonlySet<Permission>;
export const permSet = (perms: readonly Permission[]): PermSet => new Set(perms);
/** True when every listed permission is held. An empty list means "any signed-in staff". */
export const canAll = (have: PermSet, need: readonly Permission[] = []) => need.every((p) => have.has(p));
export const canAny = (have: PermSet, need: readonly Permission[]) => need.some((p) => have.has(p));
