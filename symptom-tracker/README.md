# Symptom Tracker

Stdlib-only authenticated capture server and SQLite store for the V1 contract in `PLAN.md`.

```sh
SYMPTOM_TRACKER_PASSWORD='use-a-secret' python3 app.py  # password used only on first run
python3 app.py --set-password                           # preferred interactive setup
python3 smoke_test.py
```

Configuration: `SYMPTOM_TRACKER_DB`, `HOST`, `PORT`, and `BASE_PATH` (default `/tracker`).
The password is scrypt-hashed with a random installation salt; it is never stored plaintext.

`schema.sql` preserves the authoritative DDL and adds FTS synchronization plus server-only
authentication tables. SQLite accepts the generated `date()`/`unixepoch()` expressions as
deterministic (tested by `smoke_test.py`, including explicit offsets around a DST transition).
Migrations are versioned by `schema_version`; future versions are applied in order by
`db.ensure_schema()`. Version 2 adds reviewed-attribute state and retained deletion tombstones.
Version 3 rebuilds only `symptom_event` so Bristol can be NULL and adds `is_bm`; existing rows
are preserved as bowel movements. Version 4 adds structured ordinal `nausea`.

## Pinned API shapes

- `GET /api/auth/session` returns
  `{ "authenticated": boolean, "configured": boolean }`.
- `GET /api/meals` returns `{ "meals": [...] }`. Every meal contains a nested
  `consumption_events` array. `POST /api/meals` accepts one meal with that same nested array;
  `/api/sync` instead accepts sibling `meals` and `consumption_events` arrays.
- `day_log.missing_kinds` is a JSON **string**, matching its SQLite `TEXT` column. Native
  arrays are rejected rather than silently transformed.
- Unknown `portion_ordinal` is JSON `null` and remains SQL NULL; no portion is inferred.
- Canonical analysis/timeline lag windows are 0–6h, 6–24h, and 24–48h. The rates endpoint
  defaults to 0–6h and accepts the other canonical bounds explicitly.
- Review endpoints are `GET /api/attributes`, `GET|PUT /api/items/:id/attributes`,
  `GET /api/review/queue?limit=`, and `GET /api/review/impact`.

`GET /api/review/impact?top_n=6` returns `n_total_observations`,
`n_unknown_exposure`, `n_classified`, `n_would_become_analyzable`, and the effective `top_n`.
Unknown exposure is the maximum candidate-specific count, never a sum across candidates.
Review queue items expose `n_consumptions`, `blocks`, marginal `unlocks`, `review_score`,
`last_used`, and item identity/review fields.

The review queue score is `consumption_count × 30-day recency weight ×
(1 + blocked_BM_observations)`. It prioritizes frequently consumed recent items and strongly
promotes items whose missing review currently prevents descriptive analysis.

Analysis HTTP responses are descriptive, use Wilson intervals, preserve unknown attributes,
and never persist derived lag features. `analysis/` is reserved for read-only scientific-stack
notebooks; dependencies placed there must never be imported by the capture server.
