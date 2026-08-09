#!/usr/bin/env bash
set -euo pipefail
missing=0
for command_name in python3 curl rsync systemctl caddy getent groupadd useradd install runuser; do
  if command -v "$command_name" >/dev/null 2>&1; then printf 'ok      %s\n' "$command_name"; else printf 'missing %s\n' "$command_name"; missing=1; fi
done
python3 - <<'PY' || missing=1
import sqlite3
c=sqlite3.connect(':memory:')
assert c.execute("select sqlite_compileoption_used('ENABLE_FTS5')").fetchone()[0]
print('ok      sqlite3 with FTS5')
PY
[[ -f "${CADDYFILE:-/etc/caddy/Caddyfile}" ]] || { echo "missing Caddyfile"; missing=1; }
exit "$missing"
