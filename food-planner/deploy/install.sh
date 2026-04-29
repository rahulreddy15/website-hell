#!/usr/bin/env bash
set -euo pipefail

APP_NAME="food-planner"
APP_USER="food-planner"
APP_ROOT="/opt/food-planner"
APP_CURRENT="$APP_ROOT/current"
DATA_DIR="/var/lib/food-planner"
SERVICE_FILE="/etc/systemd/system/food-planner.service"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
MARKER_START="# BEGIN food-planner"
MARKER_END="# END food-planner"
NOLOGIN_SHELL="/usr/sbin/nologin"

if [[ ! -x "$NOLOGIN_SHELL" ]]; then
  NOLOGIN_SHELL="/sbin/nologin"
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "install.sh must be run as root" >&2
  exit 1
fi

if [[ ! -f "app.py" || ! -d "public" || ! -f "deploy/food-planner.service" ]]; then
  echo "Run install.sh from the food-planner release directory" >&2
  exit 1
fi

install_packages() {
  local missing=()
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v rsync >/dev/null 2>&1 || missing+=(rsync)
  if command -v python3 >/dev/null 2>&1 && ! python3 - <<'PY' >/dev/null 2>&1
import sqlite3
PY
  then
    missing+=(python3)
  fi

  if (( ${#missing[@]} == 0 )); then
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "${missing[@]}"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "${missing[@]}"
  else
    echo "Missing required packages: ${missing[*]}; install them manually" >&2
    exit 1
  fi
}

ensure_user_and_dirs() {
  if ! getent group "$APP_USER" >/dev/null 2>&1; then
    groupadd --system "$APP_USER"
  fi

  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_USER" --home-dir "$DATA_DIR" --shell "$NOLOGIN_SHELL" "$APP_USER"
  fi

  mkdir -p "$APP_ROOT" "$APP_CURRENT" "$DATA_DIR"
  rsync -a --delete \
    --exclude data \
    --exclude __pycache__ \
    --exclude '*.pyc' \
    ./ "$APP_CURRENT/"

  chown -R root:root "$APP_ROOT"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
  chmod 755 "$APP_ROOT" "$APP_CURRENT"
  chmod 750 "$DATA_DIR"
}

install_service() {
  install -m 0644 deploy/food-planner.service "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl enable "$APP_NAME"
  systemctl restart "$APP_NAME"
  systemctl is-active --quiet "$APP_NAME"
}

insert_snippet_in_site_block() {
  local source="$1"
  local target="$2"
  python3 - "$source" "$target" "$MARKER_START" "$MARKER_END" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
marker_start = sys.argv[3]
marker_end = sys.argv[4]
snippet = f"""    {marker_start}
    redir /food-planner /food-planner/

    handle_path /food-planner/* {{
        reverse_proxy 127.0.0.1:8010
    }}
    {marker_end}
"""

text = source.read_text()
if marker_start in text and marker_end in text:
    before = text.split(marker_start, 1)[0].rstrip()
    after = text.split(marker_end, 1)[1].lstrip("\n")
    source.write_text(f"{before}\n{snippet}\n{after}")
    sys.exit(0)

lines = text.splitlines(keepends=True)
site_start = None
brace_depth = 0
for index, line in enumerate(lines):
    stripped = line.strip()
    if site_start is None and stripped.endswith("{") and "rahulreddy.in" in stripped:
        site_start = index
        brace_depth = line.count("{") - line.count("}")
        continue
    if site_start is not None:
        brace_depth += line.count("{") - line.count("}")
        if brace_depth == 0:
            lines.insert(index, snippet)
            source.write_text("".join(lines))
            sys.exit(0)

raise SystemExit(f"Could not find a rahulreddy.in site block in {target}")
PY
}

install_caddy_route() {
  if ! command -v caddy >/dev/null 2>&1; then
    echo "Caddy is not installed or not on PATH; cannot install /food-planner route" >&2
    exit 1
  fi

  if [[ ! -f "$CADDYFILE" ]]; then
    echo "Caddyfile not found at $CADDYFILE" >&2
    exit 1
  fi

  cp "$CADDYFILE" "$CADDYFILE.food-planner.bak.$(date +%Y%m%d%H%M%S)"
  insert_snippet_in_site_block "$CADDYFILE" "$CADDYFILE"
  caddy validate --config "$CADDYFILE"

  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    caddy reload --config "$CADDYFILE"
  fi
}

verify_app() {
  curl -fsS "http://127.0.0.1:8010/api/bootstrap" >/dev/null
}

install_packages
ensure_user_and_dirs
install_service
verify_app
install_caddy_route

echo "Food Planner deployed at /food-planner"
