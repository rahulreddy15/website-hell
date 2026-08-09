/* store.js — local durable store.
   Everything the user types lands here first and is considered saved the
   moment it does. The network is an afterthought, on purpose.

   records : mirror of server rows + anything captured offline
   outbox  : ordered queue of mutations awaiting POST /api/sync
   meta    : settings, cursors, saved searches
*/

(function (ST) {
  "use strict";

  var DB_NAME = "symptom-tracker";
  var DB_VERSION = 1;
  var db = null;
  var fallback = null;

  function open() {
    if (db) return Promise.resolve(db);
    if (fallback) return Promise.resolve(fallback);
    return new Promise(function (resolve) {
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        fallback = makeFallback();
        return resolve(fallback);
      }
      req.onupgradeneeded = function (event) {
        var d = event.target.result;
        if (!d.objectStoreNames.contains("records")) {
          var rec = d.createObjectStore("records", { keyPath: "key" });
          rec.createIndex("type", "type");
          rec.createIndex("type_date", ["type", "local_date"]);
          rec.createIndex("type_ts", ["type", "ts_utc"]);
        }
        if (!d.objectStoreNames.contains("outbox")) {
          d.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
        }
        if (!d.objectStoreNames.contains("meta")) {
          d.createObjectStore("meta", { keyPath: "k" });
        }
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () {
        console.warn("IndexedDB unavailable, using in-memory fallback");
        fallback = makeFallback();
        resolve(fallback);
      };
    });
  }

  /* Last-ditch fallback so capture never hard-fails. Persists to
     localStorage where possible; memory-only if even that is blocked. */
  function makeFallback() {
    var mem = { records: {}, outbox: [], meta: {}, seq: 1 };
    try {
      var raw = localStorage.getItem("st-fallback");
      if (raw) mem = JSON.parse(raw);
    } catch (e) { /* ignore */ }
    function save() {
      try { localStorage.setItem("st-fallback", JSON.stringify(mem)); } catch (e) { /* ignore */ }
    }
    return { __fallback: true, mem: mem, save: save };
  }

  function tx(storeName, mode, run) {
    return open().then(function (d) {
      if (d.__fallback) return run(null, d);
      return new Promise(function (resolve, reject) {
        var t = d.transaction(storeName, mode);
        var store = t.objectStore(storeName);
        var out = run(store, null);
        t.oncomplete = function () { resolve(out && out.value !== undefined ? out.value : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function reqValue(request) {
    var box = { value: null };
    request.onsuccess = function () {
      box.value = request.result === undefined ? null : request.result;
    };
    return box;
  }

  /* ------------------------------------------------------------ records */

  function keyOf(type, id) { return type + ":" + id; }

  function putRecord(type, obj, extra) {
    var row = Object.assign(
      {
        key: keyOf(type, obj.id),
        type: type,
        id: obj.id,
        ts_utc: obj.ts_utc || obj.updated_at || ST.util.isoUtc(),
        local_date: obj.local_date || (obj.ts_utc ? ST.util.localDate(obj) : obj.local_date || null),
        pending: false,
        deleted: false,
        data: obj,
      },
      extra || {}
    );
    return tx("records", "readwrite", function (store, fb) {
      if (fb) { fb.mem.records[row.key] = row; fb.save(); return row; }
      store.put(row);
      return row;
    });
  }

  function getRecord(type, id) {
    return tx("records", "readonly", function (store, fb) {
      if (fb) return fb.mem.records[keyOf(type, id)] || null;
      return reqValue(store.get(keyOf(type, id)));
    }).then(function (r) { return r || null; });
  }

  function allRecords(type) {
    return tx("records", "readonly", function (store, fb) {
      if (fb) {
        return Object.keys(fb.mem.records)
          .map(function (k) { return fb.mem.records[k]; })
          .filter(function (r) { return !type || r.type === type; });
      }
      if (!type) return reqValue(store.getAll());
      return reqValue(store.index("type").getAll(type));
    }).then(function (rows) {
      return (rows || []).filter(function (r) { return r && !r.deleted; });
    });
  }

  function deleteRecord(type, id, soft) {
    return tx("records", "readwrite", function (store, fb) {
      var k = keyOf(type, id);
      if (fb) {
        if (soft && fb.mem.records[k]) fb.mem.records[k].deleted = true;
        else delete fb.mem.records[k];
        fb.save();
        return true;
      }
      if (soft) {
        var g = store.get(k);
        g.onsuccess = function () {
          var row = g.result;
          if (row) { row.deleted = true; store.put(row); }
        };
      } else {
        store.delete(k);
      }
      return true;
    });
  }

  function clearType(type) {
    return allRecords(type).then(function (rows) {
      return Promise.all(rows.map(function (r) { return deleteRecord(type, r.id, false); }));
    });
  }

  /* ------------------------------------------------------------- outbox */

  function enqueue(op) {
    return tx("outbox", "readwrite", function (store, fb) {
      if (fb) {
        op.seq = fb.mem.seq++;
        fb.mem.outbox.push(op);
        fb.save();
        return op;
      }
      store.add(op);
      return op;
    });
  }

  function outboxAll() {
    return tx("outbox", "readonly", function (store, fb) {
      if (fb) return fb.mem.outbox.slice();
      return reqValue(store.getAll());
    }).then(function (rows) { return rows || []; });
  }

  function outboxCount() {
    return outboxAll().then(function (rows) { return rows.length; });
  }

  function outboxRemove(seqs) {
    return tx("outbox", "readwrite", function (store, fb) {
      if (fb) {
        fb.mem.outbox = fb.mem.outbox.filter(function (o) { return seqs.indexOf(o.seq) === -1; });
        fb.save();
        return true;
      }
      seqs.forEach(function (s) { store.delete(s); });
      return true;
    });
  }

  /* --------------------------------------------------------------- meta */

  function metaGet(k, dflt) {
    return tx("meta", "readonly", function (store, fb) {
      if (fb) return fb.mem.meta[k];
      return reqValue(store.get(k));
    }).then(function (row) {
      if (row === undefined || row === null) return dflt;
      return row.v !== undefined ? row.v : (row.__fallbackValue !== undefined ? row.__fallbackValue : row);
    });
  }

  function metaSet(k, v) {
    return tx("meta", "readwrite", function (store, fb) {
      if (fb) { fb.mem.meta[k] = { k: k, v: v }; fb.save(); return v; }
      store.put({ k: k, v: v });
      return v;
    });
  }

  ST.store = {
    open: open,
    putRecord: putRecord,
    getRecord: getRecord,
    allRecords: allRecords,
    deleteRecord: deleteRecord,
    clearType: clearType,
    enqueue: enqueue,
    outboxAll: outboxAll,
    outboxCount: outboxCount,
    outboxRemove: outboxRemove,
    metaGet: metaGet,
    metaSet: metaSet,
  };
})(window.ST);
