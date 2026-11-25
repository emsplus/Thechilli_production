#!/usr/bin/env bash
# Back up ALL our databases (pg_dump custom format), the upload volumes and the generated secrets into ./backups/<date>/.
#   scripts/backup.sh            (also run by update.sh before every update; schedule daily with cron or from the pipeline)
# BACKUP_AGE_RECIPIENT in .env (age public key) => every file is encrypted with `age` and the plaintext removed.
# Without it the files are plaintext, mode 600, in a mode-700 folder: copy them OFF this host (they include the secrets).
# Keeps the newest KEEP (default 14) backups.
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
umask 077
LOCK_WAIT=${LOCK_WAIT:-300}   # a cron backup that meets a running update waits up to 5 min, then exits 75 (the update takes its own backup)
acquire_lock "backup.sh"
check_free_space "${MIN_FREE_MB:-512}" "backup"
db=$(our_container db); [ -n "$db" ] || die "our database container is not running"
guard_container "$db"
stamp=$(date +%Y%m%d-%H%M%S); out="$BUNDLE_DIR/backups/$stamp"; n=0
mkdir -p "$BUNDLE_DIR/backups"
while [ -e "$out" ]; do n=$((n+1)); out="$BUNDLE_DIR/backups/$stamp-$n"; done   # two backups in the same second (safety backup of a restore) never share a folder
mkdir -p "$out"; chmod 700 "$BUNDLE_DIR/backups" "$out"
# a failed run (disk full, pg_dump error, Ctrl-C) must not leave a half backup behind: it would count as one of the KEEP newest and push a good one out
BACKUP_OK=0
cleanup() { [ "$BACKUP_OK" = 1 ] || { rm -rf "$out"; warn "backup failed: partial folder removed"; }; release_lock; }
trap cleanup EXIT
for d in $DATABASES; do
  docker exec "$db" pg_dump -U chilli_admin -Fc -d "$d" > "$out/$d.dump" || die "pg_dump $d failed"
  docker exec -i "$db" pg_restore --list < "$out/$d.dump" > /dev/null || die "dump of $d is not readable"
  ok "$d: $(du -h "$out/$d.dump" | cut -f1)"
done
docker exec "$db" pg_dumpall -U chilli_admin --roles-only > "$out/roles.sql" || die "pg_dumpall (roles) failed"
img=$(docker inspect -f '{{.Config.Image}}' "$db")
for v in pos_storage marketing_documents; do
  vol="${PROJECT}_$v"; docker volume inspect "$vol" >/dev/null 2>&1 || continue; guard_volume "$vol"
  docker run --rm --network none -v "$vol":/v:ro --entrypoint tar "$img" -C /v -czf - . > "$out/$v.tar.gz" || die "archive of volume $v failed (disk full?)"
  ok "volume $v: $(du -h "$out/$v.tar.gz" | cut -f1)"
done
cp "$ENV_FILE" "$out/env"; [ -f "$BUNDLE_DIR/.env.secrets" ] && cp "$BUNDLE_DIR/.env.secrets" "$out/env.secrets"   # older backups: compose.env / bundle.env / compose.env.secrets
{ echo "project=$PROJECT"; echo "created=$stamp"; head -40 "$BUNDLE_DIR/MANIFEST.txt" 2>/dev/null || true; } > "$out/meta.txt"
rcpt=$(envget BACKUP_AGE_RECIPIENT)
if [ -n "$rcpt" ]; then
  command -v age >/dev/null || die "BACKUP_AGE_RECIPIENT is set but age is not installed (sudo apt-get install -y age)"
  for f in "$out"/*; do case "$f" in *meta.txt) continue;; esac; age -r "$rcpt" -o "$f.age" "$f" && rm -f "$f"; done
  ok "encrypted with age"
else warn "backup is NOT encrypted (set BACKUP_AGE_RECIPIENT in .env); it contains the stack's secrets: keep it private"; fi
# checksums of the files as they are stored (after encryption): restore.sh verifies them BEFORE decrypting. They used to be written
# before encryption and listed the deleted plaintext names, so every encrypted backup failed restore.sh with "checksum mismatch".
(cd "$out" && if command -v sha256sum >/dev/null; then sha256sum -- * > SHA256SUMS; else shasum -a 256 -- * > SHA256SUMS; fi)
chmod 600 "$out"/*
BACKUP_OK=1
ls -1dt "$BUNDLE_DIR"/backups/2*/ 2>/dev/null | tail -n +$(( ${KEEP:-14} + 1 )) | while read -r old; do rm -rf "$old"; done
ok "backup: $out ($(du -sh "$out" | cut -f1))"
echo "$out"
