#!/usr/bin/env bash
# Create the initial feature catalog and plans in a running platform-core (first deployment). Idempotent and production-safe:
# it only ADDS missing features/plans and never overwrites one that exists (an edited plan keeps its price and features), so it
# can be re-run after every release. It runs platform-core's own scripts/seed_catalog.py inside the container (same DB role as the API).
#   scripts/seed-plans.sh [--project NAME] [--dry-run] [--plans-file plans.json] [--accept-placeholder-prices]
#     --project NAME                compose project (default: $COMPOSE_PROJECT_NAME, else chilli-local)
#     --dry-run                     print what would be created, change nothing
#     --plans-file plans.json       your real plans/prices (JSON on the host, sent through stdin; format: platform-core
#                                   scripts/seed_catalog.py --help). Recommended in production.
#     --accept-placeholder-prices   production only: use the built-in starter plans (starter/growth/pro, PLACEHOLDER prices)
# Without --plans-file the container's ENV decides: development uses the built-in plans, production refuses them unless
# --accept-placeholder-prices is given. Prices can be edited later in super-admin (Plans; every edit is versioned).
set -euo pipefail
. "$(dirname "$0")/seed-plans.lib.sh"
project=${COMPOSE_PROJECT_NAME:-chilli-local}; args=(); plans_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) project=${2:?--project needs a name}; shift 2 ;;
    --plans-file) plans_file=${2:?--plans-file needs a path}; [ -f "$plans_file" ] || die "no such file: $plans_file"; args+=(--plans-file -); shift 2 ;;
    --dry-run|--accept-placeholder-prices) args+=("$1"); shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
c=$(service_container "$project" platform-core)
[ -n "$c" ] || die "no running platform-core container in compose project '$project' (start the stack; --project NAME to pick another)"
log "seeding catalog in $c (project $project)"
if [ -n "$plans_file" ]; then
  docker exec -i "$c" python scripts/seed_catalog.py "${args[@]}" < "$plans_file"
else
  docker exec "$c" python scripts/seed_catalog.py ${args[@]+"${args[@]}"}
fi
