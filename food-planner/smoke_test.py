#!/usr/bin/env python3
"""Lightweight integration checks for the meal planner database/API helpers."""

from __future__ import annotations

import os
import tempfile


with tempfile.TemporaryDirectory() as tmpdir:
    os.environ["MEAL_PLANNER_DB"] = os.path.join(tmpdir, "meal_planner.sqlite3")

    import app  # noqa: E402

    app.DB_PATH = app.Path(os.environ["MEAL_PLANNER_DB"])
    app.ensure_schema()

    with app.db() as conn:
        meals = app.list_meals(conn)
        assert len(meals) == 20, f"expected 20 seed meals, got {len(meals)}"

        week = app.get_week_payload(conn)
        assert week["cells"] == [], "new week should start empty"

        cell = app.upsert_cell(
            conn,
            week["id"],
            {
                "day_index": 0,
                "slot": "Dinner",
                "mode": "meal",
                "meal_id": meals[0]["id"],
            },
        )
        assert cell["meal_id"] == meals[0]["id"]

        shopping = app.generate_shopping(conn, week["id"])
        assert shopping, "shopping list should include planned meal ingredients"

        exported = app.export_payload(conn)
        assert exported["version"] == 1
        assert "meals" in exported["tables"]

        next_week = app.archive_week(conn, week["id"], None)
        assert next_week["id"] != week["id"], "archiving should move to a fresh week"

        archive = app.archive_payload(conn)
        assert archive["weeks"], "archived week should be visible"
        assert archive["stats"], "archived meals should produce stats"

    print("Smoke test passed")
