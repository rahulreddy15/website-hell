#!/usr/bin/env bash
set -euo pipefail

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"

required_commands=(
  bash
  sudo
  systemctl
  python3
  curl
  rsync
  caddy
  getent
  groupadd
  useradd
  install
  id
  mkdir
  rm
  mv
  cp
  chown
  chmod
  date
)

missing=()

check_ok() {
  printf 'ok      %s\n' "$1"
}

check_missing() {
  printf 'missing %s\n' "$1"
  missing+=("$1")
}

check_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    check_ok "command: $command_name ($(command -v "$command_name"))"
  else
    check_missing "command: $command_name"
  fi
}

echo "Checking VM prerequisites for website-hell deployment"
echo "Host: $(hostname)"
echo

for command_name in "${required_commands[@]}"; do
  check_command "$command_name"
done

if command -v apt-get >/dev/null 2>&1; then
  check_ok "package manager: apt-get"
elif command -v dnf >/dev/null 2>&1; then
  check_ok "package manager: dnf"
elif command -v yum >/dev/null 2>&1; then
  check_ok "package manager: yum"
else
  check_missing "package manager: apt-get, dnf, or yum"
fi

if command -v python3 >/dev/null 2>&1; then
  if python3 - <<'PY' >/dev/null 2>&1
import sqlite3
PY
  then
    check_ok "python3 module: sqlite3"
  else
    check_missing "python3 module: sqlite3"
  fi
fi

if sudo -n true >/dev/null 2>&1; then
  check_ok "passwordless sudo for deployment user"
else
  check_missing "passwordless sudo for deployment user"
fi

if [[ -d /var/www ]]; then
  check_ok "directory: /var/www"
else
  check_missing "directory: /var/www"
fi

if [[ -d /etc/caddy ]]; then
  check_ok "directory: /etc/caddy"
else
  check_missing "directory: /etc/caddy"
fi

if [[ -f "$CADDYFILE" ]]; then
  check_ok "file: $CADDYFILE"
else
  check_missing "file: $CADDYFILE"
fi

if [[ -r "$CADDYFILE" ]]; then
  check_ok "readable: $CADDYFILE"
else
  check_missing "readable: $CADDYFILE"
fi

if [[ -f "$CADDYFILE" ]] && grep -q 'rahulreddy\.in' "$CADDYFILE"; then
  check_ok "Caddy site block references rahulreddy.in"
else
  check_missing "Caddy site block references rahulreddy.in"
fi

if command -v caddy >/dev/null 2>&1 && [[ -f "$CADDYFILE" ]]; then
  if caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
    check_ok "caddy validate --config $CADDYFILE"
  else
    check_missing "caddy validate --config $CADDYFILE"
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet caddy; then
    check_ok "systemd service: caddy active"
  else
    check_missing "systemd service: caddy active"
  fi
fi

echo
if (( ${#missing[@]} > 0 )); then
  echo "Missing or invalid VM prerequisites:"
  for item in "${missing[@]}"; do
    echo "- $item"
  done
  exit 1
fi

echo "All VM prerequisites are present."
