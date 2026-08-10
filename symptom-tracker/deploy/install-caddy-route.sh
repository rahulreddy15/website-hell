#!/usr/bin/env bash
set -euo pipefail

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
SNIPPET_FILE="${1:-deploy/caddy-symptom-tracker.caddy}"
MARKER_START="# BEGIN symptom-tracker"
MARKER_END="# END symptom-tracker"

insert_snippet_in_site_block() {
  local source="$1"
  local target="$2"
  local snippet_file="$3"
  python3 - "$source" "$target" "$snippet_file" "$MARKER_START" "$MARKER_END" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

source = Path(sys.argv[1])
target = Path(sys.argv[2])
snippet_file = Path(sys.argv[3])
marker_start = sys.argv[4]
marker_end = sys.argv[5]

body_lines = [line for line in snippet_file.read_text().splitlines()
              if not line.lstrip().startswith("# Insert inside")]
body = "\n".join(f"    {line}" if line else "" for line in body_lines)
snippet = f"    {marker_start}\n{body}\n    {marker_end}\n"

text = source.read_text()
start_count = text.count(marker_start)
end_count = text.count(marker_end)
if start_count or end_count:
    if start_count != 1 or end_count != 1 or text.index(marker_start) > text.index(marker_end):
        raise SystemExit(f"Malformed or duplicate symptom-tracker markers in {target}")
    before, remainder = text.split(marker_start, 1)
    _, after = remainder.split(marker_end, 1)
    source.write_text(f"{before.rstrip()}\n{snippet}{after.lstrip(chr(10))}")
    raise SystemExit(0)

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
            raise SystemExit(0)

raise SystemExit(f"Could not find a rahulreddy.in site block in {target}")
PY
}

install_caddy_route() {
  if ! command -v caddy >/dev/null 2>&1; then
    echo "WARNING: Caddy is not installed or not on PATH; /tracker route was not installed." >&2
    return 0
  fi
  if [[ ! -f "$CADDYFILE" ]]; then
    echo "WARNING: Caddyfile not found at $CADDYFILE; /tracker route was not installed." >&2
    return 0
  fi
  if [[ ! -f "$SNIPPET_FILE" ]]; then
    echo "ERROR: Symptom Tracker Caddy snippet not found at $SNIPPET_FILE." >&2
    return 1
  fi

  local backup="$CADDYFILE.symptom-tracker.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$CADDYFILE" "$backup"
  if ! insert_snippet_in_site_block "$CADDYFILE" "$CADDYFILE" "$SNIPPET_FILE"; then
    cp -p "$backup" "$CADDYFILE"
    echo "ERROR: Could not install /tracker route; restored $CADDYFILE from $backup." >&2
    return 1
  fi
  if ! caddy validate --config "$CADDYFILE"; then
    cp -p "$backup" "$CADDYFILE"
    echo "ERROR: Caddy validation failed; restored the original Caddyfile from $backup. Deployment aborted." >&2
    return 1
  fi

  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    caddy reload --config "$CADDYFILE"
  fi
}

install_caddy_route
