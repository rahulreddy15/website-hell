#!/usr/bin/env python3
"""Authenticated stdlib HTTP server for the Symptom Tracker PWA."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import mimetypes
import os
import sqlite3
import traceback
import uuid
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import db as store

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8011"))
BASE_PATH = os.environ.get("BASE_PATH", "/tracker").rstrip("/")

def one(query: dict, name: str, default: str = "") -> str:
    return query.get(name, [default])[0]

def bounds(query: dict, column: str = "ts_utc") -> tuple[str, list]:
    clauses=[]; values=[]
    if one(query,"from"): clauses.append(f"{column}>=?"); values.append(one(query,"from"))
    if one(query,"to"): clauses.append(f"{column}<=?"); values.append(one(query,"to") + ("T23:59:59Z" if "T" not in one(query,"to") else ""))
    return (" AND ".join(clauses) or "1=1", values)

class Handler(BaseHTTPRequestHandler):
    server_version = "SymptomTracker/1.0"

    def send_json(self, payload: object, status: int = 200, headers: dict | None = None) -> None:
        body=json.dumps(payload,ensure_ascii=False).encode()
        self.send_response(status); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(body)))
        for key,value in (headers or {}).items(): self.send_header(key,value)
        self.end_headers(); self.wfile.write(body)

    def read_json(self) -> dict:
        length=int(self.headers.get("Content-Length","0") or 0)
        if length > 2_000_000: raise ValueError("request body too large")
        value=json.loads(self.rfile.read(length).decode() or "{}")
        if not isinstance(value,dict): raise ValueError("JSON body must be an object")
        return value

    def strip_base(self, path: str) -> str:
        if BASE_PATH and (path == BASE_PATH or path.startswith(BASE_PATH+"/")): return path[len(BASE_PATH):] or "/"
        return path

    def session_token(self) -> str:
        jar=cookies.SimpleCookie(); jar.load(self.headers.get("Cookie", ""))
        return jar["symptom_session"].value if "symptom_session" in jar else ""

    def require_auth(self, conn: sqlite3.Connection, path: str) -> bool:
        if path.startswith("/api/auth/"): return True
        if not store.validate_session(conn,self.session_token()):
            self.send_json({"error":"Authentication required"},401); return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        self.dispatch("GET")
    def do_POST(self) -> None:  # noqa: N802
        self.dispatch("POST")
    def do_PUT(self) -> None:  # noqa: N802
        self.dispatch("PUT")
    def do_DELETE(self) -> None:  # noqa: N802
        self.dispatch("DELETE")

    def dispatch(self, method: str) -> None:
        try:
            parsed=urlparse(self.path); path=self.strip_base(parsed.path)
            if not path.startswith("/api/"): self.serve_static(path); return
            payload=self.read_json() if method in ("POST","PUT") else {}
            with store.connect() as conn:
                if not self.require_auth(conn,path): return
                if method=="GET": self.route_get(conn,path,parse_qs(parsed.query)); return
                self.route_write(conn,method,path,payload)
        except (ValueError,KeyError,json.JSONDecodeError,sqlite3.IntegrityError) as exc:
            self.send_json({"error":str(exc)},400)
        except Exception:
            traceback.print_exc(); self.send_json({"error":"Internal server error"},500)

    # Routing table: all API reads.
    def route_get(self, conn: sqlite3.Connection, path: str, query: dict) -> None:
        parts=path.strip("/").split("/")
        if path=="/api/auth/session":
            self.send_json({"authenticated":store.validate_session(conn,self.session_token()),"configured":bool(conn.execute("SELECT 1 FROM auth_config").fetchone())}); return
        if path=="/api/sync": self.send_json(store.sync_pull(conn,one(query,"since","1970-01-01T00:00:00Z"))); return
        if path=="/api/search": self.send_json({"results":store.search(conn,query)}); return
        if path=="/api/items": self.send_json({"items":self.list_items(conn,query)}); return
        if path=="/api/attributes": self.send_json({"attributes":store.attributes_coverage(conn)}); return
        if path=="/api/review/queue": self.send_json({"items":store.review_queue(conn,int(one(query,"limit","20")))}); return
        if path=="/api/review/impact": self.send_json(store.review_impact(conn,int(one(query,"top_n","6")))); return
        if len(parts)==4 and parts[:2]==["api","items"] and parts[3]=="attributes": self.send_json(store.item_attributes(conn,parts[2])); return
        if len(parts)==3 and parts[:2]==["api","items"]:
            row=conn.execute("SELECT * FROM item WHERE id=?",(parts[2],)).fetchone(); self.send_json({"item":store.as_dict(row)} if row else {"error":"Not found"},200 if row else 404); return
        if path=="/api/meals":
            clause,args=bounds(query); rows=[]
            for row in conn.execute(f"SELECT * FROM meal WHERE {clause} ORDER BY ts_epoch DESC",args):
                value=store.as_dict(row); value["consumption_events"]=[store.as_dict(x) for x in conn.execute("SELECT * FROM consumption_event WHERE meal_id=?",(row["id"],))]; rows.append(value)
            self.send_json({"meals":rows}); return
        if path=="/api/symptoms":
            clause,args=bounds(query); self.send_json({"symptoms":[store.as_dict(r) for r in conn.execute(f"SELECT * FROM symptom_event WHERE {clause} ORDER BY ts_epoch DESC",args)]}); return
        if path=="/api/days":
            clause,args=bounds(query,"d.local_date"); sql=f"SELECT d.*,s.stress,s.sleep_hours,s.menstrual_phase,s.illness_flag,s.travel_flag,s.water_source,s.notes state_notes,s.updated_at state_updated_at FROM day_log d LEFT JOIN state_log s USING(local_date) WHERE {clause} ORDER BY d.local_date DESC"
            self.send_json({"days":[store.as_dict(r) for r in conn.execute(sql,args)]}); return
        if path=="/api/censor": self.send_json({"censor_windows":[store.as_dict(r) for r in conn.execute("SELECT * FROM censor_window ORDER BY start_utc DESC")]}); return
        if path=="/api/timeline": self.send_json(self.timeline(conn,query)); return
        if path=="/api/analysis/rates":
            if one(query,"outcome","bristol67")!="bristol67": raise ValueError("only bristol67 is supported")
            self.send_json(store.rates(conn,one(query,"attribute"),float(one(query,"lag_from_h","0")),float(one(query,"lag_to_h","6")))); return
        if path=="/api/analysis/cooccurrence": self.send_json(store.cooccurrence(conn,int(one(query,"min_count","1")))); return
        self.send_json({"error":"Not found"},404)

    # Routing table: authenticated writes and auth endpoints.
    def route_write(self, conn: sqlite3.Connection, method: str, path: str, payload: dict) -> None:
        parts=path.strip("/").split("/")
        if method=="POST" and path=="/api/auth/login":
            remote=self.client_address[0]
            if not store.login_allowed(conn,remote): self.send_json({"error":"Too many login attempts"},429); return
            ok=store.verify_password(conn,str(payload.get("password",""))); conn.execute("INSERT INTO login_attempt VALUES(?,?,?)",(store.now_iso(),remote,int(ok)))
            if not ok: print(f"Failed symptom-tracker login from {remote}"); self.send_json({"error":"Invalid credentials"},401); return
            token=store.create_session(conn); self.send_json({"authenticated":True},headers={"Set-Cookie":f"symptom_session={token}; Path={BASE_PATH or '/'}; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict"}); return
        if method=="POST" and path=="/api/auth/logout":
            token=self.session_token()
            if token:
                import hashlib
                import hmac
                supplied=hashlib.sha256(token.encode()).digest()
                for row in conn.execute("SELECT token_hash FROM auth_session"):
                    if hmac.compare_digest(supplied,row[0]):
                        conn.execute("DELETE FROM auth_session WHERE token_hash=?",(row[0],)); break
            self.send_json({"authenticated":False},headers={"Set-Cookie":f"symptom_session=; Path={BASE_PATH or '/'}; Max-Age=0; HttpOnly; Secure; SameSite=Strict"}); return
        if method=="POST" and path=="/api/sync": self.send_json({"results":store.sync_push(conn,payload)}); return
        if method=="POST" and path=="/api/items": self.send_json({"status":store.upsert(conn,"items",payload),"id":payload.get("id")},201); return
        if method=="PUT" and len(parts)==4 and parts[:2]==["api","items"] and parts[3]=="attributes": self.send_json(store.set_item_attributes(conn,parts[2],payload)); return
        if method=="DELETE" and len(parts)==3 and parts[:2]==["api","items"]:
            deleted_at=store.now_iso(); status=store.apply_tombstone(conn,{"resource":"items","id":parts[2],"deleted_at":deleted_at}); self.send_json({"ok":True,"status":status,"deleted_at":deleted_at}); return
        if method=="POST" and path=="/api/meals":
            events=payload.pop("consumption_events",[]); status=store.upsert(conn,"meals",payload)
            for event in events: store.upsert(conn,"consumption_events",event)
            self.send_json({"id":payload["id"],"status":status},201); return
        if method=="DELETE" and len(parts)==3 and parts[:2]==["api","meals"]:
            deleted_at=store.now_iso(); status=store.apply_tombstone(conn,{"resource":"meals","id":parts[2],"deleted_at":deleted_at}); self.send_json({"ok":True,"status":status,"deleted_at":deleted_at}); return
        if method=="POST" and path=="/api/symptoms": self.send_json({"id":payload.get("id"),"status":store.upsert(conn,"symptom_events",payload)},201); return
        if method=="DELETE" and len(parts)==3 and parts[:2]==["api","symptoms"]:
            deleted_at=store.now_iso(); status=store.apply_tombstone(conn,{"resource":"symptom_events","id":parts[2],"deleted_at":deleted_at}); self.send_json({"ok":True,"status":status,"deleted_at":deleted_at}); return
        if method=="POST" and len(parts)==3 and parts[:2]==["api","days"]:
            date=parts[2]; day={**payload.get("day_log",{}),"local_date":date}; state={**payload.get("state_log",{}),"local_date":date}
            results={"day_log":store.upsert(conn,"day_logs",day,False)}
            if payload.get("state_log") is not None: results["state_log"]=store.upsert(conn,"state_logs",state,False)
            self.send_json(results); return
        if method=="POST" and path=="/api/censor":
            self.send_json({"id":payload.get("id"),"status":store.upsert_censor(conn,payload)},201); return
        if method=="DELETE" and len(parts)==3 and parts[:2]==["api","censor"]:
            deleted_at=store.now_iso(); status=store.apply_tombstone(conn,{"resource":"censor_windows","id":parts[2],"deleted_at":deleted_at}); self.send_json({"ok":True,"status":status,"deleted_at":deleted_at}); return
        self.send_json({"error":"Not found"},404)

    def list_items(self, conn: sqlite3.Connection, query: dict) -> list[dict]:
        q=one(query,"q"); kind=one(query,"kind"); limit=min(int(one(query,"limit","30")),100)
        where=["i.archived=0"]; args=[]
        if q: where.append("(i.name LIKE ? OR i.brand LIKE ?)"); args += [f"%{q}%",f"%{q}%"]
        if kind: where.append("i.kind=?"); args.append(kind)
        sql=f"""SELECT i.*,COALESCE(x.uses,0) uses,COALESCE(x.last_used,0) last_used,
          COALESCE(x.uses,0)*4 + CASE WHEN x.last_used IS NULL THEN 0 ELSE 20.0/(1.0+((unixepoch('now')-x.last_used)/86400.0)/7.0) END frecency
          FROM item i LEFT JOIN (SELECT ce.item_id,count(*) uses,max(m.ts_epoch) last_used FROM consumption_event ce JOIN meal m ON m.id=ce.meal_id WHERE m.ts_epoch>=unixepoch('now','-30 days') GROUP BY ce.item_id) x ON x.item_id=i.id
          WHERE {' AND '.join(where)} ORDER BY frecency DESC,i.name COLLATE NOCASE LIMIT ?"""
        return [store.as_dict(r) for r in conn.execute(sql,args+[limit])]

    def timeline(self, conn: sqlite3.Connection, query: dict) -> dict:
        clause,args=bounds(query); events=[]
        events += [{"type":"meal",**store.as_dict(r)} for r in conn.execute(f"SELECT * FROM meal WHERE {clause}",args)]
        events += [{"type":"symptom",**store.as_dict(r)} for r in conn.execute(f"SELECT * FROM symptom_event WHERE {clause}",args)]
        return {"events":sorted(events,key=lambda x:x["ts_utc"]),"censor_windows":[store.as_dict(r) for r in conn.execute("SELECT * FROM censor_window")],"days":[store.as_dict(r) for r in conn.execute("SELECT * FROM day_log ORDER BY local_date")]}

    def serve_static(self, path: str) -> None:
        target=(PUBLIC_DIR/("index.html" if path in ("","/") else path.lstrip("/"))).resolve(); root=PUBLIC_DIR.resolve()
        if target != root and root not in target.parents: self.send_error(403); return
        if not target.is_file(): self.send_error(404); return
        body=target.read_bytes(); mime,_=mimetypes.guess_type(str(target)); self.send_response(200); self.send_header("Content-Type",mime or "application/octet-stream"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)

def main() -> None:
    parser=argparse.ArgumentParser(); parser.add_argument("--set-password",action="store_true"); args=parser.parse_args(); store.ensure_schema()
    if args.set_password:
        import getpass
        with store.connect() as conn: store.set_password(conn,getpass.getpass("New password: "))
        print("Password set"); return
    password=os.environ.get("SYMPTOM_TRACKER_PASSWORD")
    with store.connect() as conn:
        if password and not conn.execute("SELECT 1 FROM auth_config").fetchone(): store.set_password(conn,password)
        if not conn.execute("SELECT 1 FROM auth_config").fetchone(): raise SystemExit("No password configured; set SYMPTOM_TRACKER_PASSWORD for first run or use --set-password")
    print(f"Symptom Tracker running at http://{HOST}:{PORT}{BASE_PATH}/"); ThreadingHTTPServer((HOST,PORT),Handler).serve_forever()

if __name__=="__main__": main()
