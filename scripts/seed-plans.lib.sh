# Shared helpers (sourced). Adapted from Pos/scripts/lib.sh, generalised for any service. bash 3.2+ (macOS ok).
# shellcheck shell=bash
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

load_env() {  # KEY=VALUE lines, no shell evaluation; caller's env wins
  local f="$1" line key val
  [ -f "$f" ] || die "env file not found: $f"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    if [ -z "${!key+x}" ]; then export "$key=$val"; fi
  done < "$f"
}

service_container() {  # PROJECT SERVICE -> first running container id
  docker ps -q --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=$2" | head -n1
}

sha256_file()  { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
sha256_check() { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c "$1"; else shasum -a 256 -c "$1"; fi; }

latest_backup() {  # DIR SERVICE -> newest complete backup dir (has SHA256SUMS)
  local d
  d="$(ls -1d "$1/$2"-*/ 2>/dev/null | sort | while read -r x; do [ -f "$x/SHA256SUMS" ] && echo "$x"; done | tail -n1)"
  [ -n "$d" ] && echo "${d%/}"
}

valid_ident() { case "$1" in ''|*[!a-z0-9_]*) return 1 ;; *) return 0 ;; esac; }

# ---- backup encryption (security review 2026-10-31, finding 14) ----
# backup.sh encrypts db.dump and storage.tar.gz for a PUBLIC key from the environment, so the backup host and the backup store
# never hold anything that can decrypt them: BACKUP_AGE_RECIPIENT (age, preferred: "age1...") or BACKUP_GPG_RECIPIENT (a key
# id / fingerprint in the caller's gpg keyring). Restores decrypt with BACKUP_AGE_IDENTITY (path to the age identity file,
# kept OFF the backup store) or the gpg keyring. No recipient = refuse, unless BACKUP_ALLOW_PLAINTEXT=1 (local drills only).
encrypt_file() {  # FILE -> FILE.age | FILE.gpg (the plaintext is removed); prints the new name
  local f="$1"
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
    command -v age >/dev/null 2>&1 || die "age not installed (BACKUP_AGE_RECIPIENT is set)"
    age -r "$BACKUP_AGE_RECIPIENT" -o "$f.age" "$f" && rm -f "$f" && echo "$f.age"
  elif [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
    command -v gpg >/dev/null 2>&1 || die "gpg not installed (BACKUP_GPG_RECIPIENT is set)"
    gpg --batch --yes --quiet --trust-model always -r "$BACKUP_GPG_RECIPIENT" -o "$f.gpg" -e "$f" && rm -f "$f" && echo "$f.gpg"
  else
    echo "$f"
  fi
}
backup_encryption_required() {  # dies unless a recipient is set or plaintext is explicitly allowed
  [ -n "${BACKUP_AGE_RECIPIENT:-}" ] || [ -n "${BACKUP_GPG_RECIPIENT:-}" ] || [ "${BACKUP_ALLOW_PLAINTEXT:-0}" = "1" ] || \
    die "backups are encrypted: set BACKUP_AGE_RECIPIENT (age public key) or BACKUP_GPG_RECIPIENT; BACKUP_ALLOW_PLAINTEXT=1 only for local drills"
}
backup_file() {  # DIR NAME -> the stored file for NAME (NAME, NAME.age or NAME.gpg)
  local x
  for x in "$1/$2" "$1/$2.age" "$1/$2.gpg"; do [ -f "$x" ] && { echo "$x"; return 0; }; done
  return 1
}
decrypt_cat() {  # FILE -> plaintext on stdout
  case "$1" in
    *.age) command -v age >/dev/null 2>&1 || die "age not installed"
           [ -n "${BACKUP_AGE_IDENTITY:-}" ] || die "set BACKUP_AGE_IDENTITY (path to the age identity file) to decrypt"
           age -d -i "$BACKUP_AGE_IDENTITY" "$1" ;;
    *.gpg) command -v gpg >/dev/null 2>&1 || die "gpg not installed"; gpg --batch --quiet -d "$1" ;;
    *) cat "$1" ;;
  esac
}
