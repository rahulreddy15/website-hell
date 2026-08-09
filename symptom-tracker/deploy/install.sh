#!/usr/bin/env bash
set -euo pipefail
APP=symptom-tracker
ROOT=/opt/symptom-tracker
CURRENT="$ROOT/current"
DATA=/var/lib/symptom-tracker
[[ "$EUID" -eq 0 ]] || { echo "Run as root" >&2; exit 1; }
[[ -f app.py && -f schema.sql && -d public ]] || { echo "Run from the symptom-tracker release directory" >&2; exit 1; }
command -v python3 >/dev/null && command -v rsync >/dev/null || { echo "python3 and rsync are required" >&2; exit 1; }
if [[ ! -f /etc/symptom-tracker.env ]]; then
  read -rsp "Initial Symptom Tracker password: " INITIAL_PASSWORD; echo
  [[ -n "$INITIAL_PASSWORD" ]] || { echo "Password cannot be empty" >&2; exit 1; }
  printf 'SYMPTOM_TRACKER_PASSWORD=%q\n' "$INITIAL_PASSWORD" > /etc/symptom-tracker.env
  chmod 0600 /etc/symptom-tracker.env
  unset INITIAL_PASSWORD
fi
getent group "$APP" >/dev/null || groupadd --system "$APP"
id "$APP" >/dev/null 2>&1 || useradd --system --gid "$APP" --home-dir "$DATA" --shell /usr/sbin/nologin "$APP"
mkdir -p "$CURRENT" "$DATA/backups"
rsync -a --delete --exclude data --exclude __pycache__ --exclude '*.pyc' ./ "$CURRENT/"
chown -R root:root "$ROOT"; chown -R "$APP:$APP" "$DATA"; chmod 750 "$DATA" "$DATA/backups"
install -m 0644 deploy/symptom-tracker.service /etc/systemd/system/
install -m 0644 deploy/symptom-tracker-backup.service deploy/symptom-tracker-backup.timer /etc/systemd/system/
chmod 0755 "$CURRENT/deploy/backup.py"
systemctl daemon-reload
systemctl enable --now symptom-tracker.service symptom-tracker-backup.timer
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8011/api/auth/session" >/dev/null; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:8011/api/auth/session" >/dev/null || { systemctl status symptom-tracker.service --no-pager; exit 1; }
echo "Install deploy/caddy-symptom-tracker.caddy inside the TLS site block, then reload Caddy."
echo "Data remains in $DATA across rsync deployments."
