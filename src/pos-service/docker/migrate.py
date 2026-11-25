"""Run `alembic upgrade head` safely.

* Waits for the database (up to MIGRATE_WAIT_SECONDS, default 60).
* Connects with MIGRATION_DATABASE_URL (the migrator login, docs/PHASE1_PLAN.md PR 1), falling back to DATABASE_URL.
  alembic/env.py uses the same URL and switches to MIGRATION_ROLE (the owner role) before migrating.
* Holds a Postgres session-level advisory lock while migrating, so two migrators started at the same time (two API
  replicas with MIGRATE_ON_START=1, or a re-run `migrate` service) serialize: the second one sees `head` and no-ops.
"""
import os
import sys
import time

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.core.config import migration_url, settings
from app.core.db_roles import ident

LOCK_KEY = 0x504F535F4D4947  # "POS_MIG"
wait = int(os.environ.get("MIGRATE_WAIT_SECONDS", "60"))
engine = create_engine(migration_url(settings), pool_pre_ping=True).execution_options(isolation_level="AUTOCOMMIT")

deadline = time.monotonic() + wait
while True:
    try:
        conn = engine.connect()
        break
    except Exception as exc:  # noqa: BLE001 - any connect failure means "not ready yet"
        if time.monotonic() > deadline:
            print(f"migrate: database not reachable after {wait}s: {exc}", file=sys.stderr)
            sys.exit(1)
        time.sleep(2)

with conn:
    print("migrate: waiting for advisory lock", flush=True)
    conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": LOCK_KEY})
    try:
        before = conn.scalar(text("SELECT version_num FROM alembic_version LIMIT 1")) \
            if conn.scalar(text("SELECT to_regclass('alembic_version')")) else None
        cfg = Config("/app/alembic.ini" if os.path.exists("/app/alembic.ini") else "alembic.ini")
        command.upgrade(cfg, "head")
        after = conn.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
        print(f"migrate: revision {before} -> {after}", flush=True)
        # Role split (security review finding 3): default privileges give the app role DML on every table the owner creates,
        # alembic_version included; only migrations may write the revision.
        app_user, mig_user = make_url(settings.database_url).username, make_url(migration_url(settings)).username
        if settings.migration_role.strip() and app_user and app_user != mig_user:
            conn.execute(text(f"SET ROLE {ident(settings.migration_role.strip())}"))
            conn.execute(text(f"REVOKE INSERT, UPDATE, DELETE ON alembic_version FROM {ident(app_user)}"))
            conn.execute(text("RESET ROLE"))
    finally:
        conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": LOCK_KEY})
