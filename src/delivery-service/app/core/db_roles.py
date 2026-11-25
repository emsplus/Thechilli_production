"""Startup self-check of the API's database role (security review finding 3; ported from pos-service app/core/db_roles.py).

Row Level Security only protects tenants when the API connects as a role that is NOT a superuser, has NO BYPASSRLS and
OWNS no tenant table: policies are ENABLEd, not FORCEd (the owner must stay exempt for migrations and the SECURITY DEFINER
``resolve_channel``), so a table owner sees every tenant's rows. The compose stack ran with ``delivery_app`` owning every
table, which made RLS inert; nothing noticed. Now:

* outside ``ENV=development`` the service refuses to start with such a role (override: ALLOW_PRIVILEGED_DB_ROLE=true, which
  logs an error on every start);
* in development the same check runs and logs a loud warning, so a local stack shows the problem too.
"""
from sqlalchemy import text
from sqlalchemy.engine import Connection

OVERRIDE_ENV = "ALLOW_PRIVILEGED_DB_ROLE"


def startup_problems(conn: Connection, tenant_tables: tuple[str, ...]) -> list[str]:
    """Why the role this connection runs as must NOT serve the API. Empty list = fine."""
    row = conn.execute(text("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).one()
    problems = []
    if row.rolsuper:
        problems.append("is a SUPERUSER")
    if row.rolbypassrls:
        problems.append("has BYPASSRLS")
    owned = [r[0] for r in conn.execute(text(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) "
        "AND c.relname = ANY(:t) ORDER BY 1"), {"t": list(tenant_tables)})]
    if owned:
        problems.append(f"owns tenant tables ({', '.join(owned[:5])}{', ...' if len(owned) > 5 else ''})")
    return [f"database role {row.rolname!r} " + " and ".join(problems)] if problems else []


def check_runtime_role(engine, *, env: str, allow_override: bool, tenant_tables: tuple[str, ...], log) -> None:
    with engine.connect() as conn:
        problems = startup_problems(conn, tenant_tables)
    if not problems:
        return
    msg = (f"{problems[0]}, so Row Level Security does not protect tenants from each other. Point DATABASE_URL at the app role "
           "(NOSUPERUSER, NOBYPASSRLS, owns nothing); migrations use ADMIN_DATABASE_URL (+ MIGRATION_ROLE). See docs/RLS.md.")
    if env == "development":
        log.warning("INSECURE DATABASE ROLE (allowed in development only): %s", msg)
        return
    if allow_override:
        log.error("%s -- STARTING ANYWAY because %s is set; tenant isolation is NOT enforced by the database.", msg, OVERRIDE_ENV)
        return
    raise RuntimeError(f"Refusing to start: {msg} Emergency override: set {OVERRIDE_ENV}=true.")
