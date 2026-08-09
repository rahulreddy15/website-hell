#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${SYMPTOM_TRACKER_RESTIC_ENV:-/etc/symptom-tracker-restic.env}
BACKUP_DIR=${SYMPTOM_TRACKER_BACKUP_DIR:-/var/lib/symptom-tracker/backups}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
command -v restic >/dev/null 2>&1 || die "restic is not installed; install it with your OS package manager."
[[ -f "$ENV_FILE" ]] || die "restic environment file is missing: $ENV_FILE (create it root-owned with mode 0600)."
[[ -r "$ENV_FILE" ]] || die "restic environment file is not readable: $ENV_FILE"
env_mode=$(stat -c '%U:%a' "$ENV_FILE") || die "cannot inspect permissions on $ENV_FILE."
[[ "$env_mode" == root:600 ]] || die "$ENV_FILE must be owned by root with mode 0600 (currently $env_mode)."
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
[[ -n "${RESTIC_REPOSITORY:-}" ]] || die "RESTIC_REPOSITORY is not set in $ENV_FILE."
[[ -n "${RESTIC_PASSWORD:-}" || -n "${RESTIC_PASSWORD_FILE:-}" ]] || die "RESTIC_PASSWORD or RESTIC_PASSWORD_FILE is not set in $ENV_FILE."
[[ -d "$BACKUP_DIR" ]] || die "local snapshot directory does not exist: $BACKUP_DIR"

snapshot=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'symptom-tracker-*.sqlite3' -mtime -1 -print | sort | tail -n 1)
[[ -n "$snapshot" ]] || die "no nightly SQLite snapshot newer than 24 hours exists in $BACKUP_DIR; check symptom-tracker-backup.timer."

# Never include the live database or the pre-migration directory: upload exactly
# one already-consistent VACUUM INTO file.
restic snapshots >/dev/null || die "cannot access the restic repository; verify credentials and run 'restic init' if needed."
restic backup --tag symptom-tracker-nightly "$snapshot"
restic forget --tag symptom-tracker-nightly --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune

# Sunday runs perform the slower repository integrity check.
if [[ "$(date +%u)" == 7 ]]; then
  restic check
fi
