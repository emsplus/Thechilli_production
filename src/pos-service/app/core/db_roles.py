"""Database role split (docs/PHASE1_PLAN.md, section (b) "DB roles", PR 1).

Three roles, so Row Level Security (PR 3) can actually apply to the API:

* ``owner``    NOLOGIN. Owns the schema objects. Exempt from RLS as table owner (policies are ENABLEd, never FORCEd), which is
               what data migrations and ``pg_dump`` need.
* ``migrator`` LOGIN, member of ``owner``. Used only by the migrate service (``MIGRATION_DATABASE_URL``) and backups; Alembic
               runs ``SET ROLE <owner>`` (``MIGRATION_ROLE``) so new objects are owned by ``owner``, not by the login role.
* ``app``      LOGIN, NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE. Used by the API (``DATABASE_URL``). Gets DML on every
               table (now and, through default privileges, every table a later migration creates) and owns nothing.

This module is the single source of the role/grant SQL: ``scripts/setup_db_roles.py`` (infra, run once as a superuser) and
the test fixture (tests/conftest.py) both call it. Passwords travel only as bind parameters (never inside SQL text) and are
never logged or returned here.
"""
import re
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.engine import Connection

_IDENT = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def ident(name: str) -> str:
    """A role name safe to splice into DDL (lower-case identifier only; no quoting games)."""
    if not _IDENT.match(name or ""):
        raise ValueError(f"invalid role name: {name!r}")
    return name


@dataclass(frozen=True)
class RoleNames:
    owner: str = "pos_owner"
    migrator: str = "pos_migrator"
    app: str = "pos_app"

    def __post_init__(self):
        for n in (self.owner, self.migrator, self.app):
            ident(n)
        if len({self.owner, self.migrator, self.app}) != 3:
            raise ValueError("owner, migrator and app roles must be three different roles")


def _exists(conn: Connection, role: str) -> bool:
    return bool(conn.scalar(text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role}))


def _set_password(conn: Connection, role: str, password: str) -> None:
    """ALTER ROLE ... PASSWORD without the password ever appearing in a statement's text (which `log_statement = ddl` would
    write to the server log): it travels as a bind parameter into a transaction-local setting that a DO block reads."""
    conn.execute(text("SELECT set_config('pos_setup.pw', :p, true)"), {"p": password})
    conn.execute(text(
        "DO $do$ BEGIN EXECUTE format('ALTER ROLE %I PASSWORD %L', '" + ident(role) + "', "
        "current_setting('pos_setup.pw')); END $do$"))
    conn.execute(text("SELECT set_config('pos_setup.pw', '', true)"))


def ensure_roles(conn: Connection, names: RoleNames, *, app_password: str | None,
                 migrator_password: str | None) -> list[str]:
    """Creates the three roles if missing and (re)asserts their attributes. A password of None leaves an existing
    role's password unchanged (a new LOGIN role without a password cannot log in with password auth). Idempotent.
    Must run as a superuser (or a CREATEROLE role). Returns a log of what was done, without secrets."""
    done: list[str] = []
    attrs = "NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION"
    for role, login, pw in ((names.owner, False, None), (names.migrator, True, migrator_password),
                            (names.app, True, app_password)):
        verb = "ALTER" if _exists(conn, role) else "CREATE"
        conn.execute(text(f"{verb} ROLE {ident(role)} {'LOGIN' if login else 'NOLOGIN'} {attrs}"))
        done.append(f"{verb.lower()} role {role}")
        if pw is not None:
            _set_password(conn, role, pw)
            done.append(f"set password of {role}")
    conn.execute(text(f"GRANT {ident(names.owner)} TO {ident(names.migrator)}"))
    done.append(f"grant {names.owner} to {names.migrator}")
    return done


def grant_privileges(conn: Connection, names: RoleNames, schema: str = "public") -> list[str]:
    """Schema and table privileges for the split. Run in the target database, as a superuser or the schema owner.
    Idempotent. The app role may read/write rows but cannot create, alter or drop anything."""
    o, a, s = ident(names.owner), ident(names.app), ident(schema)
    stmts = [
        f"GRANT USAGE, CREATE ON SCHEMA {s} TO {o}",  # PG15+: public is not writable by default
        f"GRANT USAGE ON SCHEMA {s} TO {a}",
        f"REVOKE CREATE ON SCHEMA {s} FROM {a}",
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {s} TO {a}",
        f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {s} TO {a}",
        f"ALTER DEFAULT PRIVILEGES FOR ROLE {o} IN SCHEMA {s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {a}",
        f"ALTER DEFAULT PRIVILEGES FOR ROLE {o} IN SCHEMA {s} GRANT USAGE, SELECT ON SEQUENCES TO {a}",
        # SECURITY DEFINER lookups (app/core/definer.py) revoke PUBLIC's EXECUTE; the app role keeps it through these
        f"GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA {s} TO {a}",
        f"ALTER DEFAULT PRIVILEGES FOR ROLE {o} IN SCHEMA {s} GRANT EXECUTE ON FUNCTIONS TO {a}",
    ]
    for st in stmts:
        conn.execute(text(st))
    if conn.scalar(text("SELECT to_regclass(:t)"), {"t": f"{schema}.alembic_version"}):
        # /system reads the revision; only migrations write it
        conn.execute(text(f"REVOKE INSERT, UPDATE, DELETE ON {s}.alembic_version FROM {a}"))
        stmts.append("alembic_version: read-only for app")
    return stmts


# Objects in the schema owned by `from_role`, with the ALTER ... OWNER form each one needs. Sequences owned by a table column
# move with their table; enum/domain types are listed (array types follow their element type).
_OWNED = text("""
SELECT 'TABLE' AS kind, format('%I.%I', n.nspname, c.relname) AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = :s AND c.relkind IN ('r', 'p') AND pg_get_userbyid(c.relowner) = :f
UNION ALL
SELECT 'VIEW', format('%I.%I', n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = :s AND c.relkind = 'v' AND pg_get_userbyid(c.relowner) = :f
UNION ALL
SELECT 'MATERIALIZED VIEW', format('%I.%I', n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = :s AND c.relkind = 'm' AND pg_get_userbyid(c.relowner) = :f
UNION ALL
SELECT 'SEQUENCE', format('%I.%I', n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = :s AND c.relkind = 'S' AND pg_get_userbyid(c.relowner) = :f
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))
UNION ALL
SELECT 'TYPE', format('%I.%I', n.nspname, t.typname)
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = :s AND t.typtype IN ('e', 'd') AND pg_get_userbyid(t.typowner) = :f
UNION ALL
SELECT 'FUNCTION', format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = :s AND pg_get_userbyid(p.proowner) = :f
""")


def transfer_ownership(conn: Connection, from_role: str, to_role: str, schema: str = "public") -> list[str]:
    """Moves ownership of the schema's tables, views, sequences, enum/domain types and functions from `from_role` to
    `to_role`, object by object.

    Deliberately NOT ``REASSIGN OWNED BY pos``: with the official postgres image ``pos`` is the bootstrap superuser, and
    REASSIGN OWNED BY the bootstrap superuser fails ("required by the database system"); it would also move every database
    and object ``pos`` owns cluster-wide. This touches only application objects in one schema of the current database.
    Reverse with the same function and the roles swapped."""
    rows = conn.execute(_OWNED, {"s": schema, "f": ident(from_role)}).all()
    for kind, name in rows:
        conn.execute(text(f"ALTER {kind} {name} OWNER TO {ident(to_role)}"))
    return [f"{kind.lower()} {name}" for kind, name in rows]


def role_report(conn: Connection) -> dict:
    """Attributes of the role this connection runs as: what the role test and the startup check look at."""
    row = conn.execute(text(
        "SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, "
        "(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "  WHERE c.relowner = r.oid AND n.nspname NOT IN ('pg_catalog', 'information_schema') "
        "    AND n.nspname NOT LIKE 'pg_toast%') AS owned "
        "FROM pg_roles r WHERE r.rolname = current_user")).one()
    return {"role": row.rolname, "superuser": row.rolsuper, "bypassrls": row.rolbypassrls,
            "createrole": row.rolcreaterole, "createdb": row.rolcreatedb, "owned_relations": row.owned}


def startup_problems(conn: Connection, tenant_tables: tuple[str, ...]) -> list[str]:
    """Why the role this connection runs as must NOT serve the API: a superuser or BYPASSRLS role ignores every Row Level
    Security policy, and the owner of a tenant table is exempt from its (not FORCEd) policies. Empty list = fine."""
    rep = role_report(conn)
    problems = []
    if rep["superuser"]:
        problems.append("is a SUPERUSER")
    if rep["bypassrls"]:
        problems.append("has BYPASSRLS")
    owned = [r[0] for r in conn.execute(text(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) "
        "AND c.relname = ANY(:t) ORDER BY 1"), {"t": list(tenant_tables)})]
    if owned:
        problems.append(f"owns tenant tables ({', '.join(owned[:5])}{', ...' if len(owned) > 5 else ''})")
    return [f"database role {rep['role']!r} " + " and ".join(problems)] if problems else []


OVERRIDE_ENV = "ALLOW_PRIVILEGED_DB_ROLE"


def check_runtime_role(engine, *, env: str, allow_override: bool, tenant_tables: tuple[str, ...], log) -> None:
    """Startup self-check (security review): outside ENV=development refuse to start when the API's database login would
    bypass Row Level Security. Emergency override: ALLOW_PRIVILEGED_DB_ROLE=true starts anyway, logging an error on every
    start; use it only while the role split (scripts/setup_db_roles.py, docs/RLS.md) is being rolled out.

    In development the same check runs and logs a loud WARNING instead of refusing (security review 2026-10-31, finding 3:
    the local stack ran with pos_app owning every table, so RLS was inert, and nothing said so)."""
    with engine.connect() as conn:
        problems = startup_problems(conn, tenant_tables)
    if not problems:
        return
    msg = (f"Refusing to start: {problems[0]}, so Row Level Security does not protect tenants from each other. Point DATABASE_URL "
           "at the app role (NOSUPERUSER, NOBYPASSRLS, owns nothing) created by scripts/setup_db_roles.py; migrations use "
           f"MIGRATION_DATABASE_URL. Emergency override: set {OVERRIDE_ENV}=true.")
    if env == "development":
        log.warning("INSECURE DATABASE ROLE (allowed in development only): %s", msg.removeprefix("Refusing to start: "))
        return
    if allow_override:
        log.error("%s -- STARTING ANYWAY because %s is set; tenant isolation is NOT enforced by the database.", msg, OVERRIDE_ENV)
        return
    raise RuntimeError(msg)
