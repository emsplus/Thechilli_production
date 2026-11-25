#!/usr/bin/env bash
# Ship an update of ONE service safely:  scripts/update.sh <service> [update.zip]
#   1. (optional) unzip update.zip over ./src (it contains src/<repo>/... and UPDATE.txt; nothing else is touched)
#   2. scripts/backup.sh (all databases)          3. tag the running image as :rollback
#   4. rebuild that one image (nice, one build)
#   5. API services: run its migration one-shot first (migrations are FORWARD-ONLY: the backup of step 2 is the way back)
#   6. recreate ONLY that service (--no-deps), wait for health; on failure: put the :rollback image back and recreate, and put the
#      previous src/<repo> back (a failed update must not leave the rejected source in src/: the next deploy.sh would rebuild it).
# Only one deploy/update/backup/restore/down runs at a time (lock in scripts/lib.sh, exit 75 when busy). Free disk is checked first
# (MIN_FREE_MB, default 3072; MIN_FREE_MB=0 skips).
# Services: pos-service platform-core marketing-service delivery-service payments-service aggregator-service
#           web-business-admin web-super-admin web-marketing web-public waiter-app
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
svc=${1:?usage: scripts/update.sh <service> [update.zip]}; zip=${2:-}
case " $APP_SERVICES $WEB_SERVICES " in *" $svc "*) ;; *) die "unknown service '$svc'";; esac
acquire_lock "update.sh $*"
prune_logs
check_free_space "${MIN_FREE_MB:-3072}" "update $svc"
REPLACED=""; SWITCHED=0; BK="(none)"
restore_source() {  # put the previous src/<repo> back; the rejected copy stays in src/.failed-<repo> for inspection
  local d
  for d in $REPLACED; do
    [ -d "$BUNDLE_DIR/src/.prev-$d" ] || continue
    rm -rf "$BUNDLE_DIR/src/.failed-$d"; mv "$BUNDLE_DIR/src/$d" "$BUNDLE_DIR/src/.failed-$d" 2>/dev/null || rm -rf "$BUNDLE_DIR/src/$d"
    mv "$BUNDLE_DIR/src/.prev-$d" "$BUNDLE_DIR/src/$d" && warn "source of $d is back to the version before this update (rejected copy: src/.failed-$d)"
  done
  REPLACED=""
}
# any failure/kill before the service was switched (set -e exit, unzip error, Ctrl-C, SIGTERM) puts the source back and frees the lock
finish() { [ "$SWITCHED" = 1 ] || restore_source; release_lock; }
trap finish EXIT
if [ -n "$zip" ]; then
  [ -f "$zip" ] || die "no such file $zip"
  list=$(unzip -Z1 "$zip") || die "$zip is not a readable zip"   # here-strings below: a `unzip | grep -q` pipe can die of SIGPIPE under pipefail and skip the check
  grep -vqE '^(src/|UPDATE\.txt$)' <<< "$list" && die "$zip contains files outside src/ (refusing)"
  grep -qE '^src/\.' <<< "$list" && die "$zip touches a hidden folder under src/ (refusing)"
  zl=$(unzip -Z "$zip") || die "$zip is not a readable zip"
  grep -q '^l' <<< "$zl" && die "$zip contains symbolic links (refusing: a link could point outside the build context)"
  # Each src/<repo>/ in the zip REPLACES that folder (files deleted upstream must not linger, e.g. an old migration); the previous
  # copy stays in src/.prev-<repo> until the next update of that repo.
  while IFS= read -r d; do
    if [ -n "$d" ] && [ -d "$BUNDLE_DIR/src/$d" ]; then rm -rf "$BUNDLE_DIR/src/.prev-$d"; mv "$BUNDLE_DIR/src/$d" "$BUNDLE_DIR/src/.prev-$d"; REPLACED="$REPLACED $d"; fi
  done < <(sed -n 's|^src/\([^/][^/]*\)/.*|\1|p' <<< "$list" | sort -u)
  unzip -o -q "$zip" -d "$BUNDLE_DIR" || die "unzip failed (disk full? bad zip?): the previous source is put back"   # EXIT trap restores src/
  ok "unpacked $zip (previous source kept in src/.prev-*)"; [ -f "$BUNDLE_DIR/UPDATE.txt" ] && { sed 's/^/    /' "$BUNDLE_DIR/UPDATE.txt"; rm -f "$BUNDLE_DIR/UPDATE.txt"; }
  # fresh mtimes: BuildKit keeps a stat-based (size+mtime) copy of each named build context; files unzipped with old mtimes can be
  # served from that stale copy (a case-renamed import then fails with "Module not found")
  while IFS= read -r d; do if [ -n "$d" ] && [ -d "$BUNDLE_DIR/src/$d" ]; then find "$BUNDLE_DIR/src/$d" -type f -exec touch {} + ; fi; done < <(sed -n "s|^src/\([^/][^/]*\)/.*|\1|p" <<< "$list" | sort -u)
fi
umask 077   # build/migration logs below are owner-only (after the unzip, so source file modes come from the zip)
BK=$("$BUNDLE_DIR/scripts/backup.sh") || die "backup failed: update aborted (nothing changed besides the unpacked source, which is put back)"; BK=$(printf '%s\n' "$BK" | tail -n1); ok "backup taken: $BK"
img="${PROJECT}-${svc}"
docker image inspect "$img" >/dev/null 2>&1 && docker tag "$img" "$img:rollback" && ok "current image kept as $img:rollback"
nice -n 15 env DOCKER_BUILDKIT=1 BUILDX_NO_DEFAULT_ATTESTATIONS=1 "$BUNDLE_DIR/scripts/dc.sh" build --progress plain "$svc" > "$LOG_DIR/update-build-$svc.log" 2>&1 \
  || { tail -30 "$LOG_DIR/update-build-$svc.log"; die "build failed: the running service was NOT changed (source put back)"; }
ok "built $svc"
case "$svc" in pos-service|platform-core|marketing-service|delivery-service|payments-service|aggregator-service)
  m=${svc%-service}; m=${m%-core}-migrate
  # the one-shot migration job has its own image (same source, separate tag): rebuild it too, or it runs the OLD migrations
  # (found 2026-11-02: new revision silently not applied, API answered 500 on the new table)
  nice -n 15 env DOCKER_BUILDKIT=1 BUILDX_NO_DEFAULT_ATTESTATIONS=1 "$BUNDLE_DIR/scripts/dc.sh" build --progress plain "$m" > "$LOG_DIR/update-build-$m.log" 2>&1 \
    || { tail -30 "$LOG_DIR/update-build-$m.log"; die "build of $m failed: the running service was NOT changed"; }  # build the one-shot migration image
  warn "running $m (forward-only; restore from the backup above if you must go back)"
  dc run --rm --no-deps -T "$m" > "$LOG_DIR/update-$m.log" 2>&1 || { tail -30 "$LOG_DIR/update-$m.log"; die "migration failed: service NOT recreated (still on the old image, source put back); database may need: scripts/restore.sh $BK --live ${m%-migrate}"; } ;;
esac
# after a healthy switch: the rejected-source safety copy is no longer needed (the :rollback image is the way back) and the applied zip
# is deleted: the pipeline owns the artifacts, the server keeps only what runs
tidy_after_success() {
  local d
  for d in $REPLACED; do rm -rf "$BUNDLE_DIR/src/.prev-$d"; done
  [ -z "$zip" ] || rm -f "$zip"
}
SWITCHED=1
if dc up -d --no-build --no-deps "$svc" && wait_healthy "${UPDATE_HEALTH_TIMEOUT:-240}" "$svc"; then ok "$svc updated and healthy"; tidy_after_success
else
  warn "$svc did not come up healthy: rolling back to the previous image"
  rolled=0
  if docker image inspect "$img:rollback" >/dev/null 2>&1; then
    docker tag "$img:rollback" "$img" && dc up -d --no-build --no-deps "$svc" && wait_healthy "${ROLLBACK_HEALTH_TIMEOUT:-120}" "$svc" && rolled=1
  fi
  if [ "$rolled" = 1 ]; then
    restore_source
    case "$svc" in pos-service|platform-core|marketing-service|delivery-service|payments-service|aggregator-service)
      warn "the migration of this update WAS applied (forward-only): the previous image now runs on the new schema; if it misbehaves restore ${m%-migrate}: scripts/restore.sh $BK --live ${m%-migrate}" ;; esac
    die "update failed; previous image AND previous source are back and healthy (scripts/logs.sh $svc)"
  fi
  die "update failed AND the rollback did not give a healthy $svc (no $img:rollback image, or it is unhealthy too): scripts/status.sh, scripts/logs.sh $svc; data backup: $BK (scripts/restore.sh $BK --live)"
fi
[ -f "$BUNDLE_DIR/scripts/verify-images.sh" ] && case "$svc" in web-*|waiter-app) "$BUNDLE_DIR/scripts/verify-images.sh" >/dev/null || warn "verify-images.sh reports a problem";; esac
