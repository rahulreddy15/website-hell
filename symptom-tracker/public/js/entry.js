/* entry.js — capture.

   The governing rule, taken from every post-mortem of an abandoned food
   diary: capture now, classify later. A save is never blocked on knowing
   the ingredients, the portion, the exact minute, or on being online.

   Tap budget, measured from the home screen:
     bowel movement  1 (open) + 1 (pick type)      = 2, saved
     repeat meal     1 (open) + 1 (pick meal)      = 2, saved
                     + 1 optional portion change   = 3
*/

(function (ST) {
  "use strict";

  var U = ST.util;

  /* ------------------------------------------------------- small controls */

  function segmented(config) {
    var wrap = U.el(
      '<div class="segmented' + (config.teal ? " teal" : "") +
      '" role="radiogroup" aria-label="' + U.esc(config.label) + '"></div>'
    );
    wrap.innerHTML = config.options.map(function (opt, i) {
      var on = opt.value === config.value;
      return (
        '<button type="button" role="radio" data-i="' + i + '"' +
        ' aria-checked="' + (on ? "true" : "false") + '">' +
        U.esc(opt.label) + "</button>"
      );
    }).join("");
    wrap.addEventListener("click", function (event) {
      var b = event.target.closest("[data-i]");
      if (!b) return;
      wrap.querySelectorAll("[data-i]").forEach(function (x) {
        x.setAttribute("aria-checked", x === b ? "true" : "false");
      });
      U.haptic(10);
      config.onChange(config.options[Number(b.dataset.i)].value);
    });
    return wrap;
  }

  function field(labelText, control) {
    var f = U.el('<div class="field"><span>' + U.esc(labelText) + "</span></div>");
    f.appendChild(control);
    return f;
  }

  function portionControl(value, onChange) {
    return segmented({
      label: "Portion",
      value: value === undefined ? null : value,
      options: U.PORTIONS.map(function (p) { return { value: p.key, label: p.label }; }),
      onChange: onChange,
    });
  }

  function severityControl(labelText, value, onChange, teal) {
    return segmented({
      label: labelText,
      teal: teal,
      value: value === undefined ? null : value,
      options: U.SEVERITY.map(function (s, i) { return { value: i, label: s }; })
        .concat([{ value: null, label: "unknown" }]),
      onChange: onChange,
    });
  }

  function flagToggle(labelText, helpText, value, onChange) {
    var row = U.el(
      '<div class="toggle-row">' +
      '<div><div class="tr-label">' + U.esc(labelText) + "</div>" +
      (helpText ? '<div class="tr-help">' + U.esc(helpText) + "</div>" : "") +
      "</div>" +
      '<button type="button" class="switch" role="switch" aria-checked="' +
      (value ? "true" : "false") + '" aria-label="' + U.esc(labelText) + '"></button>' +
      "</div>"
    );
    var sw = row.querySelector(".switch");
    sw.addEventListener("click", function () {
      var next = sw.getAttribute("aria-checked") !== "true";
      sw.setAttribute("aria-checked", next ? "true" : "false");
      U.haptic(10);
      onChange(next);
    });
    return row;
  }

  /* ------------------------------------------------------- time control
     Time defaults to now and the record is already saved by the time this
     is visible. Changing it afterwards is a normal, unremarkable edit —
     backfilling last night is not a failure state, it is the expected
     case for someone who was not going to reach for a phone mid-episode. */

  function timeControl(record, onChange) {
    var wrap = U.el(
      '<div class="field"><span>Time</span>' +
      '<div class="chip-row" role="group" aria-label="Adjust time"></div>' +
      '<p class="mono faint" style="font-size:11px;margin:2px 2px 0"></p>' +
      "</div>"
    );
    var row = wrap.querySelector(".chip-row");
    var readout = wrap.querySelector("p");

    function paint() {
      readout.textContent =
        U.dayLabel(U.localDate(record)) + " · " + U.fmtClock(record.ts_utc) +
        " (" + U.relTime(record.ts_utc) + ")";
    }

    var shifts = [
      { label: "now", mins: 0 },
      { label: "−15 min", mins: 15 },
      { label: "−30 min", mins: 30 },
      { label: "−1 h", mins: 60 },
      { label: "−2 h", mins: 120 },
      { label: "−4 h", mins: 240 },
    ];
    row.innerHTML =
      shifts.map(function (s, i) {
        return '<button type="button" class="chip" data-mins="' + s.mins +
          '" data-i="' + i + '">' + U.esc(s.label) + "</button>";
      }).join("") +
      '<button type="button" class="chip" data-pick="1">pick exact…</button>';

    row.addEventListener("click", function (event) {
      var chip = event.target.closest(".chip");
      if (!chip) return;
      if (chip.dataset.pick) return openExact();
      var d = new Date(Date.now() - Number(chip.dataset.mins) * 60000);
      Object.assign(record, U.stamp(d));
      paint();
      onChange(record);
    });

    function openExact() {
      var pick = U.el(
        '<div class="field"><span>Exact time</span>' +
        '<input type="datetime-local" value="' + localInputValue(record.ts_utc) + '">' +
        "</div>"
      );
      var input = pick.querySelector("input");
      input.addEventListener("change", function () {
        if (!input.value) return;
        var d = new Date(input.value);
        if (isNaN(d.getTime())) return;
        Object.assign(record, U.stamp(d));
        paint();
        onChange(record);
      });
      if (!wrap.querySelector('input[type="datetime-local"]')) wrap.appendChild(pick);
      input.focus();
    }

    paint();
    return wrap;
  }

  function localInputValue(tsUtc) {
    var d = new Date(tsUtc);
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
  }

  /* ==================================================================
     BOWEL MOVEMENT — two taps
     ================================================================== */

  function openStool(options) {
    var opts = options || {};
    ST.sheet.open({
      title: U.lex("stoolSheet"),
      render: function (body, ctx) {
        body.appendChild(U.el(
          '<p class="sheet-note">' + U.esc(U.lex("pickPrompt")) +
          " You can add anything else afterwards.</p>"
        ));

        body.appendChild(ST.bristol.strip({
          selected: null,
          onSelect: function (n) {
            ctx.close(true);
            commitStool(n, opts);
          },
        }));

        var extra = U.el('<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"></div>');

        var ref = U.el('<button type="button" class="btn ghost">What the types mean</button>');
        ref.addEventListener("click", openReference);
        extra.appendChild(ref);

        var back = U.el('<button type="button" class="btn ghost">Log an earlier one</button>');
        back.addEventListener("click", function () {
          ctx.close(true);
          openStoolBackfill();
        });
        extra.appendChild(back);

        body.appendChild(extra);
      },
    });
  }

  function commitStool(bristol, options) {
    var opts = options || {};
    var when = opts.at ? new Date(opts.at) : new Date();
    var record = Object.assign(
      {
        id: U.uuid(),
        bristol: bristol,
        is_bm: 1,
        urgency: null, volume: null, pain: null, bloating: null,
        incomplete: null,
        nocturnal: U.isNocturnal(when) ? 1 : 0,
        blood_flag: null, mucus_flag: null, accident_flag: null,
        notes: null,
      },
      U.stamp(when)
    );

    ST.sync.save("symptom", record).then(function () {
      U.haptic([12, 40, 12]);
      ST.toast.show(
        U.lex("savedStool") + " · type " + bristol + " · " + U.fmtClock(record.ts_utc),
        {
          actionLabel: "Undo",
          onAction: function () {
            ST.sync.undoCreate("symptom", record.id).then(function () {
              ST.toast.show("Removed", { duration: 1800 });
            });
          },
        }
      );
      if (!opts.skipDetail) openStoolDetail(record, { fresh: true });
    });
  }

  /* Everything below the fold: optional, post-save, and never in the way.
     Handles both bowel movements and non-BM symptoms; the difference is
     whether there is a Bristol type to show at all. */
  function openStoolDetail(record, options) {
    var opts = options || {};
    var draft = Object.assign({}, record);
    var isBm = draft.is_bm !== 0;

    function persist() {
      ST.sync.save("symptom", draft, { silent: false });
    }

    ST.sheet.open({
      title: opts.fresh
        ? "Anything else? (optional)"
        : (isBm ? "Edit record" : "Edit symptom"),
      /* Nothing here needs filling in, so nothing steals focus and
         nothing gets a ring that could be mistaken for a selection. */
      autofocus: false,
      render: function (body, ctx) {
        if (opts.fresh) {
          body.appendChild(U.el(
            '<p class="sheet-note">Already saved. Close this whenever — nothing here is required.</p>'
          ));
        }

        var head;
        if (isBm) {
          head = U.el(
            '<div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
            '<span class="lr-b" style="color:' + ST.bristol.color(draft.bristol) +
            ';width:38px;height:38px;font-size:17px">' + draft.bristol + "</span>" +
            '<div><div style="font-size:14.5px">' +
            U.esc(ST.bristol.byNumber(draft.bristol).short) + "</div>" +
            '<div class="mono faint" style="font-size:11px">' +
            U.esc(U.dayLabel(U.localDate(draft)) + " · " + U.fmtClock(draft.ts_utc)) +
            "</div></div></div>"
          );
        } else {
          head = U.el(
            '<div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:14px">' +
            '<span class="lr-glyph t-other" style="width:34px;height:34px;font-size:16px">◇</span>' +
            '<div><div style="font-size:14.5px">Symptom, no bowel movement</div>' +
            '<div class="mono faint" style="font-size:11px">' +
            U.esc(U.dayLabel(U.localDate(draft)) + " · " + U.fmtClock(draft.ts_utc)) +
            "</div></div></div>"
          );
        }
        body.appendChild(head);

        if (isBm) {
          body.appendChild(ST.bristol.miniRow(draft.bristol, function (n) {
            draft.bristol = n;
            head.querySelector(".lr-b").textContent = n;
            head.querySelector(".lr-b").style.color = ST.bristol.color(n);
            head.querySelector("div div").textContent = ST.bristol.byNumber(n).short;
            persist();
          }));

          body.appendChild(field("Urgency", severityControl("Urgency", draft.urgency, function (v) {
            draft.urgency = v; persist();
          }, true)));

          body.appendChild(field("Volume", segmented({
            label: "Volume", teal: true, value: draft.volume,
            options: [
              { value: "small", label: "small" },
              { value: "medium", label: "medium" },
              { value: "large", label: "large" },
              { value: null, label: "unknown" },
            ],
            onChange: function (v) { draft.volume = v; persist(); },
          })));
        }

        body.appendChild(field("Pain", severityControl("Pain", draft.pain, function (v) {
          draft.pain = v; persist();
        }, true)));

        body.appendChild(field("Bloating", severityControl("Bloating", draft.bloating, function (v) {
          draft.bloating = v; persist();
        }, true)));

        if (isBm) {
          var flags = U.el('<div class="card" style="padding:4px 14px;margin:12px 0"></div>');
          flags.appendChild(flagToggle("Felt incomplete", "Sense of incomplete evacuation.",
            draft.incomplete === 1, function (v) { draft.incomplete = v ? 1 : 0; persist(); }));
          flags.appendChild(flagToggle("Woke you at night",
            "Set automatically for events between midnight and 5am. Worth telling a clinician about.",
            draft.nocturnal === 1, function (v) { draft.nocturnal = v ? 1 : 0; persist(); }));
          flags.appendChild(flagToggle("Blood", "Record it and mention it at your next appointment.",
            draft.blood_flag === 1, function (v) { draft.blood_flag = v ? 1 : 0; persist(); }));
          flags.appendChild(flagToggle("Mucus", "",
            draft.mucus_flag === 1, function (v) { draft.mucus_flag = v ? 1 : 0; persist(); }));
          flags.appendChild(flagToggle("Did not reach a toilet in time", "",
            draft.accident_flag === 1, function (v) { draft.accident_flag = v ? 1 : 0; persist(); }));
          body.appendChild(flags);
        }

        body.appendChild(timeControl(draft, persist));

        var notes = U.el(
          '<label class="field"><span>Notes</span>' +
          '<textarea placeholder="Anything worth remembering later.">' +
          U.esc(draft.notes || "") + "</textarea></label>"
        );
        notes.querySelector("textarea").addEventListener("change", function (e) {
          draft.notes = e.target.value || null;
          persist();
        });
        body.appendChild(notes);

        var actions = U.el('<div class="sheet-actions"></div>');
        var done = U.el('<button type="button" class="btn primary">Done</button>');
        done.addEventListener("click", function () { ctx.close(true); });
        actions.appendChild(done);
        if (!opts.fresh) {
          var del = U.el('<button type="button" class="btn ghost">Delete</button>');
          del.addEventListener("click", function () {
            ST.sync.remove("symptom", draft.id);
            ctx.close(true);
            ST.toast.show("Record deleted", { duration: 2200 });
          });
          actions.appendChild(del);
        }
        body.appendChild(actions);
      },
    });
  }

  function openReference() {
    ST.sheet.open({
      title: "Type reference",
      render: function (body) {
        body.appendChild(U.el(
          '<p class="sheet-note">The standard seven-point scale. This full view is here to ' +
          "read at leisure — the strip on the entry screen is the one to use in a hurry.</p>"
        ));
        body.appendChild(ST.bristol.referenceGrid());
      },
    });
  }

  function openStoolBackfill() {
    var when = new Date();
    var chosen = null;
    ST.sheet.open({
      title: "Fill in an earlier one",
      render: function (body, ctx) {
        body.appendChild(U.el(
          '<p class="sheet-note">Filling in something you did not log at the time is ' +
          "ordinary and expected. Set the time first, then pick the type.</p>"
        ));
        var holder = { ts_utc: U.isoUtc(when), tz_offset_min: U.tzOffsetMin(when) };
        body.appendChild(timeControl(holder, function () {}));
        body.appendChild(ST.bristol.strip({
          selected: null,
          hint: "Tap a type to save at the time above.",
          onSelect: function (n) {
            chosen = n;
            ctx.close(true);
            commitStool(n, { at: holder.ts_utc });
          },
        }));
      },
    });
  }

  /* ==================================================================
     MEALS — frecency first, search last
     ================================================================== */

  function mealSignature(meal) {
    return (meal.consumption_events || [])
      .map(function (ce) { return ce.item_id; })
      .sort()
      .join("|");
  }

  function mealTitle(meal, items) {
    var names = (meal.consumption_events || []).map(function (ce) {
      var it = items && items.find(function (x) { return x.id === ce.item_id; });
      return (it && it.name) || ce.item_name || "unnamed";
    });
    if (!names.length) return meal.label || "Empty meal";
    return names.join(", ");
  }

  /* Distinct meals in the recent window, ranked by frecency, so the thing
     he actually eats is the first thing under his thumb. */
  function frequentMeals(meals, items, days) {
    var cutoff = Date.now() - (days || 30) * 86400000;
    var groups = {};
    meals.forEach(function (meal) {
      var t = new Date(meal.ts_utc).getTime();
      if (t < cutoff) return;
      var sig = mealSignature(meal);
      if (!sig) return;
      var g = groups[sig] || (groups[sig] = { sig: sig, n: 0, last: 0, meal: meal, score: 0 });
      g.n += 1;
      var ageDays = (Date.now() - t) / 86400000;
      g.score += ageDays <= 3 ? 4 : ageDays <= 7 ? 3 : ageDays <= 14 ? 2 : 1;
      if (t > g.last) { g.last = t; g.meal = meal; }
    });
    return Object.keys(groups)
      .map(function (k) { return groups[k]; })
      .sort(function (a, b) { return b.score - a.score || b.last - a.last; });
  }

  function openMeal(options) {
    var opts = options || {};
    var items = ST.state.items || [];
    var meals = ST.state.meals || [];

    ST.sheet.open({
      title: U.lex("repeatMeal"),
      autofocus: false,
      render: function (body, ctx) {
        var last = meals[0];

        if (last) {
          var hero = U.el(
            '<button type="button" class="pick-hero">' +
            '<span><span class="ph-kicker">Repeat last</span>' +
            '<span class="ph-title">' + U.esc(mealTitle(last, items)) + "</span>" +
            '<span class="ph-sub">' + U.esc(U.relTime(last.ts_utc)) +
            (last.label ? " · " + U.esc(last.label) : "") + "</span></span>" +
            '<span class="ph-go">log now →</span></button>'
          );
          hero.addEventListener("click", function () {
            ctx.close(true);
            repeatMeal(last, items);
          });
          body.appendChild(hero);
        }

        /* -------- frequent, last 30 days */
        var freq = frequentMeals(meals, items, 30).slice(0, 8);
        if (freq.length) {
          body.appendChild(U.el(
            '<div class="section-head"><h2>Often, last 30 days</h2></div>'
          ));
          var list = U.el('<div class="log-list"></div>');
          freq.forEach(function (g) {
            list.appendChild(pickRow(
              mealTitle(g.meal, items),
              U.plural(g.n, "time") + " · last " + U.relTime(new Date(g.last).toISOString()),
              function () { ctx.close(true); repeatMeal(g.meal, items); },
              function () { ctx.close(true); openMealEdit(draftFrom(g.meal), { isNew: true }); }
            ));
          });
          body.appendChild(list);
        }

        /* -------- yesterday */
        var yst = U.addDays(U.todayLocal(), -1);
        var ystMeals = meals.filter(function (m) { return U.localDate(m) === yst; });
        if (ystMeals.length) {
          body.appendChild(U.el('<div class="section-head"><h2>Same as yesterday</h2></div>'));
          var ylist = U.el('<div class="log-list"></div>');
          ystMeals.forEach(function (m) {
            ylist.appendChild(pickRow(
              mealTitle(m, items),
              U.fmtClock(m.ts_utc) + (m.label ? " · " + m.label : ""),
              function () { ctx.close(true); repeatMeal(m, items); },
              function () { ctx.close(true); openMealEdit(draftFrom(m), { isNew: true }); }
            ));
          });
          body.appendChild(ylist);
        }

        /* -------- frequent single items */
        var topItems = items.filter(function (i) { return i._count > 0; }).slice(0, 14);
        if (topItems.length) {
          body.appendChild(U.el('<div class="section-head"><h2>Frequent items</h2></div>'));
          var chips = U.el('<div class="item-chiplist"></div>');
          topItems.forEach(function (it) {
            var chip = U.el(
              '<button type="button" class="chip">' + U.esc(it.name) +
              '<span class="faint" style="margin-left:5px">' + it._count + "</span></button>"
            );
            chip.addEventListener("click", function () {
              ctx.close(true);
              logSingleItem(it);
            });
            chips.appendChild(chip);
          });
          body.appendChild(chips);
        }

        /* -------- search, deliberately last */
        body.appendChild(U.el('<div class="section-head"><h2>Find or add</h2></div>'));
        var searchWrap = U.el(
          '<div class="search-box">' +
          '<svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true">' +
          '<circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
          '<path d="M15.6 15.6L20.5 20.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
          '<input type="search" placeholder="Search your food, or type something new" ' +
          'aria-label="Search or add food">' +
          "</div>"
        );
        var results = U.el('<div class="log-list" style="margin-top:8px"></div>');
        var input = searchWrap.querySelector("input");
        if (opts.prefill) input.value = opts.prefill;

        function runSearch() {
          var q = input.value.trim().toLowerCase();
          results.innerHTML = "";
          if (!q) return;
          var hits = items.filter(function (it) {
            return (it.name || "").toLowerCase().indexOf(q) !== -1 ||
              (it.brand || "").toLowerCase().indexOf(q) !== -1;
          }).slice(0, 12);
          hits.forEach(function (it) {
            results.appendChild(pickRow(
              it.name,
              (it.brand ? it.brand + " · " : "") + (it._count ? U.plural(it._count, "time") : "not logged yet"),
              function () { ctx.close(true); logSingleItem(it); },
              function () { ctx.close(true); openMealEdit(draftWithItem(it), { isNew: true }); }
            ));
          });
          var exact = hits.some(function (it) { return it.name.toLowerCase() === q; });
          if (!exact) {
            var add = U.el(
              '<button type="button" class="btn wide primary" style="margin-top:10px">' +
              "Add “" + U.esc(input.value.trim()) + "” and log it</button>"
            );
            add.addEventListener("click", function () {
              ctx.close(true);
              createItemAndLog(input.value.trim());
            });
            results.appendChild(add);
          }
        }
        input.addEventListener("input", U.debounce(runSearch, 120));
        body.appendChild(searchWrap);
        body.appendChild(results);
        if (opts.prefill) runSearch();

        var blank = U.el(
          '<button type="button" class="btn wide ghost" style="margin-top:14px">' +
          "Build a meal from scratch</button>"
        );
        blank.addEventListener("click", function () {
          ctx.close(true);
          openMealEdit(draftFrom(null), { isNew: true });
        });
        body.appendChild(blank);

        var nothing = U.el(
          '<button type="button" class="btn quiet" style="margin-top:10px;width:100%">' +
          "Nothing eaten today</button>"
        );
        nothing.addEventListener("click", function () {
          ctx.close(true);
          markNothingEaten();
        });
        body.appendChild(nothing);
      },
    });
  }

  /* A one-line readout of an item's attribute state, with a way in.
     Reviewed items say what they are; unreviewed ones say what that costs. */
  function reviewLine(item) {
    var reviewed = ST.review.isReviewed(item);
    var tags = ST.review.tagsFor(item.id);
    var on = Object.keys(tags).filter(function (k) { return tags[k]; }).map(U.prettyAttr);
    var row = U.el(
      '<div class="item-review-line">' +
      '<span class="irl-name">' +
      (on.length ? U.esc(on.join(", ")) : (reviewed ? "none of the candidates" : "not reviewed")) +
      "</span>" +
      '<span class="irl-state' + (reviewed ? " is-reviewed" : "") + '">' +
      (reviewed ? "reviewed" : "unknown") + "</span>" +
      '<button type="button" class="irl-review-btn">' +
      (reviewed ? "edit tags" : "review") + "</button>" +
      "</div>"
    );
    row.querySelector(".irl-review-btn").addEventListener("click", function () {
      ST.review.openItemSheet(item.id);
    });
    return row;
  }

  function pickRow(title, sub, onPick, onEdit) {    var row = U.el(
      '<div class="pick-row">' +
      '<button type="button" class="pick-main">' +
      '<span class="pm-title">' + U.esc(title) + "</span>" +
      '<span class="pm-sub">' + U.esc(sub) + "</span></button>" +
      '<button type="button" class="pick-edit" aria-label="Repeat with edits">edit</button>' +
      "</div>"
    );
    row.querySelector(".pick-main").addEventListener("click", onPick);
    row.querySelector(".pick-edit").addEventListener("click", onEdit);
    return row;
  }

  function draftFrom(meal) {
    var now = new Date();
    return Object.assign(
      {
        id: U.uuid(),
        label: meal ? meal.label : suggestLabel(now),
        context: meal ? meal.context : null,
        location: meal ? meal.location : null,
        notes: null,
        consumption_events: (meal && meal.consumption_events ? meal.consumption_events : []).map(
          function (ce) {
            return {
              id: U.uuid(),
              item_id: ce.item_id,
              item_name: ce.item_name,
              portion_ordinal: ce.portion_ordinal || null,
              amount_g: null,
              portion_basis: ce.portion_ordinal ? "ordinal" : null,
              prep_method: ce.prep_method || null,
              notes: null,
            };
          }
        ),
      },
      U.stamp(now)
    );
  }

  function draftWithItem(item) {
    var d = draftFrom(null);
    d.consumption_events = [{
      id: U.uuid(),
      item_id: item.id,
      item_name: item.name,
      portion_ordinal: item._lastPortion || item.default_portion || null,
      amount_g: null,
      portion_basis: item._lastPortion ? "ordinal" : null,
      prep_method: null,
      notes: null,
    }];
    return d;
  }

  function suggestLabel(date) {
    var h = (date || new Date()).getHours();
    if (h < 11) return "breakfast";
    if (h < 15) return "lunch";
    if (h < 18) return "snack";
    if (h < 22) return "dinner";
    return "late";
  }

  function saveMeal(draft, message) {
    draft.consumption_events.forEach(function (ce) { ce.meal_id = draft.id; });
    return ST.sync.save("meal", draft).then(function () {
      U.haptic(16);
      ST.toast.show(message, {
        actionLabel: "Undo",
        onAction: function () {
          ST.sync.undoCreate("meal", draft.id).then(function () {
            ST.toast.show("Removed", { duration: 1800 });
          });
        },
      });
      return draft;
    });
  }

  function repeatMeal(source, items) {
    var draft = draftFrom(source);
    saveMeal(draft, "Logged: " + mealTitle(draft, items) + " · " + U.fmtClock(draft.ts_utc))
      .then(function () { offerAdjust(draft); });
  }

  function logSingleItem(item) {
    var draft = draftWithItem(item);
    saveMeal(draft, "Logged: " + item.name + " · " + U.fmtClock(draft.ts_utc))
      .then(function () { offerAdjust(draft); });
  }

  function createItemAndLog(name) {
    var item = {
      id: U.uuid(),
      name: name,
      kind: "dish",
      brand: null, barcode: null, is_raw: 0,
      default_portion: null, notes: null, archived: 0,
    };
    ST.sync.save("item", item).then(function () {
      var draft = draftWithItem(item);
      saveMeal(draft, "Logged: " + name + " · " + U.fmtClock(draft.ts_utc))
        .then(function () { openMealEdit(draft, { isNew: false, justCreated: true }); });
    });
  }

  /* A quiet, dismissible offer — not a step. The meal is already saved. */
  function offerAdjust(draft) {
    ST.bus.emit("offer-adjust", draft);
  }

  function openMealEdit(draft, options) {
    var opts = options || {};
    var items = ST.state.items || [];
    var isNew = !!opts.isNew;

    function persist() {
      if (isNew) return;
      draft.consumption_events.forEach(function (ce) { ce.meal_id = draft.id; });
      ST.sync.save("meal", draft);
    }

    ST.sheet.open({
      title: isNew ? "New meal" : "Edit meal",
      autofocus: false,
      render: function (body, ctx) {
        if (!isNew) {
          body.appendChild(U.el(
            '<p class="sheet-note">Saved. Changes here are kept as you make them.</p>'
          ));
        }

        var itemsBox = U.el('<div></div>');
        function paintItems() {
          itemsBox.innerHTML = "";
          if (!draft.consumption_events.length) {
            itemsBox.appendChild(U.el(
              '<p class="empty" style="padding:16px 0">Nothing added yet.</p>'
            ));
          }
          draft.consumption_events.forEach(function (ce, index) {
            var it = items.find(function (x) { return x.id === ce.item_id; });
            var name = (it && it.name) || ce.item_name || "unnamed";
            var card = U.el(
              '<div class="card" style="margin-bottom:9px">' +
              '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
              '<div style="font-size:15px">' + U.esc(name) + "</div>" +
              '<button type="button" class="btn quiet" data-remove="' + index + '">remove</button>' +
              "</div></div>"
            );
            card.appendChild(field("Portion", portionControl(ce.portion_ordinal, function (v) {
              ce.portion_ordinal = v;
              ce.portion_basis = v ? "ordinal" : null;
              persist();
            })));
            /* Attribute state, shown where the food actually is. Tapping
               through does not interrupt the meal edit. */
            if (it) card.appendChild(reviewLine(it));
            card.querySelector("[data-remove]").addEventListener("click", function () {
              draft.consumption_events.splice(index, 1);
              paintItems();
              persist();
            });
            itemsBox.appendChild(card);
          });
        }
        paintItems();
        body.appendChild(U.el('<div class="section-head"><h2>What was in it</h2></div>'));
        body.appendChild(itemsBox);

        var addBox = U.el(
          '<div class="search-box" style="margin-bottom:8px">' +
          '<input type="search" placeholder="Add another item" aria-label="Add another item">' +
          "</div>"
        );
        addBox.querySelector(".search-icon") && addBox.querySelector(".search-icon").remove();
        addBox.querySelector("input").style.paddingLeft = "13px";
        var addResults = U.el('<div class="item-chiplist" style="margin-bottom:12px"></div>');
        var addInput = addBox.querySelector("input");
        addInput.addEventListener("input", U.debounce(function () {
          var q = addInput.value.trim().toLowerCase();
          addResults.innerHTML = "";
          if (!q) return;
          items.filter(function (it) {
            return (it.name || "").toLowerCase().indexOf(q) !== -1;
          }).slice(0, 8).forEach(function (it) {
            var chip = U.el('<button type="button" class="chip">' + U.esc(it.name) + "</button>");
            chip.addEventListener("click", function () {
              draft.consumption_events.push({
                id: U.uuid(), meal_id: draft.id, item_id: it.id, item_name: it.name,
                portion_ordinal: it._lastPortion || null, amount_g: null,
                portion_basis: it._lastPortion ? "ordinal" : null,
                prep_method: null, notes: null,
              });
              addInput.value = ""; addResults.innerHTML = "";
              paintItems(); persist();
            });
            addResults.appendChild(chip);
          });
          var newChip = U.el(
            '<button type="button" class="chip is-on">+ add “' + U.esc(addInput.value.trim()) + "”</button>"
          );
          newChip.addEventListener("click", function () {
            var item = {
              id: U.uuid(), name: addInput.value.trim(), kind: "dish",
              brand: null, barcode: null, is_raw: 0,
              default_portion: null, notes: null, archived: 0,
            };
            ST.sync.save("item", item).then(function () {
              draft.consumption_events.push({
                id: U.uuid(), meal_id: draft.id, item_id: item.id, item_name: item.name,
                portion_ordinal: null, amount_g: null, portion_basis: null,
                prep_method: null, notes: null,
              });
              addInput.value = ""; addResults.innerHTML = "";
              paintItems(); persist();
            });
          });
          addResults.appendChild(newChip);
        }, 120));
        body.appendChild(addBox);
        body.appendChild(addResults);

        body.appendChild(field("Meal", segmented({
          label: "Meal",
          value: draft.label,
          options: ["breakfast", "lunch", "dinner", "snack", "late"].map(function (v) {
            return { value: v, label: v };
          }),
          onChange: function (v) { draft.label = v; persist(); },
        })));

        body.appendChild(field("Where", segmented({
          label: "Where",
          value: draft.context,
          options: [
            { value: "home", label: "home" },
            { value: "restaurant", label: "out" },
            { value: "packaged", label: "packaged" },
            { value: "other", label: "other" },
            { value: null, label: "unknown" },
          ],
          onChange: function (v) { draft.context = v; persist(); },
        })));

        body.appendChild(timeControl(draft, persist));

        var notes = U.el(
          '<label class="field"><span>Notes</span><textarea placeholder="Recipe, restaurant, anything you might search for later.">' +
          U.esc(draft.notes || "") + "</textarea></label>"
        );
        notes.querySelector("textarea").addEventListener("change", function (e) {
          draft.notes = e.target.value || null;
          persist();
        });
        body.appendChild(notes);

        var actions = U.el('<div class="sheet-actions"></div>');
        if (isNew) {
          var save = U.el('<button type="button" class="btn primary">Save meal</button>');
          save.addEventListener("click", function () {
            ctx.close(true);
            saveMeal(draft, "Logged: " + mealTitle(draft, items) + " · " + U.fmtClock(draft.ts_utc));
          });
          actions.appendChild(save);
        } else {
          var done = U.el('<button type="button" class="btn primary">Done</button>');
          done.addEventListener("click", function () { ctx.close(true); });
          actions.appendChild(done);
          var del = U.el('<button type="button" class="btn ghost">Delete</button>');
          del.addEventListener("click", function () {
            ST.sync.remove("meal", draft.id);
            ctx.close(true);
            ST.toast.show("Meal deleted", { duration: 2200 });
          });
          actions.appendChild(del);
        }
        body.appendChild(actions);
      },
    });
  }

  function markNothingEaten() {
    var date = U.todayLocal();
    var existing = (ST.state.days && ST.state.days[date]) || {};
    var row = Object.assign({}, existing, {
      id: date, local_date: date, nothing_eaten: 1,
    });
    ST.sync.save("day", row).then(function () {
      ST.toast.show(
        "Recorded: nothing eaten today. This is a real observation, not a gap.",
        { duration: 4200 }
      );
    });
  }

  /* ==================================================================
     OTHER SYMPTOM
     A first-class symptom_event with bristol = NULL and is_bm = 0.
     Bloating, pain or nausea at 19:40 is a real observation; giving it a
     fabricated Bristol score would corrupt the outcome variable, and
     burying it in free text would make it unanalyzable. Nausea has no
     column of its own in v1, so it is recorded in notes with a stable
     prefix that search can find.
     ================================================================== */

  var OTHER_LINE = /^(\d{2}:\d{2})\s+—\s+(.*)$/;

  /* Retained only so notes written by earlier builds into state_log still
     appear in the timeline and in search. Nothing writes these any more. */
  function parseOtherNotes(stateRow) {
    if (!stateRow || !stateRow.notes) return [];
    return String(stateRow.notes).split("\n").map(function (line) {
      var m = OTHER_LINE.exec(line.trim());
      if (!m) return null;
      return { time: m[1], text: m[2], date: stateRow.local_date };
    }).filter(Boolean);
  }

  function otherSummary(record) {
    var parts = [];
    if (record.bloating != null) parts.push("bloating " + U.SEVERITY[record.bloating]);
    if (record.pain != null) parts.push("pain " + U.SEVERITY[record.pain]);
    var nausea = /nausea: (\w+)/.exec(record.notes || "");
    if (nausea) parts.push("nausea " + nausea[1]);
    if (!parts.length) {
      var text = String(record.notes || "").replace(/^nausea: \w+;?\s*/, "").trim();
      if (text) return text;
      return "symptom noted";
    }
    return parts.join(" · ");
  }

  function openOtherSymptom() {
    var when = new Date();
    var draft = {
      id: U.uuid(),
      bristol: null,
      is_bm: 0,
      urgency: null, volume: null,
      pain: null, bloating: null,
      incomplete: null,
      nocturnal: U.isNocturnal(when) ? 1 : 0,
      blood_flag: null, mucus_flag: null, accident_flag: null,
      notes: null,
    };
    var nausea = null;

    ST.sheet.open({
      title: U.lex("otherSymptom"),
      autofocus: false,
      render: function (body, ctx) {
        body.appendChild(U.el(
          '<p class="sheet-note">For something you felt without a bowel movement. ' +
          "Recorded with its own timestamp, so it lines up with meals the same way " +
          "everything else does.</p>"
        ));

        body.appendChild(field("Bloating", severityControl("Bloating", draft.bloating, function (v) {
          draft.bloating = v;
        })));
        body.appendChild(field("Pain", severityControl("Pain", draft.pain, function (v) {
          draft.pain = v;
        })));
        body.appendChild(field("Nausea", severityControl("Nausea", nausea, function (v) {
          nausea = v;
        })));

        var notes = U.el(
          '<label class="field"><span>Note</span>' +
          '<textarea placeholder="What you noticed."></textarea></label>'
        );
        body.appendChild(notes);

        body.appendChild(timeControl(Object.assign(draft, U.stamp(when)), function () {}));

        var actions = U.el('<div class="sheet-actions"></div>');
        var save = U.el('<button type="button" class="btn primary">Save</button>');
        save.addEventListener("click", function () {
          var text = notes.querySelector("textarea").value.trim();
          var noteParts = [];
          if (nausea != null) noteParts.push("nausea: " + U.SEVERITY[nausea]);
          if (text) noteParts.push(text);
          draft.notes = noteParts.length ? noteParts.join("; ") : null;

          if (draft.bloating == null && draft.pain == null && nausea == null && !text) {
            ctx.close(true);
            return;
          }

          ST.sync.save("symptom", draft).then(function () {
            U.haptic(14);
            ST.toast.show("Symptom saved · " + U.fmtClock(draft.ts_utc), {
              actionLabel: "Undo",
              onAction: function () {
                ST.sync.undoCreate("symptom", draft.id).then(function () {
                  ST.toast.show("Removed", { duration: 1800 });
                });
              },
            });
          });
          ctx.close(true);
        });
        actions.appendChild(save);
        body.appendChild(actions);
      },
    });
  }

  ST.entry = {
    openStool: openStool,
    openStoolDetail: openStoolDetail,
    openStoolBackfill: openStoolBackfill,
    openReference: openReference,
    openMeal: openMeal,
    openMealEdit: openMealEdit,
    openOtherSymptom: openOtherSymptom,
    markNothingEaten: markNothingEaten,
    mealTitle: mealTitle,
    draftFrom: draftFrom,
    parseOtherNotes: parseOtherNotes,
    otherSummary: otherSummary,
    segmented: segmented,
    field: field,
    flagToggle: flagToggle,
    timeControl: timeControl,
    severityControl: severityControl,
  };
})(window.ST);
