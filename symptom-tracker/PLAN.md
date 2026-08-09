# Symptom Tracker — V1 Plan and Contract

A personal n-of-1 research instrument for linking food intake to GI symptoms.

This document is the **shared contract**. The backend, frontend, and analysis layers are
built against it independently. Where this document and an implementation disagree, this
document wins until it is deliberately amended.

---

## 1. What this is

This is not a food diary. It is an **n-of-1 observational study with a confirmation loop**,
with a diary as its data-capture surface.

The scientific design is:

```
passive logging  ──►  hypothesis ranking  ──►  deliberate rechallenge  ──►  claim
   (v1)                    (v2)                      (v3)
```

Only the last step produces a causal claim. Everything before it produces *candidates*.
The UI must reflect this distinction at all times.

### V1 scope

V1 delivers **trustworthy capture plus description. Zero inference.**

In scope:

- Mobile PWA for fast, offline-capable logging of meals and stool events
- SQLite store with full-text search
- Authenticated self-hosted server
- A correct lagged-exposure join (meals → later symptoms)
- Descriptive exposed-vs-unexposed symptom rates with confidence intervals, over a small
  pre-registered candidate set
- Search and timeline exploration

Explicitly out of scope for v1:

- Multivariable regression, adjustment, case-crossover models
- Any causal language anywhere in the UI
- Compound-level chemistry (schema hooks only, no data population)
- Ingredient decomposition of dishes (schema supports it; v1 uses tagged attributes)
- External food database imports (USDA/FNDDS/OFF are v2+)

### V1 acceptance test

> **The pipeline must independently re-surface the known "Ginger Ale Cold Brew" trigger
> from logged data, without being told about it.**

If it cannot rediscover a trigger the user already knows about, the pipeline is broken and
no later sophistication will rescue it. This is the gate for calling v1 done.

---

## 2. The eight irreversible decisions

Everything else — schema shape, model choice, binning, the compound layer — can be redone
later against the same raw log. These eight cannot. They are non-negotiable in v1.

| # | Decision | Consequence of getting it wrong |
|---|---|---|
| 1 | **UTC timestamp + local offset, minute precision, on every event** | A bare date makes lag analysis impossible forever. Naive local time is silently corrupted by DST and travel. |
| 2 | **Bristol 1–7 + urgency + timestamp as structured fields** | Free text is not an analyzable outcome. Never store a "was it diarrhea" boolean instead of the raw scale. |
| 3 | **Daily completeness flag + explicit "nothing eaten" capability** | Without it you cannot distinguish *didn't eat* from *didn't log*. Every rate model needs the negative timeline as its denominator. Unreconstructable after the fact. |
| 4 | **Some quantitative portion captured at log time** (ordinal is sufficient) | Dose-response cannot be recovered later. Ordinal upgrades to grams via calibration; the reverse is impossible. |
| 5 | **NULL ≠ 0 for attributes** | An unknown value is *unknown*, not zero. Silent zero-imputation manufactures false "safe" foods. |
| 6 | **Version recipes and attribute knowledge** | Correcting a recipe next year must not silently rewrite last year's computed exposures. |
| 7 | **Store raw timestamps, never lag bins** | Baking analysis windows into storage forecloses every future windowing or decay-kernel choice. |
| 8 | **Ability to censor illness and travel windows** | An acute GI infection looks exactly like a food trigger and lasts days. It must be excluded, not adjusted for. |

---

## 3. Data model

### Design principle

**Log at the layer you actually observe; resolve to deeper layers at analysis time.**

```
EVENT LAYER        what you tap into the phone: a dish, a portion, a Bristol score
      │            never blocked on knowing ingredients
      ▼
RESOLUTION LAYER   dish → ingredients, editable and versioned
      │            a restaurant dish is a low-confidence template
      ▼
KNOWLEDGE LAYER    ingredient → attributes (fat, lactose, capsaicin, FODMAP fractions)
      │            sparse; absent means unknown
      ▼
FEATURE LAYER      computed on demand at analysis time. Never stored.
```

`item` unifies dishes and ingredients. A "dish" is simply an item that has `recipe_component`
rows. This recursion means a raw ingredient eaten alone needs no special case, and a dish
used as an ingredient in another dish works for free.

V1 populates the event layer and a **tagged-attribute** subset of the knowledge layer. The
resolution layer exists in the schema and the UI may allow editing it, but v1 analysis does
not depend on it.

### Schema (SQLite, authoritative DDL)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- meta

CREATE TABLE schema_version (
  version     INTEGER NOT NULL,
  applied_at  TEXT    NOT NULL
);

-- ---------------------------------------------------------------- items

-- Dishes and ingredients share one table. kind is a hint, not a constraint:
-- an item becomes a "dish" by having recipe_component rows.
CREATE TABLE item (
  id            TEXT PRIMARY KEY,            -- client-generated UUIDv4
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('dish','ingredient','drink','supplement','med')),
  brand         TEXT,
  barcode       TEXT,
  is_raw        INTEGER NOT NULL DEFAULT 0,  -- 1 = single unprocessed ingredient
  default_portion TEXT,                      -- remembered ordinal, speeds re-logging
  -- Decision #5 enabler. 0 = this item's attributes have never been fully reviewed, so a
  -- MISSING attribute row means UNKNOWN. 1 = the user has reviewed this item against the
  -- candidate set, so a missing row legitimately means ZERO. Without this flag there is no
  -- honest way to ever have an "unexposed" observation.
  attributes_reviewed INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX item_kind_idx     ON item(kind, archived);
CREATE UNIQUE INDEX item_barcode_idx ON item(barcode) WHERE barcode IS NOT NULL;

-- ---------------------------------------------------------------- events

-- A meal groups items eaten together. Created implicitly by the client.
CREATE TABLE meal (
  id            TEXT PRIMARY KEY,
  ts_utc        TEXT NOT NULL,               -- ISO8601 'YYYY-MM-DDTHH:MM:SSZ'
  tz_offset_min INTEGER NOT NULL,            -- local offset at time of event
  label         TEXT,                        -- breakfast/lunch/dinner/snack, free text
  context       TEXT CHECK (context IN ('home','restaurant','packaged','other')),
  location      TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  ts_epoch      INTEGER GENERATED ALWAYS AS (unixepoch(ts_utc)) STORED,
  local_date    TEXT    GENERATED ALWAYS AS (
                   date(ts_utc, (CASE WHEN tz_offset_min >= 0 THEN '+' ELSE '-' END)
                        || abs(tz_offset_min) || ' minutes')) STORED
);
CREATE INDEX meal_ts_idx    ON meal(ts_epoch);
CREATE INDEX meal_date_idx  ON meal(local_date);

CREATE TABLE consumption_event (
  id              TEXT PRIMARY KEY,
  meal_id         TEXT NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL REFERENCES item(id),
  portion_ordinal TEXT CHECK (portion_ordinal IN
                    ('none','taste','small','medium','large','huge')),
  amount_g        REAL,                      -- optional; NULL is expected and fine
  portion_basis   TEXT CHECK (portion_basis IN ('ordinal','measured','estimated')),
  prep_method     TEXT,                      -- fried/boiled/raw/grilled...
  notes           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX ce_meal_idx ON consumption_event(meal_id);
CREATE INDEX ce_item_idx ON consumption_event(item_id);

CREATE TABLE symptom_event (
  id            TEXT PRIMARY KEY,
  ts_utc        TEXT NOT NULL,
  tz_offset_min INTEGER NOT NULL,
  -- NULLABLE. A bowel movement has a Bristol type; bloating, pain, or nausea at 19:40
  -- does not. Forcing a Bristol value onto a non-BM symptom would corrupt the v1 outcome
  -- variable, and burying it in free text violates decision #2. Non-BM symptoms are
  -- first-class rows with bristol IS NULL.
  bristol       INTEGER CHECK (bristol IS NULL OR bristol BETWEEN 1 AND 7),
  is_bm         INTEGER NOT NULL DEFAULT 1,  -- 1 = bowel movement, 0 = other symptom
  urgency       INTEGER CHECK (urgency BETWEEN 0 AND 3),
  volume        TEXT    CHECK (volume  IN ('small','medium','large')),
  pain          INTEGER CHECK (pain    BETWEEN 0 AND 3),
  nausea        INTEGER CHECK (nausea  BETWEEN 0 AND 3),
  bloating      INTEGER CHECK (bloating BETWEEN 0 AND 3),
  incomplete    INTEGER,                     -- sense of incomplete evacuation, 0/1
  nocturnal     INTEGER,                     -- 0/1; clinically meaningful red flag
  blood_flag    INTEGER,
  mucus_flag    INTEGER,
  accident_flag INTEGER,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  ts_epoch      INTEGER GENERATED ALWAYS AS (unixepoch(ts_utc)) STORED,
  local_date    TEXT    GENERATED ALWAYS AS (
                   date(ts_utc, (CASE WHEN tz_offset_min >= 0 THEN '+' ELSE '-' END)
                        || abs(tz_offset_min) || ' minutes')) STORED
);
CREATE INDEX se_ts_idx   ON symptom_event(ts_epoch);
CREATE INDEX se_date_idx ON symptom_event(local_date);

-- ---------------------------------------------- completeness and daily state

-- Decision #3. This table is the denominator for all analysis.
CREATE TABLE day_log (
  local_date     TEXT PRIMARY KEY,           -- 'YYYY-MM-DD'
  -- Graded, not boolean. 'unanswered' is distinct from 'unsure': the first means we
  -- never asked, the second means the user genuinely does not know. Analysis treats
  -- them differently. NULL is equivalent to 'unanswered'.
  completeness   TEXT CHECK (completeness IN
                   ('complete','mostly','partial','unsure','declined','unanswered')),
  missing_kinds  TEXT,                       -- JSON array: ['meals','symptoms']
  nothing_eaten  INTEGER NOT NULL DEFAULT 0, -- fasting / genuinely no intake
  notes          TEXT,
  updated_at     TEXT NOT NULL
);

-- Decision #8 and confounders. Slow-moving daily state.
CREATE TABLE state_log (
  local_date      TEXT PRIMARY KEY,
  stress          INTEGER CHECK (stress BETWEEN 0 AND 3),
  sleep_hours     REAL,
  menstrual_phase TEXT,
  illness_flag    INTEGER NOT NULL DEFAULT 0,
  travel_flag     INTEGER NOT NULL DEFAULT 0,
  water_source    TEXT,
  notes           TEXT,
  updated_at      TEXT NOT NULL
);

-- Explicit exclusion windows. Analysis MUST honour these.
CREATE TABLE censor_window (
  id          TEXT PRIMARY KEY,
  start_utc   TEXT NOT NULL,
  end_utc     TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (reason IN
                ('illness','travel','antibiotics','other')),
  notes       TEXT,
  created_at  TEXT NOT NULL
);

-- Deletions must propagate through offline sync. A row deleted on the phone while offline
-- would otherwise silently reappear on the next pull. Tombstones are retained, not purged.
CREATE TABLE tombstone (
  id          TEXT NOT NULL,                 -- id of the deleted row
  resource    TEXT NOT NULL,                 -- 'items' | 'meals' | 'symptom_events' | ...
  deleted_at  TEXT NOT NULL,
  PRIMARY KEY (resource, id)
);
CREATE INDEX tombstone_time_idx ON tombstone(deleted_at);

-- ------------------------------------------------- resolution layer (v1: hooks)

CREATE TABLE recipe_component (
  id                TEXT PRIMARY KEY,
  parent_item_id    TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  child_item_id     TEXT NOT NULL REFERENCES item(id),
  amount_frac       REAL,                    -- fraction of parent by mass
  amount_uncertainty REAL,
  presence_prob     REAL NOT NULL DEFAULT 1.0 CHECK (presence_prob BETWEEN 0 AND 1),
  recipe_version    INTEGER NOT NULL DEFAULT 1,
  effective_from    TEXT NOT NULL,           -- decision #6
  recipe_confidence TEXT CHECK (recipe_confidence IN ('high','medium','low')),
  created_at        TEXT NOT NULL
);
CREATE INDEX rc_parent_idx ON recipe_component(parent_item_id, recipe_version);

-- ------------------------------------------------- knowledge layer

CREATE TABLE attribute_def (
  id          TEXT PRIMARY KEY,              -- 'total_fat_g', 'lactose', 'capsaicin'
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN
                ('macro','fodmap_fraction','compound','category','flag')),
  unit        TEXT,
  is_candidate INTEGER NOT NULL DEFAULT 0,   -- part of the pre-registered v1 set
  description TEXT
);

-- Sparse by design. An ABSENT ROW MEANS UNKNOWN, NOT ZERO. (Decision #5)
CREATE TABLE item_attribute (
  item_id           TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  attribute_id      TEXT NOT NULL REFERENCES attribute_def(id),
  value             REAL,
  unit              TEXT,
  source            TEXT,                    -- 'manual','usda:<fdc_id>','off:<barcode>'
  confidence        TEXT CHECK (confidence IN ('high','medium','low')),
  knowledge_version INTEGER NOT NULL DEFAULT 1,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (item_id, attribute_id, knowledge_version)
);

-- ------------------------------------------------- search (decision: FTS5)

CREATE VIRTUAL TABLE item_fts USING fts5(
  name, brand, notes,
  content='item', content_rowid='rowid', tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE note_fts USING fts5(
  body, kind UNINDEXED, ref_id UNINDEXED, ts_utc UNINDEXED,
  tokenize='porter unicode61'
);
```

Triggers keep `item_fts` and `note_fts` in sync on insert/update/delete. `note_fts` is a
union index over free-text notes from `meal`, `consumption_event`, `symptom_event`,
`day_log`, and `state_log`, so one query searches the entire corpus.

### Pre-registered v1 candidate set

Decision #3 of the multiplicity discipline: a small, mechanism-anchored candidate set, not
hundreds of features. Seeded into `attribute_def` with `is_candidate = 1`:

`total_fat` · `lactose` · `caffeine` · `alcohol` · `polyols` · `excess_fructose` ·
`capsaicin` · `artificial_sweetener` · `high_fodmap` · `gluten` · `dairy` · `fried` ·
`spicy` · `carbonation` · `meal_size`

In v1 these are **manual tags on items**, not imported chemistry. Tagging an item is a
one-time cost that pays off on every subsequent log.

---

## 4. API contract

JSON over HTTP. All paths below are relative to the app's mount point, which must be
configurable so the app works under a subpath (`/tracker/`) exactly as `food-planner` does.

### Offline sync semantics

**Every mutable row uses a client-generated UUIDv4 primary key.** The client may write
offline, queue, and replay. Writes are **idempotent upserts** keyed on that id, so replaying
a queued batch after a flaky connection can never duplicate an event. This is the single
most important API property for a PWA that is used in bathrooms with bad signal.

Conflict rule for v1: **last-write-wins by `updated_at`.** Single user, single device at a
time; anything more elaborate is unjustified.

```
POST /api/sync            batch upsert; body: {meals:[], consumption_events:[],
                          symptom_events:[], items:[], item_attributes:[],
                          day_logs:[], state_logs:[], censor_windows:[], tombstones:[]}
                          returns per-record {id, status: applied|stale|rejected}
GET  /api/sync?since=<iso> changes since timestamp, for pulling to a second device
```

Every resource that can be created offline belongs in this envelope. Censor windows and
attribute reviews qualify: marking an illness window or reviewing an item are both things
done on the couch with no signal, and routing them through single-resource POSTs makes them
the only writes that can be lost.

### Core resources

```
GET    /api/items?q=&kind=&limit=       frecency-ranked; drives the quick-add list
POST   /api/items                       upsert item
GET    /api/items/:id
DELETE /api/items/:id                   soft delete via archived=1

GET    /api/meals?from=&to=
POST   /api/meals                       upsert meal + its consumption_events atomically
DELETE /api/meals/:id

GET    /api/symptoms?from=&to=
POST   /api/symptoms                    upsert symptom_event
DELETE /api/symptoms/:id

GET    /api/days?from=&to=              day_log + state_log merged per date
POST   /api/days/:date                  upsert completeness + daily state

GET    /api/censor
POST   /api/censor
DELETE /api/censor/:id
```

### Attributes and the review flow

**This is what makes the three-way exposure model reachable.** Without these endpoints an item
can never be tagged or marked reviewed, so every observation classifies as `unknown` forever
and the analysis is permanently and correctly inert. The review flow is not an admin screen;
it is the mechanism by which the study acquires the ability to say anything at all.

```
GET  /api/attributes                     the candidate set, with per-attribute coverage:
                                         how many logged items are tagged vs unreviewed
GET  /api/items/:id/attributes           current tags + attributes_reviewed for one item
PUT  /api/items/:id/attributes           set tags and/or attributes_reviewed atomically
                                         body: {attributes: {lactose: 1, capsaicin: 0},
                                                attributes_reviewed: 1}
GET  /api/review/queue?limit=            items needing review, ranked by ANALYTICAL VALUE:
                                         consumption frequency × recency × whether the item
                                         currently blocks otherwise-analyzable observations
GET  /api/review/impact                  how many observations are currently unknown-exposure,
                                         and how many would become analyzable if the top N
                                         queue items were reviewed
```

`GET /api/review/impact` exists so the UI can answer *"why is this screen empty, and what
exactly do I do about it?"* with a number rather than a shrug. Reviewing must feel like it
buys something measurable, because it does.

**Response shapes are part of the contract, not an implementation detail.** Field names below
are normative. They use the same `n_` convention as the analysis envelope so the two read
consistently:

```json
// GET /api/review/impact
{ "n_total_observations": 46,      // all is_bm observations in the corpus
  "n_unknown_exposure": 46,        // currently unclassifiable for ANY candidate.
                                   // This is a MAX across candidates, never a sum:
                                   // the same observation seen through 15 candidates
                                   // is one observation, not fifteen.
  "n_classified": 0,
  "n_would_become_analyzable": 19, // if the top `top_n` queue items were reviewed
  "top_n": 6 }

// GET /api/review/queue
{ "items": [
    { "id": "…", "name": "Ginger Ale Cold Brew", "kind": "drink",
      "attributes_reviewed": 0,
      "n_consumptions": 12,        // times logged
      "blocks": 9,                 // observations currently unclassifiable because of it
      "unlocks": 4,                // observations that become analyzable if reviewed alone
      "review_score": 41.2,        // ranking value; opaque to the client
      "last_used": "2026-02-01T08:00:00Z" } ] }
```

`item_attribute` and `attributes_reviewed` participate in `/api/sync` like every other
resource, so reviewing works offline.

**Tombstone ids are per-resource, not universally UUIDv4.** `item_attribute` has a composite
primary key, so its tombstone id is `<item_id>|<attribute_id>|<knowledge_version>`. The
server must accept this form for `resource: "item_attributes"` and must not apply UUID
validation to it. Rejecting it means an attribute tag deleted offline can never be removed
on the server — a silent, permanent divergence between device and study data.


### Search (first-class, not an afterthought)

```
GET /api/search?q=&from=&to=&kind=&bristol_min=&bristol_max=&item_id=&limit=&offset=
```

- `q` runs against FTS5 across item names, brands, and all free-text notes
- Structured facets (`from`/`to`/`bristol_min`/`item_id`) combine with `q` as AND filters
- Results are a unified, reverse-chronological stream of typed hits:
  `{type: meal|symptom|item|note, id, ts_utc, snippet, ...}`
- `snippet` uses FTS5 `snippet()` with highlight markers so the UI can bold matches
- Empty `q` with facets set is valid — that is pure faceted browsing

```
GET /api/timeline?from=&to=
```
Returns meals and symptom events interleaved on one axis, plus censor windows and daily
completeness, for the timeline view.

### Analysis (v1: descriptive only)

```
GET /api/analysis/rates?attribute=&lag_from_h=&lag_to_h=&outcome=bristol67
```
Returns exposed / unexposed / unknown-exposure symptom rates with Wilson confidence
intervals, honouring `censor_window` exclusions and applying the graded completeness rules
in section 6. Returns a primary result plus a `sensitivity` block that additionally includes
unknown-completeness days, so the effect of that filtering choice is visible rather than
hidden. Never returns a silently empty result.

```
GET /api/analysis/cooccurrence?min_count=
```
Returns the pairwise co-occurrence and **discordant-event counts** that drive the
identifiability warnings.

Every analysis response carries an explicit envelope:

```json
{ "evidence_tier": "unclear",
  "n_exposed": 12, "n_unexposed": 88, "n_unknown_exposure": 41,
  "identifiable": false,
  "warnings": ["Co-occurs with 'onion' in 47/49 meals; effects are not separable."],
  "disclaimer": "Descriptive association only. Not a causal claim." }
```

`evidence_tier` is exactly one of five values, which are also the five the UI renders:
`observed` · `suggestive` · `unclear` · `contradictory` · `experiment`. There is no
`hypothesis` tier — the whole v1 output is hypothesis-level by construction, so a tier
saying so carries no information. Unrecognised values must map **down** to `unclear`,
never up.

The API must never return a bare p-value, and must never return a field named or framed as
"trigger" from observational data.

### Auth

Single user. Stdlib only.

- `POST /api/auth/login` → `{password}` → sets `HttpOnly; Secure; SameSite=Strict` session cookie
- `POST /api/auth/logout`
- `GET  /api/auth/session` → current session state, used by the PWA on boot
- Password stored as `hashlib.scrypt` hash + per-install random salt; never plaintext,
  never in the repo
- Session tokens are random 256-bit values stored server-side in SQLite with an expiry;
  long-lived (30 days, sliding) because re-authenticating on a phone at 3am is exactly the
  friction that kills adherence
- Constant-time comparison on both password and token
- Login rate-limited; failures logged
- Every `/api/*` route except the auth endpoints requires a valid session
- Static assets may be served unauthenticated (they contain no data); **all data endpoints
  must not**

---

## 5. Architecture and deployment

```
PWA (service worker, IndexedDB queue)
        │  fetch, relative base URL
        ▼
stdlib http.server + auth  ──►  SQLite (WAL, FTS5, JSON1)
        │                            │
   /var/lib/symptom-tracker/    read directly by
                                Jupyter: pandas / statsmodels / pymc
```

**Deliberate convention split.** The capture server is stdlib-only, matching `food-planner`,
so it stays trivially deployable. The analysis layer is a separate notebook environment that
freely uses numpy/scipy/statsmodels/pymc. Do not hand-roll statistics in the server.

Deployment mirrors the proven `food-planner` pattern with distinct identifiers:

| | food-planner | symptom-tracker |
|---|---|---|
| install path | `/opt/food-planner/current` | `/opt/symptom-tracker/current` |
| data | `/var/lib/food-planner/` | `/var/lib/symptom-tracker/` |
| port | `127.0.0.1:8010` | `127.0.0.1:8011` |
| Caddy route | `/food-planner/*` | `/tracker/*` |
| systemd unit | `food-planner.service` | `symptom-tracker.service` |

Both apps bind loopback only and sit behind Caddy, which terminates TLS. Unlike
`food-planner`, this app **must** enforce authentication: it holds health data.

Backups: nightly `VACUUM INTO` snapshot of the SQLite file, retained locally. The entire
dataset is one file, which is a significant operational advantage — protect it accordingly.

---

## 6. Analysis layer (v1)

Lives in `symptom-tracker/analysis/`, reads the SQLite file read-only, writes nothing.

The **lagged-exposure join** is the piece most likely to contain silent bugs, and it is
where review effort should concentrate:

1. For each candidate attribute, build the exposure timeline from consumption events.
2. For each symptom event, look back over a configurable window. **Canonical windows are
   0–6h, 6–24h, 24–48h**, used identically by the analysis layer and by timeline lag
   shading in the UI — a shaded band on screen must mean the same interval the numbers
   were computed over, or the visualisation actively misleads. Computed, never stored, per
   decision #7.
3. Drop windows overlapping any `censor_window`.
4. Exclude days whose `completeness` is `partial` or `declined`. Treat `unsure`,
   `unanswered`, and NULL as unknown, run the analysis both with and without them, and
   report how much data that choice moves the result.
5. Classify each symptom event's exposure **three ways, never two**:
   - **exposed** — some item in the window has an attribute row with a non-zero value
   - **unexposed** — no item is exposed AND every item in the window is either
     `attributes_reviewed = 1` or has an explicit zero row for that attribute
   - **unknown** — no item is exposed, but at least one item is unreviewed and has no row
   Collapsing `unknown` into `unexposed` is the zero-imputation error of decision #5. It
   inflates the unexposed denominator and biases every result toward the null. Report
   `n_unknown_exposure` alongside `n_exposed` and `n_unexposed`.
6. Emit a 2×2 of exposed/unexposed × symptom/no-symptom, with a Wilson confidence interval.

**Never return a silently empty result.** If completeness filtering or unknown-exposure
classification removes everything, the response must say so explicitly in `warnings` rather
than returning zeroes that look like a finding. Early on — before the user has answered any
completeness prompts or reviewed any item attributes — this will be the normal case, and the
UI must communicate "not enough reviewed data yet", not "no association".

Outcome definition for v1: **a symptom event with Bristol 6 or 7.** Raw Bristol is retained
so this definition can be changed later without re-logging.

Deliverables: a reproducible notebook, plus a test fixture of synthetic logs with a known
planted trigger used to prove the join recovers a signal it should recover.

---

## 7. What v1 must not do

- No causal language. Ever. Not in the UI, not in API field names.
- No ranked p-value table.
- No "your triggers are…" list.
- No zero-imputation of missing attributes.
- No storing of derived features, lag bins, or binarized outcomes.
- No compound database population.
- No unauthenticated data endpoints.

---

## 8. Medical note

This tool complements a medical workup; it does not substitute for one. Chronic diarrhea has
treatable causes that no diary can identify: celiac disease, bile acid malabsorption,
microscopic colitis, pancreatic insufficiency, giardia, inflammatory bowel disease. A logged
association is a reason to ask a clinician a better question, not a diagnosis.
