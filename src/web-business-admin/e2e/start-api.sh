#!/bin/sh
# Recreates the e2e database and runs the API against it.
# Local default: Postgres from docker compose (container pos-db-1, published on :5460) - unchanged behaviour.
# CI / no pos-db-1 container: set E2E_PG_ADMIN_URL to a libpq URL of the server's maintenance DB, e.g.
#   E2E_PG_ADMIN_URL=postgresql://pos:pos@localhost:5460/postgres
# and the database is recreated over that connection instead of `docker exec`.
# E2E_DATABASE_URL overrides the API's connection URL (default: pos:pos@localhost:5460/pos_e2e).
# E2E_DB_NAME (default pos_e2e), E2E_API_PORT (8120), E2E_WEB_PORT (3120) let a second run use its own database and ports.
set -e
DB_NAME="${E2E_DB_NAME:-pos_e2e}"
API_PORT="${E2E_API_PORT:-8120}"
WEB_PORT="${E2E_WEB_PORT:-3120}"
if [ -z "${E2E_PG_ADMIN_URL:-}" ]; then
  docker exec pos-db-1 psql -U pos -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" >/dev/null
  docker exec pos-db-1 psql -U pos -d postgres -c "CREATE DATABASE $DB_NAME" >/dev/null
fi
cd "${POS_SERVICE_DIR:-$(dirname "$0")/../../pos-service}"
if [ -n "${E2E_PG_ADMIN_URL:-}" ]; then
  DB_NAME="$DB_NAME" uv run python -c '
import os, psycopg
with psycopg.connect(os.environ["E2E_PG_ADMIN_URL"], autocommit=True) as c:
    c.execute("DROP DATABASE IF EXISTS %s WITH (FORCE)" % os.environ["DB_NAME"])
    c.execute("CREATE DATABASE %s" % os.environ["DB_NAME"])
'
fi
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql+psycopg://pos:pos@localhost:5460/$DB_NAME}"
export CORS_ORIGINS="[\"http://localhost:$WEB_PORT\"]"
export STORAGE_DIR="/tmp/pos-e2e-storage-$API_PORT"
# Tests must never call the real Gemini API (or depend on a developer's key in apps/api/.env).
export GEMINI_API_KEY=""
# ...except for known fixture bills (e2e/urban-plate-bill.spec.ts): a file whose sha256 has a JSON here is "read" from it.
export OCR_FIXTURE_DIR="$(pwd)/tests/fixtures/ocr"
export DEFAULT_COUNTRY=IN  # specs that register without a country get an Indian restaurant (India is the only country)
# Every spec registers its own restaurant: lift the per-IP / global sign-up limits (5 / 100 per hour) for this test API only.
export REGISTER_PER_IP_PER_HOUR=100000 REGISTER_GLOBAL_PER_HOUR=100000
export PRINT_RETRY_DELAYS="0,0,0,0"  # print retries without waiting (real default: 5,15,30,60,120,180,300 seconds)
export ENV=development  # the API defaults to production (fail closed)
uv run alembic upgrade head
# Never a real mailbox in tests (apps/api/.env may hold one): SMTP is forced empty and re-order emails go to a folder instead
# (EMAIL_SINK_DIR, a test hook) that the specs can read back through the "Sent emails" list.
export SMTP_HOST="" SMTP_USER="" SMTP_PASSWORD="" SMTP_FROM=""
export EMAIL_SINK_DIR="/tmp/pos-e2e-mail-$API_PORT"
rm -rf "$EMAIL_SINK_DIR"
exec uv run uvicorn app.main:app --port "$API_PORT"
