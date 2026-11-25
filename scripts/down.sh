#!/usr/bin/env bash
# Stop OUR stack. Data (database, uploads) is KEPT. Only our project is touched (-p chilli...).
#   scripts/down.sh                 stop and remove our containers + networks (volumes kept; scripts/deploy.sh --skip-build brings it back)
#   scripts/down.sh --delete-data   ALSO delete our volumes (database!). Asks you to type the project name. Back up first: scripts/backup.sh
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
acquire_lock "down.sh $*"
if [ "${1:-}" = "--delete-data" ]; then
  read -r -p "This DELETES the database of project '$PROJECT'. Type the project name to confirm: " x
  [ "$x" = "$PROJECT" ] || die "not confirmed"
  dc down -v --remove-orphans
else
  dc down --remove-orphans
fi
ok "stopped project $PROJECT"
