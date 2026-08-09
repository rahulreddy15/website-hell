/* sync.js — the write path and the replay queue.

   Contract (PLAN.md §4): every mutable row carries a client-generated
   UUIDv4 primary key and POST /api/sync is an idempotent upsert keyed on
   it. That is what makes replaying a queued batch after a dropped
   connection safe, and it is why a save here never waits on the network.

   save() is synchronous from the user's point of view: write locally,
   redraw, then try the server in the background.
*/

(function (ST) {
  "use strict";

  var U = ST.util;

  /* kind -> key in the POST /api/sync batch envelope. Every resource that
     can be created offline lives here; nothing writes through a
     single-resource POST any more, because those are the only writes that
     could be lost. */
  var BATCH_KEY = {
    meal: "meals",
    symptom: "symptom_events",
    item: "items",
    itemattr: "item_attributes",
    day: "day_logs",
    state: "state_logs",
    censor: "censor_windows",
  };

  /* Deletions travel as tombstones so a row deleted offline cannot quietly
     reappear on the next pull. */
  function resourceOf(kind) { return BATCH_KEY[kind] || kind; }
  var KIND_OF_RESOURCE = {};
  Object.keys(BATCH_KEY).forEach(function (k) { KIND_OF_RESOURCE[BATCH_KEY[k]] = k; });

  var flushing = false;
  var retryTimer = null;

  function nowIso() { return U.isoUtc(); }

  /* ---------------------------------------------------------- write path */

  function save(kind, record, opts) {
    var options = opts || {};
    record.updated_at = nowIso();
    if (!record.created_at) record.created_at = record.updated_at;
    if (!record.id && kind !== "day" && kind !== "state") record.id = U.uuid();
    if (kind === "day" || kind === "state") record.id = record.local_date;

    return ST.store
      .putRecord(kind, record, { pending: true })
      .then(function () {
        return ST.store.enqueue({
          kind: kind,
          id: record.id,
          op: "upsert",
          queued_at: nowIso(),
        });
      })
      .then(function () {
        return refreshLocal(kind);
      })
      .then(function () {
        updatePending();
        if (!options.silent) ST.bus.emit("data-changed", { kind: kind, id: record.id });
        if (!options.defer) flush();
        return record;
      });
  }

  /* Write several records of possibly different kinds as ONE queued unit.
     The review flow needs this: an item's tag rows and its
     attributes_reviewed flag must reach the server together. If the flag
     arrived alone, the server would treat a food as reviewed with no tags
     — meaning "definitely contains none of these" — which is exactly the
     zero-imputation error the flag exists to prevent. Queue everything
     first, with the tag rows ahead of the item, then flush once. */
  function saveMany(entries, opts) {
    var options = opts || {};
    var chain = Promise.resolve();
    entries.forEach(function (entry) {
      chain = chain.then(function () {
        return save(entry.kind, entry.record, { silent: true, defer: true });
      });
    });
    return chain.then(function () {
      if (!options.silent) ST.bus.emit("data-changed", { bulk: true });
      return flush();
    }).then(function () { return entries; });
  }


  function remove(kind, id) {
    return ST.store
      .deleteRecord(kind, id, true)
      .then(function () {
        return ST.store.enqueue({
          kind: kind, id: id, op: "delete",
          deleted_at: nowIso(), queued_at: nowIso(),
        });
      })
      .then(function () { return refreshLocal(kind); })
      .then(function () {
        updatePending();
        ST.bus.emit("data-changed", { kind: kind, id: id, deleted: true });
        flush();
      });
  }

  /* Undo of a just-created record: drop it entirely, and drop its queued
     upsert if it never left the device. If it did leave, issue a delete. */
  function undoCreate(kind, id) {
    return ST.store.outboxAll().then(function (queue) {
      var mine = queue.filter(function (o) { return o.kind === kind && o.id === id; });
      var neverSent = mine.length > 0;
      return ST.store
        .outboxRemove(mine.map(function (o) { return o.seq; }))
        .then(function () {
          if (neverSent) {
            return ST.store.deleteRecord(kind, id, false);
          }
          return remove(kind, id);
        })
        .then(function () { return refreshLocal(kind); })
        .then(function () {
          updatePending();
          ST.bus.emit("data-changed", { kind: kind, id: id, deleted: true });
        });
    });
  }

  /* ---------------------------------------------------------------- flush */

  function stripLocalFields(obj) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
      if (k.charAt(0) === "_") return;
      if (k === "item_name" || k === "consumption_events") return;
      copy[k] = obj[k];
    });
    return copy;
  }

  function flush() {
    if (flushing) return Promise.resolve();
    if (!navigator.onLine) { updatePending(); return Promise.resolve(); }
    if (ST.state && ST.state.session && ST.state.session.authenticated === false) {
      // Keep everything queued. Losing data because a cookie expired is
      // the one failure mode this app is not allowed to have.
      updatePending();
      return Promise.resolve();
    }
    flushing = true;

    return ST.store
      .outboxAll()
      .then(function (queue) {
        if (!queue.length) return null;
        return buildBatch(queue).then(function (built) {
          if (!built.any) {
            return ST.store.outboxRemove(built.dropSeqs);
          }
          return ST.api.sync(built.batch).then(function (response) {
            var rejected = collectRejected(response);
            var okSeqs = built.seqs.filter(function (entry) {
              return rejected.indexOf(entry.id) === -1;
            }).map(function (entry) { return entry.seq; });
            return ST.store
              .outboxRemove(built.dropSeqs.concat(okSeqs))
              .then(function () { return markSynced(built.records); });
          });
        });
      })
      .then(function () {
        flushing = false;
        updatePending();
        return refreshAllLocal();
      })
      .catch(function (err) {
        flushing = false;
        updatePending();
        if (err instanceof ST.api.AuthError) return;
        scheduleRetry();
      });
  }

  function buildBatch(ops) {
    var batch = {
      meals: [], consumption_events: [], symptom_events: [],
      items: [], item_attributes: [], day_logs: [], state_logs: [],
      censor_windows: [], tombstones: [],
    };
    var seqs = [];
    var dropSeqs = [];
    var records = [];
    var chain = Promise.resolve();

    ops.forEach(function (op) {
      chain = chain.then(function () {
        if (op.op === "delete") {
          batch.tombstones.push({
            id: op.id,
            resource: resourceOf(op.kind),
            deleted_at: op.deleted_at || op.queued_at || nowIso(),
          });
          seqs.push({ seq: op.seq, id: op.id });
          return;
        }
        var key = BATCH_KEY[op.kind];
        if (!key) { dropSeqs.push(op.seq); return; }
        return ST.store.getRecord(op.kind, op.id).then(function (row) {
          if (!row || row.deleted) { dropSeqs.push(op.seq); return; }
          batch[key].push(stripLocalFields(row.data));
          if (op.kind === "meal") {
            (row.data.consumption_events || []).forEach(function (ce) {
              batch.consumption_events.push(stripLocalFields(ce));
            });
          }
          seqs.push({ seq: op.seq, id: op.id });
          records.push(row);
        });
      });
    });

    return chain.then(function () {
      var any = Object.keys(batch).some(function (k) { return batch[k].length > 0; });
      return { batch: batch, seqs: seqs, dropSeqs: dropSeqs, records: records, any: any };
    });
  }

  /* The contract says per-record {id, status}. Be liberal about where the
     server puts them so a shape disagreement degrades to "assume applied"
     rather than losing the queue. */
  function collectRejected(response) {
    var rejected = [];
    function walk(node) {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object") return;
      if (node.id && node.status && node.status === "rejected") rejected.push(node.id);
      Object.keys(node).forEach(function (k) {
        if (node[k] && typeof node[k] === "object") walk(node[k]);
      });
    }
    walk(response);
    return rejected;
  }

  function markSynced(rows) {
    return Promise.all(
      rows.map(function (row) {
        return ST.store.putRecord(row.type, row.data, { pending: false });
      })
    );
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      flush();
    }, 30000);
  }

  function updatePending() {
    ST.store.outboxCount().then(function (n) {
      ST.state.pending = n;
      ST.bus.emit("status-changed");
    });
  }

  /* ------------------------------------------------------- local reads */

  function sortByTsDesc(a, b) {
    return (b.ts_utc || "").localeCompare(a.ts_utc || "");
  }

  function refreshLocal(kind) {
    if (kind === "meal") {
      return ST.store.allRecords("meal").then(function (rows) {
        ST.state.meals = rows.map(unwrap).sort(sortByTsDesc);
        ST.state.items = recomputeFrecency(ST.state.itemsRaw || [], ST.state.meals);
      });
    }
    if (kind === "symptom") {
      return ST.store.allRecords("symptom").then(function (rows) {
        ST.state.symptoms = rows.map(unwrap).sort(sortByTsDesc);
      });
    }
    if (kind === "item") {
      return ST.store.allRecords("item").then(function (rows) {
        ST.state.itemsRaw = rows.map(unwrap);
        ST.state.items = recomputeFrecency(ST.state.itemsRaw, ST.state.meals || []);
      });
    }
    if (kind === "itemattr") {
      return ST.store.allRecords("itemattr").then(function (rows) {
        var map = {};
        rows.map(unwrap).forEach(function (row) {
          var bucket = map[row.item_id] || (map[row.item_id] = {});
          /* Highest knowledge_version wins; correcting knowledge next year
             must not silently rewrite what was computed last year, so the
             older rows stay on disk (decision #6). */
          var prev = bucket[row.attribute_id];
          if (!prev || (row.knowledge_version || 1) >= (prev.knowledge_version || 1)) {
            bucket[row.attribute_id] = row;
          }
        });
        ST.state.itemAttrs = map;
      });
    }
    if (kind === "day" || kind === "state") {
      return Promise.all([
        ST.store.allRecords("day"),
        ST.store.allRecords("state"),
      ]).then(function (res) {
        ST.state.days = {};
        res[0].map(unwrap).forEach(function (d) { ST.state.days[d.local_date] = d; });
        ST.state.states = {};
        res[1].map(unwrap).forEach(function (d) { ST.state.states[d.local_date] = d; });
      });
    }
    if (kind === "censor") {
      return ST.store.allRecords("censor").then(function (rows) {
        ST.state.censor = rows.map(unwrap);
      });
    }
    return Promise.resolve();
  }

  function unwrap(row) {
    var data = Object.assign({}, row.data);
    data._pending = !!row.pending;
    return data;
  }

  function refreshAllLocal() {
    return Promise.all([
      refreshLocal("item"),
      refreshLocal("itemattr"),
      refreshLocal("meal"),
      refreshLocal("symptom"),
      refreshLocal("day"),
      refreshLocal("censor"),
    ]).then(function () {
      ST.state.items = recomputeFrecency(ST.state.itemsRaw || [], ST.state.meals || []);
    });
  }

  /* Frecency: recent use beats raw frequency, but frequency still counts.
     This is what puts "the thing he actually eats" at the top of the meal
     sheet, which is the whole reason a repeat is two taps. */
  function recomputeFrecency(items, meals) {
    var stats = {};
    var now = Date.now();
    (meals || []).forEach(function (meal) {
      (meal.consumption_events || []).forEach(function (ce) {
        var s = stats[ce.item_id] || (stats[ce.item_id] = { n: 0, last: 0, score: 0, portion: null });
        var age = (now - new Date(meal.ts_utc).getTime()) / 86400000;
        s.n += 1;
        if (new Date(meal.ts_utc).getTime() > s.last) {
          s.last = new Date(meal.ts_utc).getTime();
          s.portion = ce.portion_ordinal;
        }
        s.score += age <= 3 ? 4 : age <= 7 ? 3 : age <= 14 ? 2 : age <= 30 ? 1 : 0.25;
      });
    });
    return (items || [])
      .filter(function (it) { return !it.archived; })
      .map(function (it) {
        var s = stats[it.id] || { n: 0, last: 0, score: 0, portion: null };
        return Object.assign({}, it, {
          _count: s.n,
          _last: s.last,
          _score: s.score,
          _lastPortion: s.portion || it.default_portion || null,
        });
      })
      .sort(function (a, b) {
        if (b._score !== a._score) return b._score - a._score;
        return (b._last || 0) - (a._last || 0);
      });
  }

  /* ------------------------------------------------------------- pull */

  function hydrateFromServer() {
    if (!navigator.onLine) return Promise.resolve(false);
    var to = U.todayLocal();
    var from = U.addDays(to, -120);

    return ST.store.metaGet("lastSync", null).then(function (since) {
      return Promise.all([
        ST.api.items({ limit: 400 }).catch(function () { return null; }),
        ST.api.meals({ from: from, to: to }).catch(function () { return null; }),
        ST.api.symptoms({ from: from, to: to }).catch(function () { return null; }),
        ST.api.days({ from: from, to: to }).catch(function () { return null; }),
        ST.api.censor().catch(function () { return null; }),
        /* The sync envelope is the only place item_attributes and
           tombstones are exposed, so we always pull it too. */
        ST.api.pull(since).catch(function () { return null; }),
        ST.api.attributes().catch(function () { return null; }),
      ]).then(function (res) {
        var writes = [];
        pick(res[0], ["items"]).forEach(function (row) {
          writes.push(mergeRemote("item", row));
        });
        pick(res[1], ["meals"]).forEach(function (row) {
          row.consumption_events = row.consumption_events || row.items || row.events || [];
          writes.push(mergeRemote("meal", row));
        });
        pick(res[2], ["symptoms", "symptom_events"]).forEach(function (row) {
          writes.push(mergeRemote("symptom", normaliseSymptom(row)));
        });
        pick(res[3], ["days", "day_logs"]).forEach(function (row) {
          var day = {
            id: row.local_date, local_date: row.local_date,
            completeness: row.completeness, missing_kinds: row.missing_kinds,
            nothing_eaten: row.nothing_eaten, notes: row.notes,
            updated_at: row.updated_at,
          };
          writes.push(mergeRemote("day", day));
          if (row.stress != null || row.illness_flag != null || row.travel_flag != null ||
              row.sleep_hours != null) {
            writes.push(mergeRemote("state", {
              id: row.local_date, local_date: row.local_date,
              stress: row.stress, sleep_hours: row.sleep_hours,
              illness_flag: row.illness_flag, travel_flag: row.travel_flag,
              notes: row.state_notes, updated_at: row.updated_at,
            }));
          }
        });
        pick(res[4], ["censor", "windows", "censor_windows"]).forEach(function (row) {
          writes.push(mergeRemote("censor", row));
        });

        /* changes envelope */
        var changes = res[5];
        if (changes) {
          Object.keys(BATCH_KEY).forEach(function (kind) {
            var key = BATCH_KEY[kind];
            (changes[key] || []).forEach(function (row) {
              if (kind === "itemattr") row = normaliseItemAttr(row);
              if (kind === "symptom") row = normaliseSymptom(row);
              if (kind === "day" || kind === "state") row.id = row.local_date;
              writes.push(mergeRemote(kind, row));
            });
          });
          (changes.item_attributes || []).forEach(function (row) {
            writes.push(mergeRemote("itemattr", normaliseItemAttr(row)));
          });
          (changes.tombstones || []).forEach(function (t) {
            var kind = KIND_OF_RESOURCE[t.resource];
            if (kind) writes.push(applyTombstone(kind, t));
          });
          if (changes.server_time || changes.now) {
            writes.push(ST.store.metaSet("lastSync", changes.server_time || changes.now));
          } else {
            writes.push(ST.store.metaSet("lastSync", U.isoUtc()));
          }
        }

        if (res[6]) {
          ST.state.attributes = pick(res[6], ["attributes", "candidates"]);
          ST.state.attributeCoverage = res[6].coverage || res[6];
        }

        return Promise.all(writes)
          .then(refreshAllLocal)
          .then(function () { return true; });
      });
    });
  }

  /* item_attribute has a composite primary key; the local store needs a
     single string id, so we synthesise one deterministically. Replay stays
     idempotent because the same three fields always produce the same id. */
  function normaliseItemAttr(row) {
    var version = row.knowledge_version || 1;
    return Object.assign({}, row, {
      id: row.id || (row.item_id + "|" + row.attribute_id + "|" + version),
      knowledge_version: version,
    });
  }

  /* bristol is nullable now; is_bm defaults to 1 for anything historical. */
  function normaliseSymptom(row) {
    var copy = Object.assign({}, row);
    if (copy.is_bm === undefined || copy.is_bm === null) {
      copy.is_bm = copy.bristol === null || copy.bristol === undefined ? 0 : 1;
    }
    if (copy.bristol === undefined) copy.bristol = null;
    return copy;
  }

  function applyTombstone(kind, tomb) {
    return ST.store.getRecord(kind, tomb.id).then(function (existing) {
      /* A local edit made after the delete wins; otherwise the row goes. */
      if (existing && existing.pending &&
          existing.data.updated_at && tomb.deleted_at &&
          existing.data.updated_at > tomb.deleted_at) return null;
      return ST.store.deleteRecord(kind, tomb.id, false);
    });
  }

  function pick(payload, keys) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    for (var i = 0; i < keys.length; i++) {
      if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
    }
    return [];
  }

  /* Last-write-wins by updated_at (PLAN.md §4). A locally queued edit
     always wins over a server row we are only just learning about. */
  function mergeRemote(kind, row) {
    if (!row || !row.id) return Promise.resolve();
    return ST.store.getRecord(kind, row.id).then(function (existing) {
      if (existing && existing.pending) return null;
      if (existing && existing.data.updated_at && row.updated_at &&
          existing.data.updated_at > row.updated_at) return null;
      return ST.store.putRecord(kind, row, { pending: false });
    });
  }

  ST.sync = {
    save: save,
    saveMany: saveMany,
    remove: remove,
    undoCreate: undoCreate,
    flush: flush,
    hydrateFromServer: hydrateFromServer,
    refreshAllLocal: refreshAllLocal,
    refreshLocal: refreshLocal,
    updatePending: updatePending,
    recomputeFrecency: recomputeFrecency,
    normaliseItemAttr: normaliseItemAttr,
    normaliseSymptom: normaliseSymptom,
  };
})(window.ST);
