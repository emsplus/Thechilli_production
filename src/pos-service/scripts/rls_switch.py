"""Emergency RLS switch (docs/RLS.md). Run as the table owner / a superuser, e.g.

    ADMIN_DATABASE_URL=postgresql+psycopg://pos_migrator:...@db:5432/pos python scripts/rls_switch.py off   # kill switch
    ADMIN_DATABASE_URL=... python scripts/rls_switch.py on                                                 # restore
    ADMIN_DATABASE_URL=... python scripts/rls_switch.py status

`off` runs ALTER TABLE ... DISABLE ROW LEVEL SECURITY on every tenant table in ONE transaction (policies stay defined);
`on` re-enables them. A pos_migrator login must `SET ROLE pos_owner` first (done here when --role is given).
"""
import argparse
import os
import sys

from sqlalchemy import create_engine, text

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core import rls  # noqa: E402
from app.core.db_roles import ident  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("action", choices=["off", "on", "status"])
    ap.add_argument("--role", default="pos_owner", help="role to SET ROLE to (owner of the tables); '' to skip")
    args = ap.parse_args(argv)
    url = os.environ.get("ADMIN_DATABASE_URL", "").strip()
    if not url:
        print("ADMIN_DATABASE_URL is required", file=sys.stderr)
        return 2
    engine = create_engine(url)
    with engine.begin() as conn:
        if args.role:
            conn.execute(text(f"SET LOCAL ROLE {ident(args.role)}"))
        if args.action == "status":
            for t, on in sorted(rls.rls_status(conn).items()):
                print(f"{t}: {'ON' if on else 'off'}")
        else:
            done = rls.kill_switch(conn) if args.action == "off" else rls.enable_switch(conn)
            print(f"row level security {args.action.upper()} on {len(done)} tables")
    engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())
