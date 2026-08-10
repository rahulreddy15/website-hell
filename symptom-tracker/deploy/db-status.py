#!/usr/bin/env python3
"""Read-only status summary for the deployed database.

Invoked by the Tracker Admin workflow so routine checks do not require an SSH
client. Opens the database read-only and never writes, so it is safe to run
against a live service.
"""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

DB = Path(os.environ.get("SYMPTOM_TRACKER_DB", "/var/lib/symptom-tracker/symptom_tracker.sqlite3"))

if not DB.exists():
    sys.exit(f"No database at {DB}")

conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

print(f"database      {DB} ({DB.stat().st_size / 1024:.0f} KiB)")
print(f"schema        v{conn.execute('SELECT MAX(version) FROM schema_version').fetchone()[0]}")
print(f"integrity     {conn.execute('PRAGMA quick_check').fetchone()[0]}")

print("\nrow counts")
for table in ("item", "meal", "consumption_event", "symptom_event", "day_log", "state_log", "item_attribute", "censor_window"):
    count = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    print(f"  {table:<20} {count}")

bm = conn.execute("SELECT count(*) FROM symptom_event WHERE is_bm=1").fetchone()[0]
reviewed = conn.execute("SELECT count(*) FROM item WHERE attributes_reviewed=1").fetchone()[0]
items = conn.execute("SELECT count(*) FROM item").fetchone()[0]
print("\nstudy state")
print(f"  bowel movements      {bm}")
print(f"  items reviewed       {reviewed} of {items}")

first = conn.execute("SELECT MIN(local_date) FROM meal").fetchone()[0]
last = conn.execute("SELECT MAX(local_date) FROM meal").fetchone()[0]
print(f"  logging range        {first or '-'} to {last or '-'}")

answered = conn.execute(
    "SELECT count(*) FROM day_log WHERE completeness IN ('complete','mostly')"
).fetchone()[0]
print(f"  days marked complete {answered}")
if items and reviewed == 0:
    print("\n  Note: no items reviewed yet, so all observations classify as unknown")
    print("  exposure and the analysis will correctly decline to draw conclusions.")
