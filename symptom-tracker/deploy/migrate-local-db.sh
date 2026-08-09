#!/usr/bin/env bash
set -euo pipefail

DEST=/var/lib/symptom-tracker/symptom_tracker.sqlite3
SERVICE=symptom-tracker.service
# Read from db.py rather than hardcoding: a stale constant here would reject a valid
# database after the next schema bump, in the one script you run under stress.
# Falls back to a literal only if db.py cannot be located.
EXPECTED_SCHEMA_VERSION=$(
  python3 - "$(dirname "$0")/../db.py" <<'PY' 2>/dev/null || echo 4
import re, sys
try:
    m = re.search(r'^VERSION\s*=\s*(\d+)', open(sys.argv[1]).read(), re.M)
    print(m.group(1) if m else 4)
except Exception:
    print(4)
PY
)
FORCE=0

usage() {
  cat >&2 <<'EOF'
Usage: sudo migrate-local-db.sh [--force] [--expected-schema-version N] INCOMING.sqlite3

The source must first be checkpointed with PRAGMA wal_checkpoint(TRUNCATE).
Without --force, an existing destination containing study data is never replaced.
EOF
}
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --expected-schema-version)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ ]] || { usage; die "--expected-schema-version requires an integer."; }
      EXPECTED_SCHEMA_VERSION=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --*) usage; die "unknown option: $1" ;;
    *) [[ -z "${SOURCE:-}" ]] || { usage; die "only one incoming database may be supplied."; }; SOURCE=$1; shift ;;
  esac
done
[[ -n "${SOURCE:-}" ]] || { usage; die "incoming database path is required."; }
[[ "$EUID" -eq 0 ]] || die "run as root (sudo)."
command -v python3 >/dev/null 2>&1 || die "python3 is required."
command -v systemctl >/dev/null 2>&1 || die "systemctl is required."
[[ -f "$SOURCE" ]] || die "incoming database does not exist: $SOURCE"
[[ ! -e "$SOURCE-wal" && ! -e "$SOURCE-shm" ]] || die "incoming WAL/SHM sidecars exist; checkpoint the source with PRAGMA wal_checkpoint(TRUNCATE) and copy again."

incoming_version=$(python3 - "$SOURCE" <<'PY'
import sqlite3, sys
uri = "file:" + sys.argv[1] + "?mode=ro"
with sqlite3.connect(uri, uri=True) as c:
    result = c.execute("PRAGMA integrity_check").fetchone()[0]
    if result != "ok": raise SystemExit(f"integrity_check failed: {result}")
    exists = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone()
    if not exists: raise SystemExit("schema_version table is missing")
    version = c.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
    if version is None: raise SystemExit("schema_version is empty")
    print(int(version))
PY
) || die "incoming file failed SQLite validation; destination was not touched."
[[ "$incoming_version" == "$EXPECTED_SCHEMA_VERSION" ]] || die "incoming schema is v$incoming_version; expected v$EXPECTED_SCHEMA_VERSION."

if [[ -e "$DEST" && "$FORCE" -ne 1 ]]; then
  has_data=$(python3 - "$DEST" <<'PY'
import sqlite3, sys
tables = ("item","meal","consumption_event","symptom_event","day_log","state_log","censor_window")
with sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True) as c:
    present={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    print(int(any(c.execute(f'SELECT EXISTS(SELECT 1 FROM "{t}" LIMIT 1)').fetchone()[0] for t in tables if t in present)))
PY
  ) || die "could not inspect existing destination; use --force only after investigating and backing it up."
  [[ "$has_data" == 0 ]] || die "destination contains study data; refusing to overwrite it (use --force deliberately)."
fi

install -d -o symptom-tracker -g symptom-tracker -m 0750 "$(dirname "$DEST")" "$(dirname "$DEST")/backups/pre-import"
was_active=0
systemctl is-active --quiet "$SERVICE" && was_active=1
systemctl stop "$SERVICE"
restart_on_exit() { [[ "$was_active" -eq 0 ]] || systemctl start "$SERVICE" || true; }
trap restart_on_exit EXIT

if [[ -e "$DEST" ]]; then
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="$(dirname "$DEST")/backups/pre-import/symptom-tracker-$stamp.sqlite3"
  python3 - "$DEST" "$backup" <<'PY' || die "could not back up existing destination; import aborted."
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as c: c.execute("VACUUM INTO ?", (sys.argv[2],))
PY
  chown symptom-tracker:symptom-tracker "$backup"; chmod 0600 "$backup"
fi

temp="$DEST.importing.$$"
trap 'rm -f "$temp"; restart_on_exit' EXIT
install -o symptom-tracker -g symptom-tracker -m 0600 "$SOURCE" "$temp"
mv -f "$temp" "$DEST"
rm -f "$DEST-wal" "$DEST-shm"
systemctl start "$SERVICE"
was_active=0
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8011/api/auth/session >/dev/null && break
  sleep 1
done
curl -fsS http://127.0.0.1:8011/api/auth/session >/dev/null || die "service did not become healthy after import; inspect journalctl -u $SERVICE."
trap - EXIT
echo "Imported schema v$incoming_version database and verified service health."
