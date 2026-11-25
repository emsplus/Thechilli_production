"""One-time infra step for the DB role split (docs/PHASE1_PLAN.md, PR 1). Run as a SUPERUSER, once per database.

    ADMIN_DATABASE_URL=postgresql+psycopg://pos:...@db:5432/pos \\
    POS_APP_PASSWORD=... POS_MIGRATOR_PASSWORD=... \\
    python scripts/setup_db_roles.py [--transfer-ownership-from pos] [--owner pos_owner --migrator pos_migrator --app pos_app]

1. creates/updates the roles `pos_owner` (NOLOGIN), `pos_migrator` (LOGIN, member of pos_owner) and `pos_app`
   (LOGIN, NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE); an unset password variable leaves that role's password as is;
2. with --transfer-ownership-from, moves the application objects of schema `public` to pos_owner (object by object; see
   app/core/db_roles.transfer_ownership for why this is not `REASSIGN OWNED BY pos`). REHEARSE ON A RESTORED COPY FIRST;
3. grants: schema usage, DML on all tables to pos_app, default privileges FOR ROLE pos_owner so later migrations' tables
   are writable by pos_app, alembic_version read-only for pos_app.

Then point the services at the new logins:
    API:      DATABASE_URL=postgresql+psycopg://pos_app:...@db:5432/pos
    migrate:  MIGRATION_DATABASE_URL=postgresql+psycopg://pos_migrator:...@db:5432/pos  MIGRATION_ROLE=pos_owner
Rollback: point DATABASE_URL back at `pos`; ownership is moved back with --transfer-ownership-from pos_owner --to pos.

Prints role and object names only; never URLs or passwords. Idempotent.
"""
import argparse
import os
import sys

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core.db_roles import RoleNames, ensure_roles, grant_privileges, role_report, transfer_ownership  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--owner", default="pos_owner")
    ap.add_argument("--migrator", default="pos_migrator")
    ap.add_argument("--app", default="pos_app")
    ap.add_argument("--transfer-ownership-from", metavar="ROLE", default=None,
                    help="move schema objects owned by ROLE (e.g. pos) to the owner role")
    ap.add_argument("--to", metavar="ROLE", default=None, help="target of --transfer-ownership-from (default: --owner)")
    args = ap.parse_args(argv)

    url = os.environ.get("ADMIN_DATABASE_URL", "").strip()
    if not url:
        print("ADMIN_DATABASE_URL (a superuser login) is required", file=sys.stderr)
        return 2
    names = RoleNames(owner=args.owner, migrator=args.migrator, app=args.app)
    engine = create_engine(url)
    print(f"database: {make_url(url).database}")
    with engine.begin() as conn:
        me = role_report(conn)
        if not me["superuser"]:
            print(f"refusing: {me['role']} is not a superuser", file=sys.stderr)
            return 2
        for line in ensure_roles(conn, names, app_password=os.environ.get("POS_APP_PASSWORD") or None,
                                 migrator_password=os.environ.get("POS_MIGRATOR_PASSWORD") or None):
            print(line)
        if args.transfer_ownership_from:
            moved = transfer_ownership(conn, args.transfer_ownership_from, args.to or names.owner)
            print(f"ownership moved {args.transfer_ownership_from} -> {args.to or names.owner}: {len(moved)} objects")
            for m in moved:
                print("  " + m)
        for line in grant_privileges(conn, names):
            print(line)
    engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())
