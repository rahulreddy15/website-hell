# `food-planner/`

This is a standalone Python standard-library application serving a JSON API and a hand-written frontend. It shares no templates, assets, configuration, or output with the Zola blog.

## Layout

```text
food-planner/
├── app.py                    # Server entrypoint
├── smoke_test.py             # Application smoke test
├── README.md
├── public/                   # Committed HTML, CSS, and JavaScript source
└── deploy/
    ├── install.sh
    ├── check-vm-prereqs.sh
    ├── food-planner.service
    └── caddy-food-planner.caddy
```

## Commands

Run from the repository root:

```sh
python3 food-planner/app.py
python3 food-planner/smoke_test.py
python3 -m py_compile food-planner/app.py food-planner/smoke_test.py
```

## Runtime and Deployment

- There are no third-party dependencies, `requirements.txt`, virtualenv requirement, or frontend build step.
- Development uses port `8000` and `food-planner/data/meal_planner.sqlite3`, which is gitignored.
- Production uses port `8010` and `/var/lib/food-planner/meal_planner.sqlite3`.
- Production installs to `/opt/food-planner/current` through `deploy/install.sh` and runs as a systemd unit behind Caddy.
- `BASE_PATH` serves the app under `/food-planner/` in production.

## Conventions and Gotchas

- `app.py` serves `public/` as well as the JSON API.
- `public/app.js` deliberately computes its API base relatively with `new URL("api/", window.location.href).pathname`; never hard-code `/api/`.
- `food-planner/public/` is committed source. It is unrelated to generated `blog/public/`.
