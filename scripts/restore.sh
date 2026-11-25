#!/usr/bin/env bash
# Restore from a backup made by scripts/backup.sh.
#   scripts/restore.sh backups/<date>                 restore every database into NEW databases <db>_restore (live data untouched; inspect)
#   scripts/restore.sh backups/<date> --live [db...]  STOP the apps, replace the live database(s) (default: all), start again
# Encrypted backups (.age): BACKUP_AGE_IDENTITY=/path/to/key.txt scripts/restore.sh ...
# The secrets in the backup (env) must match the running ones for the MFA keys / PIN pepper: on a NEW host copy
# env to .env (and env.secrets to .env.secrets) in the bundle folder BEFORE scripts/deploy.sh. (Backups made before 2026-11-14 call them
# compose.env + bundle.env: merge both into .env.)
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
dir=${1:?usage: scripts/restore.sh backups/<date> [--live [db...]]}; shift
[ -d "$dir" ] || die "no such backup folder: $dir"
live=0; [ "${1:-}" = "--live" ] && { live=1; shift; }
dbs=${*:-$DATABASES}
acquire_lock "restore.sh $*"
db=$(our_container db); [ -n "$db" ] || die "our database container is not running (./scripts/dc.sh up -d db)"
guard_container "$db"
(cd "$dir" && if command -v sha256sum >/dev/null; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi) || die "checksum mismatch"
# F-08: decrypted dumps go to a private (0700) temp dir that is removed on every exit, including failures and Ctrl-C
# (they used to stay in /tmp as full plaintext database dumps).
umask 077
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/chilli-restore.XXXXXX"); chmod 700 "$TMPD"
trap 'rm -rf "$TMPD"; release_lock' EXIT
trap 'exit 130' INT TERM
get() {  # NAME -> plaintext path (decrypts .age into $TMPD)
  if [ -f "$dir/$1" ]; then echo "$dir/$1"; elif [ -f "$dir/$1.age" ]; then
    : "${BACKUP_AGE_IDENTITY:?set BACKUP_AGE_IDENTITY to the age private key file}"
    t=$(mktemp "$TMPD/$1.XXXXXX"); age -d -i "$BACKUP_AGE_IDENTITY" -o "$t" "$dir/$1.age" || die "cannot decrypt $1.age"; echo "$t"
  else die "missing $1 in $dir"; fi; }
for d in $dbs; do [ -f "$dir/$d.dump" ] || [ -f "$dir/$d.dump.age" ] || die "no dump of '$d' in $dir (nothing was changed)"; done   # before anything is dropped
if [ "$live" = 1 ]; then
  read -r -p "Replace the LIVE database(s) [$dbs] of '$PROJECT' with $dir? Type the project name: " x; [ "$x" = "$PROJECT" ] || die "not confirmed"
  # safety net: --live DROPs the live database first; if the restore then fails half way, this is the way back
  if [ "${SKIP_SAFETY_BACKUP:-0}" = 1 ]; then SAFETY="(skipped)"; warn "SKIP_SAFETY_BACKUP=1: no backup of the current live data is taken"
  else SAFETY=$("$BUNDLE_DIR/scripts/backup.sh") || die "safety backup of the current live data failed: nothing was changed (SKIP_SAFETY_BACKUP=1 to go on without it)"
    SAFETY=$(printf '%s\n' "$SAFETY" | tail -n1); ok "safety backup of the current live data: $SAFETY"; fi
  dc stop $APP_SERVICES $WEB_SERVICES caddy
fi
for d in $dbs; do
  f=$(get "$d.dump"); target=$d; [ "$live" = 1 ] || target="${d}_restore"
  owner=$(docker exec "$db" psql -U chilli_admin -d postgres -tAc "select pg_get_userbyid(datdba) from pg_database where datname='$d'" | tr -d '[:space:]')
  docker exec "$db" psql -v ON_ERROR_STOP=1 -U chilli_admin -d postgres -q -c "DROP DATABASE IF EXISTS \"$target\" WITH (FORCE)" -c "CREATE DATABASE \"$target\" OWNER \"${owner:-chilli_admin}\""
  docker exec -i "$db" pg_restore -U chilli_admin -d "$target" --no-comments --exit-on-error < "$f" || die "restore of $d failed${SAFETY:+: the apps are STOPPED and $d is incomplete; the data from before is in $SAFETY (scripts/restore.sh $SAFETY --live $d)}"
  ok "restored $d -> $target"
done
if [ "$live" = 1 ]; then
  img=$(docker inspect -f '{{.Config.Image}}' "$db")
  for v in pos_storage marketing_documents; do
    [ -f "$dir/$v.tar.gz" ] || [ -f "$dir/$v.tar.gz.age" ] || continue; vol="${PROJECT}_$v"; guard_volume "$vol"; f=$(get "$v.tar.gz")
    docker run --rm --network none -i -v "$vol":/v --entrypoint sh "$img" -c 'find /v -mindepth 1 -delete; tar -C /v -xzf -' < "$f"; ok "volume $v restored"
  done
  dc up -d --no-build; ok "apps started again: scripts/status.sh"
else echo "Inspect: ./scripts/dc.sh exec db psql -U chilli_admin -d <db>_restore ; drop them afterwards."; fi
