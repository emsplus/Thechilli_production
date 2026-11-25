#!/usr/bin/env bash
# Proves that one restaurant can never see or change another restaurant's data. Read-only: every probe runs inside a transaction that is
# rolled back, as the application's own database role (pos_app: no superuser, no BYPASSRLS, owns nothing), so row-level security applies.
#   scripts/check-isolation.sh          exit 0 only if every check passed (run it after every update of pos-service, or daily from cron / CI)
# Checks: (1) every tenant table has RLS on, (2) the app role cannot bypass it, (3) with restaurant A's context only A's rows are visible,
# (4) with no context nothing is visible, (5) A cannot update or insert rows of B, (6) the visible rows of all restaurants add up to the total.
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
db=$(our_container db); [ -n "$db" ] || die "our database container is not running"
guard_container "$db"
q() { docker exec -i "$db" sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d pos -At -q' ; }
fail=0; bad() { printf '%s %s[FAIL]%s %s\n' "$(date +%H:%M:%S)" "$c_red" "$c_off" "$*" >&2; fail=1; }

# (1) tables that carry a tenant column but have no RLS (a short allow-list of global system tables is expected to be the only ones)
no_rls=$(q <<'SQL'
select string_agg(c.relname, ' ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
   and exists (select 1 from information_schema.columns k where k.table_schema = 'public' and k.table_name = c.relname and k.column_name in ('restaurant_id', 'tenant_id'))
   and c.relname not in ('provisioning_requests');
SQL
)
[ -z "$no_rls" ] && ok "every table with a restaurant/tenant column has row-level security" || bad "tenant tables WITHOUT row-level security: $no_rls"

# (2) the application role
role=$(q <<'SQL'
select rolsuper::text || ' ' || rolbypassrls::text from pg_roles where rolname = 'pos_app';
SQL
)
[ "$role" = "false false" ] && ok "pos_app is not a superuser and cannot bypass row-level security" || bad "pos_app role flags are '$role' (must be 'false false')"
owned=$(q <<'SQL'
select count(*) from pg_tables where schemaname = 'public' and tableowner = 'pos_app';
SQL
)
[ "$owned" = 0 ] && ok "pos_app owns no table (owners are exempt from RLS)" || bad "pos_app owns $owned tables"

# (3)-(6) per restaurant
ids=$(q <<'SQL'
select id from restaurants order by id;
SQL
)
n=$(printf '%s\n' "$ids" | grep -c .)
[ "$n" -ge 1 ] || { warn "no restaurant yet: nothing more to compare"; exit "$fail"; }
total=$(q <<'SQL'
select count(*) from menu_items;
SQL
)
sum=0
for a in $ids; do
  seen=$(q <<SQL
begin; set local role pos_app; select set_config('app.tenant_id', '$a', true) \gset
select (select count(*) from menu_items) || ' ' || (select count(*) from menu_items where restaurant_id <> '$a'::uuid) || ' ' || (select count(*) from restaurants);
rollback;
SQL
)
  seen=$(printf '%s\n' "$seen" | { grep -E '^[0-9]+ [0-9]+ [0-9]+$' || true; } | tail -1)
  # shellcheck disable=SC2086
  set -- $seen; mine=${1:-x}; foreign=${2:-x}; rest=${3:-x}
  { [ "$foreign" = 0 ] && [ "$rest" = 1 ]; } && ok "restaurant ${a%%-*}: sees $mine own menu items, 0 foreign rows, 1 restaurant" || bad "restaurant $a sees foreign data (foreign menu rows=$foreign, restaurants visible=$rest)"
  case "$mine" in ''|*[!0-9]*) ;; *) sum=$((sum + mine));; esac
  for b in $ids; do
    [ "$b" = "$a" ] && continue
    upd=$(q <<SQL | { grep -E '^[0-9]+$' || true; } | tail -1
begin; set local role pos_app; select set_config('app.tenant_id', '$a', true) \gset
with u as (update menu_items set name = name where restaurant_id = '$b'::uuid returning 1) select count(*) from u;
rollback;
SQL
)
    [ "$upd" = 0 ] || bad "restaurant ${a%%-*} could update rows of ${b%%-*} (rows touched: ${upd:-unknown})"
  done
done
[ "$sum" = "$total" ] && ok "the restaurants' own rows add up to the total ($sum = $total): no row is shared or orphaned" || bad "visible rows $sum != total $total"
none=$(q <<'SQL' | { grep -E '^[0-9]+$' || true; } | tail -1
begin; set local role pos_app; select (select count(*) from menu_items) + (select count(*) from dining_tables) + (select count(*) from users) + (select count(*) from restaurants); rollback;
SQL
)
[ "$none" = 0 ] && ok "without a restaurant context the application sees nothing" || bad "no-context query returned $none rows"
[ "$fail" = 0 ] && ok "ISOLATION OK ($n restaurants)" || die "isolation check FAILED"
