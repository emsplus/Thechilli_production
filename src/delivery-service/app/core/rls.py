"""Row Level Security (adapted from pos-service app/core/rls.py; operations in docs/RLS.md).

The single source of the RLS SQL: Alembic revisions and the test fixture both call it. Policies are ENABLEd, never FORCEd:
the table owner (migrations, pg_dump, SECURITY DEFINER functions) is exempt; the app role owns nothing, has no BYPASSRLS
and is always filtered. Every policy reads the tenant through ``app_tenant()``; unset or empty is NULL, so
``restaurant_id = NULL`` matches nothing and every write is rejected (fails closed, never an error).

Differences to pos-service: the tenant id here is the text ``restaurant_id`` (not a uuid), and there is one child table
(rider_declines, visible iff its order is).
"""
from sqlalchemy import text
from sqlalchemy.engine import Connection

POLICY = "tenant_isolation"

APP_TENANT_FN = """
CREATE OR REPLACE FUNCTION app_tenant() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '') $$"""

# Pre-tenant lookup: inbound WhatsApp knows only the phone_number_id. Runs as the owner (SECURITY DEFINER) and returns
# nothing but the owning restaurant id. The only way the app role can read channel_numbers across tenants.
RESOLVE_CHANNEL_FN = """
CREATE OR REPLACE FUNCTION resolve_channel(pnid text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS
$$ SELECT restaurant_id FROM channel_numbers WHERE phone_number_id = pnid $$"""

# Pre-tenant lookup for the public ordering page /r/{slug}: the visitor knows only the slug. SECURITY DEFINER, returns nothing but
# the restaurant id, and only for an ENABLED link (a disabled or rotated-away slug resolves to NULL, exactly like an unknown one).
RESOLVE_PUBLIC_LINK_FN = """
CREATE OR REPLACE FUNCTION resolve_public_link(s text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS
$$ SELECT restaurant_id FROM public_links WHERE slug = s AND enabled $$"""

ROOT_TABLE = "restaurants"  # the tenant itself: policy on restaurant_id (its primary key)

# Tables with their own restaurant_id (revision 0002). Explicit so a revision's meaning never drifts;
# tests/test_rls.py asserts every tenant table in the models is covered.
DIRECT_TABLES_V1: tuple[str, ...] = (
    "channel_numbers", "riders", "delivery_orders", "rider_locations", "order_events", "processed_pos_events",
    "inbound_messages", "conversations", "outbound_messages", "outbox_jobs", "reminders",
)
# Tables added by later revisions, each enabled by its own revision through enable_tables(). Add new tenant tables HERE.
LATER_DIRECT_TABLES: tuple[str, ...] = ("revoked_tokens", "rate_buckets", "wa_consents", "message_statuses",
                                       "order_ratings", "public_links")  # 0003, 0004, 0005, 0006
DIRECT_TABLES: tuple[str, ...] = DIRECT_TABLES_V1 + LATER_DIRECT_TABLES

# child table -> (FK column, parent table)
CHILD_TABLES: dict[str, tuple[str, str]] = {"rider_declines": ("order_id", "delivery_orders")}

# Deliberately without RLS: no tenant data / written before the tenant is known (unknown phone_number_id).
EXEMPT_TABLES = ("unprocessed_inbound", "alembic_version")


def _q(name: str) -> str:
    assert name.replace("_", "").isalnum(), name  # names come from the constants above only
    return name


def _direct_policy(table: str) -> str:
    col = _q("restaurant_id")
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


def enable_direct(conn: Connection, tables: tuple[str, ...] | None = None) -> None:
    """Run as the owner role after the tables exist. Idempotent. Revisions pass the table set they shipped with."""
    conn.execute(text(APP_TENANT_FN))
    conn.execute(text(RESOLVE_CHANNEL_FN))
    for t in (ROOT_TABLE, *(DIRECT_TABLES_V1 if tables is None else tables)):
        _enable(conn, t, _direct_policy(t))


def create_public_link_fn(conn: Connection) -> None:
    """Revision 0006 (needs the public_links table). Re-grants so the app role may call it."""
    conn.execute(text(RESOLVE_PUBLIC_LINK_FN))
    grant_app_role(conn)


def enable_children(conn: Connection) -> None:
    for t in CHILD_TABLES:
        _enable(conn, t, _child_policy(t))


def enable_tables(conn: Connection, tables: tuple[str, ...]) -> None:
    """RLS on tenant tables added after 0002 (needs app_tenant()). Idempotent. Also grants the app role access."""
    for t in tables:
        _enable(conn, t, _direct_policy(t))
    grant_app_role(conn)


def disable_tables(conn: Connection, tables: tuple[str, ...]) -> None:
    for t in tables:
        _remove(conn, t)


def disable_all(conn: Connection) -> None:
    for t in CHILD_TABLES:
        _remove(conn, t)
    for t in (ROOT_TABLE, *DIRECT_TABLES):
        if conn.scalar(text("SELECT to_regclass(:t)"), {"t": t}) is not None:
            _remove(conn, t)
    conn.execute(text("DROP FUNCTION IF EXISTS resolve_public_link(text)"))
    conn.execute(text("DROP FUNCTION IF EXISTS resolve_channel(text)"))
    conn.execute(text("DROP FUNCTION IF EXISTS app_tenant()"))


def enable_all(conn: Connection) -> None:
    enable_direct(conn, DIRECT_TABLES)
    enable_children(conn)
    conn.execute(text(RESOLVE_PUBLIC_LINK_FN))
    grant_app_role(conn)


def grant_app_role(conn: Connection, role: str | None = None) -> None:
    """Grants the (non-owner) app role DML on every table. No-op when no app role is configured or it does not exist
    (single-role dev setups keep working, just unprotected: see docs/RLS.md)."""
    from app.core.config import settings
    role = role or settings.app_db_role
    if not role:
        return
    assert role.replace("_", "").isalnum(), role
    if conn.scalar(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role}) is None:
        return
    conn.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
    conn.execute(text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {role}"))
    fns = ["app_tenant()", "resolve_channel(text)"]
    if conn.scalar(text("SELECT to_regprocedure('resolve_public_link(text)')")) is not None:  # exists from revision 0006
        fns.append("resolve_public_link(text)")
    conn.execute(text(f"GRANT EXECUTE ON FUNCTION {', '.join(fns)} TO {role}"))
    conn.execute(text(f"REVOKE ALL ON TABLE alembic_version FROM {role}"))


# ---------------------------------------------------------------------------------------------- kill switch
def all_tables() -> tuple[str, ...]:
    return (ROOT_TABLE, *DIRECT_TABLES, *CHILD_TABLES)


def kill_switch(conn: Connection) -> list[str]:
    """Emergency: stops filtering at once WITHOUT dropping policies, so enable_switch() restores everything. Owner only."""
    return _switch(conn, "DISABLE")


def enable_switch(conn: Connection) -> list[str]:
    return _switch(conn, "ENABLE")


def _switch(conn: Connection, verb: str) -> list[str]:
    for t in all_tables():
        conn.execute(text(f"ALTER TABLE {_q(t)} {verb} ROW LEVEL SECURITY"))
    return list(all_tables())


def rls_status(conn: Connection) -> dict[str, bool]:
    rows = conn.execute(text(
        "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(:t)"), {"t": list(all_tables())}).all()
    return {n: bool(v) for n, v in rows}
