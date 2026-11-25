"""Roles and permissions. The matrix in docs/DESIGN.md is generated from this."""
ALL = [
    "staff.read", "staff.manage", "service_clients.manage",
    "tenants.read", "tenants.write", "tenants.suspend",
    "onboarding.read", "onboarding.manage",
    "catalog.read", "catalog.manage",
    "subscriptions.read", "subscriptions.manage",
    "entitlements.read", "entitlements.override",
    "invoices.read", "invoices.manage", "payments.read", "payments.manage",
    "tickets.read", "tickets.manage",
    "support_access.grant", "support_access.use", "support_access.read",
    "audit.read", "security.read", "ai_usage.read",
    "system.read", "config.read", "config.write",
    "analytics.read", "analytics.export", "marketing.read",
    "wallet.read", "wallet.adjust", "billing_settings.manage",  # PAYG wallet (docs/PAYG_BILLING.md)
]
_ADMIN_EXCLUDED = {"staff.manage", "service_clients.manage", "config.write", "support_access.use", "wallet.adjust"}
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "super_admin": frozenset(p for p in ALL if p != "support_access.use"),
    "platform_admin": frozenset(p for p in ALL if p not in _ADMIN_EXCLUDED),
    "support": frozenset({
        "tenants.read", "onboarding.read", "catalog.read", "subscriptions.read", "entitlements.read",
        "tickets.read", "tickets.manage", "support_access.use", "support_access.read", "system.read", "wallet.read"}),
    "finance": frozenset({
        "tenants.read", "catalog.read", "subscriptions.read", "entitlements.read",
        "invoices.read", "invoices.manage", "payments.read", "payments.manage", "ai_usage.read",
        "analytics.read", "analytics.export", "marketing.read", "wallet.read", "wallet.adjust"}),
}
ROLES = list(ROLE_PERMISSIONS)
