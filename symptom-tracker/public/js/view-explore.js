/* view-explore.js — the log explorer.

   Modelled on a log search tool rather than a diary: one persistent query
   box, facet chips that AND together, a dense reverse-chronological
   stream, and expandable raw records. The point is to be able to answer
   "what did I eat the last four times this happened" in about ten seconds,
   without scrolling a calendar.

   Search runs locally against the mirrored corpus first, so it works with
   no signal. When there is a connection, GET /api/search runs in parallel
   for real FTS5 ranking and highlighted snippets, and takes over if it
   answers. Which one you got is always stated.
*/

(function (ST) {
  "use strict";

  var U = ST.util;

  var DATE_PRESETS = [
    { k: "today", label: "today" },
    { k: "7d", label: "last 7 days" },
    { k: "30d", label: "last 30 days" },
    { k: "90d", label: "last 90 days" },
    { k: "all", label: "all time" },
  ];

  var FLAGS = [
    { k: "urgency", label: "urgent", test: function (s) { return s.urgency >= 2; } },
    { k: "blood", label: "blood", test: function (s) { return s.blood_flag === 1; } },
    { k: "mucus", label: "mucus", test: function (s) { return s.mucus_flag === 1; } },
    { k: "incomplete", label: "incomplete", test: function (s) { return s.incomplete === 1; } },
    { k: "nocturnal", label: "overnight", test: function (s) { return s.nocturnal === 1; } },
    { k: "accident", label: "no toilet in time", test: function (s) { return s.accident_flag === 1; } },
  ];

  var KINDS = [
    { k: "meal", label: "meals" },
    { k: "bm", label: "bowel records" },
    { k: "other", label: "other symptoms" },
    { k: "note", label: "day notes" },
  ];

  /* The facet value an entry answers to. Bowel records and non-BM symptoms
     are both symptom_event rows but they are not interchangeable: only one
     of them has a Bristol type, and only one of them is the v1 outcome. */
  function kindOf(entry) {
    if (entry.type === "meal") return "meal";
    if (entry.type === "note") return "note";
    return ST.today.isBm(entry.data) ? "bm" : "other";
  }

  var COMPLETENESS = ["complete", "mostly", "partial", "unsure", "declined", "unanswered"];

  function defaults() {
    return {
      q: "",
      date: "30d",
      from: null,
      to: null,
      kinds: [],
      bristol: [],
      flags: [],
      itemId: null,
      completeness: [],
      group: "day",
    };
  }

  function ensureState() {
    if (!ST.state.explore) ST.state.explore = defaults();
    return ST.state.explore;
  }

  function dateBounds(f) {
    var today = U.todayLocal();
    if (f.date === "custom" && f.from) return { from: f.from, to: f.to || today };
    if (f.date === "today") return { from: today, to: today };
    if (f.date === "7d") return { from: U.addDays(today, -6), to: today };
    if (f.date === "30d") return { from: U.addDays(today, -29), to: today };
    if (f.date === "90d") return { from: U.addDays(today, -89), to: today };
    return { from: null, to: null };
  }

  function activeCount(f) {
    var n = 0;
    if (f.date !== "30d") n++;
    if (f.kinds.length) n++;
    if (f.bristol.length) n++;
    if (f.flags.length) n++;
    if (f.itemId) n++;
    if (f.completeness.length) n++;
    return n;
  }

  /* ----------------------------------------------------- local matching */

  function haystack(entry) {
    var d = entry.data;
    if (entry.type === "meal") {
      var names = (d.consumption_events || []).map(function (ce) {
        var it = (ST.state.items || []).find(function (x) { return x.id === ce.item_id; });
        return ((it && it.name) || ce.item_name || "") + " " + ((it && it.brand) || "");
      });
      return [names.join(" "), d.label, d.context, d.location, d.notes].join(" ").toLowerCase();
    }
    if (entry.type === "symptom") {
      if (!ST.today.isBm(d)) {
        return [
          "symptom", "no bowel movement", ST.entry.otherSummary(d), d.notes,
          d.pain != null ? "pain " + U.SEVERITY[d.pain] : "",
          d.bloating != null ? "bloating " + U.SEVERITY[d.bloating] : "",
        ].join(" ").toLowerCase();
      }
      return [
        ST.bristol.byNumber(d.bristol).short,
        "type " + d.bristol,
        d.volume,
        d.notes,
        d.urgency != null ? "urgency " + U.SEVERITY[d.urgency] : "",
        d.blood_flag ? "blood" : "",
        d.mucus_flag ? "mucus" : "",
      ].join(" ").toLowerCase();
    }
    return String(d.text || "").toLowerCase();
  }

  function localSearch(f) {
    var bounds = dateBounds(f);
    var terms = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var entries = ST.today.unifyEvents(null);

    return entries.filter(function (entry) {
      var date = entry.type === "note" ? entry.date : U.localDate(entry.data);
      if (bounds.from && date < bounds.from) return false;
      if (bounds.to && date > bounds.to) return false;

      if (f.kinds.length && f.kinds.indexOf(kindOf(entry)) === -1) return false;

      if (f.bristol.length) {
        /* A Bristol filter can only ever be about bowel records. */
        if (entry.type !== "symptom" || !ST.today.isBm(entry.data)) return false;
        if (f.bristol.indexOf(entry.data.bristol) === -1) return false;
      }

      if (f.flags.length) {
        if (entry.type !== "symptom") return false;
        var ok = f.flags.every(function (key) {
          var flag = FLAGS.find(function (x) { return x.k === key; });
          return flag && flag.test(entry.data);
        });
        if (!ok) return false;
      }

      if (f.itemId) {
        if (entry.type !== "meal") return false;
        var has = (entry.data.consumption_events || []).some(function (ce) {
          return ce.item_id === f.itemId;
        });
        if (!has) return false;
      }

      if (f.completeness.length) {
        var day = (ST.state.days || {})[date];
        var value = (day && day.completeness) || "unanswered";
        if (f.completeness.indexOf(value) === -1) return false;
      }

      if (terms.length) {
        var hay = haystack(entry);
        if (!terms.every(function (t) { return hay.indexOf(t) !== -1; })) return false;
      }
      return true;
    });
  }

  /* ------------------------------------------------------------ grouping */

  function weekKey(date) {
    var d = new Date(date + "T12:00:00Z");
    var day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }

  function group(entries, mode) {
    if (mode === "none") return [{ key: "", label: "", entries: entries }];
    var buckets = {};
    var order = [];

    function push(key, label, entry) {
      if (!buckets[key]) { buckets[key] = { key: key, label: label, entries: [] }; order.push(key); }
      buckets[key].entries.push(entry);
    }

    entries.forEach(function (entry) {
      var date = entry.type === "note" ? entry.date : U.localDate(entry.data);
      if (mode === "day") return push(date, U.dayLabel(date), entry);
      if (mode === "week") {
        var wk = weekKey(date);
        return push(wk, "week of " + U.fmtDay(wk, { month: "short", day: "numeric" }), entry);
      }
      if (mode === "item") {
        if (entry.type !== "meal") return push("~other", "other events", entry);
        var ces = entry.data.consumption_events || [];
        if (!ces.length) return push("~other", "other events", entry);
        return ces.forEach(function (ce) {
          var it = (ST.state.items || []).find(function (x) { return x.id === ce.item_id; });
          push(ce.item_id, (it && it.name) || ce.item_name || "unnamed", entry);
        });
      }
      if (mode === "symptom") {
        if (entry.type !== "symptom") return push("~other", "meals and notes", entry);
        if (!ST.today.isBm(entry.data)) {
          return push("~nonbm", "symptoms without a bowel movement", entry);
        }
        return push(
          "b" + entry.data.bristol,
          "type " + entry.data.bristol + " · " + ST.bristol.byNumber(entry.data.bristol).short,
          entry
        );
      }
      push("", "", entry);
    });

    var groups = order.map(function (k) { return buckets[k]; });
    if (mode === "item" || mode === "symptom") {
      groups.sort(function (a, b) { return b.entries.length - a.entries.length; });
    }
    return groups;
  }

  /* --------------------------------------------------------- facet sheets */

  function openDateFacet(f, redraw) {
    ST.sheet.open({
      title: "Date range",
      render: function (body, ctx) {
        var list = U.el('<div class="opt-list"></div>');
        DATE_PRESETS.forEach(function (p) {
          var b = U.el(
            '<button type="button" class="opt-btn" aria-pressed="' +
            (f.date === p.k ? "true" : "false") + '">' + U.esc(p.label) +
            '<span class="opt-mark">' + (f.date === p.k ? "on" : "") + "</span></button>"
          );
          b.addEventListener("click", function () {
            f.date = p.k; f.from = null; f.to = null;
            ctx.close(true); redraw();
          });
          list.appendChild(b);
        });
        body.appendChild(list);

        var custom = U.el(
          '<div style="margin-top:14px">' +
          '<label class="field"><span>From</span><input type="date" value="' +
          U.esc(f.from || "") + '"></label>' +
          '<label class="field"><span>To</span><input type="date" value="' +
          U.esc(f.to || "") + '"></label>' +
          "</div>"
        );
        var inputs = custom.querySelectorAll("input");
        var apply = U.el('<button type="button" class="btn wide primary">Use this range</button>');
        apply.addEventListener("click", function () {
          if (!inputs[0].value) return;
          f.date = "custom";
          f.from = inputs[0].value;
          f.to = inputs[1].value || U.todayLocal();
          ctx.close(true); redraw();
        });
        custom.appendChild(apply);
        body.appendChild(custom);
      },
    });
  }

  function openMultiFacet(title, options, selected, onDone) {
    ST.sheet.open({
      title: title,
      render: function (body, ctx) {
        var picked = selected.slice();
        var list = U.el('<div class="opt-list"></div>');
        options.forEach(function (opt) {
          var on = picked.indexOf(opt.value) !== -1;
          var b = U.el(
            '<button type="button" class="opt-btn" aria-pressed="' + on + '">' +
            U.esc(opt.label) +
            '<span class="opt-mark">' + (opt.hint || "") + "</span></button>"
          );
          b.addEventListener("click", function () {
            var i = picked.indexOf(opt.value);
            if (i === -1) picked.push(opt.value); else picked.splice(i, 1);
            b.setAttribute("aria-pressed", i === -1 ? "true" : "false");
          });
          list.appendChild(b);
        });
        body.appendChild(list);
        var actions = U.el('<div class="sheet-actions"></div>');
        var apply = U.el('<button type="button" class="btn primary">Apply</button>');
        apply.addEventListener("click", function () { ctx.close(true); onDone(picked); });
        actions.appendChild(apply);
        var clear = U.el('<button type="button" class="btn ghost">Clear</button>');
        clear.addEventListener("click", function () { ctx.close(true); onDone([]); });
        actions.appendChild(clear);
        body.appendChild(actions);
      },
    });
  }

  /* ------------------------------------------------------------ suggest */

  function suggestions(f, query) {
    var q = query.trim().toLowerCase();
    var out = [];

    if (!q) {
      out.push({ group: "Jump to", items: [
        { label: "today", kind: "date", apply: function () { f.date = "today"; } },
        { label: "last 7 days", kind: "date", apply: function () { f.date = "7d"; } },
        { label: "last 30 days", kind: "date", apply: function () { f.date = "30d"; } },
        { label: "loose records only (type 6–7)", kind: "facet", apply: function () {
          f.bristol = [6, 7]; f.kinds = ["bm"];
        } },
        { label: "symptoms without a bowel movement", kind: "facet", apply: function () {
          f.kinds = ["other"]; f.bristol = [];
        } },
        { label: "days marked partial", kind: "facet", apply: function () {
          f.completeness = ["partial"];
        } },
      ] });
    }

    var recents = (ST.state.recentSearches || []).filter(function (r) {
      return !q || r.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 5);
    if (recents.length) {
      out.push({ group: "Recent searches", items: recents.map(function (r) {
        return { label: r, kind: "recent", apply: function () { f.q = r; } };
      }) });
    }

    var saved = (ST.state.savedSearches || []).filter(function (s) {
      return !q || s.name.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 5);
    if (saved.length) {
      out.push({ group: "Saved", items: saved.map(function (s) {
        return { label: s.name, kind: "saved", apply: function () {
          Object.assign(f, s.filters);
        } };
      }) });
    }

    var items = (ST.state.items || []).filter(function (it) {
      return !q || (it.name || "").toLowerCase().indexOf(q) !== -1;
    }).slice(0, 6);
    if (items.length) {
      out.push({ group: "Your food", items: items.map(function (it) {
        return {
          label: it.name,
          kind: it._count ? it._count + "×" : "",
          apply: function () { f.itemId = it.id; f.q = ""; },
        };
      }) });
    }

    if (q) {
      out.unshift({ group: "Search text", items: [
        { label: "“" + query.trim() + "” everywhere", kind: "text", apply: function () { f.q = query.trim(); } },
      ] });
    }
    return out;
  }

  function rememberSearch(q) {
    if (!q) return;
    var list = (ST.state.recentSearches || []).filter(function (x) { return x !== q; });
    list.unshift(q);
    ST.state.recentSearches = list.slice(0, 12);
    ST.store.metaSet("recentSearches", ST.state.recentSearches);
  }

  /* --------------------------------------------------------------- view */

  function render(container) {
    var f = ensureState();
    container.innerHTML = "";

    var head = U.el('<div class="explorer-head"></div>');

    /* --- query box */
    var box = U.el(
      '<div class="search-box">' +
      '<svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
      '<path d="M15.6 15.6L20.5 20.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>' +
      '<input type="search" role="combobox" aria-expanded="false" aria-autocomplete="list" ' +
      'aria-label="Search your record" placeholder="Search food, notes, records…" value="' +
      U.esc(f.q) + '">' +
      '<button type="button" class="search-clear" aria-label="Clear search">' +
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      "</button></div>"
    );
    var input = box.querySelector("input");
    var panel = null;

    function closePanel() {
      if (panel) { panel.remove(); panel = null; }
      input.setAttribute("aria-expanded", "false");
    }

    function openPanel() {
      closePanel();
      var groups = suggestions(f, input.value);
      if (!groups.length) return;
      panel = U.el('<div class="suggest" role="listbox"></div>');
      groups.forEach(function (g) {
        panel.appendChild(U.el('<div class="suggest-group">' + U.esc(g.group) + "</div>"));
        g.items.forEach(function (item) {
          var b = U.el(
            '<button type="button" class="suggest-item" role="option">' +
            "<span>" + U.esc(item.label) + "</span>" +
            (item.kind ? '<span class="s-kind">' + U.esc(item.kind) + "</span>" : "") +
            "</button>"
          );
          b.addEventListener("mousedown", function (e) { e.preventDefault(); });
          b.addEventListener("click", function () {
            item.apply();
            rememberSearch(f.q);
            closePanel();
            input.blur();
            render(container);
          });
          panel.appendChild(b);
        });
      });
      box.appendChild(panel);
      input.setAttribute("aria-expanded", "true");
    }

    input.addEventListener("focus", openPanel);
    input.addEventListener("input", U.debounce(function () { openPanel(); }, 90));
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        f.q = input.value.trim();
        rememberSearch(f.q);
        closePanel();
        input.blur();
        render(container);
      } else if (e.key === "Escape") {
        closePanel();
      }
    });
    input.addEventListener("blur", function () { setTimeout(closePanel, 140); });
    box.querySelector(".search-clear").addEventListener("click", function () {
      f.q = ""; input.value = ""; render(container);
    });
    head.appendChild(box);

    /* --- facet chips */
    var bar = U.el('<div class="facet-bar" role="group" aria-label="Filters"></div>');

    function facetChip(label, on, onClick, onClear) {
      var chip = U.el(
        '<button type="button" class="chip' + (on ? " is-on" : "") + '">' +
        U.esc(label) + (on && onClear ? '<span class="chip-x" aria-hidden="true">×</span>' : "") +
        "</button>"
      );
      chip.addEventListener("click", function (e) {
        if (on && onClear && e.target.classList.contains("chip-x")) return onClear();
        onClick();
      });
      return chip;
    }

    var bounds = dateBounds(f);
    var dateLabel = f.date === "custom"
      ? (f.from + " → " + (f.to || "now"))
      : (DATE_PRESETS.find(function (p) { return p.k === f.date; }) || {}).label;
    bar.appendChild(facetChip(dateLabel, f.date !== "30d", function () {
      openDateFacet(f, function () { render(container); });
    }, function () { f.date = "30d"; render(container); }));

    bar.appendChild(facetChip(
      f.kinds.length ? f.kinds.map(function (k) {
        return (KINDS.find(function (x) { return x.k === k; }) || {}).label;
      }).join(", ") : "type",
      f.kinds.length,
      function () {
        openMultiFacet("Event type", KINDS.map(function (k) {
          return { value: k.k, label: k.label };
        }), f.kinds, function (picked) { f.kinds = picked; render(container); });
      },
      function () { f.kinds = []; render(container); }
    ));

    bar.appendChild(facetChip(
      f.bristol.length ? "type " + f.bristol.slice().sort().join(",") : U.lex("bristol").toLowerCase(),
      f.bristol.length,
      function () {
        openMultiFacet("Bristol type", ST.bristol.TYPES.map(function (t) {
          return { value: t.n, label: t.n + " · " + t.short };
        }), f.bristol, function (picked) { f.bristol = picked; render(container); });
      },
      function () { f.bristol = []; render(container); }
    ));

    bar.appendChild(facetChip(
      f.flags.length ? f.flags.join(", ") : "markers",
      f.flags.length,
      function () {
        openMultiFacet("Markers", FLAGS.map(function (x) {
          return { value: x.k, label: x.label };
        }), f.flags, function (picked) { f.flags = picked; render(container); });
      },
      function () { f.flags = []; render(container); }
    ));

    var itemName = f.itemId
      ? ((ST.state.items || []).find(function (x) { return x.id === f.itemId; }) || {}).name
      : null;
    bar.appendChild(facetChip(
      itemName || "food",
      !!f.itemId,
      function () {
        openMultiFacet(
          "Food",
          (ST.state.items || []).slice(0, 60).map(function (it) {
            return { value: it.id, label: it.name, hint: it._count ? it._count + "×" : "" };
          }),
          f.itemId ? [f.itemId] : [],
          function (picked) { f.itemId = picked.length ? picked[picked.length - 1] : null; render(container); }
        );
      },
      function () { f.itemId = null; render(container); }
    ));

    bar.appendChild(facetChip(
      f.completeness.length ? "day: " + f.completeness.join(",") : "day quality",
      f.completeness.length,
      function () {
        openMultiFacet("Day completeness", COMPLETENESS.map(function (c) {
          return { value: c, label: c };
        }), f.completeness, function (picked) { f.completeness = picked; render(container); });
      },
      function () { f.completeness = []; render(container); }
    ));

    head.appendChild(bar);
    container.appendChild(head);

    /* --- results */
    var results = localSearch(f);
    var dayCount = {};
    results.forEach(function (e) {
      var date = e.type === "note" ? e.date : U.localDate(e.data);
      dayCount[date] = 1;
    });

    var meta = U.el(
      '<div class="result-meta">' +
      "<span>" + results.length + " events · " + Object.keys(dayCount).length + " days" +
      (activeCount(f) ? " · " + U.plural(activeCount(f), "filter") : "") +
      '<span class="src-note"></span></span>' +
      '<label style="display:flex;align-items:center;gap:6px">group ' +
      '<select aria-label="Group by">' +
      ["day", "week", "item", "symptom", "none"].map(function (g) {
        return '<option value="' + g + '"' + (f.group === g ? " selected" : "") + ">" + g + "</option>";
      }).join("") +
      "</select></label></div>"
    );
    meta.querySelector("select").addEventListener("change", function (e) {
      f.group = e.target.value;
      render(container);
    });
    container.appendChild(meta);

    var srcNote = meta.querySelector(".src-note");
    srcNote.className = "src-note faint";
    srcNote.textContent = navigator.onLine ? "" : " · this device only";

    var listHost = U.el("<div></div>");
    container.appendChild(listHost);

    function paint(entries) {
      listHost.innerHTML = "";
      if (!entries.length) {
        listHost.appendChild(U.el(
          '<p class="empty">Nothing matches these filters.<br>' +
          "That is a result too — it means the record has no example of this yet.</p>"
        ));
        return;
      }
      group(entries, f.group).forEach(function (g) {
        if (g.label) {
          listHost.appendChild(U.el(
            '<div class="group-head"><span>' + U.esc(g.label) + "</span>" +
            '<span class="gh-count">' + g.entries.length + "</span></div>"
          ));
        }
        ST.today.renderList(g.entries, listHost, {});
      });
    }

    paint(results);

    /* Server FTS, when it is available, for ranking and snippets. */
    if (navigator.onLine && f.q) {
      ST.api.search({
        q: f.q,
        from: bounds.from, to: bounds.to,
        bristol_min: f.bristol.length ? Math.min.apply(null, f.bristol) : null,
        bristol_max: f.bristol.length ? Math.max.apply(null, f.bristol) : null,
        item_id: f.itemId,
        limit: 200,
      }).then(function (payload) {
        var hits = Array.isArray(payload) ? payload : (payload.results || payload.hits || []);
        if (!hits.length) return;
        var byId = {};
        results.forEach(function (e) { byId[e.id] = e; });
        var ordered = [];
        hits.forEach(function (hit) {
          var local = byId[hit.id];
          if (local) {
            if (hit.snippet) local.snippet = hit.snippet;
            ordered.push(local);
          }
        });
        if (!ordered.length) return;
        srcNote.textContent = " · ranked by full-text search";
        paint(ordered);
      }).catch(function () {
        srcNote.textContent = " · this device only";
      });
    }

    /* --- save this search */
    var save = U.el(
      '<button type="button" class="btn quiet" style="width:100%;margin-top:16px">' +
      "Save this search</button>"
    );
    save.addEventListener("click", function () {
      var name = window.prompt("Name this search", f.q || dateLabel);
      if (!name) return;
      var list = (ST.state.savedSearches || []).slice();
      list.unshift({ name: name, filters: JSON.parse(JSON.stringify(f)) });
      ST.state.savedSearches = list.slice(0, 20);
      ST.store.metaSet("savedSearches", ST.state.savedSearches);
      ST.toast.show("Saved as “" + name + "”", { duration: 2400 });
    });
    container.appendChild(save);
  }

  ST.explore = { render: render, defaults: defaults };
})(window.ST);
