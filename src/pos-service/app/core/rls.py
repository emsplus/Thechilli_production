"""Row Level Security policies (docs/PHASE1_PLAN.md section (b) "Policy template", PR 3a/3b; operations in docs/RLS.md).

This module is the single source of the RLS SQL: the Alembic revisions and the test fixture (tests/conftest.py) both call it.
Policies are ENABLEd, never FORCEd: the table owner (the owner role) is exempt, which is what data migrations, ``pg_dump`` and
the SECURITY DEFINER functions of app/core/definer.py rely on. The app role owns nothing, so it is always filtered.

Every policy reads the tenant through ``app_tenant()``, which wraps ``NULLIF(current_setting('app.tenant_id', true), '')``:
an unset setting is NULL (``missing_ok``), and a setting whose SET LOCAL ended reads as '' on a pooled connection (and
``''::uuid`` would raise), so both give NULL -> ``restaurant_id = NULL`` -> no rows visible and every write rejected.

Stages: 3a = ``app_tenant()``, the root table and the tables with their own ``restaurant_id``; 3b = the child tables without
a tenant column, visible iff their parent row is visible (the parent's own policy applies inside the EXISTS).
"""
from sqlalchemy import text
from sqlalchemy.engine import Connection

POLICY = "tenant_isolation"

APP_TENANT_FN = """
CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$"""

ROOT_TABLE = "restaurants"  # the tenant itself: policy on id

# Tables with their own restaurant_id column (3a). Explicit (not read from the models) so a revision's meaning never drifts;
# tests/test_rls.py asserts this list plus the root and the children equals every tenant table in the models.
DIRECT_TABLES_3A: tuple[str, ...] = (
    "ai_conversations", "alerts", "audit_logs", "bills", "consent_records", "customers", "devices", "dining_tables",
    "expenses", "hub_pairings", "inventory_items", "invoice_sequences", "kot_tickets", "menu_categories", "menu_items",
    "orders", "payments", "print_hubs", "print_jobs", "printers", "purchase_invoices", "recipes", "refresh_tokens",
    "refunds", "stock_movements", "supplier_emails", "suppliers", "sync_operations", "tax_rates", "users", "voice_aliases", "z_reports",
)

# Tables added after 3a, each enabled by its own revision (3a must keep meaning what it meant when it shipped, so a fresh
# database never asks it to protect a table that does not exist yet). Add new tenant tables HERE.
DELIVERY_TABLES: tuple[str, ...] = ("delivery_settings", "delivery_orders", "delivery_outbox")  # phase 2 delivery (d4a6c8e0f2b1)
MENU_EXTRA_TABLES: tuple[str, ...] = (  # docs/MODIFIERS_OFFERS.md (e3c5a7b9d1f4); = models/menu_extras.NEW_TABLES
    "modifier_groups", "modifier_options", "menu_item_modifier_groups", "combo_components", "offers")
FRONTDESK_TABLES: tuple[str, ...] = ("reservations", "attendance_records", "attendance_schedules", "setup_step_skips")  # e2b7c9d4f6a1
WALLET_TABLES: tuple[str, ...] = ("billing_usage_outbox",)  # PAYG metering outbox (b4e7a2c9d6f3, docs/PAYG_BILLING.md)
VOICE_WAKE_TABLES: tuple[str, ...] = ("voice_wake_samples",)  # testing-phase wake samples (b8d2f4a6c0e3, docs/VOICE_WAKE_SAMPLES.md)
TABLE_QR_TABLES: tuple[str, ...] = (  # table QR codes and guest reviews (c5e7a9b1d3f6, docs/TABLE_QR_REVIEWS.md); = models/table_qr.NEW_TABLES
    "table_qr_settings", "table_qr_links", "table_reviews")
STAFF_DEVICE_TABLES: tuple[str, ...] = (  # docs/STAFF_PIN_DEVICES_API.md (f1a3c5e7b9d2); = models/devices.NEW_TABLES
    "login_devices", "counter_devices", "staff_pins", "staff_pin_sessions", "pin_lockouts")
LATER_DIRECT_TABLES: tuple[str, ...] = (
    "outlets", "user_outlet_access",  # PR 4 (a4f1c2d3e5b6), PR 7 (f9c6b7d8e0a1)
    # inventory / procurement (revision 7a2e9c4b1d60, models/inventory.py NEW_TABLES)
    "stock_locations", "stock_balances", "stock_batches", "item_unit_conversions", "purchase_orders", "purchase_order_lines",
    "goods_receipts", "goods_receipt_lines", "purchase_returns", "purchase_return_lines", "supplier_ledger", "stock_counts",
    "stock_count_lines",
    "payment_provider_accounts", "online_payments",  # payments-service integration (c2a7e9f1b3d5)
    "voice_commits", "voice_transcripts", "voice_usage",  # voice hardening (c7a9e1b3d5f8)
    "cash_sessions",  # cash sessions (c5a1e7b3d9f2)
    "password_reset_tokens", "whatsapp_outbox",  # comms (c1d2e3f4a5b6)
    "shifts", "table_assignments",  # waiter app (d3b8f4a6c1e7)
    "user_invites",  # owner invites of provisioned tenants (provisioning revision d8a5c1e7f3b9)
    *DELIVERY_TABLES,  # delivery (d4a6c8e0f2b1)
    *MENU_EXTRA_TABLES,  # modifier groups, combos, offers (e3c5a7b9d1f4)
    *FRONTDESK_TABLES,  # reservations, attendance, setup checklist skips (e2b7c9d4f6a1)
    "user_mfa",  # owner / manager TOTP (security review finding 7, 5ec1a0b1c2d5)
    "daily_report_emails",  # end of day report email ledger (a6e1d2c3b4f5)
    *WALLET_TABLES,  # PAYG usage outbox (b4e7a2c9d6f3)
    *STAFF_DEVICE_TABLES,  # device sessions, counter devices, staff PINs (f1a3c5e7b9d2)
    *VOICE_WAKE_TABLES,  # testing-phase wake-word samples (b8d2f4a6c0e3)
    *TABLE_QR_TABLES,  # table QR codes and guest reviews (c5e7a9b1d3f6)
)
DIRECT_TABLES: tuple[str, ...] = DIRECT_TABLES_3A + LATER_DIRECT_TABLES

# child table -> (its FK column, parent table); parents are tenant tables whose pk is `id` (3b).
CHILD_TABLES: dict[str, tuple[str, str]] = {
    "menu_variants": ("item_id", "menu_items"),
    "order_lines": ("order_id", "orders"),
    "bill_lines": ("bill_id", "bills"),
    "recipe_ingredients": ("recipe_id", "recipes"),
    "purchase_lines": ("invoice_id", "purchase_invoices"),
    "ai_messages": ("conversation_id", "ai_conversations"),
}

# Roles and permissions (PR 8, revision after f9c6b7d8e0a1). `roles.restaurant_id` NULL = a system role shared by all tenants:
# visible to every bound tenant (never to an unbound session: fail closed), writable only for the tenant's own rows.
# role_permissions has no tenant column: visible iff its role is, writable only for the tenant's own roles.
PERMISSION_TABLES: tuple[str, ...] = ("roles", "role_permissions")

# Deliberately without RLS (documented exceptions): looked up before the tenant is known / not tenant data.
EXEMPT_TABLES = ("login_attempts", "abuse_counters", "whatsapp_contacts", "alembic_version", "provisioning_requests",
                 "email_otps")  # email_otps: sign-up / reset codes, before any tenant exists or is known (a6e1d2c3b4f5)


def _q(name: str) -> str:
    assert name.replace("_", "").isalnum(), name  # table names come from the constants above only
    return name


def _direct_policy(table: str) -> str:
    col = "id" if table == ROOT_TABLE else "restaurant_id"
    return f"CREATE POLICY {POLICY} ON {_q(table)} USING ({col} = app_tenant()) WITH CHECK ({col} = app_tenant())"


def _child_policy(table: str) -> str:
    col, parent = CHILD_TABLES[table]
    exists = f"EXISTS (SELECT 1 FROM {_q(parent)} p WHERE p.id = {_q(table)}.{col})"
    return f"CREATE POLICY {POLICY} ON {_q(table)} USING ({exists}) WITH CHECK ({exists})"


def _enable(conn: Connection, table: str, policy_sql: str) -> None:
    conn.execute(text(f"ALTER TABLE {_q(table)} ENABLE ROW LEVEL SECURITY"))  # ENABLE, not FORCE
    conn.execute(text(f"DROP POLICY IF EXISTS {POLICY} ON {_q(table)}"))
    conn.execute(text(policy_sql))


def _remove(conn: Connection, table: str) -> None:
    conn.execute(text(f"DROP POLICY IF EXISTS {POLICY} ON {_q(table)}"))
    conn.execute(text(f"ALTER TABLE {_q(table)} DISABLE ROW LEVEL SECURITY"))


# ------------------------------------------------------------------------------------------------ stage 3a / 3b
def enable_direct(conn: Connection, tables: tuple[str, ...] | None = None) -> None:
    """3a. Run as the owner role, after the tables exist. Idempotent. Revisions pass the table set they shipped with."""
    conn.execute(text(APP_TENANT_FN))
    for t in (ROOT_TABLE, *(DIRECT_TABLES if tables is None else tables)):
        _enable(conn, t, _direct_policy(t))


def enable_tables(conn: Connection, tables: tuple[str, ...]) -> None:
    """RLS on tables added after 3a (needs app_tenant()). Idempotent."""
    for t in tables:
        _enable(conn, t, _direct_policy(t))


def disable_tables(conn: Connection, tables: tuple[str, ...]) -> None:
    for t in tables:
        _remove(conn, t)


READ_POLICY = "tenant_read_system"  # extra SELECT policy of the permission tables: system rows are readable, never writable


def _enable_permission(conn: Connection, table: str, write_policy: str, read_policy: str) -> None:
    _enable(conn, table, write_policy)
    conn.execute(text(f"DROP POLICY IF EXISTS {READ_POLICY} ON {table}"))
    conn.execute(text(read_policy))


def enable_permission_tables(conn: Connection) -> None:
    """Needs app_tenant(). Idempotent. Policies are permissive and OR together: `tenant_isolation` (FOR ALL) covers the
    tenant's own rows only, so system rows (restaurant_id NULL) cannot be inserted, changed or deleted by the app role;
    `tenant_read_system` additionally lets a BOUND session read them (an unbound session sees nothing: fail closed)."""
    _enable_permission(
        conn, "roles",
        f"CREATE POLICY {POLICY} ON roles USING (restaurant_id = app_tenant()) WITH CHECK (restaurant_id = app_tenant())",
        f"CREATE POLICY {READ_POLICY} ON roles FOR SELECT USING (app_tenant() IS NOT NULL AND restaurant_id IS NULL)")
    own = "EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id AND r.restaurant_id = app_tenant())"
    _enable_permission(
        conn, "role_permissions",
        f"CREATE POLICY {POLICY} ON role_permissions USING ({own}) WITH CHECK ({own})",
        f"CREATE POLICY {READ_POLICY} ON role_permissions FOR SELECT USING "
        "(EXISTS (SELECT 1 FROM roles r WHERE r.id = role_permissions.role_id))")


def disable_permission_tables(conn: Connection) -> None:
    """Idempotent, also when the tables do not exist (an older revision)."""
    for t in reversed(PERMISSION_TABLES):
        if conn.scalar(text("SELECT to_regclass(:t)"), {"t": t}) is not None:
            conn.execute(text(f"DROP POLICY IF EXISTS {READ_POLICY} ON {t}"))
            _remove(conn, t)


def enable_children(conn: Connection) -> None:
    """3b. Needs 3a (the parents' policies). Idempotent."""
    for t in CHILD_TABLES:
        _enable(conn, t, _child_policy(t))


def disable_children(conn: Connection) -> None:
    for t in CHILD_TABLES:
        _remove(conn, t)


def disable_direct(conn: Connection, tables: tuple[str, ...] | None = None) -> None:
    disable_permission_tables(conn)  # their policies depend on app_tenant()
    for t in (ROOT_TABLE, *(DIRECT_TABLES if tables is None else tables)):
        _remove(conn, t)
    conn.execute(text("DROP FUNCTION IF EXISTS app_tenant()"))


def enable_all(conn: Connection) -> None:
    enable_direct(conn)
    enable_children(conn)
    enable_permission_tables(conn)


def disable_all(conn: Connection) -> None:
    disable_children(conn)
    disable_direct(conn)


# ------------------------------------------------------------------------------------------------ kill switch
def all_tables() -> tuple[str, ...]:
    return (ROOT_TABLE, *DIRECT_TABLES, *CHILD_TABLES, *PERMISSION_TABLES)


def kill_switch(conn: Connection) -> list[str]:
    """Emergency: stops filtering at once, WITHOUT dropping policies or the function, so enable_switch() (or the 3a/3b
    upgrade, which is idempotent) restores everything. Run as the owner role / a superuser. Takes a brief lock per table."""
    return _switch(conn, "DISABLE")


def enable_switch(conn: Connection) -> list[str]:
    return _switch(conn, "ENABLE")


def _switch(conn: Connection, verb: str) -> list[str]:
    done = []
    for t in all_tables():
        conn.execute(text(f"ALTER TABLE {_q(t)} {verb} ROW LEVEL SECURITY"))
        done.append(t)
    return done


def rls_status(conn: Connection) -> dict[str, bool]:
    """table -> relrowsecurity, for every table that has (or should have) a policy."""
    rows = conn.execute(text(
        "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(:t)"), {"t": list(all_tables())}).all()
    return {n: bool(v) for n, v in rows}
