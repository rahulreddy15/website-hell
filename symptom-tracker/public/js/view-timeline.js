/* view-timeline.js — one shared time axis.

   Meals are instant markers, bowel records are vertical markers labelled
   with their Bristol number, and reported severity gets its own row.
   Nothing is stacked into a single overloaded chart.

   Meals are drawn as instants, not bands, because consumption_event has a
   timestamp and no duration. The old band width was chosen to fit a text
   label, which meant it asserted an eating window that was never observed.
   Names are not drawn on the axis at all: long titles collided, and the
   point of the view is the timing of intake against symptoms. Tap a marker
   to read the record.

   The lag window is the whole point of the view: pick 0–6h, 6–24h or
   24–48h and the shading shows exactly which later events fall inside the
   window of which meal. The axis therefore runs past midnight by the width
   of the window, because a 24–48h lag from Tuesday's dinner lands on
   Thursday and pretending otherwise would be dishonest.
*/

(function (ST) {
  "use strict";

  var U = ST.util;
  var PX_PER_HOUR = 52;

  var LAGS = [
    { k: "off", label: "no window", from: 0, to: 0 },
    { k: "0-6", label: "0–6 h", from: 0, to: 6 },
    { k: "6-24", label: "6–24 h", from: 6, to: 24 },
    { k: "24-48", label: "24–48 h", from: 24, to: 48 },
  ];

  function lagFor(key) {
    return LAGS.find(function (l) { return l.k === key; }) || LAGS[2];
  }

  function dayStartMs(date) {
    return new Date(date + "T00:00:00").getTime();
  }

  function xFor(tsUtc, startMs) {
    return ((new Date(tsUtc).getTime() - startMs) / 3600000) * PX_PER_HOUR;
  }

  function render(container) {
    container.innerHTML = "";
    var date = ST.state.timelineDate || U.todayLocal();
    var lag = lagFor(ST.state.settings.lagWindow);
    var spanHours = 24 + lag.to;
    var startMs = dayStartMs(date);
    var endMs = startMs + spanHours * 3600000;

    /* ---- day strip */
    var strip = U.el('<div class="tl-daystrip" role="group" aria-label="Choose a day"></div>');
    for (var i = 29; i >= 0; i--) {
      (function (d) {
        var has = ST.today.dayHas(d);
        var btn = U.el(
          '<button type="button" class="tl-day" aria-pressed="' + (d === date) + '"' +
          ' aria-label="' + U.esc(U.fmtDay(d)) + '">' +
          "<span>" + U.esc(U.fmtDay(d, { weekday: "narrow" })) + "</span>" +
          "<b>" + Number(d.slice(8, 10)) + "</b>" +
          '<span class="tl-dots">' +
          '<i class="' + (has.meal ? "m" : "") + '"></i>' +
          '<i class="' + (has.stool ? "s" : "") + '"></i>' +
          "</span></button>"
        );
        btn.addEventListener("click", function () {
          ST.state.timelineDate = d;
          render(container);
        });
        strip.appendChild(btn);
      })(U.addDays(U.todayLocal(), -i));
    }
    container.appendChild(strip);
    requestAnimationFrame(function () {
      var on = strip.querySelector('[aria-pressed="true"]');
      if (on) on.scrollIntoView({ inline: "center", block: "nearest" });
    });

    /* ---- lag control */
    var controls = U.el('<div class="chip-row" role="group" aria-label="Lag window"></div>');
    LAGS.forEach(function (l) {
      var chip = U.el(
        '<button type="button" class="chip' + (l.k === lag.k ? " is-on" : "") + '">' +
        U.esc(l.label) + "</button>"
      );
      chip.addEventListener("click", function () {
        ST.state.settings.lagWindow = l.k;
        ST.settings.persist();
        render(container);
      });
      controls.appendChild(chip);
    });
    container.appendChild(controls);

    /* ---- data in range */
    var meals = (ST.state.meals || []).filter(function (m) { return U.localDate(m) === date; });
    var inRange = (ST.state.symptoms || []).filter(function (s) {
      var t = new Date(s.ts_utc).getTime();
      return t >= startMs && t < endMs;
    });
    var symptoms = inRange.filter(function (s) { return ST.today.isBm(s); });
    var others = inRange.filter(function (s) { return !ST.today.isBm(s); });
    var notes = [];
    Object.keys(ST.state.states || {}).forEach(function (d) {
      ST.entry.parseOtherNotes(ST.state.states[d]).forEach(function (n) {
        var t = new Date(d + "T" + n.time + ":00").getTime();
        if (t >= startMs && t < endMs) notes.push({ t: t, n: n, date: d });
      });
    });

    var selected = ST.state.timelineSelection || null;

    /* ---- frame */
    var frame = U.el('<div class="tl-frame"></div>');
    var scroll = U.el('<div class="tl-scroll"></div>');
    var inner = U.el('<div class="tl-inner" style="width:' + spanHours * PX_PER_HOUR + 'px"></div>');

    /* axis */
    var axis = U.el('<div class="tl-axis"></div>');
    for (var h = 0; h <= spanHours; h += 2) {
      var labelDate = new Date(startMs + h * 3600000);
      var hh = labelDate.getHours();
      axis.appendChild(U.el(
        '<span class="tl-tick" style="left:' + h * PX_PER_HOUR + 'px">' +
        (hh === 0 ? U.fmtDay(U.todayLocal(labelDate), { month: "short", day: "numeric" })
                  : (hh < 10 ? "0" : "") + hh) +
        "</span>"
      ));
    }
    inner.appendChild(axis);

    /* lag shading, drawn behind everything else */
    var lagLayer = U.el(
      '<div style="position:absolute;left:0;right:0;top:24px;bottom:0;pointer-events:none"></div>'
    );
    if (lag.to > 0) {
      meals.forEach(function (m) {
        if (selected && selected.type === "meal" && selected.id !== m.id) return;
        var x0 = xFor(m.ts_utc, startMs) + lag.from * PX_PER_HOUR;
        var w = (lag.to - lag.from) * PX_PER_HOUR;
        lagLayer.appendChild(U.el(
          '<div class="tl-lag" style="left:' + x0 + "px;width:" + w + "px;opacity:" +
          (selected ? 1 : 0.55) + '"></div>'
        ));
      });
    }
    inner.appendChild(lagLayer);

    /* censor windows */
    (ST.state.censor || []).forEach(function (w) {
      var a = Math.max(xFor(w.start_utc, startMs), 0);
      var b = Math.min(xFor(w.end_utc, startMs), spanHours * PX_PER_HOUR);
      if (b <= 0 || a >= spanHours * PX_PER_HOUR) return;
      inner.appendChild(U.el(
        '<div class="tl-censor" style="left:' + a + "px;width:" + (b - a) +
        'px;top:24px" title="Excluded: ' + U.esc(w.reason) + '"></div>'
      ));
    });

    /* row: meals.
       Drawn as a point, not a labelled band. Two reasons: long dish names
       collided and were unreadable, and — more importantly — the band's
       width was only ever chosen to fit its text. A consumption_event has
       a timestamp and no duration, so a band asserts an eating window that
       was never observed. The name lives in the accessible label and in
       the detail you get by tapping. */
    var rowMeals = U.el('<div class="tl-row"><span class="tl-rowlabel">meals</span></div>');
    meals.forEach(function (m) {
      var x = xFor(m.ts_utc, startMs);
      var title = ST.entry.mealTitle(m, ST.state.items);
      var mark = U.el(
        '<button type="button" class="tl-meal" style="left:' + x + 'px" aria-label="' +
        U.esc(U.fmtClock(m.ts_utc) + ", meal, " + title) + '">' +
        '<span class="tl-meal-dot"></span><span class="tl-stem"></span></button>'
      );
      if (selected && selected.id === m.id) mark.classList.add("is-selected");
      mark.addEventListener("click", function () {
        toggleSelect({ type: "meal", id: m.id, data: m });
      });
      rowMeals.appendChild(mark);
    });
    inner.appendChild(rowMeals);

    /* row: bowel records */
    var rowSym = U.el(
      '<div class="tl-row"><span class="tl-rowlabel">' +
      U.esc(U.lex("stoolPlural")) + "</span></div>"
    );
    symptoms.forEach(function (s) {
      var x = xFor(s.ts_utc, startMs);
      var mark = U.el(
        '<button type="button" class="tl-mark" style="left:' + x + "px;--b-color:" +
        ST.bristol.color(s.bristol) + '" aria-label="' +
        U.esc(U.fmtClock(s.ts_utc) + ", type " + s.bristol + ", " +
          ST.bristol.byNumber(s.bristol).short) + '">' +
        '<span class="tl-num">' + s.bristol + "</span>" +
        '<span class="tl-stem"></span></button>'
      );
      if (selected && selected.id === s.id) mark.style.outline = "2px solid var(--ink)";
      mark.addEventListener("click", function () {
        toggleSelect({ type: "symptom", id: s.id, data: s });
      });
      rowSym.appendChild(mark);
    });
    inner.appendChild(rowSym);

    /* row: reported severity, plus symptoms that had no bowel movement */
    var rowSev = U.el('<div class="tl-row" style="height:52px"><span class="tl-rowlabel">symptoms</span></div>');
    symptoms.forEach(function (s) {
      var level = Math.max(s.urgency || 0, s.pain || 0, s.bloating || 0);
      if (!level) return;
      rowSev.appendChild(U.el(
        '<div class="tl-sev" style="left:' + xFor(s.ts_utc, startMs) + "px;height:" +
        level * 9 + 'px" title="reported severity ' + U.SEVERITY[level] + '"></div>'
      ));
    });
    others.forEach(function (s) {
      var level = Math.max(s.pain || 0, s.bloating || 0, 1);
      var mark = U.el(
        '<button type="button" class="tl-other" style="left:' + xFor(s.ts_utc, startMs) +
        "px;height:" + (level * 9 + 8) + 'px" aria-label="' +
        U.esc(U.fmtClock(s.ts_utc) + ", " + ST.entry.otherSummary(s) +
          ", no bowel movement") + '"><span class="tl-other-dot">◇</span></button>'
      );
      if (selected && selected.id === s.id) mark.style.outline = "2px solid var(--ink)";
      mark.addEventListener("click", function () {
        toggleSelect({ type: "symptom", id: s.id, data: s });
      });
      rowSev.appendChild(mark);
    });
    notes.forEach(function (item) {
      rowSev.appendChild(U.el(
        '<div class="tl-sev" style="left:' + ((item.t - startMs) / 3600000) * PX_PER_HOUR +
        'px;height:8px;background:var(--muted)" title="' + U.esc(item.n.text) + '"></div>'
      ));
    });
    inner.appendChild(rowSev);

    scroll.appendChild(inner);
    frame.appendChild(scroll);
    container.appendChild(frame);

    requestAnimationFrame(function () {
      scroll.scrollLeft = Math.max(0, 7 * PX_PER_HOUR);
    });

    container.appendChild(U.el(
      '<div class="tl-legend">' +
      '<span><i class="lg-meal"></i>meal</span>' +
      '<span><i class="lg-bm"></i>' + U.esc(U.lex("stoolShort").toLowerCase()) +
      ", numbered by type</span>" +
      '<span><i class="lg-other"></i>symptom, no bowel movement</span>' +
      '<span><i class="lg-sev"></i>reported severity</span>' +
      (lag.to ? '<span><i class="lg-lag"></i>' + U.esc(lag.label) + " after a meal</span>" : "") +
      '<span><i class="lg-censor"></i>excluded window</span>' +
      "</div>"
    ));

    /* ---- selection detail, inline rather than modal */
    var detailHost = U.el('<div style="margin-top:14px"></div>');
    container.appendChild(detailHost);

    function toggleSelect(entry) {
      if (selected && selected.id === entry.id) ST.state.timelineSelection = null;
      else ST.state.timelineSelection = entry;
      render(container);
    }

    if (selected) {
      var entry = selected.type === "meal"
        ? { type: "meal", id: selected.id, data: (ST.state.meals || []).find(function (m) { return m.id === selected.id; }) }
        : { type: "symptom", id: selected.id, data: (ST.state.symptoms || []).find(function (s) { return s.id === selected.id; }) };
      if (entry.data) {
        detailHost.appendChild(U.el('<div class="section-head"><h2>Selected record</h2></div>'));
        ST.today.renderList([entry], detailHost, {});
      }
    } else {
      detailHost.appendChild(U.el(
        '<p class="mono faint" style="font-size:11px;padding:6px 2px;line-height:1.55">' +
        "Names are not drawn on the axis — tap any marker to read the record and isolate " +
        "its window.</p>"
      ));
    }

    /* ---- the day itself */
    var dayCard = U.el('<div class="card" style="margin-top:16px"></div>');
    var day = (ST.state.days || {})[date] || {};
    dayCard.appendChild(U.el(
      '<div class="section-head" style="margin-top:0"><h2>' + U.esc(U.dayLabel(date)) + "</h2>" +
      '<span class="mono faint" style="font-size:10.5px">' +
      U.esc(day.completeness ? "logged as " + day.completeness : "completeness unanswered") +
      "</span></div>"
    ));

    var dayActions = U.el('<div class="detail-actions"></div>');

    var setComplete = U.el('<button type="button" class="btn ghost">Set completeness</button>');
    setComplete.addEventListener("click", function () { openCompletenessFor(date, container); });
    dayActions.appendChild(setComplete);

    var censored = ST.today.isCensored(date);
    var censorBtn = U.el(
      '<button type="button" class="btn ghost">' +
      (censored ? "Remove exclusion" : "Exclude this day") + "</button>"
    );
    censorBtn.addEventListener("click", function () {
      if (censored) removeCensorFor(date, container);
      else openCensorFor(date, container);
    });
    dayActions.appendChild(censorBtn);

    dayCard.appendChild(dayActions);
    dayCard.appendChild(U.el(
      '<p class="prose small" style="margin-top:10px">Excluding a day removes it from every ' +
      "rate calculation. Use it for a stomach bug, a course of antibiotics or a trip — " +
      "an acute infection looks exactly like a food association and lasts for days.</p>"
    ));
    container.appendChild(dayCard);

    /* ---- flat list for the day, for people who would rather read */
    container.appendChild(U.el('<div class="section-head"><h2>Everything on this day</h2></div>'));
    ST.today.renderList(ST.today.unifyEvents(date), container, {
      emptyText: "Nothing recorded on this day.",
    });
  }

  function openCompletenessFor(date, container) {
    ST.sheet.open({
      title: "How complete was " + U.dayLabel(date).toLowerCase() + "?",
      render: function (body, ctx) {
        var wrap = U.el('<div class="prompt-opts"></div>');
        ST.today.ANSWERS.forEach(function (a) {
          var chip = U.el('<button type="button" class="chip">' + U.esc(a.label) + "</button>");
          chip.addEventListener("click", function () {
            var existing = (ST.state.days || {})[date] || {};
            ST.sync.save("day", Object.assign({}, existing, {
              id: date, local_date: date, completeness: a.v,
            })).then(function () {
              ctx.close(true);
              ST.timeline.render(container);
            });
          });
          wrap.appendChild(chip);
        });
        body.appendChild(wrap);
      },
    });
  }

  function openCensorFor(date, container) {
    ST.sheet.open({
      title: "Exclude " + U.dayLabel(date).toLowerCase(),
      render: function (body, ctx) {
        body.appendChild(U.el(
          '<p class="sheet-note">The analysis will skip this window entirely rather than ' +
          "try to adjust for it.</p>"
        ));
        var reason = { value: "illness" };
        body.appendChild(ST.entry.field("Reason", ST.entry.segmented({
          label: "Reason",
          value: "illness",
          options: [
            { value: "illness", label: "illness" },
            { value: "travel", label: "travel" },
            { value: "antibiotics", label: "antibiotics" },
            { value: "other", label: "other" },
          ],
          onChange: function (v) { reason.value = v; },
        })));
        var days = { value: 1 };
        body.appendChild(ST.entry.field("How many days", ST.entry.segmented({
          label: "How many days",
          value: 1,
          options: [1, 2, 3, 5, 7].map(function (n) { return { value: n, label: n + "d" }; }),
          onChange: function (v) { days.value = v; },
        })));
        var notes = U.el('<label class="field"><span>Note</span><input type="text"></label>');
        body.appendChild(notes);
        var actions = U.el('<div class="sheet-actions"></div>');
        var go = U.el('<button type="button" class="btn primary">Exclude</button>');
        go.addEventListener("click", function () {
          var start = new Date(date + "T00:00:00");
          var end = new Date(start.getTime() + days.value * 86400000 - 60000);
          ST.sync.save("censor", {
            id: U.uuid(),
            start_utc: U.isoUtc(start),
            end_utc: U.isoUtc(end),
            reason: reason.value,
            notes: notes.querySelector("input").value || null,
          }).then(function () {
            ctx.close(true);
            ST.toast.show("Excluded " + U.plural(days.value, "day"), { duration: 2600 });
            ST.timeline.render(container);
          });
        });
        actions.appendChild(go);
        body.appendChild(actions);
      },
    });
  }

  function removeCensorFor(date, container) {
    var hit = (ST.state.censor || []).find(function (w) {
      return date >= U.localDate({ ts_utc: w.start_utc }) && date <= U.localDate({ ts_utc: w.end_utc });
    });
    if (!hit) return;
    ST.sync.remove("censor", hit.id).then(function () {
      ST.toast.show("Exclusion removed", { duration: 2200 });
      ST.timeline.render(container);
    });
  }

  ST.timeline = { render: render, LAGS: LAGS };
})(window.ST);
