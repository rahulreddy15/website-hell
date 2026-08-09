# `symptom-tracker/`

A personal n-of-1 research instrument linking food intake to GI symptoms. Self-hosted, single user, offline-capable PWA over a stdlib Python server and SQLite.

**[`PLAN.md`](PLAN.md) is the authoritative contract.** Read it before changing the schema, the API, or the analysis. Response field names in it are normative, not suggestions — the frontend and backend are built independently against that document, and they have already diverged once when a shape was left unspecified.

This is not a food diary with statistics bolted on. It is an observational study with a confirmation loop, and the diary is its capture surface. Changes that improve convenience at the cost of analyzability are regressions.

## Layout

```text
symptom-tracker/
├── PLAN.md              the contract: schema, API, study design, v1 scope
├── app.py               stdlib http.server; routing tables and auth gate
├── db.py                persistence, sync, search, auth, descriptive analysis
├── schema.sql           authoritative DDL, applied on first run
├── smoke_test.py        integration + v1 acceptance tests
├── analysis/            notebooks; the ONLY place the scientific stack is allowed
├── deploy/              systemd units, install.sh, Caddy snippet, nightly backup
└── public/              the PWA (vanilla JS, no build step, no dependencies)
```

## Commands

From the repository root:

```sh
python3 symptom-tracker/smoke_test.py
python3 -m py_compile symptom-tracker/app.py symptom-tracker/db.py symptom-tracker/smoke_test.py
bash -n symptom-tracker/deploy/install.sh
SYMPTOM_TRACKER_DB=/tmp/dev.sqlite3 python3 symptom-tracker/app.py   # local run
```

## The eight irreversible decisions

Everything else can be redone later against the same raw log. These cannot. They are listed in full in `PLAN.md` section 2; the short form:

1. UTC timestamp + local offset on every event, minute precision. Never a bare date.
2. Bristol 1–7 + urgency + time as structured fields. Never a "was it diarrhea" boolean.
3. Graded daily completeness + explicit "nothing eaten". This is the denominator for all analysis.
4. Some quantitative portion at log time. Ordinal is fine; nothing is not.
5. `NULL ≠ 0` for attributes. Absent means unknown, never zero.
6. Version recipes and attribute knowledge so re-analysis stays reproducible.
7. Store raw timestamps, never lag bins or derived features.
8. Ability to censor illness and travel windows.

## The failure mode to hunt

Every serious defect found while building this shared one shape: **a data gap presenting as a finding.** None crashed. All produced confident, wrong output.

- An untagged item counted as "does not contain it" → false safe foods.
- Unanswered completeness excluded every event → `n=0` that reads as "no association".
- A non-bowel-movement symptom forced into free text → silently unanalyzable.
- Mismatched API field names → a local estimate silently substituted for the server's number.

When reviewing changes here, ask what happens when data is *missing* rather than wrong. Tests passing is weak evidence: fixtures write directly to the database and can bypass an entirely missing API, which is exactly how the attribute-review flow went unnoticed.

## Conventions and gotchas

- **The server is stdlib-only.** No numpy, pandas, or web framework in `app.py`/`db.py`. Only `analysis/` may use the scientific stack. Wilson intervals are implemented in pure Python for this reason — do not "simplify" them into a scipy call.
- **Every `/api/*` route except the auth endpoints requires a session.** This app holds health data. `food-planner` is deliberately unauthenticated; never copy its routing here.
- **Client generates UUIDv4 primary keys.** This is what makes offline sync replay-safe. Not all tombstone ids are UUIDs: `item_attributes` uses the composite `<item_id>|<attribute_id>|<knowledge_version>`, and `day_logs`/`state_logs` are keyed by `local_date`. Do not apply blanket UUID validation.
- **Lag windows are canonically 0–6h / 6–24h / 24–48h**, identical in the analysis layer and in timeline shading. If they diverge, a shaded band stops meaning the interval the numbers were computed over.
- **`evidence_tier` is exactly one of** `observed` · `suggestive` · `unclear` · `contradictory` · `experiment`. Unknown values map **down** to `unclear`, never up. There is no `hypothesis` tier: all v1 output is hypothesis-level by construction.
- **Banned in the UI and in API field names:** "trigger", "caused", "intolerant", "safe food". The frontend runs every server-supplied string through `neutralise()`, so a careless backend message cannot leak causal language into the interface. Do not defeat this.
- **No p-values, no ranked significance tables, no "your triggers are…" list.** V1 is descriptive only. Causal claims are earned in v3 by deliberate rechallenge, not by observational association.
- **Never return a silently empty analysis result.** Distinguish "not enough reviewed data yet" from "no association detected" — they are completely different claims.
- `n_unknown_exposure` is a **max across candidates, never a sum.** One observation seen through fifteen candidates is one observation.
- Port `8011`, loopback only, mounted at `/tracker/`, data at `/var/lib/symptom-tracker/`. All distinct from `food-planner`'s `8010`. Redeploy must never touch the data directory.
- Schema changes require a migration and a version bump; `ensure_schema()` refuses to run against a newer database than the server knows.

## V1 acceptance test

The pipeline must independently re-surface a known trigger from realistic noisy data, and must **not** surface a negative control. Both directions are required: a test that only proves you can find a signal never proves you avoid inventing one.

## Out of scope for v1

Multivariable regression, case-crossover models, causal language, compound-database population, and external food-database imports (USDA/FNDDS/Open Food Facts). Schema hooks exist for the resolution and knowledge layers; do not populate them yet. Note that no openly licensed FODMAP dataset exists — Monash's is proprietary and must not be scraped.
