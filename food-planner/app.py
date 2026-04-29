#!/usr/bin/env python3
"""Meal planning app: static frontend plus a small SQLite JSON API."""

from __future__ import annotations

import datetime as dt
import json
import mimetypes
import os
import re
import sqlite3
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = BASE_DIR / "data"
DB_PATH = Path(os.environ.get("MEAL_PLANNER_DB", DATA_DIR / "meal_planner.sqlite3"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
BASE_PATH = os.environ.get("BASE_PATH", "/food-planner").rstrip("/")

MEAL_TYPES = ["Breakfast", "Lunch", "Dinner", "Snack"]
SLOTS = ["Breakfast", "Lunch", "Dinner"]
EFFORTS = ["Quick", "Medium", "Project"]
PREP_OPTIONS = ["None", "Soak overnight", "Marinate", "Defrost morning of"]
CATEGORIES = ["Produce", "Dairy", "Grains & Pulses", "Proteins", "Pantry", "Other"]


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def json_list(value: object) -> str:
    return json.dumps(value or [], separators=(",", ":"))


def parse_json_list(raw: object) -> list:
    if not raw:
        return []
    if isinstance(raw, list):
        return raw
    try:
        value = json.loads(str(raw))
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def split_list(value: object) -> list[str]:
    if isinstance(value, list):
        items = value
    else:
        items = re.split(r"[\n,]+", str(value or ""))
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = str(item).strip()
        key = text.casefold()
        if text and key not in seen:
            cleaned.append(text)
            seen.add(key)
    return cleaned


def ingredient_key(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9& ]+", " ", name.casefold())).strip()


def default_week_start() -> str:
    today = dt.date.today()
    if today.weekday() == 6:  # On Sunday, default to planning the week ahead.
        start = today + dt.timedelta(days=1)
    else:
        start = today - dt.timedelta(days=today.weekday())
    return start.isoformat()


def week_end(start_date: str) -> str:
    return (dt.date.fromisoformat(start_date) + dt.timedelta(days=6)).isoformat()


def ensure_schema() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meals (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                meal_types_json TEXT NOT NULL DEFAULT '[]',
                effort TEXT NOT NULL DEFAULT 'Quick',
                ingredients_json TEXT NOT NULL DEFAULT '[]',
                prep_needed TEXT NOT NULL DEFAULT 'None',
                notes TEXT NOT NULL DEFAULT '',
                tags_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS weeks (
                id TEXT PRIMARY KEY,
                start_date TEXT NOT NULL UNIQUE,
                pantry_notes TEXT NOT NULL DEFAULT '',
                archived_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS planned_meals (
                id TEXT PRIMARY KEY,
                week_id TEXT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
                day_index INTEGER NOT NULL,
                slot TEXT NOT NULL,
                mode TEXT NOT NULL,
                meal_id TEXT REFERENCES meals(id) ON DELETE SET NULL,
                meal_label TEXT NOT NULL DEFAULT '',
                split_a_meal_id TEXT REFERENCES meals(id) ON DELETE SET NULL,
                split_a_label TEXT NOT NULL DEFAULT '',
                split_b_meal_id TEXT REFERENCES meals(id) ON DELETE SET NULL,
                split_b_label TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(week_id, day_index, slot)
            );

            CREATE TABLE IF NOT EXISTS shopping_items (
                id TEXT PRIMARY KEY,
                week_id TEXT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'Other',
                source TEXT NOT NULL DEFAULT 'custom',
                checked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meal_verdicts (
                id TEXT PRIMARY KEY,
                week_id TEXT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
                meal_id TEXT REFERENCES meals(id) ON DELETE SET NULL,
                label TEXT NOT NULL,
                day_index INTEGER NOT NULL,
                slot TEXT NOT NULL,
                side TEXT NOT NULL DEFAULT '',
                verdict TEXT NOT NULL DEFAULT 'again',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        count = conn.execute("SELECT COUNT(*) FROM meals").fetchone()[0]
        if count == 0:
            seed_meals(conn)
        get_or_create_current_week(conn)


def row_to_meal(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "meal_types": parse_json_list(row["meal_types_json"]),
        "effort": row["effort"],
        "ingredients": parse_json_list(row["ingredients_json"]),
        "prep_needed": row["prep_needed"],
        "notes": row["notes"],
        "tags": parse_json_list(row["tags_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def row_to_cell(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "week_id": row["week_id"],
        "day_index": row["day_index"],
        "slot": row["slot"],
        "mode": row["mode"],
        "meal_id": row["meal_id"],
        "meal_label": row["meal_label"],
        "split_a_meal_id": row["split_a_meal_id"],
        "split_a_label": row["split_a_label"],
        "split_b_meal_id": row["split_b_meal_id"],
        "split_b_label": row["split_b_label"],
    }


def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def create_week(conn: sqlite3.Connection, start_date: str) -> sqlite3.Row:
    existing = conn.execute("SELECT * FROM weeks WHERE start_date = ?", (start_date,)).fetchone()
    if existing:
        return existing
    stamp = now_iso()
    week_id = new_id()
    conn.execute(
        "INSERT INTO weeks(id, start_date, pantry_notes, created_at, updated_at) VALUES(?, ?, '', ?, ?)",
        (week_id, start_date, stamp, stamp),
    )
    return conn.execute("SELECT * FROM weeks WHERE id = ?", (week_id,)).fetchone()


def get_or_create_current_week(conn: sqlite3.Connection) -> sqlite3.Row:
    current_id = get_setting(conn, "current_week_id")
    if current_id:
        row = conn.execute("SELECT * FROM weeks WHERE id = ?", (current_id,)).fetchone()
        if row:
            return row

    row = conn.execute(
        "SELECT * FROM weeks WHERE archived_at IS NULL ORDER BY start_date DESC LIMIT 1"
    ).fetchone()
    if not row:
        row = create_week(conn, default_week_start())
    set_setting(conn, "current_week_id", row["id"])
    return row


def get_week_payload(conn: sqlite3.Connection, week_id: str | None = None) -> dict:
    row = get_or_create_current_week(conn) if not week_id else conn.execute(
        "SELECT * FROM weeks WHERE id = ?", (week_id,)
    ).fetchone()
    if not row:
        raise ValueError("Week not found")
    cells = [
        row_to_cell(cell)
        for cell in conn.execute(
            "SELECT * FROM planned_meals WHERE week_id = ? ORDER BY day_index, slot", (row["id"],)
        )
    ]
    return {
        "id": row["id"],
        "start_date": row["start_date"],
        "end_date": week_end(row["start_date"]),
        "pantry_notes": row["pantry_notes"],
        "archived_at": row["archived_at"],
        "cells": cells,
    }


def list_meals(conn: sqlite3.Connection) -> list[dict]:
    return [row_to_meal(row) for row in conn.execute("SELECT * FROM meals ORDER BY name COLLATE NOCASE")]


def validate_meal(payload: dict) -> dict:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValueError("Meal name is required")

    meal_types = [item for item in split_list(payload.get("meal_types")) if item in MEAL_TYPES]
    if not meal_types:
        raise ValueError("Choose at least one meal type")

    effort = str(payload.get("effort", "Quick")).strip()
    if effort not in EFFORTS:
        effort = "Quick"

    ingredients = split_list(payload.get("ingredients"))
    if not ingredients:
        raise ValueError("Add at least one ingredient")

    prep_needed = str(payload.get("prep_needed", "None")).strip() or "None"
    notes = str(payload.get("notes", "")).strip()
    tags = split_list(payload.get("tags"))
    return {
        "name": name,
        "meal_types": meal_types,
        "effort": effort,
        "ingredients": ingredients,
        "prep_needed": prep_needed,
        "notes": notes,
        "tags": tags,
    }


def insert_meal(conn: sqlite3.Connection, payload: dict) -> dict:
    meal = validate_meal(payload)
    stamp = now_iso()
    meal_id = payload.get("id") or new_id()
    conn.execute(
        """
        INSERT INTO meals(id, name, meal_types_json, effort, ingredients_json, prep_needed, notes, tags_json, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            meal_id,
            meal["name"],
            json_list(meal["meal_types"]),
            meal["effort"],
            json_list(meal["ingredients"]),
            meal["prep_needed"],
            meal["notes"],
            json_list(meal["tags"]),
            stamp,
            stamp,
        ),
    )
    return row_to_meal(conn.execute("SELECT * FROM meals WHERE id = ?", (meal_id,)).fetchone())


def update_meal(conn: sqlite3.Connection, meal_id: str, payload: dict) -> dict:
    if not conn.execute("SELECT id FROM meals WHERE id = ?", (meal_id,)).fetchone():
        raise ValueError("Meal not found")
    meal = validate_meal(payload)
    conn.execute(
        """
        UPDATE meals
        SET name = ?, meal_types_json = ?, effort = ?, ingredients_json = ?, prep_needed = ?, notes = ?, tags_json = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            meal["name"],
            json_list(meal["meal_types"]),
            meal["effort"],
            json_list(meal["ingredients"]),
            meal["prep_needed"],
            meal["notes"],
            json_list(meal["tags"]),
            now_iso(),
            meal_id,
        ),
    )
    conn.execute("UPDATE planned_meals SET meal_label = ? WHERE meal_id = ?", (meal["name"], meal_id))
    conn.execute("UPDATE planned_meals SET split_a_label = ? WHERE split_a_meal_id = ?", (meal["name"], meal_id))
    conn.execute("UPDATE planned_meals SET split_b_label = ? WHERE split_b_meal_id = ?", (meal["name"], meal_id))
    return row_to_meal(conn.execute("SELECT * FROM meals WHERE id = ?", (meal_id,)).fetchone())


def get_meal_name(conn: sqlite3.Connection, meal_id: str | None) -> str:
    if not meal_id:
        return ""
    row = conn.execute("SELECT name FROM meals WHERE id = ?", (meal_id,)).fetchone()
    return row["name"] if row else ""


def upsert_cell(conn: sqlite3.Connection, week_id: str, payload: dict) -> dict:
    if not conn.execute("SELECT id FROM weeks WHERE id = ?", (week_id,)).fetchone():
        raise ValueError("Week not found")
    day_index = int(payload.get("day_index", -1))
    slot = str(payload.get("slot", ""))
    if day_index < 0 or day_index > 6 or slot not in SLOTS:
        raise ValueError("Invalid planner cell")

    mode = str(payload.get("mode", "empty"))
    if mode == "empty":
        conn.execute(
            "DELETE FROM planned_meals WHERE week_id = ? AND day_index = ? AND slot = ?",
            (week_id, day_index, slot),
        )
        return {"day_index": day_index, "slot": slot, "mode": "empty"}

    meal_id = payload.get("meal_id") or None
    split_a_meal_id = payload.get("split_a_meal_id") or None
    split_b_meal_id = payload.get("split_b_meal_id") or None
    meal_label = str(payload.get("meal_label") or get_meal_name(conn, meal_id)).strip()
    split_a_label = str(payload.get("split_a_label") or get_meal_name(conn, split_a_meal_id)).strip()
    split_b_label = str(payload.get("split_b_label") or get_meal_name(conn, split_b_meal_id)).strip()

    if mode == "meal":
        if not meal_id and not meal_label:
            raise ValueError("Choose a meal")
        split_a_meal_id = split_b_meal_id = None
        split_a_label = split_b_label = ""
    elif mode == "split":
        if not (split_a_label or split_a_meal_id) or not (split_b_label or split_b_meal_id):
            raise ValueError("Choose both split meals")
        meal_id = None
        meal_label = ""
    else:
        raise ValueError("Invalid planner mode")

    stamp = now_iso()
    existing = conn.execute(
        "SELECT id FROM planned_meals WHERE week_id = ? AND day_index = ? AND slot = ?",
        (week_id, day_index, slot),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE planned_meals
            SET mode = ?, meal_id = ?, meal_label = ?, split_a_meal_id = ?, split_a_label = ?, split_b_meal_id = ?, split_b_label = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                mode,
                meal_id,
                meal_label,
                split_a_meal_id,
                split_a_label,
                split_b_meal_id,
                split_b_label,
                stamp,
                existing["id"],
            ),
        )
        cell_id = existing["id"]
    else:
        cell_id = new_id()
        conn.execute(
            """
            INSERT INTO planned_meals(id, week_id, day_index, slot, mode, meal_id, meal_label, split_a_meal_id, split_a_label, split_b_meal_id, split_b_label, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cell_id,
                week_id,
                day_index,
                slot,
                mode,
                meal_id,
                meal_label,
                split_a_meal_id,
                split_a_label,
                split_b_meal_id,
                split_b_label,
                stamp,
                stamp,
            ),
        )
    return row_to_cell(conn.execute("SELECT * FROM planned_meals WHERE id = ?", (cell_id,)).fetchone())


def categorize_ingredient(name: str) -> str:
    n = ingredient_key(name)
    keyword_groups = {
        "Produce": [
            "avocado",
            "banana",
            "berries",
            "broccoli",
            "cabbage",
            "capsicum",
            "carrot",
            "cauliflower",
            "cucumber",
            "eggplant",
            "greens",
            "herbs",
            "kale",
            "lemon",
            "lime",
            "mint",
            "okra",
            "onion",
            "parsley",
            "pepper",
            "potato",
            "salad",
            "spinach",
            "tomato",
            "vegetables",
            "zucchini",
        ],
        "Dairy": ["butter", "cheese", "feta", "ghee", "milk", "paneer", "raita", "yogurt"],
        "Grains & Pulses": [
            "beans",
            "besan",
            "brown rice",
            "chana",
            "chickpea",
            "dal",
            "dalia",
            "lentil",
            "millet",
            "moong",
            "oats",
            "quinoa",
            "rajma",
            "rice",
            "roti",
            "sprouts",
        ],
        "Proteins": ["chicken", "egg", "fish", "salmon", "shrimp", "tofu", "turkey"],
        "Pantry": [
            "almond",
            "chia",
            "chutney",
            "coconut",
            "cumin",
            "flax",
            "hummus",
            "masala",
            "mustard",
            "oil",
            "olive",
            "peanut",
            "pickle",
            "seed",
            "spice",
            "tahini",
            "turmeric",
            "walnut",
        ],
    }
    for category, keywords in keyword_groups.items():
        if any(keyword in n for keyword in keywords):
            return category
    return "Other"


def collect_week_ingredients(conn: sqlite3.Connection, week_id: str) -> list[str]:
    ids: list[str] = []
    for cell in conn.execute("SELECT * FROM planned_meals WHERE week_id = ?", (week_id,)):
        if cell["mode"] == "meal" and cell["meal_id"]:
            ids.append(cell["meal_id"])
        elif cell["mode"] == "split":
            if cell["split_a_meal_id"]:
                ids.append(cell["split_a_meal_id"])
            if cell["split_b_meal_id"]:
                ids.append(cell["split_b_meal_id"])

    ingredients: list[str] = []
    seen: set[str] = set()
    for meal_id in ids:
        row = conn.execute("SELECT ingredients_json FROM meals WHERE id = ?", (meal_id,)).fetchone()
        if not row:
            continue
        for ingredient in parse_json_list(row["ingredients_json"]):
            text = str(ingredient).strip()
            key = ingredient_key(text)
            if text and key and key not in seen:
                ingredients.append(text)
                seen.add(key)
    return ingredients


def row_to_shopping_item(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "week_id": row["week_id"],
        "name": row["name"],
        "category": row["category"],
        "source": row["source"],
        "checked": bool(row["checked"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def list_shopping_items(conn: sqlite3.Connection, week_id: str) -> list[dict]:
    return [
        row_to_shopping_item(row)
        for row in conn.execute(
            "SELECT * FROM shopping_items WHERE week_id = ? ORDER BY category, checked, name COLLATE NOCASE",
            (week_id,),
        )
    ]


def generate_shopping(conn: sqlite3.Connection, week_id: str) -> list[dict]:
    if not conn.execute("SELECT id FROM weeks WHERE id = ?", (week_id,)).fetchone():
        raise ValueError("Week not found")
    desired = collect_week_ingredients(conn, week_id)
    desired_keys = {ingredient_key(item) for item in desired}
    existing_rows = list(conn.execute("SELECT * FROM shopping_items WHERE week_id = ?", (week_id,)))
    by_key = {ingredient_key(row["name"]): row for row in existing_rows}
    stamp = now_iso()

    for name in desired:
        key = ingredient_key(name)
        if not key or key in by_key:
            continue
        conn.execute(
            "INSERT INTO shopping_items(id, week_id, name, category, source, checked, created_at, updated_at) VALUES(?, ?, ?, ?, 'generated', 0, ?, ?)",
            (new_id(), week_id, name, categorize_ingredient(name), stamp, stamp),
        )

    for row in existing_rows:
        key = ingredient_key(row["name"])
        if row["source"] == "generated" and key not in desired_keys:
            conn.execute("DELETE FROM shopping_items WHERE id = ?", (row["id"],))
    return list_shopping_items(conn, week_id)


def planned_occurrences(conn: sqlite3.Connection, week_id: str) -> list[dict]:
    occurrences: list[dict] = []
    for cell in conn.execute(
        "SELECT * FROM planned_meals WHERE week_id = ? ORDER BY day_index, slot", (week_id,)
    ):
        if cell["mode"] == "meal":
            label = cell["meal_label"] or get_meal_name(conn, cell["meal_id"])
            if label:
                occurrences.append(
                    {
                        "meal_id": cell["meal_id"],
                        "label": label,
                        "day_index": cell["day_index"],
                        "slot": cell["slot"],
                        "side": "",
                    }
                )
        elif cell["mode"] == "split":
            for side, id_field, label_field in [
                ("A", "split_a_meal_id", "split_a_label"),
                ("B", "split_b_meal_id", "split_b_label"),
            ]:
                label = cell[label_field] or get_meal_name(conn, cell[id_field])
                if label:
                    occurrences.append(
                        {
                            "meal_id": cell[id_field],
                            "label": label,
                            "day_index": cell["day_index"],
                            "slot": cell["slot"],
                            "side": side,
                        }
                    )
    return occurrences


def archive_week(conn: sqlite3.Connection, week_id: str, verdicts: list[dict] | None) -> dict:
    row = conn.execute("SELECT * FROM weeks WHERE id = ?", (week_id,)).fetchone()
    if not row:
        raise ValueError("Week not found")

    if verdicts is None:
        verdicts = [dict(item, verdict="again") for item in planned_occurrences(conn, week_id)]

    conn.execute("DELETE FROM meal_verdicts WHERE week_id = ?", (week_id,))
    stamp = now_iso()
    for item in verdicts:
        label = str(item.get("label", "")).strip()
        if not label:
            continue
        verdict = str(item.get("verdict", "again"))
        if verdict not in ["love", "no", "again"]:
            verdict = "again"
        conn.execute(
            """
            INSERT INTO meal_verdicts(id, week_id, meal_id, label, day_index, slot, side, verdict, created_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                new_id(),
                week_id,
                item.get("meal_id") or None,
                label,
                int(item.get("day_index", 0)),
                str(item.get("slot", "")),
                str(item.get("side", "")),
                verdict,
                stamp,
            ),
        )
    conn.execute("UPDATE weeks SET archived_at = ?, updated_at = ? WHERE id = ?", (stamp, stamp, week_id))
    next_start = (dt.date.fromisoformat(row["start_date"]) + dt.timedelta(days=7)).isoformat()
    next_week = create_week(conn, next_start)
    set_setting(conn, "current_week_id", next_week["id"])
    return get_week_payload(conn, next_week["id"])


def archive_payload(conn: sqlite3.Connection) -> dict:
    weeks = []
    for week in conn.execute("SELECT * FROM weeks WHERE archived_at IS NOT NULL ORDER BY start_date DESC"):
        entries = [
            {
                "id": row["id"],
                "week_id": row["week_id"],
                "meal_id": row["meal_id"],
                "label": row["label"],
                "day_index": row["day_index"],
                "slot": row["slot"],
                "side": row["side"],
                "verdict": row["verdict"],
            }
            for row in conn.execute(
                "SELECT * FROM meal_verdicts WHERE week_id = ? ORDER BY day_index, slot, side", (week["id"],)
            )
        ]
        weeks.append(
            {
                "id": week["id"],
                "start_date": week["start_date"],
                "end_date": week_end(week["start_date"]),
                "pantry_notes": week["pantry_notes"],
                "archived_at": week["archived_at"],
                "entries": entries,
            }
        )

    stats = [
        {
            "meal_id": row["meal_id"],
            "label": row["label"],
            "total": row["total"],
            "love": row["love"],
            "no": row["no"],
            "again": row["again"],
            "last_eaten": row["last_eaten"],
        }
        for row in conn.execute(
            """
            SELECT
                meal_id,
                label,
                COUNT(*) AS total,
                SUM(CASE WHEN verdict = 'love' THEN 1 ELSE 0 END) AS love,
                SUM(CASE WHEN verdict = 'no' THEN 1 ELSE 0 END) AS no,
                SUM(CASE WHEN verdict = 'again' THEN 1 ELSE 0 END) AS again,
                MAX(weeks.start_date) AS last_eaten
            FROM meal_verdicts
            JOIN weeks ON weeks.id = meal_verdicts.week_id
            GROUP BY COALESCE(meal_id, label), label
            ORDER BY total DESC, label COLLATE NOCASE
            """
        )
    ]
    return {"weeks": weeks, "stats": stats}


def export_payload(conn: sqlite3.Connection) -> dict:
    tables = {}
    for table in ["meals", "weeks", "planned_meals", "shopping_items", "meal_verdicts", "settings"]:
        tables[table] = [dict(row) for row in conn.execute(f"SELECT * FROM {table}")]
    return {"version": 1, "exported_at": now_iso(), "tables": tables}


def import_payload(conn: sqlite3.Connection, payload: dict) -> dict:
    tables = payload.get("tables") if isinstance(payload, dict) else None
    if not isinstance(tables, dict):
        raise ValueError("Import file must contain a tables object")
    allowed_tables = ["meals", "weeks", "planned_meals", "shopping_items", "meal_verdicts", "settings"]
    columns = {
        table: [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]
        for table in allowed_tables
    }
    conn.execute("PRAGMA defer_foreign_keys = ON")
    for table in ["meal_verdicts", "shopping_items", "planned_meals", "weeks", "meals", "settings"]:
        conn.execute(f"DELETE FROM {table}")
    for table in allowed_tables:
        rows = tables.get(table, [])
        if not isinstance(rows, list):
            raise ValueError(f"Table {table} must be a list")
        for row in rows:
            if not isinstance(row, dict):
                continue
            keys = [key for key in columns[table] if key in row]
            if not keys:
                continue
            placeholders = ",".join(["?"] * len(keys))
            conn.execute(
                f"INSERT INTO {table}({','.join(keys)}) VALUES({placeholders})",
                [row[key] for key in keys],
            )
    if not conn.execute("SELECT id FROM meals LIMIT 1").fetchone():
        seed_meals(conn)
    week = get_or_create_current_week(conn)
    set_setting(conn, "current_week_id", week["id"])
    return {"ok": True}


def seed_meals(conn: sqlite3.Connection) -> None:
    starters = [
        {
            "name": "Moong dal + brown basmati + cucumber kachumber",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Medium",
            "ingredients": ["moong dal", "brown basmati rice", "cucumber", "tomato", "red onion", "lemon", "cilantro", "cumin", "turmeric"],
            "prep_needed": "Soak overnight",
            "notes": "Soak dal if you want it extra quick; works well as leftovers.",
            "tags": ["Indian", "veg", "high-fiber", "comfort food"],
        },
        {
            "name": "Chickpea Greek salad bowls",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Quick",
            "ingredients": ["chickpeas", "cucumber", "tomato", "red onion", "feta", "olives", "mixed greens", "olive oil", "lemon"],
            "prep_needed": "None",
            "notes": "Use canned chickpeas for a 15-minute meal; add quinoa if hungrier.",
            "tags": ["Mediterranean", "veg", "no-cook", "high-protein"],
        },
        {
            "name": "Palak tofu + millet roti",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Project",
            "ingredients": ["spinach", "tofu", "onion", "tomato", "ginger", "garlic", "millet flour", "yogurt", "garam masala"],
            "prep_needed": "Other: press tofu 20 minutes",
            "notes": "Paneer also works; tofu keeps it lighter.",
            "tags": ["Indian", "veg", "high-protein", "greens"],
        },
        {
            "name": "Masoor dal soup + roasted vegetables",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Medium",
            "ingredients": ["masoor dal", "carrot", "zucchini", "broccoli", "onion", "tomato", "lemon", "olive oil", "cumin"],
            "prep_needed": "None",
            "notes": "Make it soupier than dal and roast whatever vegetables need using up.",
            "tags": ["Indian", "Mediterranean", "veg", "use-up"],
        },
        {
            "name": "Grilled salmon + quinoa tabbouleh",
            "meal_types": ["Dinner"],
            "effort": "Medium",
            "ingredients": ["salmon", "quinoa", "parsley", "cucumber", "tomato", "lemon", "olive oil", "garlic", "mixed greens"],
            "prep_needed": "Defrost morning of",
            "notes": "Good Sunday or Monday dinner when fish is fresh.",
            "tags": ["Mediterranean", "fish", "high-protein", "omega-3"],
        },
        {
            "name": "Egg bhurji + avocado + whole-grain toast",
            "meal_types": ["Breakfast", "Lunch"],
            "effort": "Quick",
            "ingredients": ["eggs", "onion", "tomato", "spinach", "avocado", "whole-grain bread", "cilantro", "turmeric"],
            "prep_needed": "None",
            "notes": "Skip toast or use one slice if keeping refined carbs low.",
            "tags": ["Indian", "eggs", "quick", "high-protein"],
        },
        {
            "name": "Besan chilla + mint yogurt",
            "meal_types": ["Breakfast", "Lunch", "Snack"],
            "effort": "Quick",
            "ingredients": ["besan", "spinach", "onion", "green chili", "yogurt", "mint", "cucumber", "cumin"],
            "prep_needed": "None",
            "notes": "Add grated zucchini or carrots if they need using up.",
            "tags": ["Indian", "veg", "quick", "gluten-free"],
        },
        {
            "name": "Adai dosa + coconut chutney",
            "meal_types": ["Breakfast", "Dinner"],
            "effort": "Project",
            "ingredients": ["toor dal", "chana dal", "urad dal", "brown rice", "coconut", "curry leaves", "mustard seeds", "ginger"],
            "prep_needed": "Soak overnight",
            "notes": "Make extra batter for one breakfast and one dinner.",
            "tags": ["South Indian", "veg", "high-protein", "batch"],
        },
        {
            "name": "Chicken kebab lettuce bowls",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Medium",
            "ingredients": ["chicken", "romaine lettuce", "cucumber", "tomato", "red onion", "yogurt", "lemon", "garlic", "tandoori masala"],
            "prep_needed": "Marinate",
            "notes": "Serve with a small scoop of quinoa or hummus if needed.",
            "tags": ["Indian", "Mediterranean", "chicken", "low-carb"],
        },
        {
            "name": "Rajma + cauliflower rice + crunchy salad",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Project",
            "ingredients": ["rajma", "cauliflower rice", "onion", "tomato", "cucumber", "carrot", "lemon", "garam masala"],
            "prep_needed": "Soak overnight",
            "notes": "A lighter rajma night without a large rice portion.",
            "tags": ["Indian", "veg", "legumes", "comfort food"],
        },
        {
            "name": "Paneer tikka salad",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Medium",
            "ingredients": ["paneer", "yogurt", "mixed greens", "cucumber", "capsicum", "red onion", "lemon", "mint", "tikka masala"],
            "prep_needed": "Marinate",
            "notes": "Grill or air-fry paneer; add chickpeas to stretch it.",
            "tags": ["Indian", "veg", "high-protein", "salad"],
        },
        {
            "name": "Mediterranean lentil soup",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Medium",
            "ingredients": ["green lentils", "carrot", "celery", "onion", "tomato", "spinach", "olive oil", "lemon", "bay leaf"],
            "prep_needed": "None",
            "notes": "Freezes well; finish with lemon and olive oil.",
            "tags": ["Mediterranean", "veg", "batch", "high-fiber"],
        },
        {
            "name": "Vegetable oats upma",
            "meal_types": ["Breakfast", "Lunch"],
            "effort": "Quick",
            "ingredients": ["rolled oats", "carrot", "peas", "onion", "ginger", "curry leaves", "mustard seeds", "peanuts", "lemon"],
            "prep_needed": "None",
            "notes": "Toast oats first for better texture.",
            "tags": ["Indian", "veg", "quick", "high-fiber"],
        },
        {
            "name": "Greek yogurt bowl with berries and chia",
            "meal_types": ["Breakfast", "Snack"],
            "effort": "Quick",
            "ingredients": ["Greek yogurt", "berries", "chia seeds", "walnuts", "cinnamon", "flax seeds"],
            "prep_needed": "None",
            "notes": "Add a small drizzle of honey only if needed.",
            "tags": ["Mediterranean", "vegetarian", "quick", "high-protein"],
        },
        {
            "name": "Hummus vegetable snack plate",
            "meal_types": ["Snack", "Lunch"],
            "effort": "Quick",
            "ingredients": ["hummus", "cucumber", "carrot", "capsicum", "cherry tomatoes", "olives", "whole-grain pita"],
            "prep_needed": "None",
            "notes": "Use pita sparingly; mostly vegetables and hummus.",
            "tags": ["Mediterranean", "veg", "no-cook", "snack"],
        },
        {
            "name": "Sprouted moong chaat",
            "meal_types": ["Breakfast", "Snack", "Lunch"],
            "effort": "Quick",
            "ingredients": ["sprouted moong", "cucumber", "tomato", "red onion", "cilantro", "lemon", "chaat masala", "peanuts"],
            "prep_needed": "Other: sprout moong 1-2 days ahead",
            "notes": "Keep chopped vegetables separate until eating.",
            "tags": ["Indian", "veg", "high-protein", "no-cook"],
        },
        {
            "name": "Shakshuka with greens",
            "meal_types": ["Breakfast", "Dinner"],
            "effort": "Medium",
            "ingredients": ["eggs", "tomato", "capsicum", "onion", "spinach", "feta", "olive oil", "cumin", "paprika"],
            "prep_needed": "None",
            "notes": "Serve with salad or one slice of whole-grain bread.",
            "tags": ["Mediterranean", "eggs", "vegetarian", "brunch"],
        },
        {
            "name": "Chana saag + quinoa",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Medium",
            "ingredients": ["chickpeas", "spinach", "quinoa", "onion", "tomato", "ginger", "garlic", "cumin", "lemon"],
            "prep_needed": "None",
            "notes": "Use canned chickpeas when planning a quick weeknight.",
            "tags": ["Indian", "veg", "high-protein", "greens"],
        },
        {
            "name": "Tandoori chicken + roasted broccoli + raita",
            "meal_types": ["Dinner"],
            "effort": "Medium",
            "ingredients": ["chicken", "broccoli", "yogurt", "cucumber", "mint", "lemon", "garlic", "tandoori masala", "olive oil"],
            "prep_needed": "Marinate",
            "notes": "Marinate in the morning; roast everything on one tray.",
            "tags": ["Indian", "chicken", "high-protein", "sheet-pan"],
        },
        {
            "name": "Brown rice vegetable khichdi + raita",
            "meal_types": ["Lunch", "Dinner"],
            "effort": "Medium",
            "ingredients": ["brown rice", "moong dal", "carrot", "peas", "spinach", "yogurt", "cucumber", "cumin", "ghee"],
            "prep_needed": "Soak overnight",
            "notes": "Use a higher dal-to-rice ratio for more protein and fewer refined carbs.",
            "tags": ["Indian", "veg", "comfort food", "one-pot"],
        },
    ]
    for meal in starters:
        insert_meal(conn, meal)


class Handler(BaseHTTPRequestHandler):
    server_version = "MealPlanner/1.0"

    def send_json(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw or "{}")

    def handle_error(self, exc: Exception) -> None:
        if isinstance(exc, ValueError):
            self.send_json({"error": str(exc)}, 400)
            return
        traceback.print_exc()
        self.send_json({"error": "Internal server error"}, 500)

    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = self.strip_base_path(parsed.path)
            query = parse_qs(parsed.query)
            if path.startswith("/api/"):
                self.route_get(path, query)
            else:
                self.serve_static(path)
        except Exception as exc:  # pragma: no cover - surfaced as API response
            self.handle_error(exc)

    def do_POST(self) -> None:  # noqa: N802
        try:
            self.route_write("POST", self.strip_base_path(urlparse(self.path).path), self.read_json())
        except Exception as exc:
            self.handle_error(exc)

    def do_PUT(self) -> None:  # noqa: N802
        try:
            self.route_write("PUT", self.strip_base_path(urlparse(self.path).path), self.read_json())
        except Exception as exc:
            self.handle_error(exc)

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            self.route_write("DELETE", self.strip_base_path(urlparse(self.path).path), {})
        except Exception as exc:
            self.handle_error(exc)

    def strip_base_path(self, path: str) -> str:
        if BASE_PATH and (path == BASE_PATH or path.startswith(f"{BASE_PATH}/")):
            return path[len(BASE_PATH) :] or "/"
        return path

    def route_get(self, path: str, query: dict) -> None:
        with db() as conn:
            if path == "/api/bootstrap":
                week = get_week_payload(conn)
                self.send_json(
                    {
                        "meals": list_meals(conn),
                        "week": week,
                        "shoppingItems": list_shopping_items(conn, week["id"]),
                        "archive": archive_payload(conn),
                        "categories": CATEGORIES,
                    }
                )
            elif path == "/api/meals":
                self.send_json({"meals": list_meals(conn)})
            elif path == "/api/archive":
                self.send_json({"archive": archive_payload(conn)})
            elif path == "/api/shopping":
                week_id = query.get("week_id", [get_or_create_current_week(conn)["id"]])[0]
                self.send_json({"items": list_shopping_items(conn, week_id)})
            elif path == "/api/export":
                self.send_json(export_payload(conn))
            else:
                self.send_json({"error": "Not found"}, 404)

    def route_write(self, method: str, path: str, payload: dict) -> None:
        parts = path.strip("/").split("/")
        with db() as conn:
            if method == "POST" and path == "/api/meals":
                self.send_json({"meal": insert_meal(conn, payload)}, 201)
                return
            if method == "PUT" and len(parts) == 3 and parts[:2] == ["api", "meals"]:
                self.send_json({"meal": update_meal(conn, parts[2], payload)})
                return
            if method == "DELETE" and len(parts) == 3 and parts[:2] == ["api", "meals"]:
                conn.execute("DELETE FROM meals WHERE id = ?", (parts[2],))
                self.send_json({"ok": True})
                return
            if method == "PUT" and len(parts) == 4 and parts[:2] == ["api", "weeks"] and parts[3] == "pantry":
                conn.execute(
                    "UPDATE weeks SET pantry_notes = ?, updated_at = ? WHERE id = ?",
                    (str(payload.get("pantry_notes", "")), now_iso(), parts[2]),
                )
                self.send_json({"week": get_week_payload(conn, parts[2])})
                return
            if method == "PUT" and len(parts) == 4 and parts[:2] == ["api", "weeks"] and parts[3] == "cells":
                cell = upsert_cell(conn, parts[2], payload)
                self.send_json({"cell": cell, "week": get_week_payload(conn, parts[2])})
                return
            if method == "POST" and len(parts) == 4 and parts[:2] == ["api", "weeks"] and parts[3] == "archive":
                week = archive_week(conn, parts[2], payload.get("verdicts"))
                self.send_json(
                    {
                        "week": week,
                        "shoppingItems": list_shopping_items(conn, week["id"]),
                        "archive": archive_payload(conn),
                    }
                )
                return
            if method == "POST" and path == "/api/shopping/generate":
                week_id = str(payload.get("week_id") or get_or_create_current_week(conn)["id"])
                self.send_json({"items": generate_shopping(conn, week_id)})
                return
            if method == "POST" and path == "/api/shopping/custom":
                week_id = str(payload.get("week_id") or get_or_create_current_week(conn)["id"])
                name = str(payload.get("name", "")).strip()
                if not name:
                    raise ValueError("Item name is required")
                category = str(payload.get("category", "Other"))
                if category not in CATEGORIES:
                    category = "Other"
                stamp = now_iso()
                item_id = new_id()
                conn.execute(
                    "INSERT INTO shopping_items(id, week_id, name, category, source, checked, created_at, updated_at) VALUES(?, ?, ?, ?, 'custom', 0, ?, ?)",
                    (item_id, week_id, name, category, stamp, stamp),
                )
                self.send_json({"item": row_to_shopping_item(conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone())}, 201)
                return
            if method == "PUT" and len(parts) == 3 and parts[:2] == ["api", "shopping"]:
                item_id = parts[2]
                row = conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone()
                if not row:
                    raise ValueError("Shopping item not found")
                name = str(payload.get("name", row["name"])).strip() or row["name"]
                category = str(payload.get("category", row["category"]))
                if category not in CATEGORIES:
                    category = row["category"]
                checked = 1 if payload.get("checked", bool(row["checked"])) else 0
                conn.execute(
                    "UPDATE shopping_items SET name = ?, category = ?, checked = ?, updated_at = ? WHERE id = ?",
                    (name, category, checked, now_iso(), item_id),
                )
                self.send_json({"item": row_to_shopping_item(conn.execute("SELECT * FROM shopping_items WHERE id = ?", (item_id,)).fetchone())})
                return
            if method == "DELETE" and len(parts) == 3 and parts[:2] == ["api", "shopping"]:
                conn.execute("DELETE FROM shopping_items WHERE id = ?", (parts[2],))
                self.send_json({"ok": True})
                return
            if method == "POST" and path == "/api/shopping/reset":
                week_id = str(payload.get("week_id") or get_or_create_current_week(conn)["id"])
                conn.execute("DELETE FROM shopping_items WHERE week_id = ?", (week_id,))
                self.send_json({"items": generate_shopping(conn, week_id)})
                return
            if method == "POST" and path == "/api/import":
                self.send_json(import_payload(conn, payload))
                return
            self.send_json({"error": "Not found"}, 404)

    def serve_static(self, path: str) -> None:
        target = PUBLIC_DIR / ("index.html" if path in ["/", ""] else path.lstrip("/"))
        target = target.resolve()
        if PUBLIC_DIR.resolve() not in target.parents and target != PUBLIC_DIR.resolve():
            self.send_error(403)
            return
        if not target.exists() or not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        mime, _ = mimetypes.guess_type(str(target))
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}")


def main() -> None:
    ensure_schema()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Meal planner running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
