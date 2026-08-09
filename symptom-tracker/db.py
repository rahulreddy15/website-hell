"""SQLite persistence, search, sync, authentication, and descriptive analysis."""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import math
import os
import secrets
import sqlite3
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SYMPTOM_TRACKER_DB", ROOT / "data" / "symptom_tracker.sqlite3"))
SCHEMA = ROOT / "schema.sql"
VERSION = 4
CANDIDATES = ["total_fat", "lactose", "caffeine", "alcohol", "polyols", "excess_fructose", "capsaicin", "artificial_sweetener", "high_fodmap", "gluten", "dairy", "fried", "spicy", "carbonation", "meal_size"]

TABLES = {
    "items": ("item", "id", ["id","name","kind","brand","barcode","is_raw","default_portion","attributes_reviewed","notes","archived","created_at","updated_at"]),
    "meals": ("meal", "id", ["id","ts_utc","tz_offset_min","label","context","location","notes","created_at","updated_at"]),
    "consumption_events": ("consumption_event", "id", ["id","meal_id","item_id","portion_ordinal","amount_g","portion_basis","prep_method","notes","created_at","updated_at"]),
    "symptom_events": ("symptom_event", "id", ["id","ts_utc","tz_offset_min","bristol","is_bm","urgency","volume","pain","nausea","bloating","incomplete","nocturnal","blood_flag","mucus_flag","accident_flag","notes","created_at","updated_at"]),
    "day_logs": ("day_log", "local_date", ["local_date","completeness","missing_kinds","nothing_eaten","notes","updated_at"]),
    "state_logs": ("state_log", "local_date", ["local_date","stress","sleep_hours","menstrual_phase","illness_flag","travel_flag","water_source","notes","updated_at"]),
}
DELETE_RESOURCES = {**{name: (table, key, "updated_at") for name, (table, key, _) in TABLES.items()},
                    "censor_windows": ("censor_window", "id", "created_at")}

def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")

def connect(path: Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(path or DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def ensure_schema(path: Path | None = None) -> None:
    target = path or DB_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    with connect(target) as conn:
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'").fetchone()
        if not exists:
            conn.executescript(SCHEMA.read_text())
            conn.execute("INSERT INTO schema_version VALUES(?,?)", (VERSION, now_iso()))
        current = conn.execute("SELECT COALESCE(MAX(version),0) FROM schema_version").fetchone()[0]
        if current > VERSION:
            raise RuntimeError(f"Database schema {current} is newer than server schema {VERSION}")
        if current < 2:
            conn.execute("ALTER TABLE item ADD COLUMN attributes_reviewed INTEGER NOT NULL DEFAULT 0")
            conn.executescript("CREATE TABLE tombstone (id TEXT NOT NULL, resource TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(resource,id)); CREATE INDEX tombstone_time_idx ON tombstone(deleted_at);")
            conn.execute("INSERT INTO schema_version VALUES(2,?)", (now_iso(),))
            current = 2
        if current < 3:
            # SQLite cannot remove NOT NULL in place. Rebuild only this table while
            # preserving raw rows and then restore its indexes and note-FTS triggers.
            conn.executescript("""
              DROP TRIGGER IF EXISTS symptom_note_ai; DROP TRIGGER IF EXISTS symptom_note_ad; DROP TRIGGER IF EXISTS symptom_note_au;
              ALTER TABLE symptom_event RENAME TO symptom_event_v2;
              CREATE TABLE symptom_event (
                id TEXT PRIMARY KEY, ts_utc TEXT NOT NULL, tz_offset_min INTEGER NOT NULL,
                bristol INTEGER CHECK (bristol IS NULL OR bristol BETWEEN 1 AND 7),
                is_bm INTEGER NOT NULL DEFAULT 1, urgency INTEGER CHECK (urgency BETWEEN 0 AND 3),
                volume TEXT CHECK (volume IN ('small','medium','large')), pain INTEGER CHECK (pain BETWEEN 0 AND 3),
                bloating INTEGER CHECK (bloating BETWEEN 0 AND 3), incomplete INTEGER, nocturnal INTEGER,
                blood_flag INTEGER, mucus_flag INTEGER, accident_flag INTEGER, notes TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                ts_epoch INTEGER GENERATED ALWAYS AS (unixepoch(ts_utc)) STORED,
                local_date TEXT GENERATED ALWAYS AS (date(ts_utc,(CASE WHEN tz_offset_min>=0 THEN '+' ELSE '-' END)||abs(tz_offset_min)||' minutes')) STORED);
              INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,is_bm,urgency,volume,pain,bloating,incomplete,nocturnal,blood_flag,mucus_flag,accident_flag,notes,created_at,updated_at)
                SELECT id,ts_utc,tz_offset_min,bristol,1,urgency,volume,pain,bloating,incomplete,nocturnal,blood_flag,mucus_flag,accident_flag,notes,created_at,updated_at FROM symptom_event_v2;
              DROP TABLE symptom_event_v2;
              CREATE INDEX se_ts_idx ON symptom_event(ts_epoch); CREATE INDEX se_date_idx ON symptom_event(local_date);
              CREATE TRIGGER symptom_note_ai AFTER INSERT ON symptom_event WHEN new.notes IS NOT NULL BEGIN INSERT INTO note_fts(body,kind,ref_id,ts_utc) VALUES(new.notes,'symptom',new.id,new.ts_utc); END;
              CREATE TRIGGER symptom_note_ad AFTER DELETE ON symptom_event BEGIN DELETE FROM note_fts WHERE kind='symptom' AND ref_id=old.id; END;
              CREATE TRIGGER symptom_note_au AFTER UPDATE ON symptom_event BEGIN DELETE FROM note_fts WHERE kind='symptom' AND ref_id=old.id; INSERT INTO note_fts(body,kind,ref_id,ts_utc) SELECT new.notes,'symptom',new.id,new.ts_utc WHERE new.notes IS NOT NULL; END;
            """)
            conn.execute("INSERT INTO schema_version VALUES(3,?)", (now_iso(),))
            current = 3
        if current < 4:
            conn.execute("ALTER TABLE symptom_event ADD COLUMN nausea INTEGER CHECK (nausea BETWEEN 0 AND 3)")
            conn.execute("INSERT INTO schema_version VALUES(4,?)", (now_iso(),))
        for candidate in CANDIDATES:
            conn.execute("INSERT OR IGNORE INTO attribute_def(id,label,kind,is_candidate,description) VALUES(?,?,'flag',1,?)", (candidate, candidate.replace('_',' ').title(), "Pre-registered v1 candidate"))

def as_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}

def validate_uuid(value: object) -> str:
    text = str(value or "")
    parsed = uuid.UUID(text)
    if parsed.version != 4:
        raise ValueError("id must be a UUIDv4")
    return text

def upsert(conn: sqlite3.Connection, resource: str, data: dict, validate_id: bool = True) -> str:
    table, key, allowed = TABLES[resource]
    if key == "id" and validate_id:
        validate_uuid(data.get(key))
    if key not in data:
        raise ValueError(f"{key} is required")
    if "updated_at" not in data:
        data = {**data, "updated_at": now_iso()}
    fields = [f for f in allowed if f in data]
    if not fields:
        raise ValueError("no writable fields")
    tombstone = conn.execute("SELECT deleted_at FROM tombstone WHERE resource=? AND id=?", (resource, data[key])).fetchone()
    if tombstone and str(tombstone[0]) >= str(data.get("updated_at", "")):
        return "stale"
    current = conn.execute(f"SELECT updated_at FROM {table} WHERE {key}=?", (data[key],)).fetchone()
    if current and str(current[0]) >= str(data.get("updated_at", "")):
        return "stale"
    if "missing_kinds" in data and data["missing_kinds"] is not None and not isinstance(data["missing_kinds"], str):
        raise ValueError("missing_kinds must be a JSON string")
    values = [data[f] for f in fields]
    updates = [f for f in fields if f != key and f not in ("created_at",)]
    sql = f"INSERT INTO {table} ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)}) ON CONFLICT({key}) DO UPDATE SET " + ",".join(f"{f}=excluded.{f}" for f in updates)
    conn.execute(sql, values)
    if tombstone:
        conn.execute("DELETE FROM tombstone WHERE resource=? AND id=?", (resource, data[key]))
    return "applied"

def apply_tombstone(conn: sqlite3.Connection, data: dict) -> str:
    resource = str(data.get("resource", "")); row_id = str(data.get("id", ""))
    deleted_at = str(data.get("deleted_at") or now_iso())
    old = conn.execute("SELECT deleted_at FROM tombstone WHERE resource=? AND id=?", (resource,row_id)).fetchone()
    if old and old[0] >= deleted_at:
        return "stale"
    if resource == "item_attributes":
        try:
            item_id, attribute, version_text = row_id.split("|", 2)
            validate_uuid(item_id); version = int(version_text)
        except (ValueError, TypeError) as exc:
            raise ValueError("item_attributes tombstone id must be <item_id>|<attribute_id>|<knowledge_version>") from exc
        if attribute not in CANDIDATES: raise ValueError("unknown candidate attribute")
        current=conn.execute("SELECT updated_at FROM item_attribute WHERE item_id=? AND attribute_id=? AND knowledge_version=?",(item_id,attribute,version)).fetchone()
        if current and current[0] > deleted_at: return "stale"
        conn.execute("DELETE FROM item_attribute WHERE item_id=? AND attribute_id=? AND knowledge_version=?",(item_id,attribute,version))
        conn.execute("INSERT INTO tombstone(resource,id,deleted_at) VALUES(?,?,?) ON CONFLICT(resource,id) DO UPDATE SET deleted_at=excluded.deleted_at",(resource,row_id,deleted_at))
        return "applied"
    if resource not in DELETE_RESOURCES:
        raise ValueError("unknown tombstone resource")
    if resource in ("day_logs","state_logs"):
        try: dt.date.fromisoformat(row_id)
        except ValueError as exc: raise ValueError(f"{resource} tombstone id must be YYYY-MM-DD") from exc
    else:
        validate_uuid(row_id)
    table, key, timestamp = DELETE_RESOURCES[resource]
    current = conn.execute(f"SELECT {timestamp} FROM {table} WHERE {key}=?", (row_id,)).fetchone()
    if current and current[0] > deleted_at:
        return "stale"
    conn.execute("INSERT INTO tombstone(resource,id,deleted_at) VALUES(?,?,?) ON CONFLICT(resource,id) DO UPDATE SET deleted_at=excluded.deleted_at", (resource,row_id,deleted_at))
    if resource == "items":
        conn.execute("UPDATE item SET archived=1,updated_at=? WHERE id=?", (deleted_at,row_id))
    else:
        conn.execute(f"DELETE FROM {table} WHERE {key}=?", (row_id,))
    return "applied"

def sync_push(conn: sqlite3.Connection, payload: dict) -> list[dict]:
    results = []
    # Parent-first order is required by foreign keys, independent of JSON key order.
    for resource in TABLES:
        for record in payload.get(resource, []):
            try:
                status = upsert(conn, resource, record)
                results.append({"id": record.get(TABLES[resource][1]), "status": status})
            except (ValueError, TypeError, sqlite3.Error) as exc:
                results.append({"id": record.get(TABLES[resource][1]), "status": "rejected", "error": str(exc)})
    for record in payload.get("item_attributes", []):
        try:
            status=upsert_item_attribute(conn,record)
            results.append({"id":attribute_record_id(record),"resource":"item_attributes","status":status})
        except (ValueError, TypeError, sqlite3.Error) as exc:
            results.append({"id":attribute_record_id(record),"resource":"item_attributes","status":"rejected","error":str(exc)})
    for record in payload.get("censor_windows", []):
        try:
            status=upsert_censor(conn,record)
            results.append({"id":record.get("id"),"resource":"censor_windows","status":status})
        except (ValueError, TypeError, sqlite3.Error) as exc:
            results.append({"id":record.get("id"),"resource":"censor_windows","status":"rejected","error":str(exc)})
    for record in payload.get("tombstones", []):
        try:
            results.append({"id":record.get("id"),"resource":record.get("resource"),"status":apply_tombstone(conn,record)})
        except (ValueError, TypeError, sqlite3.Error) as exc:
            results.append({"id":record.get("id"),"resource":record.get("resource"),"status":"rejected","error":str(exc)})
    return results

def sync_pull(conn: sqlite3.Connection, since: str) -> dict:
    result = {}
    for resource, (table, _, _) in TABLES.items():
        result[resource] = [as_dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE updated_at>? ORDER BY updated_at", (since,))]
    result["item_attributes"] = [as_dict(r) for r in conn.execute("SELECT * FROM item_attribute WHERE updated_at>? ORDER BY updated_at",(since,))]
    result["censor_windows"] = [as_dict(r) for r in conn.execute("SELECT * FROM censor_window WHERE created_at>? ORDER BY created_at",(since,))]
    result["tombstones"] = [as_dict(r) for r in conn.execute("SELECT * FROM tombstone WHERE deleted_at>? ORDER BY deleted_at", (since,))]
    return result

def attribute_record_id(data: dict) -> str:
    return f"{data.get('item_id','')}|{data.get('attribute_id','')}|{data.get('knowledge_version',1)}"

def upsert_item_attribute(conn: sqlite3.Connection, data: dict) -> str:
    item_id=validate_uuid(data.get("item_id")); attribute=str(data.get("attribute_id", ""))
    if not attribute and "attributes_reviewed" in data:
        updated=str(data.get("updated_at") or now_iso())
        current=conn.execute("SELECT updated_at FROM item WHERE id=?",(item_id,)).fetchone()
        if not current: raise ValueError("item not found")
        if current[0] >= updated: return "stale"
        conn.execute("UPDATE item SET attributes_reviewed=?,updated_at=? WHERE id=?",(int(bool(data["attributes_reviewed"])),updated,item_id))
        return "applied"
    if attribute not in CANDIDATES: raise ValueError("attribute_id must be a candidate")
    version=int(data.get("knowledge_version",1)); updated=str(data.get("updated_at") or now_iso())
    tombstone_id=f"{item_id}|{attribute}|{version}"
    tombstone=conn.execute("SELECT deleted_at FROM tombstone WHERE resource='item_attributes' AND id=?",(tombstone_id,)).fetchone()
    if tombstone and tombstone[0] >= updated: return "stale"
    current=conn.execute("SELECT updated_at FROM item_attribute WHERE item_id=? AND attribute_id=? AND knowledge_version=?",(item_id,attribute,version)).fetchone()
    if current and current[0] >= updated: return "stale"
    fields=["item_id","attribute_id","value","unit","source","confidence","knowledge_version","updated_at"]
    values=[item_id,attribute,data.get("value"),data.get("unit"),data.get("source","manual"),data.get("confidence"),version,updated]
    conn.execute(f"INSERT INTO item_attribute({','.join(fields)}) VALUES({','.join('?' for _ in fields)}) ON CONFLICT(item_id,attribute_id,knowledge_version) DO UPDATE SET value=excluded.value,unit=excluded.unit,source=excluded.source,confidence=excluded.confidence,updated_at=excluded.updated_at",values)
    if tombstone: conn.execute("DELETE FROM tombstone WHERE resource='item_attributes' AND id=?",(tombstone_id,))
    return "applied"

def upsert_censor(conn: sqlite3.Connection, data: dict) -> str:
    row_id=validate_uuid(data.get("id")); created=str(data.get("created_at") or now_iso())
    current=conn.execute("SELECT created_at FROM censor_window WHERE id=?",(row_id,)).fetchone()
    if current and current[0] >= created: return "stale"
    fields=["id","start_utc","end_utc","reason","notes","created_at"]
    conn.execute(f"INSERT INTO censor_window({','.join(fields)}) VALUES({','.join('?' for _ in fields)}) ON CONFLICT(id) DO UPDATE SET start_utc=excluded.start_utc,end_utc=excluded.end_utc,reason=excluded.reason,notes=excluded.notes,created_at=excluded.created_at",[data.get(x) for x in fields])
    return "applied"

def item_attributes(conn: sqlite3.Connection, item_id: str) -> dict:
    item=conn.execute("SELECT id,name,attributes_reviewed,updated_at FROM item WHERE id=?",(item_id,)).fetchone()
    if not item: raise ValueError("item not found")
    tags={r["attribute_id"]:r["value"] for r in conn.execute("SELECT attribute_id,value FROM item_attribute WHERE item_id=? AND knowledge_version=1",(item_id,))}
    return {"item_id":item_id,"name":item["name"],"attributes_reviewed":item["attributes_reviewed"],"attributes":tags,"updated_at":item["updated_at"]}

def set_item_attributes(conn: sqlite3.Connection, item_id: str, payload: dict) -> dict:
    validate_uuid(item_id); tags=payload.get("attributes",{})
    if not isinstance(tags,dict): raise ValueError("attributes must be an object")
    unknown=set(tags)-set(CANDIDATES)
    if unknown: raise ValueError(f"unknown candidate attributes: {', '.join(sorted(unknown))}")
    stamp=str(payload.get("updated_at") or now_iso())
    for attribute,value in tags.items():
        upsert_item_attribute(conn,{"item_id":item_id,"attribute_id":attribute,"value":value,"source":"manual","knowledge_version":1,"updated_at":stamp})
    if "attributes_reviewed" in payload:
        conn.execute("UPDATE item SET attributes_reviewed=?,updated_at=? WHERE id=?",(int(bool(payload["attributes_reviewed"])),stamp,item_id))
    return item_attributes(conn,item_id)

def attributes_coverage(conn: sqlite3.Connection) -> list[dict]:
    logged=conn.execute("SELECT count(DISTINCT ce.item_id) FROM consumption_event ce JOIN item i ON i.id=ce.item_id WHERE i.archived=0").fetchone()[0]
    result=[]
    for row in conn.execute("SELECT * FROM attribute_def WHERE is_candidate=1 ORDER BY label"):
        tagged=conn.execute("SELECT count(DISTINCT ia.item_id) FROM item_attribute ia JOIN consumption_event ce ON ce.item_id=ia.item_id WHERE ia.attribute_id=? AND ia.value IS NOT NULL AND ia.value!=0",(row["id"],)).fetchone()[0]
        unreviewed=conn.execute("SELECT count(DISTINCT ce.item_id) FROM consumption_event ce JOIN item i ON i.id=ce.item_id LEFT JOIN item_attribute ia ON ia.item_id=i.id AND ia.attribute_id=? WHERE i.attributes_reviewed=0 AND ia.item_id IS NULL",(row["id"],)).fetchone()[0]
        result.append({**as_dict(row),"logged_items":logged,"tagged_items":tagged,"unreviewed_items":unreviewed})
    return result

def review_queue(conn: sqlite3.Connection, limit: int = 20) -> list[dict]:
    now=conn.execute("SELECT unixepoch('now')").fetchone()[0]
    rows=conn.execute("""SELECT i.id,i.name,i.kind,i.attributes_reviewed,count(ce.id) n_consumptions,max(m.ts_epoch) last_used_epoch,max(m.ts_utc) last_used
      FROM item i JOIN consumption_event ce ON ce.item_id=i.id JOIN meal m ON m.id=ce.meal_id
      WHERE i.archived=0 AND i.attributes_reviewed=0 GROUP BY i.id""").fetchall()
    queue=[]
    for row in rows:
        blocked_ids={r[0] for r in conn.execute("""SELECT DISTINCT s.id FROM symptom_event s
          WHERE s.is_bm=1 AND s.bristol IS NOT NULL AND EXISTS (
            SELECT 1 FROM meal m JOIN consumption_event ce ON ce.meal_id=m.id
            WHERE ce.item_id=? AND m.ts_epoch BETWEEN s.ts_epoch-172800 AND s.ts_epoch)""",(row["id"],))}
        unlocks=0
        for symptom_id in blocked_ids:
            other=conn.execute("""SELECT 1 FROM symptom_event s JOIN meal m ON m.ts_epoch BETWEEN s.ts_epoch-172800 AND s.ts_epoch
              JOIN consumption_event ce ON ce.meal_id=m.id JOIN item i ON i.id=ce.item_id
              WHERE s.id=? AND i.attributes_reviewed=0 AND i.id!=? LIMIT 1""",(symptom_id,row["id"])).fetchone()
            if not other: unlocks+=1
        blocked=len(blocked_ids); recency=1.0/(1.0+max(0,now-row["last_used_epoch"])/86400.0/30.0)
        score=row["n_consumptions"]*recency*(1+blocked)
        queue.append({"id":row["id"],"name":row["name"],"kind":row["kind"],"attributes_reviewed":row["attributes_reviewed"],
                      "n_consumptions":row["n_consumptions"],"blocks":blocked,"unlocks":unlocks,
                      "review_score":score,"last_used":row["last_used"]})
    return sorted(queue,key=lambda x:(-x["review_score"],x["name"].casefold()))[:max(0,min(limit,100))]

def review_impact(conn: sqlite3.Connection, top_n: int = 6) -> dict:
    top_n=max(0,min(top_n,100))
    queue=review_queue(conn,100)
    symptom_ids={r[0] for r in conn.execute("SELECT id FROM symptom_event WHERE is_bm=1 AND bristol IS NOT NULL")}
    simulated={item["id"] for item in queue[:top_n]}
    def unknown_for(attribute: str, reviewed: set[str]) -> set[str]:
        unknown=set()
        for symptom_id in symptom_ids:
            items=conn.execute("""SELECT DISTINCT i.id,i.attributes_reviewed,
              MAX(CASE WHEN ia.attribute_id=? AND ia.value IS NOT NULL AND ia.value!=0 THEN 1 ELSE 0 END) exposed,
              MAX(CASE WHEN ia.attribute_id=? AND ia.value=0 THEN 1 ELSE 0 END) explicit_zero
              FROM symptom_event s JOIN meal m ON m.ts_epoch BETWEEN s.ts_epoch-172800 AND s.ts_epoch
              JOIN consumption_event ce ON ce.meal_id=m.id JOIN item i ON i.id=ce.item_id LEFT JOIN item_attribute ia ON ia.item_id=i.id
              WHERE s.id=? GROUP BY i.id""",(attribute,attribute,symptom_id)).fetchall()
            if not any(x["exposed"] for x in items) and not all(x["attributes_reviewed"] or x["explicit_zero"] or x["id"] in reviewed for x in items): unknown.add(symptom_id)
        return unknown
    before=[unknown_for(attribute,set()) for attribute in CANDIDATES]; after=[unknown_for(attribute,simulated) for attribute in CANDIDATES]
    n_unknown=max((len(ids) for ids in before),default=0); n_after=max((len(ids) for ids in after),default=0); total=len(symptom_ids)
    return {"n_total_observations":total,"n_unknown_exposure":n_unknown,"n_classified":total-n_unknown,
            "n_would_become_analyzable":max(0,n_unknown-n_after),"top_n":min(top_n,len(queue))}

def set_password(conn: sqlite3.Connection, password: str) -> None:
    if not password:
        raise ValueError("password must not be empty")
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    conn.execute("INSERT INTO auth_config VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,password_hash=excluded.password_hash,updated_at=excluded.updated_at", (salt, digest, now_iso()))
    conn.execute("DELETE FROM auth_session")

def verify_password(conn: sqlite3.Connection, password: str) -> bool:
    row = conn.execute("SELECT salt,password_hash FROM auth_config WHERE id=1").fetchone()
    if not row:
        return False
    supplied = hashlib.scrypt(password.encode(), salt=row["salt"], n=2**14, r=8, p=1)
    return hmac.compare_digest(supplied, row["password_hash"])

def create_session(conn: sqlite3.Connection) -> str:
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode()).digest()
    now = dt.datetime.now(dt.timezone.utc)
    conn.execute("INSERT INTO auth_session VALUES(?,?,?,?)", (digest, (now+dt.timedelta(days=30)).isoformat(), now.isoformat(), now.isoformat()))
    return token

def validate_session(conn: sqlite3.Connection, token: str) -> bool:
    supplied = hashlib.sha256(token.encode()).digest()
    now = dt.datetime.now(dt.timezone.utc)
    conn.execute("DELETE FROM auth_session WHERE expires_at<=?", (now.isoformat(),))
    for row in conn.execute("SELECT token_hash FROM auth_session"):
        if hmac.compare_digest(supplied, row[0]):
            conn.execute("UPDATE auth_session SET expires_at=?,last_seen_at=? WHERE token_hash=?", ((now+dt.timedelta(days=30)).isoformat(), now.isoformat(), row[0]))
            return True
    return False

def login_allowed(conn: sqlite3.Connection, remote: str) -> bool:
    cutoff = (dt.datetime.now(dt.timezone.utc)-dt.timedelta(minutes=15)).isoformat()
    return conn.execute("SELECT count(*) FROM login_attempt WHERE remote_addr=? AND succeeded=0 AND attempted_at>?", (remote, cutoff)).fetchone()[0] < 5

def search(conn: sqlite3.Connection, params: dict) -> list[dict]:
    one = lambda key, default="": params.get(key, [default])[0]
    q, date_from, date_to, kind, item_id = (one("q").strip(), one("from"), one("to"), one("kind"), one("item_id"))
    has_bristol = "bristol_min" in params or "bristol_max" in params
    bmin, bmax = int(one("bristol_min", "1")), int(one("bristol_max", "7"))
    limit, offset = min(int(one("limit", "50")), 200), int(one("offset", "0"))
    hits = []
    if q:
        for r in conn.execute("SELECT i.*,snippet(item_fts,0,'<mark>','</mark>',' … ',12) snippet FROM item_fts JOIN item i ON i.rowid=item_fts.rowid WHERE item_fts MATCH ?", (q,)):
            if (not kind or kind == "item") and (not item_id or r["id"] == item_id) and not has_bristol:
                hits.append({"type":"item","id":r["id"],"ts_utc":r["updated_at"],"snippet":r["snippet"],"name":r["name"]})
        for r in conn.execute("SELECT kind,ref_id,ts_utc,snippet(note_fts,0,'<mark>','</mark>',' … ',12) snippet FROM note_fts WHERE note_fts MATCH ?", (q,)):
            hit={"type":"note","source_type":r["kind"],"id":r["ref_id"],"ts_utc":r["ts_utc"],"snippet":r["snippet"]}
            if r["kind"] == "symptom":
                symptom=conn.execute("SELECT bristol FROM symptom_event WHERE id=?",(r["ref_id"],)).fetchone()
                if symptom: hit["bristol"]=symptom[0]
            if r["kind"] == "consumption":
                ce=conn.execute("SELECT item_id FROM consumption_event WHERE id=?",(r["ref_id"],)).fetchone()
                if ce: hit["item_ids"]=[ce[0]]
            if r["kind"] == "meal":
                hit["item_ids"]=[x[0] for x in conn.execute("SELECT item_id FROM consumption_event WHERE meal_id=?",(r["ref_id"],))]
            hits.append(hit)
    # Personal-scale implementation: pure facet browsing materializes all events before
    # filtering. Push these predicates into SQL if this is ever used for multi-user data.
    # Structured event browsing is also included when q is empty; with q, only matching
    # notes/items survive, and event facets filter those hits below.
    if not q:
        if kind == "item" or item_id:
            for r in conn.execute("SELECT * FROM item WHERE archived=0" + (" AND id=?" if item_id else ""), ((item_id,) if item_id else ())):
                hits.append({"type":"item","id":r["id"],"ts_utc":r["updated_at"],"snippet":r["name"],"name":r["name"]})
        meal_sql = "SELECT m.*,group_concat(ce.item_id) item_ids FROM meal m LEFT JOIN consumption_event ce ON ce.meal_id=m.id GROUP BY m.id"
        for r in conn.execute(meal_sql):
            hits.append({"type":"meal","id":r["id"],"ts_utc":r["ts_utc"],"snippet":r["notes"] or r["label"] or "","item_ids":(r["item_ids"] or "").split(',')})
        for r in conn.execute("SELECT * FROM symptom_event WHERE bristol BETWEEN ? AND ?", (bmin,bmax)):
            hits.append({"type":"symptom","id":r["id"],"ts_utc":r["ts_utc"],"snippet":r["notes"] or f"Bristol {r['bristol']}","bristol":r["bristol"]})
    filtered=[]
    for h in hits:
        if date_from and (h.get("ts_utc") or "") < date_from: continue
        if date_to and (h.get("ts_utc") or "") > date_to + ("T23:59:59Z" if "T" not in date_to else ""): continue
        if kind and h["type"] != kind and h.get("source_type") != kind: continue
        if item_id and h["type"] == "item" and h["id"] != item_id: continue
        if item_id and h["type"] != "item" and item_id not in h.get("item_ids",[]): continue
        if has_bristol and "bristol" not in h: continue
        if "bristol" in h and not bmin <= h["bristol"] <= bmax: continue
        filtered.append(h)
    return sorted(filtered, key=lambda x:x.get("ts_utc") or "", reverse=True)[offset:offset+limit]

def wilson(success: int, total: int) -> list[float | None]:
    if not total: return [None, None]
    z=1.959963984540054; p=success/total; d=1+z*z/total
    c=(p+z*z/(2*total))/d; m=z*math.sqrt((p*(1-p)+z*z/(4*total))/total)/d
    return [c-m,c+m]

def rates(conn: sqlite3.Connection, attribute: str, lag_from: float, lag_to: float, _compute_tier: bool = True) -> dict:
    if attribute not in CANDIDATES: raise ValueError("attribute must be a pre-registered candidate")
    if lag_from < 0 or lag_to <= lag_from: raise ValueError("invalid lag window")
    rows=conn.execute("SELECT s.*,d.completeness FROM symptom_event s LEFT JOIN day_log d ON d.local_date=s.local_date WHERE s.is_bm=1 AND s.bristol IS NOT NULL ORDER BY s.ts_epoch").fetchall()
    censors=conn.execute("SELECT unixepoch(start_utc),unixepoch(end_utc) FROM censor_window").fetchall()
    observations=[]; excluded=0; unknown_completeness=0
    for s in rows:
        comp=s["completeness"]
        if comp in ("partial","declined"): excluded+=1; continue
        start=s["ts_epoch"]-lag_to*3600; end=s["ts_epoch"]-lag_from*3600
        if any(a <= s["ts_epoch"] and b >= start for a,b in censors): excluded+=1; continue
        if comp not in ("complete","mostly"): unknown_completeness+=1
        items=conn.execute("""SELECT DISTINCT i.id,i.attributes_reviewed,
          MAX(CASE WHEN ia.attribute_id=? AND ia.value IS NOT NULL AND ia.value!=0 THEN 1 ELSE 0 END) exposed,
          MAX(CASE WHEN ia.attribute_id=? AND ia.value=0 THEN 1 ELSE 0 END) explicit_zero
          FROM meal m JOIN consumption_event ce ON ce.meal_id=m.id JOIN item i ON i.id=ce.item_id
          LEFT JOIN item_attribute ia ON ia.item_id=i.id
          WHERE m.ts_epoch BETWEEN ? AND ? GROUP BY i.id""", (attribute,attribute,start,end)).fetchall()
        if any(item["exposed"] for item in items): classification="exposed"
        elif all(item["attributes_reviewed"] or item["explicit_zero"] for item in items): classification="unexposed"
        else: classification="unknown"
        observations.append((classification, int(s["bristol"]>=6), comp in ("complete","mostly")))

    def summarize(include_unknown_completeness: bool) -> dict:
        selected=[x for x in observations if include_unknown_completeness or x[2]]
        exposed=[x for x in selected if x[0]=="exposed"]
        unexposed=[x for x in selected if x[0]=="unexposed"]
        unknown_exposure=sum(x[0]=="unknown" for x in selected)
        eo=sum(x[1] for x in exposed); uo=sum(x[1] for x in unexposed)
        return {"exposed":{"events":len(exposed),"outcomes":eo,"rate":eo/len(exposed) if exposed else None,"wilson_95":wilson(eo,len(exposed))},
                "unexposed":{"events":len(unexposed),"outcomes":uo,"rate":uo/len(unexposed) if unexposed else None,"wilson_95":wilson(uo,len(unexposed))},
                "n_exposed":len(exposed),"n_unexposed":len(unexposed),"n_unknown_exposure":unknown_exposure}

    primary=summarize(False); sensitivity=summarize(True)
    warnings=[]
    if unknown_completeness: warnings.append(f"Primary result excludes {unknown_completeness} events on unsure, unanswered, or missing-completeness days; sensitivity includes them.")
    if excluded: warnings.append(f"Excluded {excluded} events due to incomplete days or censor-window overlap.")
    if primary["n_unknown_exposure"]: warnings.append(f"Excluded {primary['n_unknown_exposure']} known-completeness events because one or more items lacked reviewed attribute data.")
    if not primary["n_exposed"] and not primary["n_unexposed"]:
        warnings.append("No analyzable known-completeness observations remain; this is insufficient reviewed data, not evidence of no association.")
    elif not primary["n_exposed"] or not primary["n_unexposed"]:
        warnings.append("Both exposed and unexposed reviewed observations are required; this is insufficient data, not evidence of no association.")
    enough=primary["n_exposed"]>=10 and primary["n_unexposed"]>=10
    difference=(primary["exposed"]["rate"]-primary["unexposed"]["rate"]) if enough else None
    tier="suggestive" if difference is not None and abs(difference)>=0.15 else ("observed" if enough else "unclear")
    if _compute_tier and enough:
        signs=[]
        for start,end in ((0,6),(6,24),(24,48)):
            other=rates(conn,attribute,start,end,False)
            if other["n_exposed"]>=10 and other["n_unexposed"]>=10:
                delta=other["exposed"]["rate"]-other["unexposed"]["rate"]
                if abs(delta)>=0.15: signs.append(1 if delta>0 else -1)
        if 1 in signs and -1 in signs: tier="contradictory"
    return {"attribute":attribute,"outcome":"bristol67","lag_from_h":lag_from,"lag_to_h":lag_to,**primary,
            "sensitivity":{"includes_unknown_completeness":True,**sensitivity},"evidence_tier":tier,
            "identifiable":bool(primary["n_exposed"] and primary["n_unexposed"]),"unknown_completeness_events":unknown_completeness,
            "warnings":warnings,"disclaimer":"Descriptive association only. Not a causal claim."}

def cooccurrence(conn: sqlite3.Connection, minimum: int) -> dict:
    attrs={r[0] for r in conn.execute("SELECT id FROM attribute_def WHERE is_candidate=1")}
    meal_sets={}
    for r in conn.execute("SELECT m.id,ia.attribute_id FROM meal m JOIN consumption_event ce ON ce.meal_id=m.id JOIN item_attribute ia ON ia.item_id=ce.item_id WHERE ia.value IS NOT NULL AND ia.value!=0"):
        meal_sets.setdefault(r[0],set()).add(r[1])
    pairs=[]
    names=sorted(attrs)
    for i,a in enumerate(names):
        for b in names[i+1:]:
            both=sum(a in s and b in s for s in meal_sets.values()); a_only=sum(a in s and b not in s for s in meal_sets.values()); b_only=sum(b in s and a not in s for s in meal_sets.values())
            if both>=minimum: pairs.append({"attribute_a":a,"attribute_b":b,"cooccurring":both,"a_only":a_only,"b_only":b_only,"discordant":a_only+b_only})
    warnings=[f"{p['attribute_a']} and {p['attribute_b']} have only {p['discordant']} discordant meals; associations may not be separable." for p in pairs if p["discordant"]<3]
    n=sum(len(s)>0 for s in meal_sets.values())
    return {"pairs":pairs,"evidence_tier":"observed" if pairs and not warnings else "unclear","n_exposed":n,"n_unexposed":max(0,len(meal_sets)-n),"n_unknown_exposure":0,"identifiable":not warnings,"warnings":warnings,"disclaimer":"Descriptive association only. Not a causal claim."}
