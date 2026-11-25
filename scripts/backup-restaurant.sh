#!/usr/bin/env bash
# Back up ONE restaurant's data (all its rows in the pos database) without touching the others.
#   scripts/backup-restaurant.sh --list            restaurants (id, name)
#   scripts/backup-restaurant.sh <restaurant-id>   writes backups/restaurant-<id>-<date>.tgz (one CSV per table + schema version)
# Rows are read as the application role (SET ROLE pos_app + app.tenant_id), so row-level security decides what belongs to the
# restaurant: child tables without their own restaurant_id are covered too. Read-only. Full backups: scripts/backup.sh.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
umask 077
db=$(our_container db); [ -n "$db" ] || die "our database container is not running"
guard_container "$db"
q() { docker exec -i "$db" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d pos -At -q'; }
if [ "${1:-}" = "--list" ] || [ -z "${1:-}" ]; then
  q <<<"select id || '  ' || coalesce(name,'') from restaurants order by 2;"; [ -n "${1:-}" ] || echo "usage: $0 <restaurant-id> | --list" >&2; exit 0
fi
rid="$1"; [[ "$rid" =~ ^[0-9a-fA-F-]{36}$ ]] || die "restaurant id must be a UUID (see --list)"
[ "$(q <<<"select count(*) from restaurants where id='$rid';")" = 1 ] || die "no such restaurant: $rid"
check_free_space "${MIN_FREE_MB:-256}" "restaurant backup"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/rbackup.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
mkdir -p "$BUNDLE_DIR/backups"; chmod 700 "$BUNDLE_DIR/backups"
tables=$(q <<<"select tablename from pg_tables where schemaname='public' and tablename <> 'alembic_version' order by 1;")
q <<<"select version_num from alembic_version;" > "$tmp/alembic_version.txt"
n=0
for t in $tables; do
  [[ "$t" =~ ^[a-z0-9_]+$ ]] || die "unexpected table name: $t"
  docker exec -i "$db" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d pos -At -q' > "$tmp/$t.csv" <<SQL || die "export of $t failed"
BEGIN READ ONLY;
SET LOCAL ROLE pos_app;
SELECT set_config('app.tenant_id', '$rid', true);
COPY (SELECT * FROM public."$t") TO STDOUT WITH (FORMAT csv, HEADER true);
ROLLBACK;
SQL
  # psql prints the set_config result row before the COPY data: drop that single line
  sed -i.bak '1d' "$tmp/$t.csv" 2>/dev/null && rm -f "$tmp/$t.csv.bak"
  if [ "$(wc -l < "$tmp/$t.csv")" -le 1 ]; then rm -f "$tmp/$t.csv"; else n=$((n+1)); fi   # header only = no rows of this restaurant
done
out="$BUNDLE_DIR/backups/restaurant-$rid-$(date +%Y%m%d-%H%M%S).tgz"
tar -czf "$out" -C "$tmp" . && chmod 600 "$out"
ok "restaurant $rid: $n tables with data -> $out ($(du -h "$out" | cut -f1)). Copy it off this host."
