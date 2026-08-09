#!/usr/bin/env python3
"""Plain-stdlib integration and v1 acceptance checks."""
from __future__ import annotations

import datetime as dt
import json
import os
import random
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer

def uid() -> str: return str(uuid.uuid4())
def stamp(day: int, hour: int) -> str: return f"2026-01-{day:02d}T{hour:02d}:00:00Z"
def iso(moment: dt.datetime) -> str: return moment.replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00","Z")

with tempfile.TemporaryDirectory() as tmp:
    os.environ["SYMPTOM_TRACKER_DB"] = os.path.join(tmp,"tracker.sqlite3")
    sys.path.insert(0,os.path.dirname(__file__))
    import db
    import app
    db.DB_PATH=app.store.DB_PATH=db.Path(os.environ["SYMPTOM_TRACKER_DB"])
    db.ensure_schema()
    with db.connect() as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower()=="wal"
        assert conn.execute("SELECT count(*) FROM attribute_def WHERE is_candidate=1").fetchone()[0]==15
        assert "attributes_reviewed" in [r[1] for r in conn.execute("PRAGMA table_info(item)")]
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='tombstone'").fetchone()
        assert conn.execute("PRAGMA table_info(symptom_event)").fetchall()[3][3]==0
        assert "nausea" in [r[1] for r in conn.execute("PRAGMA table_info(symptom_event)")]
        # Generated local dates: east-of-UTC midnight crossing and real US DST offset change.
        for event_id,ts,offset in [(uid(),"2026-03-08T04:30:00Z",-300),(uid(),"2026-03-09T04:30:00Z",-240),(uid(),"2026-01-01T23:30:00Z",330)]:
            conn.execute("INSERT INTO meal(id,ts_utc,tz_offset_min,created_at,updated_at) VALUES(?,?,?,?,?)",(event_id,ts,offset,ts,ts))
        assert [r[0] for r in conn.execute("SELECT local_date FROM meal ORDER BY ts_epoch")]==["2026-01-02","2026-03-07","2026-03-09"]

        # Replay-safe sync and FTS synchronization.
        item_id=uid(); meal_id=uid(); ce_id=uid(); t=stamp(1,8)
        batch={"items":[{"id":item_id,"name":"Ginger Ale Cold Brew","kind":"drink","attributes_reviewed":1,"notes":"fizzy coffee","created_at":t,"updated_at":t}],"meals":[{"id":meal_id,"ts_utc":t,"tz_offset_min":0,"notes":"morning beverage","created_at":t,"updated_at":t}],"consumption_events":[{"id":ce_id,"meal_id":meal_id,"item_id":item_id,"portion_ordinal":"medium","portion_basis":"ordinal","created_at":t,"updated_at":t}]}
        assert all(x["status"]=="applied" for x in db.sync_push(conn,batch))
        assert all(x["status"]=="stale" for x in db.sync_push(conn,batch))
        assert conn.execute("SELECT count(*) FROM consumption_event WHERE id=?",(ce_id,)).fetchone()[0]==1
        hits=db.search(conn,{"q":["ginger"]}); assert any(x["id"]==item_id and "<mark>" in x["snippet"] for x in hits)
        first=db.now_iso(); second=db.now_iso(); assert second > first and "." in second

        # Offline deletion is replay-safe, is pulled as a tombstone, and an older queued
        # upsert cannot resurrect the deleted row.
        deleted_at="2026-01-01T09:00:00.000001Z"
        deletion={"id":meal_id,"resource":"meals","deleted_at":deleted_at}
        assert db.sync_push(conn,{"tombstones":[deletion]})[0]["status"]=="applied"
        assert db.sync_push(conn,{"tombstones":[deletion]})[0]["status"]=="stale"
        assert not conn.execute("SELECT 1 FROM meal WHERE id=?",(meal_id,)).fetchone()
        assert db.sync_push(conn,{"meals":[batch["meals"][0]]})[0]["status"]=="stale"
        pulled=db.sync_pull(conn,"2026-01-01T08:59:59Z")
        assert any(x["id"]==meal_id and x["resource"]=="meals" for x in pulled["tombstones"])

        # Offline attribute review and illness window use the same replay-safe envelope.
        offline_item=uid(); db.sync_push(conn,{"items":[{"id":offline_item,"name":"Offline review","kind":"dish","created_at":t,"updated_at":t}]})
        review_time="2026-01-01T09:00:00.000002Z"; censor_id=uid()
        offline={"item_attributes":[{"item_id":offline_item,"attribute_id":"dairy","value":1,"updated_at":review_time},{"item_id":offline_item,"attributes_reviewed":1,"updated_at":"2026-01-01T09:00:00.000003Z"}],"censor_windows":[{"id":censor_id,"start_utc":"2026-02-01T00:00:00Z","end_utc":"2026-02-02T00:00:00Z","reason":"illness","created_at":review_time}]}
        offline_results=db.sync_push(conn,offline); assert all(x["status"]=="applied" for x in offline_results)
        assert db.item_attributes(conn,offline_item)["attributes"]=={"dairy":1.0} and db.item_attributes(conn,offline_item)["attributes_reviewed"]==1
        offline_pull=db.sync_pull(conn,"2026-01-01T08:59:59Z"); assert offline_pull["item_attributes"] and any(x["id"]==censor_id for x in offline_pull["censor_windows"])
        # Composite attribute tombstones delete and round-trip without UUID validation.
        attribute_tombstone=f"{offline_item}|dairy|1"; attribute_deleted="2026-01-01T09:00:00.000004Z"
        deleted=db.sync_push(conn,{"tombstones":[{"id":attribute_tombstone,"resource":"item_attributes","deleted_at":attribute_deleted}]})[0]
        assert deleted["status"]=="applied" and not conn.execute("SELECT 1 FROM item_attribute WHERE item_id=? AND attribute_id='dairy'",(offline_item,)).fetchone()
        assert any(x["id"]==attribute_tombstone for x in db.sync_pull(conn,"2026-01-01T08:59:59Z")["tombstones"])
        assert db.sync_push(conn,{"tombstones":[{"id":"2026-01-01","resource":"day_logs","deleted_at":attribute_deleted}]})[0]["status"]=="applied"

        # Noisy deterministic fixture: planted candidate is 72% vs 20%. An independently
        # balanced, co-logged negative control is 46% vs 46%.
        conn.execute("INSERT INTO item_attribute(item_id,attribute_id,value,source,knowledge_version,updated_at) VALUES(?, 'caffeine',1,'manual',1,?)",(item_id,t))
        control_id=uid(); outside_id=uid(); neutral_id=uid(); unknown_id=uid()
        for iid,name in [(control_id,"Balanced control"),(outside_id,"Outside-window candidate"),(neutral_id,"Reviewed neutral"),(unknown_id,"Unreviewed mystery")]:
            conn.execute("INSERT INTO item(id,name,kind,attributes_reviewed,created_at,updated_at) VALUES(?,?, 'ingredient',?,?,?)",(iid,name,0 if iid==unknown_id else 1,t,t))
        conn.execute("INSERT INTO item_attribute(item_id,attribute_id,value,source,knowledge_version,updated_at) VALUES(?,'lactose',1,'manual',1,?)",(control_id,t))
        conn.execute("INSERT INTO item_attribute(item_id,attribute_id,value,source,knowledge_version,updated_at) VALUES(?,'capsaicin',1,'manual',1,?)",(outside_id,t))
        strata=[(exposed,control,outcome) for exposed,rate in [(True,18),(False,5)] for control in (True,False) for outcome in ([True]*rate+[False]*(25-rate))]
        random.Random(20260809).shuffle(strata)
        start=dt.datetime(2026,4,1)
        for index,(exposed,control,outcome) in enumerate(strata):
            day=start+dt.timedelta(days=index); date=day.date().isoformat(); meal_ts=iso(day.replace(hour=8)); symptom=iso(day.replace(hour=10))
            completeness="partial" if index==0 else "complete"
            conn.execute("INSERT INTO day_log(local_date,completeness,updated_at) VALUES(?,?,?)",(date,completeness,iso(day.replace(hour=23))))
            mid=uid(); conn.execute("INSERT INTO meal(id,ts_utc,tz_offset_min,created_at,updated_at) VALUES(?,?,?,?,?)",(mid,meal_ts,0,meal_ts,meal_ts))
            selected=([item_id] if exposed else [])+([control_id] if control else [])
            # A reviewed neutral item makes the no-candidate windows honestly unexposed.
            if not selected: selected=[neutral_id]
            for iid in selected: conn.execute("INSERT INTO consumption_event(id,meal_id,item_id,created_at,updated_at) VALUES(?,?,?,?,?)",(uid(),mid,iid,meal_ts,meal_ts))
            # capsaicin is always outside 0-6h, so this must not become exposure.
            old_ts=iso(day.replace(hour=2)); old_mid=uid(); conn.execute("INSERT INTO meal(id,ts_utc,tz_offset_min,created_at,updated_at) VALUES(?,?,?,?,?)",(old_mid,old_ts,0,old_ts,old_ts)); conn.execute("INSERT INTO consumption_event(id,meal_id,item_id,created_at,updated_at) VALUES(?,?,?,?,?)",(uid(),old_mid,outside_id,old_ts,old_ts))
            conn.execute("INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,created_at,updated_at) VALUES(?,?,?,?,?,?)",(uid(),symptom,0,7 if outcome else 4,symptom,symptom))
        result=db.rates(conn,"caffeine",0,6)
        assert result["exposed"]["rate"] > .65 and result["unexposed"]["rate"] < .25
        assert result["identifiable"] and result["exposed"]["wilson_95"][0] is not None
        control=db.rates(conn,"lactose",0,6); assert abs(control["exposed"]["rate"]-control["unexposed"]["rate"]) < .05
        outside=db.rates(conn,"capsaicin",0,6); assert outside["n_exposed"]==0
        # Unknown attributes never enter the unexposed denominator.
        mystery_day=start+dt.timedelta(days=101); mts=iso(mystery_day.replace(hour=8)); sts=iso(mystery_day.replace(hour=10))
        conn.execute("INSERT INTO day_log VALUES(?,'complete',NULL,0,NULL,?)",(mystery_day.date().isoformat(),sts)); mid=uid(); conn.execute("INSERT INTO meal(id,ts_utc,tz_offset_min,created_at,updated_at) VALUES(?,?,?,?,?)",(mid,mts,0,mts,mts)); conn.execute("INSERT INTO consumption_event(id,meal_id,item_id,created_at,updated_at) VALUES(?,?,?,?,?)",(uid(),mid,unknown_id,mts,mts)); conn.execute("INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,created_at,updated_at) VALUES(?,?,?,?,?,?)",(uid(),sts,0,4,sts,sts))
        unknown=db.rates(conn,"caffeine",0,6); assert unknown["n_unknown_exposure"]==1 and unknown["n_unexposed"]==result["n_unexposed"]
        # Reviewed plus no tag is semantically unexposed, equivalent to explicit zero.
        before_unexposed=unknown["n_unexposed"]; conn.execute("UPDATE item SET attributes_reviewed=1 WHERE id=?",(unknown_id,)); reviewed_absence=db.rates(conn,"caffeine",0,6); assert reviewed_absence["n_unknown_exposure"]==0 and reviewed_absence["n_unexposed"]==before_unexposed+1
        # Missing completeness appears only in sensitivity; censor removes one observation.
        sensitivity_day=mystery_day+dt.timedelta(days=1); mts=iso(sensitivity_day.replace(hour=8)); sts=iso(sensitivity_day.replace(hour=10)); mid=uid(); conn.execute("INSERT INTO meal(id,ts_utc,tz_offset_min,created_at,updated_at) VALUES(?,?,?,?,?)",(mid,mts,0,mts,mts)); conn.execute("INSERT INTO consumption_event(id,meal_id,item_id,created_at,updated_at) VALUES(?,?,?,?,?)",(uid(),mid,item_id,mts,mts)); conn.execute("INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,created_at,updated_at) VALUES(?,?,?,?,?,?)",(uid(),sts,0,7,sts,sts))
        sensitivity=db.rates(conn,"caffeine",0,6); assert sensitivity["sensitivity"]["n_exposed"]==sensitivity["n_exposed"]+1
        conn.execute("INSERT INTO censor_window VALUES(?,?,?,?,?,?)",(uid(),mts,sts,"illness",None,mts)); censored=db.rates(conn,"caffeine",0,6); assert censored["sensitivity"]["n_exposed"]==sensitivity["sensitivity"]["n_exposed"]-1 and any("censor" in x for x in censored["warnings"])
        # A non-BM symptom is first-class but absent from every bristol67 denominator.
        before=(censored["n_exposed"],censored["n_unexposed"],censored["n_unknown_exposure"]); non_bm=iso((sensitivity_day+dt.timedelta(days=2)).replace(hour=10)); conn.execute("INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,is_bm,nausea,bloating,created_at,updated_at) VALUES(?,?,0,NULL,0,2,3,?,?)",(uid(),non_bm,non_bm,non_bm)); assert conn.execute("SELECT nausea FROM symptom_event WHERE ts_utc=?",(non_bm,)).fetchone()[0]==2; after=db.rates(conn,"caffeine",0,6); assert (after["n_exposed"],after["n_unexposed"],after["n_unknown_exposure"])==before

        # Review queue analytical value: repeated blocking item outranks a one-off item;
        # impact reports that reviewing it unlocks observations.
        high=uid(); low=uid()
        for iid,name in [(high,"Frequent blocker"),(low,"One-off blocker")]: conn.execute("INSERT INTO item(id,name,kind,created_at,updated_at) VALUES(?,?,'dish',?,?)",(iid,name,t,t))
        queue_start=dt.datetime(2026,8,1)
        for index in range(8):
            day=queue_start+dt.timedelta(days=index); meal_ts=iso(day.replace(hour=8)); symptom_ts=iso(day.replace(hour=10)); mid=uid(); conn.execute("INSERT INTO day_log(local_date,completeness,updated_at) VALUES(?,'complete',?)",(day.date().isoformat(),symptom_ts)); conn.execute("INSERT INTO meal(id,ts_utc,tz_offset_min,created_at,updated_at) VALUES(?,?,?,?,?)",(mid,meal_ts,0,meal_ts,meal_ts)); conn.execute("INSERT INTO consumption_event(id,meal_id,item_id,portion_ordinal,created_at,updated_at) VALUES(?,?,?,?,?,?)",(uid(),mid,high,None,meal_ts,meal_ts)); conn.execute("INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,is_bm,created_at,updated_at) VALUES(?,?,0,4,1,?,?)",(uid(),symptom_ts,symptom_ts,symptom_ts))
        day=queue_start+dt.timedelta(days=9); meal_ts=iso(day.replace(hour=8)); symptom_ts=iso(day.replace(hour=10)); mid=uid(); conn.execute("INSERT INTO meal(id,ts_utc,tz_offset_min,created_at,updated_at) VALUES(?,?,?,?,?)",(mid,meal_ts,0,meal_ts,meal_ts)); conn.execute("INSERT INTO consumption_event(id,meal_id,item_id,created_at,updated_at) VALUES(?,?,?,?,?)",(uid(),mid,low,meal_ts,meal_ts)); conn.execute("INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,is_bm,created_at,updated_at) VALUES(?,?,0,4,1,?,?)",(uid(),symptom_ts,symptom_ts,symptom_ts))
        queue=db.review_queue(conn,20); assert queue[0]["id"]==high and queue[0]["blocks"]==8 and queue[0]["n_consumptions"]==8 and queue[0]["unlocks"]<=queue[0]["blocks"]
        assert set(("id","name","kind","attributes_reviewed","n_consumptions","blocks","unlocks","review_score","last_used")) <= set(queue[0])
        impact=db.review_impact(conn,1); assert set(impact)=={"n_total_observations","n_unknown_exposure","n_classified","n_would_become_analyzable","top_n"}; assert impact["top_n"]==1 and impact["n_unknown_exposure"]<=impact["n_total_observations"] and impact["n_classified"]==impact["n_total_observations"]-impact["n_unknown_exposure"]
        coverage=db.attributes_coverage(conn); assert len(coverage)==15 and all("tagged_items" in x and "unreviewed_items" in x for x in coverage)
        assert result["evidence_tier"] in {"observed","suggestive","unclear","contradictory","experiment"}
        db.set_password(conn,"test-password")

    # Real handler check: protected data route rejects a request without a cookie.
    app.BASE_PATH="/tracker"; server=ThreadingHTTPServer(("127.0.0.1",0),app.Handler); thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    try:
        try: urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/tracker/api/items")
        except urllib.error.HTTPError as exc:
            assert exc.code==401 and json.loads(exc.read())["error"]=="Authentication required"
        else: raise AssertionError("unauthenticated API request was accepted")
        request=urllib.request.Request(f"http://127.0.0.1:{server.server_port}/tracker/api/auth/login",data=b'{"password":"wrong"}',headers={"Content-Type":"application/json"},method="POST")
        try: urllib.request.urlopen(request)
        except urllib.error.HTTPError as exc: assert exc.code==401
        with db.connect() as conn: assert conn.execute("SELECT count(*) FROM login_attempt WHERE succeeded=0").fetchone()[0]==1
    finally: server.shutdown(); server.server_close(); thread.join()

    # Version-3 migration adds nausea without losing existing rows.
    legacy=db.Path(tmp)/"legacy.sqlite3"; old_schema=db.SCHEMA.read_text().replace("  nausea INTEGER CHECK (nausea BETWEEN 0 AND 3),\n","")
    with db.connect(legacy) as conn:
        conn.executescript(old_schema); conn.execute("INSERT INTO schema_version VALUES(3,?)",(db.now_iso(),)); sid=uid(); conn.execute("INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,created_at,updated_at) VALUES(?,?,0,6,?,?)",(sid,t,t,t))
    db.ensure_schema(legacy)
    with db.connect(legacy) as conn:
        row=conn.execute("SELECT bristol,is_bm,nausea FROM symptom_event WHERE id=?",(sid,)).fetchone(); assert tuple(row)==(6,1,None); conn.execute("INSERT INTO symptom_event(id,ts_utc,tz_offset_min,bristol,is_bm,nausea,created_at,updated_at) VALUES(?,?,0,NULL,0,3,?,?)",(uid(),t,t,t))
    print("Symptom Tracker smoke test passed")
