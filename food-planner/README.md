# Couple Meal Planner

A small single-page meal planning app for a couple, backed by SQLite and served by Python's standard library. No build step and no package install are required.

## Run Locally

```bash
python3 app.py
```

Open `http://localhost:8000`.

The SQLite database is created at `data/meal_planner.sqlite3` on first run and is preloaded with 20 starter meals.

## VM Hosting In `website-hell`

The repository deploys this app behind Caddy at `https://rahulreddy.in/food-planner/`.

GitHub Actions copies this directory to the VM, runs `deploy/install.sh`, and installs:

- `/opt/food-planner/current` for app code
- `/var/lib/food-planner/meal_planner.sqlite3` for persistent SQLite data
- `/etc/systemd/system/food-planner.service` for the backend service
- a Caddy route that reverse proxies `/food-planner/*` to `127.0.0.1:8010`

For manual VM hosting, run from this directory on the VM:

```bash
sudo bash deploy/install.sh
```

For ad-hoc local testing, run:

```bash
HOST=0.0.0.0 PORT=8000 python3 app.py
```

To store the database somewhere else during ad-hoc runs:

```bash
MEAL_PLANNER_DB=/var/lib/food-planner/meal_planner.sqlite3 python3 app.py
```

## Backup And Restore

In the app, open `Library` and use:

- `Export JSON` to download a full backup.
- `Import JSON` to restore from a prior export. Import replaces the current database.

API endpoints are also available:

```bash
curl http://localhost:8000/api/export > meal-planner-backup.json
curl -X POST -H 'Content-Type: application/json' --data @meal-planner-backup.json http://localhost:8000/api/import
```

## Verify

```bash
python3 smoke_test.py
```

The smoke test initializes a temporary database, verifies seed data, creates a plan cell, generates a shopping list, archives a week, and validates JSON export/import shape.
