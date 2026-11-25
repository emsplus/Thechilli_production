#!/usr/bin/env bash
# Convert an EXISTING local volume to the RLS role split (security review 2026-10-31, finding 3). A fresh volume gets it from
# initdb/10-service-dbs.sh; initdb never runs again on a volume that already has data, hence this script.
#
#   scripts/gen-env.sh --update      # adds POS_MIGRATOR_DB_PASSWORD / DELIVERY_MIGRATOR_DB_PASSWORD to .env
#   scripts/rls-role-split.sh        # idempotent; then: docker compose up -d --build (migrate one-shots log in as the migrators)
#
# For pos and delivery it creates <svc>_owner (NOLOGIN) and <svc>_migrator (LOGIN, member of the owner), moves the
# database, the public schema and every object in it from <svc>_app to <svc>_owner (object by object, like pos-service
# app/core/db_roles.transfer_ownership: never REASSIGN OWNED), grants <svc>_app DML / sequence use / EXECUTE now and through
# default privileges, and makes alembic_version read-only for the app. Rollback: the same loop with the roles swapped.
# Prints role names only; the migrator passwords travel as environment variables into psql (\getenv), never as arguments.
set -euo pipefail
cd "$(dirname "$0")/.."   # the bundle root: .env, .env.secrets and docker-compose*.yml live there
[ -e .env ] || { echo "no .env (run scripts/gen-env.sh)" >&2; exit 1; }
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
POS_MIG=$(get POS_MIGRATOR_DB_PASSWORD); DEL_MIG=$(get DELIVERY_MIGRATOR_DB_PASSWORD)
[ -n "$POS_MIG" ] && [ -n "$DEL_MIG" ] || { echo "run scripts/gen-env.sh --update first (migrator passwords missing)" >&2; exit 1; }

split() { # db svc password
  local db=$1 o=$2_owner m=$2_migrator a=$2_app
  echo "== $db: $a -> owner $o, migrator $m"
  # `-e MIGPW` (no value) makes docker read it from THIS process's environment: a `-e MIGPW=<value>` argument would show the
  # migrator password in `ps` / /proc/*/cmdline of every user on a shared host.
  MIGPW="$3"; export MIGPW
  ${DB_EXEC:-docker compose exec -T} -e MIGPW "${DB_SERVICE:-db}" sh -c "psql -v ON_ERROR_STOP=1 -q -U \"\$POSTGRES_USER\" -d $db" <<SQL
\getenv migpw MIGPW
SELECT set_config('split.pw', :'migpw', false) AS ignored \gset
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$o') THEN
    CREATE ROLE $o NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$m') THEN
    CREATE ROLE $m LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; END IF;
  EXECUTE format('ALTER ROLE $m PASSWORD %L', current_setting('split.pw'));
  ALTER ROLE $a NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
END \$\$;
SELECT set_config('split.pw', '', false) AS ignored \gset
GRANT $o TO $m;
ALTER DATABASE $db OWNER TO $o;
GRANT CONNECT ON DATABASE $db TO $m, $a;
ALTER SCHEMA public OWNER TO $o;
DO \$\$ DECLARE r record; BEGIN
  FOR r IN
    SELECT 'TABLE' AS kind, format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND pg_get_userbyid(c.relowner) = '$a'
    UNION ALL SELECT 'VIEW', format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v' AND pg_get_userbyid(c.relowner) = '$a'
    UNION ALL SELECT 'MATERIALIZED VIEW', format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'm' AND pg_get_userbyid(c.relowner) = '$a'
    UNION ALL SELECT 'SEQUENCE', format('%I.%I', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S' AND pg_get_userbyid(c.relowner) = '$a'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i'))
    UNION ALL SELECT 'TYPE', format('%I.%I', n.nspname, t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') AND pg_get_userbyid(t.typowner) = '$a'
    UNION ALL SELECT 'FUNCTION', format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = '$a'
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO $o', r.kind, r.name);
  END LOOP;
END \$\$;
GRANT USAGE, CREATE ON SCHEMA public TO $o;
GRANT USAGE ON SCHEMA public TO $a;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, $a;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $a;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $a;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO $a;
ALTER DEFAULT PRIVILEGES FOR ROLE $o IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $a;
ALTER DEFAULT PRIVILEGES FOR ROLE $o IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $a;
ALTER DEFAULT PRIVILEGES FOR ROLE $o IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO $a;
DO \$\$ BEGIN
  IF to_regclass('public.alembic_version') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON public.alembic_version FROM $a; END IF;
END \$\$;
SELECT '$a owns ' || count(*) || ' tables (must be 0)' FROM pg_tables WHERE schemaname = 'public' AND tableowner = '$a';
SQL
  unset MIGPW
}
split pos      pos      "$POS_MIG"
split delivery delivery "$DEL_MIG"
echo "done. Rebuild/recreate pos-migrate, pos-service, delivery-migrate, delivery-service; both APIs now log (dev) or refuse"
echo "(other ENV) a privileged role at startup. Check: SELECT tableowner, count(*) FROM pg_tables WHERE schemaname='public' GROUP BY 1;"
