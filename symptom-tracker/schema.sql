PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE item (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('dish','ingredient','drink','supplement','med')),
  brand TEXT,
  barcode TEXT,
  is_raw INTEGER NOT NULL DEFAULT 0,
  default_portion TEXT,
  attributes_reviewed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX item_kind_idx ON item(kind, archived);
CREATE UNIQUE INDEX item_barcode_idx ON item(barcode) WHERE barcode IS NOT NULL;

CREATE TABLE meal (
  id TEXT PRIMARY KEY,
  ts_utc TEXT NOT NULL,
  tz_offset_min INTEGER NOT NULL,
  label TEXT,
  context TEXT CHECK (context IN ('home','restaurant','packaged','other')),
  location TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ts_epoch INTEGER GENERATED ALWAYS AS (unixepoch(ts_utc)) STORED,
  local_date TEXT GENERATED ALWAYS AS (
    date(ts_utc, (CASE WHEN tz_offset_min >= 0 THEN '+' ELSE '-' END)
      || abs(tz_offset_min) || ' minutes')) STORED
);
CREATE INDEX meal_ts_idx ON meal(ts_epoch);
CREATE INDEX meal_date_idx ON meal(local_date);

CREATE TABLE consumption_event (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL REFERENCES meal(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES item(id),
  portion_ordinal TEXT CHECK (portion_ordinal IN ('none','taste','small','medium','large','huge')),
  amount_g REAL,
  portion_basis TEXT CHECK (portion_basis IN ('ordinal','measured','estimated')),
  prep_method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ce_meal_idx ON consumption_event(meal_id);
CREATE INDEX ce_item_idx ON consumption_event(item_id);

CREATE TABLE symptom_event (
  id TEXT PRIMARY KEY,
  ts_utc TEXT NOT NULL,
  tz_offset_min INTEGER NOT NULL,
  bristol INTEGER CHECK (bristol IS NULL OR bristol BETWEEN 1 AND 7),
  is_bm INTEGER NOT NULL DEFAULT 1,
  urgency INTEGER CHECK (urgency BETWEEN 0 AND 3),
  volume TEXT CHECK (volume IN ('small','medium','large')),
  pain INTEGER CHECK (pain BETWEEN 0 AND 3),
  nausea INTEGER CHECK (nausea BETWEEN 0 AND 3),
  bloating INTEGER CHECK (bloating BETWEEN 0 AND 3),
  incomplete INTEGER,
  nocturnal INTEGER,
  blood_flag INTEGER,
  mucus_flag INTEGER,
  accident_flag INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ts_epoch INTEGER GENERATED ALWAYS AS (unixepoch(ts_utc)) STORED,
  local_date TEXT GENERATED ALWAYS AS (
    date(ts_utc, (CASE WHEN tz_offset_min >= 0 THEN '+' ELSE '-' END)
      || abs(tz_offset_min) || ' minutes')) STORED
);
CREATE INDEX se_ts_idx ON symptom_event(ts_epoch);
CREATE INDEX se_date_idx ON symptom_event(local_date);

CREATE TABLE day_log (
  local_date TEXT PRIMARY KEY,
  completeness TEXT CHECK (completeness IN ('complete','mostly','partial','unsure','declined','unanswered')),
  missing_kinds TEXT,
  nothing_eaten INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE state_log (
  local_date TEXT PRIMARY KEY,
  stress INTEGER CHECK (stress BETWEEN 0 AND 3),
  sleep_hours REAL,
  menstrual_phase TEXT,
  illness_flag INTEGER NOT NULL DEFAULT 0,
  travel_flag INTEGER NOT NULL DEFAULT 0,
  water_source TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE censor_window (
  id TEXT PRIMARY KEY,
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('illness','travel','antibiotics','other')),
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE tombstone (
  id TEXT NOT NULL,
  resource TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (resource, id)
);
CREATE INDEX tombstone_time_idx ON tombstone(deleted_at);

CREATE TABLE recipe_component (
  id TEXT PRIMARY KEY,
  parent_item_id TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  child_item_id TEXT NOT NULL REFERENCES item(id),
  amount_frac REAL,
  amount_uncertainty REAL,
  presence_prob REAL NOT NULL DEFAULT 1.0 CHECK (presence_prob BETWEEN 0 AND 1),
  recipe_version INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT NOT NULL,
  recipe_confidence TEXT CHECK (recipe_confidence IN ('high','medium','low')),
  created_at TEXT NOT NULL
);
CREATE INDEX rc_parent_idx ON recipe_component(parent_item_id, recipe_version);

CREATE TABLE attribute_def (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('macro','fodmap_fraction','compound','category','flag')),
  unit TEXT,
  is_candidate INTEGER NOT NULL DEFAULT 0,
  description TEXT
);

CREATE TABLE item_attribute (
  item_id TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  attribute_id TEXT NOT NULL REFERENCES attribute_def(id),
  value REAL,
  unit TEXT,
  source TEXT,
  confidence TEXT CHECK (confidence IN ('high','medium','low')),
  knowledge_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, attribute_id, knowledge_version)
);

CREATE VIRTUAL TABLE item_fts USING fts5(
  name, brand, notes,
  content='item', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE note_fts USING fts5(
  body, kind UNINDEXED, ref_id UNINDEXED, ts_utc UNINDEXED,
  tokenize='porter unicode61'
);

-- FTS synchronization. note_fts is deliberately contentful: its rowid namespace is
-- independent from the five source tables, avoiding cross-table rowid collisions.
CREATE TRIGGER item_ai AFTER INSERT ON item BEGIN
  INSERT INTO item_fts(rowid,name,brand,notes) VALUES(new.rowid,new.name,new.brand,new.notes);
END;
CREATE TRIGGER item_ad AFTER DELETE ON item BEGIN
  INSERT INTO item_fts(item_fts,rowid,name,brand,notes) VALUES('delete',old.rowid,old.name,old.brand,old.notes);
END;
CREATE TRIGGER item_au AFTER UPDATE ON item BEGIN
  INSERT INTO item_fts(item_fts,rowid,name,brand,notes) VALUES('delete',old.rowid,old.name,old.brand,old.notes);
  INSERT INTO item_fts(rowid,name,brand,notes) VALUES(new.rowid,new.name,new.brand,new.notes);
END;

CREATE TRIGGER meal_note_ai AFTER INSERT ON meal WHEN new.notes IS NOT NULL BEGIN
  INSERT INTO note_fts(body,kind,ref_id,ts_utc) VALUES(new.notes,'meal',new.id,new.ts_utc);
END;
CREATE TRIGGER meal_note_ad AFTER DELETE ON meal BEGIN
  DELETE FROM note_fts WHERE kind='meal' AND ref_id=old.id;
END;
CREATE TRIGGER meal_note_au AFTER UPDATE ON meal BEGIN
  DELETE FROM note_fts WHERE kind='meal' AND ref_id=old.id;
  INSERT INTO note_fts(body,kind,ref_id,ts_utc) SELECT new.notes,'meal',new.id,new.ts_utc WHERE new.notes IS NOT NULL;
  UPDATE note_fts SET ts_utc=new.ts_utc WHERE kind='consumption' AND ref_id IN (SELECT id FROM consumption_event WHERE meal_id=new.id);
END;

CREATE TRIGGER ce_note_ai AFTER INSERT ON consumption_event WHEN new.notes IS NOT NULL BEGIN
  INSERT INTO note_fts(body,kind,ref_id,ts_utc) SELECT new.notes,'consumption',new.id,ts_utc FROM meal WHERE id=new.meal_id;
END;
CREATE TRIGGER ce_note_ad AFTER DELETE ON consumption_event BEGIN DELETE FROM note_fts WHERE kind='consumption' AND ref_id=old.id; END;
CREATE TRIGGER ce_note_au AFTER UPDATE ON consumption_event BEGIN
  DELETE FROM note_fts WHERE kind='consumption' AND ref_id=old.id;
  INSERT INTO note_fts(body,kind,ref_id,ts_utc) SELECT new.notes,'consumption',new.id,ts_utc FROM meal WHERE id=new.meal_id AND new.notes IS NOT NULL;
END;

CREATE TRIGGER symptom_note_ai AFTER INSERT ON symptom_event WHEN new.notes IS NOT NULL BEGIN INSERT INTO note_fts(body,kind,ref_id,ts_utc) VALUES(new.notes,'symptom',new.id,new.ts_utc); END;
CREATE TRIGGER symptom_note_ad AFTER DELETE ON symptom_event BEGIN DELETE FROM note_fts WHERE kind='symptom' AND ref_id=old.id; END;
CREATE TRIGGER symptom_note_au AFTER UPDATE ON symptom_event BEGIN DELETE FROM note_fts WHERE kind='symptom' AND ref_id=old.id; INSERT INTO note_fts(body,kind,ref_id,ts_utc) SELECT new.notes,'symptom',new.id,new.ts_utc WHERE new.notes IS NOT NULL; END;
CREATE TRIGGER day_note_ai AFTER INSERT ON day_log WHEN new.notes IS NOT NULL BEGIN INSERT INTO note_fts(body,kind,ref_id,ts_utc) VALUES(new.notes,'day',new.local_date,new.local_date||'T00:00:00Z'); END;
CREATE TRIGGER day_note_ad AFTER DELETE ON day_log BEGIN DELETE FROM note_fts WHERE kind='day' AND ref_id=old.local_date; END;
CREATE TRIGGER day_note_au AFTER UPDATE ON day_log BEGIN DELETE FROM note_fts WHERE kind='day' AND ref_id=old.local_date; INSERT INTO note_fts(body,kind,ref_id,ts_utc) SELECT new.notes,'day',new.local_date,new.local_date||'T00:00:00Z' WHERE new.notes IS NOT NULL; END;
CREATE TRIGGER state_note_ai AFTER INSERT ON state_log WHEN new.notes IS NOT NULL BEGIN INSERT INTO note_fts(body,kind,ref_id,ts_utc) VALUES(new.notes,'state',new.local_date,new.local_date||'T00:00:00Z'); END;
CREATE TRIGGER state_note_ad AFTER DELETE ON state_log BEGIN DELETE FROM note_fts WHERE kind='state' AND ref_id=old.local_date; END;
CREATE TRIGGER state_note_au AFTER UPDATE ON state_log BEGIN DELETE FROM note_fts WHERE kind='state' AND ref_id=old.local_date; INSERT INTO note_fts(body,kind,ref_id,ts_utc) SELECT new.notes,'state',new.local_date,new.local_date||'T00:00:00Z' WHERE new.notes IS NOT NULL; END;

-- Server-only authentication state; migration version 1 extension.
CREATE TABLE auth_config (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB NOT NULL, password_hash BLOB NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE auth_session (token_hash BLOB PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE INDEX auth_session_expiry_idx ON auth_session(expires_at);
CREATE TABLE login_attempt (attempted_at TEXT NOT NULL, remote_addr TEXT NOT NULL, succeeded INTEGER NOT NULL);
CREATE INDEX login_attempt_idx ON login_attempt(remote_addr, attempted_at);
