#!/usr/bin/env bash
set -euo pipefail
APP=symptom-tracker
ROOT=/opt/symptom-tracker
CURRENT="$ROOT/current"
DATA=/var/lib/symptom-tracker
DB="$DATA/symptom_tracker.sqlite3"
PRE_MIGRATION="$DATA/backups/pre-migration"
[[ "$EUID" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ -f app.py && -f schema.sql && -d public ]] || { echo "Run from the symptom-tracker release directory" >&2; exit 1; }
command -v python3 >/dev/null && command -v rsync >/dev/null && command -v runuser >/dev/null || { echo "python3, rsync, and runuser are required" >&2; exit 1; }
GENERATED_PASSWORD=0
if [[ ! -f /etc/symptom-tracker.env ]]; then
  # CI runs this over ssh with no TTY. An unguarded `read` hits EOF and, under set -e,
  # kills the deploy with no output at all. Prefer an explicit variable, fall back to an
  # interactive prompt only when there really is a terminal, and otherwise generate a
  # strong random password. Never ship a default or known password: this holds health data.
  if [[ -n "${SYMPTOM_TRACKER_INITIAL_PASSWORD:-}" ]]; then
    INITIAL_PASSWORD="$SYMPTOM_TRACKER_INITIAL_PASSWORD"
  elif [[ -t 0 ]]; then
    read -rsp "Initial Symptom Tracker password: " INITIAL_PASSWORD; echo
  else
    INITIAL_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
    GENERATED_PASSWORD=1
  fi
  [[ -n "$INITIAL_PASSWORD" ]] || { echo "Password cannot be empty" >&2; exit 1; }
  printf 'SYMPTOM_TRACKER_PASSWORD=%q\n' "$INITIAL_PASSWORD" > /etc/symptom-tracker.env
  chmod 0600 /etc/symptom-tracker.env
  unset INITIAL_PASSWORD
fi
getent group "$APP" >/dev/null || groupadd --system "$APP"
id "$APP" >/dev/null 2>&1 || useradd --system --gid "$APP" --home-dir "$DATA" --shell /usr/sbin/nologin "$APP"
mkdir -p "$CURRENT" "$DATA/backups" "$PRE_MIGRATION"
chown -R "$APP:$APP" "$DATA"
chmod 750 "$DATA" "$DATA/backups" "$PRE_MIGRATION"

# The running old release may still be writing in WAL mode. VACUUM INTO gives us
# one transactionally consistent file immediately before the new release migrates it.
if [[ -e "$DB" ]]; then
  echo "Creating mandatory pre-migration database snapshot..."
  if ! runuser -u "$APP" -- python3 - "$DB" "$PRE_MIGRATION" <<'PY'
import datetime as dt
import sqlite3
import sys
from pathlib import Path

database, directory = map(Path, sys.argv[1:])
stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
with sqlite3.connect(database, timeout=30) as connection:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).fetchone()
    if not row:
        raise RuntimeError("database has no schema_version table")
    version = connection.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
    if version is None:
        raise RuntimeError("database has no recorded schema version")
    target = directory / f"symptom-tracker-{stamp}-schema-v{int(version)}.sqlite3"
    connection.execute("VACUUM INTO ?", (str(target),))
snapshots = sorted(directory.glob("symptom-tracker-*-schema-v*.sqlite3"))
for old in snapshots[:-10]:
    old.unlink()
print(target)
PY
  then
    echo "ERROR: pre-migration snapshot failed; deployment aborted before migration." >&2
    exit 1
  fi
else
  echo "No existing database; skipping pre-migration snapshot on first install."
fi

rsync -a --delete --exclude data --exclude __pycache__ --exclude '*.pyc' ./ "$CURRENT/"
chown -R root:root "$ROOT"; chown -R "$APP:$APP" "$DATA"; chmod 750 "$DATA" "$DATA/backups" "$PRE_MIGRATION"
install -m 0644 deploy/symptom-tracker.service /etc/systemd/system/
install -m 0644 deploy/symptom-tracker-backup.service deploy/symptom-tracker-backup.timer /etc/systemd/system/
install -m 0644 deploy/symptom-tracker-restic-backup.service deploy/symptom-tracker-restic-backup.timer /etc/systemd/system/
chmod 0755 "$CURRENT/deploy/backup.py" "$CURRENT/deploy/restic-backup.sh" "$CURRENT/deploy/migrate-local-db.sh"
systemctl daemon-reload
systemctl enable symptom-tracker.service symptom-tracker-backup.timer
systemctl restart symptom-tracker.service
systemctl start symptom-tracker-backup.timer
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8011/api/auth/session" >/dev/null; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:8011/api/auth/session" >/dev/null || { systemctl status symptom-tracker.service --no-pager; exit 1; }
echo "Install deploy/caddy-symptom-tracker.caddy inside the TLS site block, then reload Caddy."
echo "Data remains in $DATA across rsync deployments."
if [[ "$GENERATED_PASSWORD" -eq 1 ]]; then
  echo
  echo "No password existed, so one was generated. Retrieve it on the VM with:"
  echo "  sudo cat /etc/symptom-tracker.env"
  echo "Then change it with:"
  echo "  cd $CURRENT && sudo -u $APP SYMPTOM_TRACKER_DB=$DB python3 app.py --set-password"
  echo "It is deliberately not printed here: CI logs are not a place for credentials."
fi
