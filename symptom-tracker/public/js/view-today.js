/* view-today.js — home.

   Three things, in this order of importance:
     1. two thumb-sized actions pinned to the bottom (in index.html)
     2. an honest coverage readout, which replaces streaks
     3. everything logged today, dense and directly editable

   There is no streak anywhere in this app. Streaks punish illness, and a
   person who is unwell will either quit or start inventing entries to keep
   one alive. Coverage says the same thing without the moral loading: it is
   an audit of what the data can and cannot support.
*/

(function (ST) {
  "use strict";

  var U = ST.util;

  /* ------------------------------------------------- shared event rows */

  function flagList(sym) {
    var out = [];
    if (sym.urgency >= 2) out.push({ k: "U", label: "urgent", warn: false });
    if (sym.incomplete === 1) out.push({ k: "I", label: "felt incomplete", warn: false });
    if (sym.nocturnal === 1) out.push({ k: "N", label: "overnight", warn: false });
    if (sym.accident_flag === 1) out.push({ k: "A", label: "did not reach a toilet", warn: false });
    if (sym.mucus_flag === 1) out.push({ k: "M", label: "mucus", warn: false });
    if (sym.blood_flag === 1) out.push({ k: "B", label: "blood", warn: true });
    return out;
  }

  function isBm(record) {
    return record && record.is_bm !== 0 && record.is_bm !== false;
  }

  function unifyEvents(dateFilter) {
    var out = [];
    (ST.state.meals || []).forEach(function (m) {
      if (dateFilter && U.localDate(m) !== dateFilter) return;
      out.push({ type: "meal", ts: m.ts_utc, id: m.id, data: m });
    });
    (ST.state.symptoms || []).forEach(function (s) {
      if (dateFilter && U.localDate(s) !== dateFilter) return;
      out.push({
        type: "symptom", ts: s.ts_utc, id: s.id, data: s, isBm: isBm(s),
      });
    });
    /* Legacy timed notes written into state_log by an earlier build. Kept
       readable and searchable; nothing writes them any more. */
    Object.keys(ST.state.states || {}).forEach(function (date) {
      if (dateFilter && date !== dateFilter) return;
      ST.entry.parseOtherNotes(ST.state.states[date]).forEach(function (n, i) {
        out.push({
          type: "note", id: date + ":" + i, ts: date + "T" + n.time + ":00", data: n, date: date,
        });
      });
    });
    return out.sort(function (a, b) { return (b.ts || "").localeCompare(a.ts || ""); });
  }

  function rowHtml(entry) {
    var d = entry.data;
    if (entry.type === "symptom" && !isBm(d)) {
      var flagsOther = flagList(d);
      return (
        '<span class="lr-time">' + U.esc(U.fmtClock(d.ts_utc)) + "</span>" +
        '<span class="lr-glyph t-other" aria-hidden="true">◇</span>' +
        '<span class="lr-main"><span class="lr-title">' +
        U.esc(ST.entry.otherSummary(d)) + "</span>" +
        '<span class="lr-sub">symptom · no bowel movement</span></span>' +
        '<span class="lr-tail">' +
        (d._pending ? '<span class="lr-pending" title="Saved on device, not yet synced"></span>' : "") +
        '<span class="lr-flags">' +
        flagsOther.map(function (f) {
          return '<span class="lr-flag' + (f.warn ? " warn" : "") + '" title="' +
            U.esc(f.label) + '" aria-label="' + U.esc(f.label) + '">' + f.k + "</span>";
        }).join("") +
        "</span></span>"
      );
    }
    if (entry.type === "symptom") {
      var t = ST.bristol.byNumber(d.bristol);
      var flags = flagList(d);
      return (
        '<span class="lr-time">' + U.esc(U.fmtClock(d.ts_utc)) + "</span>" +
        '<span class="lr-glyph t-symptom" aria-hidden="true">▮</span>' +
        '<span class="lr-main"><span class="lr-title">' + U.esc(t.short) + "</span>" +
        '<span class="lr-sub">' + U.esc(U.lex("stoolShort").toLowerCase()) +
        (d.urgency != null ? " · urgency " + U.SEVERITY[d.urgency] : "") +
        (d.notes ? " · " + U.esc(d.notes.slice(0, 40)) : "") + "</span></span>" +
        '<span class="lr-tail">' +
        (d._pending ? '<span class="lr-pending" title="Saved on device, not yet synced"></span>' : "") +
        '<span class="lr-flags">' +
        flags.map(function (f) {
          return '<span class="lr-flag' + (f.warn ? " warn" : "") + '" title="' +
            U.esc(f.label) + '" aria-label="' + U.esc(f.label) + '">' + f.k + "</span>";
        }).join("") +
        "</span>" +
        '<span class="lr-b" style="color:' + ST.bristol.color(d.bristol) + '" aria-label="Type ' +
        d.bristol + '">' + d.bristol + "</span></span>"
      );
    }
    if (entry.type === "meal") {
      var title = ST.entry.mealTitle(d, ST.state.items);
      var portions = (d.consumption_events || [])
        .map(function (ce) { return ce.portion_ordinal || "unknown"; })
        .filter(function (v, i, a) { return a.indexOf(v) === i; })
        .join("/");
      return (
        '<span class="lr-time">' + U.esc(U.fmtClock(d.ts_utc)) + "</span>" +
        '<span class="lr-glyph t-meal" aria-hidden="true">▬</span>' +
        '<span class="lr-main"><span class="lr-title">' + U.esc(title) + "</span>" +
        '<span class="lr-sub">' + U.esc([d.label, d.context, portions].filter(Boolean).join(" · ")) +
        "</span></span>" +
        '<span class="lr-tail">' +
        (d._pending ? '<span class="lr-pending" title="Saved on device, not yet synced"></span>' : "") +
        "</span>"
      );
    }
    return (
      '<span class="lr-time">' + U.esc(d.time) + "</span>" +
      '<span class="lr-glyph t-other" aria-hidden="true">·</span>' +
      '<span class="lr-main"><span class="lr-title">' + U.esc(d.text) + "</span>" +
      '<span class="lr-sub">note</span></span>' +
      '<span class="lr-tail"></span>'
    );
  }

  function detailFor(entry) {
    var d = entry.data;
    var box = U.el('<div class="lr-detail"></div>');

    if (entry.type === "symptom") {
      var d2 = d;
      if (!isBm(d2)) {
        box.appendChild(U.el(
          "<dl class='kv'>" +
          kv("recorded", U.fmtDay(U.localDate(d2)) + " " + U.fmtClock(d2.ts_utc)) +
          kv("utc", d2.ts_utc) +
          kv("kind", "symptom, not a bowel movement") +
          kv("bristol", "not applicable") +
          kv("pain", d2.pain == null ? "—" : U.SEVERITY[d2.pain]) +
          kv("bloating", d2.bloating == null ? "—" : U.SEVERITY[d2.bloating]) +
          kv("notes", d2.notes || "—") +
          kv("sync", d2._pending ? "saved on device" : "synced") +
          "</dl>"
        ));
        var oacts = U.el('<div class="detail-actions"></div>');
        var oedit = U.el('<button type="button" class="btn ghost">Edit details</button>');
        oedit.addEventListener("click", function () {
          ST.entry.openStoolDetail(d2, { fresh: false });
        });
        oacts.appendChild(oedit);
        var odel = U.el('<button type="button" class="btn ghost">Delete</button>');
        odel.addEventListener("click", function () {
          ST.sync.remove("symptom", d2.id);
          ST.toast.show("Record deleted", { duration: 2200 });
        });
        oacts.appendChild(odel);
        box.appendChild(oacts);
        return box;
      }
      box.appendChild(ST.bristol.miniRow(d.bristol, function (n) {
        var next = Object.assign({}, d, { bristol: n });
        ST.sync.save("symptom", next).then(function () {
          ST.toast.show("Changed to type " + n, { duration: 2200 });
        });
      }));
      box.appendChild(U.el(
        "<dl class='kv'>" +
        kv("recorded", U.fmtDay(U.localDate(d)) + " " + U.fmtClock(d.ts_utc)) +
        kv("utc", d.ts_utc) +
        kv("offset", (d.tz_offset_min >= 0 ? "+" : "") + d.tz_offset_min + " min") +
        kv("bristol", d.bristol) +
        kv("urgency", d.urgency == null ? "—" : U.SEVERITY[d.urgency]) +
        kv("volume", d.volume || "—") +
        kv("pain", d.pain == null ? "—" : U.SEVERITY[d.pain]) +
        kv("bloating", d.bloating == null ? "—" : U.SEVERITY[d.bloating]) +
        kv("incomplete", d.incomplete == null ? "—" : d.incomplete ? "yes" : "no") +
        kv("overnight", d.nocturnal ? "yes" : "no") +
        kv("blood", d.blood_flag == null ? "—" : d.blood_flag ? "yes" : "no") +
        kv("mucus", d.mucus_flag == null ? "—" : d.mucus_flag ? "yes" : "no") +
        kv("notes", d.notes || "—") +
        kv("sync", d._pending ? "saved on device" : "synced") +
        "</dl>"
      ));
      var acts = U.el('<div class="detail-actions"></div>');
      var edit = U.el('<button type="button" class="btn ghost">Edit details</button>');
      edit.addEventListener("click", function () { ST.entry.openStoolDetail(d, { fresh: false }); });
      acts.appendChild(edit);
      var del = U.el('<button type="button" class="btn ghost">Delete</button>');
      del.addEventListener("click", function () {
        ST.sync.remove("symptom", d.id);
        ST.toast.show("Record deleted", { duration: 2200 });
      });
      acts.appendChild(del);
      box.appendChild(acts);
      return box;
    }

    if (entry.type === "meal") {
      var lines = (d.consumption_events || []).map(function (ce) {
        var it = (ST.state.items || []).find(function (x) { return x.id === ce.item_id; });
        return kv((it && it.name) || ce.item_name || "item", ce.portion_ordinal || "portion unknown");
      }).join("");
      box.appendChild(U.el(
        "<dl class='kv'>" + lines +
        kv("recorded", U.fmtDay(U.localDate(d)) + " " + U.fmtClock(d.ts_utc)) +
        kv("utc", d.ts_utc) +
        kv("label", d.label || "—") +
        kv("where", d.context || "—") +
        kv("notes", d.notes || "—") +
        kv("sync", d._pending ? "saved on device" : "synced") +
        "</dl>"
      ));

      /* Which of these foods are holding this meal back from being
         classifiable, and a one-tap way to fix it. */
      var unreviewed = (d.consumption_events || [])
        .map(function (ce) {
          return (ST.state.items || []).find(function (x) { return x.id === ce.item_id; });
        })
        .filter(function (it) { return it && !ST.review.isReviewed(it); });
      if (unreviewed.length) {
        var warn = U.el(
          '<div class="quickfix">' +
          '<p class="quickfix-label">unreviewed in this meal</p>' +
          "</div>"
        );
        unreviewed.forEach(function (it) {
          var line = U.el(
            '<div class="item-review-line">' +
            '<span class="irl-name">' + U.esc(it.name) + "</span>" +
            '<button type="button" class="irl-review-btn">review</button></div>'
          );
          line.querySelector("button").addEventListener("click", function () {
            ST.review.openItemSheet(it.id);
          });
          warn.appendChild(line);
        });
        warn.appendChild(U.el(
          '<p class="faint" style="font-size:12px;line-height:1.45;margin:8px 0 0">' +
          "Until these are reviewed, nothing in the window after this meal can count " +
          "as unexposed — only as unknown.</p>"
        ));
        box.appendChild(warn);
      }

      var macts = U.el('<div class="detail-actions"></div>');
      var medit = U.el('<button type="button" class="btn ghost">Edit meal</button>');
      medit.addEventListener("click", function () {
        ST.entry.openMealEdit(JSON.parse(JSON.stringify(d)), { isNew: false });
      });
      macts.appendChild(medit);
      var again = U.el('<button type="button" class="btn ghost">Log again now</button>');
      again.addEventListener("click", function () {
        var copy = ST.entry.draftFrom(d);
        copy.consumption_events.forEach(function (ce) { ce.meal_id = copy.id; });
        ST.sync.save("meal", copy).then(function () {
          ST.toast.show("Logged again · " + U.fmtClock(copy.ts_utc), {
            actionLabel: "Undo",
            onAction: function () { ST.sync.undoCreate("meal", copy.id); },
          });
        });
      });
      macts.appendChild(again);
      var mdel = U.el('<button type="button" class="btn ghost">Delete</button>');
      mdel.addEventListener("click", function () {
        ST.sync.remove("meal", d.id);
        ST.toast.show("Meal deleted", { duration: 2200 });
      });
      macts.appendChild(mdel);
      box.appendChild(macts);
      return box;
    }

    box.appendChild(U.el(
      "<dl class='kv'>" + kv("day", d.date) + kv("time", d.time) + kv("text", d.text) +
      "</dl><p class='faint mono' style='font-size:11px'>Stored on the day's state note.</p>"
    ));
    return box;
  }

  function kv(k, v) {
    return "<dt>" + U.esc(k) + "</dt><dd>" + U.esc(v) + "</dd>";
  }

  function renderList(entries, container, options) {
    var opts = options || {};
    var list = U.el('<div class="log-list"></div>');
    if (!entries.length) {
      list.appendChild(U.el('<p class="empty">' + U.esc(opts.emptyText || "Nothing here yet.") + "</p>"));
      container.appendChild(list);
      return;
    }
    entries.forEach(function (entry) {
      var row = U.el(
        '<button type="button" class="log-row" aria-expanded="false">' + rowHtml(entry) + "</button>"
      );
      var detail = null;
      row.addEventListener("click", function () {
        if (detail) {
          detail.remove();
          detail = null;
          row.setAttribute("aria-expanded", "false");
          row.classList.remove("is-open");
          return;
        }
        detail = detailFor(entry);
        row.after(detail);
        row.setAttribute("aria-expanded", "true");
        row.classList.add("is-open");
      });
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  /* ------------------------------------------------------------ coverage */

  function dayHas(date) {
    var meals = (ST.state.meals || []).some(function (m) { return U.localDate(m) === date; });
    /* Coverage counts bowel records specifically — a bloating note is a
       real observation but it is not the outcome the study is built on. */
    var stools = (ST.state.symptoms || []).some(function (s) {
      return isBm(s) && U.localDate(s) === date;
    });
    var day = (ST.state.days || {})[date];
    return {
      meal: meals || !!(day && day.nothing_eaten),
      stool: stools,
      censored: isCensored(date),
    };
  }

  function isCensored(date) {
    return (ST.state.censor || []).some(function (w) {
      return date >= U.localDate({ ts_utc: w.start_utc }) &&
        date <= U.localDate({ ts_utc: w.end_utc });
    });
  }

  function coverageWindow(days) {
    var today = U.todayLocal();
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var date = U.addDays(today, -i);
      out.push(Object.assign({ date: date }, dayHas(date)));
    }
    return out;
  }

  function bestCoverage(spanDays) {
    var all = (ST.state.meals || []).concat(ST.state.symptoms || []);
    if (!all.length) return null;
    var first = all.reduce(function (min, r) {
      var d = U.localDate(r);
      return !min || d < min ? d : min;
    }, null);
    var today = U.todayLocal();
    var total = U.daysBetween(first, today) + 1;
    if (total < spanDays) return null;
    var best = 0;
    for (var start = 0; start <= total - spanDays; start++) {
      var hits = 0;
      for (var i = 0; i < spanDays; i++) {
        var date = U.addDays(first, start + i);
        var h = dayHas(date);
        if (h.meal && h.stool) hits++;
      }
      best = Math.max(best, hits / spanDays);
    }
    return Math.round(best * 100);
  }

  function coverageCard() {
    var win = coverageWindow(14);
    var covered = win.filter(function (d) { return d.meal && d.stool; }).length;
    var strip30 = coverageWindow(30);
    var best = bestCoverage(30);
    var today = U.todayLocal();

    var card = U.el('<section class="card coverage"></section>');
    card.appendChild(U.el(
      '<div class="coverage-head">' +
      '<span class="coverage-num">' + covered + " <small>of 14 days</small></span>" +
      (best !== null ? '<span class="mono faint" style="font-size:11px">best 30-day run · ' +
        best + "%</span>" : "") +
      "</div>"
    ));
    card.appendChild(U.el(
      '<p class="coverage-note">Days in the last two weeks with both a meal and a ' +
      U.esc(U.lex("stoolShort").toLowerCase()) + " record. " +
      (covered === 14
        ? "The recent record is continuous."
        : "Gaps are not failures — they are what the analysis has to work around, so it is worth knowing where they are.") +
      "</p>"
    ));

    var strip = U.el('<div class="cov-strip" role="list" aria-label="Coverage, last 30 days"></div>');
    strip30.forEach(function (d) {
      var item = U.el(
        '<button type="button" class="cov-day' +
        (d.date === today ? " is-today" : "") + (d.censored ? " is-censored" : "") +
        '" role="listitem" aria-label="' + U.esc(U.fmtDay(d.date)) + ": " +
        (d.meal ? "meal logged" : "no meal") + ", " +
        (d.stool ? "record logged" : "no record") +
        (d.censored ? ", excluded window" : "") + '">' +
        '<span class="cov-part' + (d.meal ? " has-meal" : "") + '"></span>' +
        '<span class="cov-part' + (d.stool ? " has-stool" : "") + '"></span>' +
        "</button>"
      );
      item.addEventListener("click", function () {
        ST.state.timelineDate = d.date;
        ST.app.go("timeline");
      });
      strip.appendChild(item);
    });
    card.appendChild(strip);
    /* The strip runs oldest to newest; land on the recent end. */
    requestAnimationFrame(function () { strip.scrollLeft = strip.scrollWidth; });
    card.appendChild(U.el(
      '<div class="cov-legend">' +
      '<span><i style="background:var(--ochre-dim)"></i>meal or “nothing eaten”</span>' +
      '<span><i style="background:var(--teal-dim)"></i>' +
      U.esc(U.lex("stoolShort").toLowerCase()) + " record</span>" +
      "</div>"
    ));
    return card;
  }

  /* ------------------------------------------------ completeness prompt */

  var ANSWERS = [
    { v: "complete", label: "Complete" },
    { v: "mostly", label: "Mostly" },
    { v: "partial", label: "Partial" },
    { v: "unsure", label: "Not sure" },
    { v: "declined", label: "Prefer not to say" },
  ];

  var MISSING = ["meals", "symptoms", "times", "portions"];

  function promptDue() {
    var date = U.todayLocal();
    var day = (ST.state.days || {})[date];
    if (day && day.completeness && day.completeness !== "unanswered") return false;
    var snooze = ST.state.settings.promptSnoozeUntil;
    if (snooze && Date.now() < snooze) return false;
    if (!ST.state.settings.promptEnabled) return false;
    var parts = String(ST.state.settings.promptTime || "21:00").split(":");
    var hour = parseInt(parts[0], 10);
    var minute = parseInt(parts[1], 10);
    if (isNaN(hour)) hour = 21;
    if (isNaN(minute)) minute = 0;
    var now = new Date();
    var due = new Date();
    due.setHours(hour, minute, 0, 0);
    return now >= due;
  }

  function answerLabel(v) {
    var found = ANSWERS.find(function (a) { return a.v === v; });
    return found ? found.label : v;
  }

  function saveCompleteness(value, missing) {
    var date = U.todayLocal();
    var existing = (ST.state.days || {})[date] || {};
    var row = Object.assign({}, existing, {
      id: date,
      local_date: date,
      completeness: value,
      missing_kinds: missing && missing.length ? JSON.stringify(missing) : existing.missing_kinds || null,
    });
    return ST.sync.save("day", row);
  }

  function completenessCard() {
    var date = U.todayLocal();
    var day = (ST.state.days || {})[date];

    if (day && day.completeness && day.completeness !== "unanswered") {
      var missing = [];
      try { missing = JSON.parse(day.missing_kinds || "[]"); } catch (e) { missing = []; }
      var row = U.el(
        '<div class="answered-row">' +
        "<span>Today logged as <b>" + U.esc(answerLabel(day.completeness).toLowerCase()) + "</b>" +
        (missing.length ? " · missing " + U.esc(missing.join(", ")) : "") + "</span>" +
        '<button type="button" class="btn quiet">change</button>' +
        "</div>"
      );
      row.querySelector("button").addEventListener("click", function () {
        var next = Object.assign({}, day, { completeness: null });
        ST.state.days[date] = next;
        ST.app.render();
      });
      return row;
    }

    if (!promptDue()) return null;

    var card = U.el('<section class="prompt-card"></section>');
    card.appendChild(U.el('<p class="prompt-q">How complete was today\'s log?</p>'));
    card.appendChild(U.el(
      '<p class="prompt-why">This is the denominator for everything else. ' +
      "A partial day answered honestly is more useful than a day left blank.</p>"
    ));
    var opts = U.el('<div class="prompt-opts" role="group" aria-label="Completeness"></div>');
    ANSWERS.forEach(function (a) {
      var chip = U.el('<button type="button" class="chip">' + U.esc(a.label) + "</button>");
      chip.addEventListener("click", function () {
        saveCompleteness(a.v, null).then(function () {
          U.haptic(12);
          if (a.v === "complete" || a.v === "declined") {
            ST.toast.show("Recorded.", { duration: 1800 });
          } else {
            askMissing();
          }
        });
      });
      opts.appendChild(chip);
    });
    card.appendChild(opts);

    var foot = U.el('<div class="prompt-foot"></div>');
    var later = U.el('<button type="button" class="btn quiet">Ask me later</button>');
    later.addEventListener("click", function () {
      ST.state.settings.promptSnoozeUntil = Date.now() + 2 * 3600 * 1000;
      ST.settings.persist();
      ST.app.render();
    });
    foot.appendChild(later);
    foot.appendChild(U.el(
      '<span class="mono faint" style="font-size:10.5px">asked once a day at ' +
      U.esc(ST.state.settings.promptTime) + "</span>"
    ));
    card.appendChild(foot);
    return card;
  }

  function askMissing() {
    ST.sheet.open({
      title: "What may be missing?",
      render: function (body, ctx) {
        body.appendChild(U.el(
          '<p class="sheet-note">Optional. Knowing which part of the day is thin is what ' +
          "lets the analysis exclude it rather than quietly treat it as a zero.</p>"
        ));
        var picked = [];
        var wrap = U.el('<div class="prompt-opts"></div>');
        MISSING.forEach(function (m) {
          var chip = U.el('<button type="button" class="chip" aria-pressed="false">' + m + "</button>");
          chip.addEventListener("click", function () {
            var on = chip.getAttribute("aria-pressed") === "true";
            chip.setAttribute("aria-pressed", on ? "false" : "true");
            if (on) picked = picked.filter(function (x) { return x !== m; });
            else picked.push(m);
          });
          wrap.appendChild(chip);
        });
        body.appendChild(wrap);
        var actions = U.el('<div class="sheet-actions"></div>');
        var save = U.el('<button type="button" class="btn primary">Save</button>');
        save.addEventListener("click", function () {
          var date = U.todayLocal();
          var day = (ST.state.days || {})[date] || {};
          saveCompleteness(day.completeness || "partial", picked);
          ctx.close(true);
        });
        actions.appendChild(save);
        var skip = U.el('<button type="button" class="btn ghost">Skip</button>');
        skip.addEventListener("click", function () { ctx.close(true); });
        actions.appendChild(skip);
        body.appendChild(actions);
      },
    });
  }

  /* --------------------------------------------------------------- view */

  function render(container) {
    var today = U.todayLocal();
    container.innerHTML = "";

    container.appendChild(coverageCard());

    var prompt = completenessCard();
    if (prompt) {
      var slot = U.el('<div style="margin-top:10px"></div>');
      slot.appendChild(prompt);
      container.appendChild(slot);
    }

    var entries = unifyEvents(today);
    var mealCount = entries.filter(function (e) { return e.type === "meal"; }).length;
    var recCount = entries.filter(function (e) {
      return e.type === "symptom" && isBm(e.data);
    }).length;
    var otherCount = entries.filter(function (e) {
      return e.type === "symptom" && !isBm(e.data);
    }).length;
    var head = U.el(
      '<div class="section-head"><h2>Today</h2>' +
      '<span class="mono faint" style="font-size:10.5px">' +
      U.plural(mealCount, "meal") + " · " + U.plural(recCount, "record") +
      (otherCount ? " · " + U.plural(otherCount, "symptom") : "") +
      "</span></div>"
    );
    container.appendChild(head);

    var day = (ST.state.days || {})[today];
    if (day && day.nothing_eaten) {
      container.appendChild(U.el(
        '<p class="answered-row" style="margin-bottom:8px">' +
        "<span>Recorded: nothing eaten today.</span></p>"
      ));
    }

    renderList(entries, container, {
      emptyText: "Nothing logged today yet. The two buttons below are the fast way in.",
    });

    if (entries.length) {
      var more = U.el(
        '<button type="button" class="btn quiet" style="width:100%;margin-top:12px">' +
        "See earlier days →</button>"
      );
      more.addEventListener("click", function () { ST.app.go("timeline"); });
      container.appendChild(more);
    }
  }

  ST.today = {
    render: render,
    unifyEvents: unifyEvents,
    renderList: renderList,
    coverageWindow: coverageWindow,
    dayHas: dayHas,
    isCensored: isCensored,
    isBm: isBm,
    saveCompleteness: saveCompleteness,
    ANSWERS: ANSWERS,
  };
})(window.ST);
