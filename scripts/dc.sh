#!/usr/bin/env bash
# docker compose for OUR project only (project, files and env files of the mode deploy.sh last used). Examples:
#   scripts/dc.sh ps        scripts/dc.sh logs --tail 100 pos-service        scripts/dc.sh exec db psql -U chilli_admin -d pos
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
case "${1:-}" in
  down) for a in "$@"; do case "$a" in -v|--volumes) die "refusing 'down -v' here: use scripts/down.sh --delete-data";; esac; done ;;
esac
dc "$@"
