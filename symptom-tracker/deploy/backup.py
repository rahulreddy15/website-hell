#!/usr/bin/env python3
"""Create a consistent nightly VACUUM INTO snapshot and retain 30 copies."""
import datetime as dt
import sqlite3
from pathlib import Path

root=Path("/var/lib/symptom-tracker"); backups=root/"backups"; backups.mkdir(mode=0o700,exist_ok=True)
stamp=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
target=backups/f"symptom-tracker-{stamp}.sqlite3"
with sqlite3.connect(root/"symptom_tracker.sqlite3") as conn:
    conn.execute("VACUUM INTO ?",(str(target),))
# This non-recursive glob deliberately cannot age out backups/pre-migration/.
for old in sorted(backups.glob("symptom-tracker-*.sqlite3"))[:-30]: old.unlink()
