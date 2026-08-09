/* view-review.js — the attribute review flow.

   Why this screen exists, stated plainly because it is not obvious:

   The analysis classifies every observation three ways — exposed,
   unexposed, or UNKNOWN. An item nobody has reviewed makes every
   observation containing it `unknown`, because a missing attribute row
   honestly means "nobody has ever said", not "zero". With nothing
   reviewed, every observation is unknown and the evidence screen is
   permanently and correctly inert. Reviewing is the mechanism by which
   the study earns the right to say anything at all.

   Design rules followed here:
   - It never blocks logging. Capture stays two taps; this is always
     deferred and always interruptible.
   - The payoff is a number, not a feeling: /api/review/impact says how
     many observations become analyzable, and that number is the headline.
   - It is a batch task. One card at a time, thumb-reachable actions,
     swipe or arrow to advance, sensible suggestions offered but never
     silently applied.
   - "Mark reviewed" is a separate, deliberate act from ticking a tag,
     because it asserts something stronger: that absence now means zero.
*/

(function (ST) {
  "use strict";

  var U = ST.util;

  /* ------------------------------------------------------------ model */

  function rawItem(id) {
    return (ST.state.itemsRaw || []).find(function (x) { return x.id === id; }) || null;
  }

  function tagsFor(itemId) {
    var bucket = (ST.state.itemAttrs || {})[itemId] || {};
    var out = {};
    Object.keys(bucket).forEach(function (attr) {
      out[attr] = Number(bucket[attr].value) > 0;
    });
    return out;
  }

  function isReviewed(item) {
    return !!(item && Number(item.attributes_reviewed) === 1);
  }

  /* Suggestions are offered, never applied on their own. A wrong tag that
     was confirmed by reflex is worse than an honest unknown, so the user
     always sees the tags before committing them. */
  var SUGGEST = [
    { re: /\b(coffee|espresso|latte|cappuccino|americano|cold brew|black tea|green tea|matcha|chai|cola|energy drink)\b/i, on: ["caffeine"] },
    { re: /\b(milk|cheese|yoghurt|yogurt|cream|butter|paneer|curd|latte|cappuccino|ice cream)\b/i, on: ["dairy", "lactose"] },
    { re: /\b(cheddar|parmesan|gouda|manchego|aged cheese)\b/i, on: ["dairy"] },
    { re: /\b(bread|toast|pasta|noodle|roti|chapati|naan|wheat|barley|rye|cake|biscuit|cookie|pastry|sourdough|pizza|couscous)\b/i, on: ["gluten"] },
    { re: /\b(fried|fry|chips|crisps|samosa|pakora|tempura|doughnut|donut|katsu|schnitzel)\b/i, on: ["fried", "total_fat"] },
    { re: /\b(chilli|chili|spicy|curry|jalapeno|sriracha|hot sauce|kimchi|vindaloo|harissa)\b/i, on: ["spicy", "capsaicin"] },
    { re: /\b(beer|wine|whisky|whiskey|vodka|gin|rum|cider|cocktail|prosecco|lager)\b/i, on: ["alcohol"] },
    { re: /\b(soda|sparkling|fizzy|cola|seltzer|tonic|beer|kombucha)\b|ginger ale/i, on: ["carbonation"] },
    { re: /\b(diet|zero|sugar[- ]free|light)\b/i, on: ["artificial_sweetener"] },
    { re: /\b(gum|mint|sorbitol|xylitol|isomalt)\b/i, on: ["polyols"] },
    { re: /\b(apple|pear|honey|mango|watermelon|agave|fructose)\b/i, on: ["excess_fructose", "high_fodmap"] },
    { re: /\b(onion|garlic|lentil|chickpea|bean|cauliflower|mushroom|hummus|dal|daal)\b/i, on: ["high_fodmap"] },
    { re: /\b(cream|butter|ghee|mayonnaise|bacon|sausage|cheese)\b/i, on: ["total_fat"] },
  ];

  function suggestFor(item) {
    var hay = [item.name, item.brand].filter(Boolean).join(" ");
    var out = [];
    SUGGEST.forEach(function (rule) {
      if (rule.re.test(hay)) {
        rule.on.forEach(function (a) { if (out.indexOf(a) === -1) out.push(a); });
      }
    });
    return out;
  }

  /* ------------------------------------------- local queue and impact
     The server ranks by analytical value and counts observations. With no
     signal we fall back to a device-side estimate over meals, which is a
     different unit — so it is labelled differently and never presented as
     the server's number. */

  function recentMeals(days) {
    var cutoff = Date.now() - (days || 90) * 86400000;
    return (ST.state.meals || []).filter(function (m) {
      return new Date(m.ts_utc).getTime() >= cutoff;
    });
  }

  function unreviewedIdsIn(meal, reviewedSet) {
    var out = [];
    (meal.consumption_events || []).forEach(function (ce) {
      if (!reviewedSet[ce.item_id] && out.indexOf(ce.item_id) === -1) out.push(ce.item_id);
    });
    return out;
  }

  function localAnalysis() {
    var reviewedSet = {};
    (ST.state.itemsRaw || []).forEach(function (it) {
      if (isReviewed(it)) reviewedSet[it.id] = true;
    });

    var meals = recentMeals(90);
    var blocked = [];
    var blocksByItem = {};
    var unlocksByItem = {};

    meals.forEach(function (m) {
      var unreviewed = unreviewedIdsIn(m, reviewedSet);
      if (!unreviewed.length) return;
      blocked.push(m);
      unreviewed.forEach(function (id) {
        blocksByItem[id] = (blocksByItem[id] || 0) + 1;
      });
      if (unreviewed.length === 1) {
        unlocksByItem[unreviewed[0]] = (unlocksByItem[unreviewed[0]] || 0) + 1;
      }
    });

    var queue = (ST.state.items || [])
      .filter(function (it) { return !isReviewed(it) && !it.archived; })
      .map(function (it) {
        return Object.assign({}, it, {
          _blocks: blocksByItem[it.id] || 0,
          _unlocks: unlocksByItem[it.id] || 0,
        });
      })
      .filter(function (it) { return it._blocks > 0 || it._count > 0; })
      .sort(function (a, b) {
        if (b._unlocks !== a._unlocks) return b._unlocks - a._unlocks;
        if (b._blocks !== a._blocks) return b._blocks - a._blocks;
        return (b._score || 0) - (a._score || 0);
      });

    return {
      meals: meals.length,
      blockedMeals: blocked.length,
      queue: queue,
      wouldUnlock: function (ids) {
        var set = {};
        ids.forEach(function (id) { set[id] = true; });
        return blocked.filter(function (m) {
          return unreviewedIdsIn(m, reviewedSet).every(function (id) { return set[id]; });
        }).length;
      },
    };
  }

  function reviewedCoverage() {
    var used = (ST.state.items || []).filter(function (it) {
      return !it.archived && it._count > 0;
    });
    return {
      total: used.length,
      reviewed: used.filter(isReviewed).length,
    };
  }

  /* ------------------------------------------------------------ writes */

  function commit(item, tagState, reviewed) {
    var source = rawItem(item.id) || item;
    var existing = (ST.state.itemAttrs || {})[item.id] || {};
    var entries = [];

    U.CANDIDATES.forEach(function (attr) {
      var on = !!tagState[attr];
      var prev = existing[attr];
      var prevOn = !!(prev && Number(prev.value) > 0);
      if (prev && on === prevOn) return;
      /* Nothing to record for an attribute that was never claimed and is
         still not claimed — attributes_reviewed already covers it. */
      if (!prev && !on) return;
      entries.push({
        kind: "itemattr",
        record: {
          id: item.id + "|" + attr + "|1",
          item_id: item.id,
          attribute_id: attr,
          value: on ? 1 : 0,
          unit: null,
          source: "manual",
          confidence: "medium",
          knowledge_version: 1,
        },
      });
    });

    entries.push({
      kind: "item",
      record: Object.assign({}, source, {
        attributes_reviewed: reviewed ? 1 : 0,
      }),
    });

    return ST.sync.saveMany(entries);
  }

  /* --------------------------------------------------------- the card */

  function buildCard(item, options) {
    var opts = options || {};
    var tagState = tagsFor(item.id);
    var suggested = suggestFor(item).filter(function (a) { return !tagState[a]; });

    var card = U.el('<section class="rv-card"></section>');

    var meta = [
      item.kind || "food",
      item._count ? U.plural(item._count, "time") : "not logged yet",
      item._last ? "last " + U.relTime(new Date(item._last).toISOString()) : null,
    ].filter(Boolean).join(" · ");

    card.appendChild(U.el(
      '<header class="rv-head">' +
      (opts.position
        ? '<p class="rv-pos">' + U.esc(opts.position) + "</p>"
        : "") +
      '<h3 class="rv-name">' + U.esc(item.name) + "</h3>" +
      '<p class="rv-meta">' + U.esc(meta) + "</p>" +
      (item._unlocks
        ? '<p class="rv-why">Reviewing this on its own clears ' +
          U.plural(item._unlocks, "meal") + "</p>"
        : item._blocks
        ? '<p class="rv-why">' + U.plural(item._blocks, "meal") +
          " can't be classified while this is unreviewed</p>"
        : "") +
      "</header>"
    ));

    if (suggested.length) {
      var sugg = U.el(
        '<div class="rv-suggest">' +
        '<span class="rv-suggest-label">suggested from the name</span>' +
        '<span class="rv-suggest-list">' +
        U.esc(suggested.map(U.prettyAttr).join(", ")) + "</span>" +
        '<button type="button" class="btn ghost rv-apply">use these</button>' +
        "</div>"
      );
      sugg.querySelector(".rv-apply").addEventListener("click", function () {
        suggested.forEach(function (a) { tagState[a] = true; });
        U.haptic(10);
        paintTags();
        sugg.remove();
      });
      card.appendChild(sugg);
    }

    var tagHost = U.el('<div class="rv-groups"></div>');
    card.appendChild(tagHost);

    function paintTags() {
      tagHost.innerHTML = "";
      U.ATTR_GROUPS.forEach(function (group) {
        var block = U.el(
          '<div class="rv-group">' +
          '<p class="rv-group-label">' + U.esc(group.label) + "</p>" +
          '<div class="rv-chips" role="group" aria-label="' + U.esc(group.label) + '"></div>' +
          "</div>"
        );
        var chips = block.querySelector(".rv-chips");
        group.items.forEach(function (attr) {
          var on = !!tagState[attr.id];
          var chip = U.el(
            '<button type="button" class="rv-chip" role="switch" aria-checked="' + on + '"' +
            (attr.help ? ' title="' + U.esc(attr.help) + '"' : "") +
            ' aria-label="' + U.esc(attr.label + (attr.help ? ". " + attr.help : "")) + '">' +
            '<span class="rv-chip-mark" aria-hidden="true"></span>' +
            "<span>" + U.esc(attr.label) + "</span></button>"
          );
          chip.addEventListener("click", function () {
            tagState[attr.id] = !tagState[attr.id];
            chip.setAttribute("aria-checked", tagState[attr.id] ? "true" : "false");
            U.haptic(8);
          });
          chips.appendChild(chip);
        });
        tagHost.appendChild(block);
      });
    }
    paintTags();

    card.appendChild(U.el(
      '<p class="rv-claim" id="rv-claim">Marking this reviewed says: <b>anything not ticked is ' +
      "genuinely absent from this food.</b> Until then, meals containing it can only " +
      "count as unknown.</p>"
    ));

    return { el: card, state: tagState };
  }

  /* ------------------------------------------------------- full screen */

  function ensureState() {
    if (!ST.state.review) {
      ST.state.review = { index: 0, done: 0, queue: null, impact: null, source: "local" };
    }
    return ST.state.review;
  }

  function render(container) {
    var rv = ensureState();
    container.innerHTML = "";

    var local = localAnalysis();
    var queue = (rv.queue && rv.queue.length ? rv.queue : local.queue).slice(0, 40);
    /* Anything reviewed since the queue was fetched drops out of it. */
    queue = queue.filter(function (it) {
      var current = rawItem(it.id);
      return current && !isReviewed(current);
    });

    container.appendChild(impactCard(rv, local, queue));

    if (!queue.length) {
      container.appendChild(U.el(
        '<section class="card" style="margin-top:12px">' +
        '<p class="prose">Every food you have logged has been reviewed.</p>' +
        '<p class="prose small" style="margin-top:8px">Nothing is waiting. New foods will ' +
        "appear here the first time you log them, and until they are reviewed the meals " +
        "containing them count as unknown rather than as unexposed.</p>" +
        "</section>"
      ));
      var toEv = U.el(
        '<button type="button" class="btn wide primary" style="margin-top:12px">' +
        "See what the record supports</button>"
      );
      toEv.addEventListener("click", function () { ST.app.go("evidence"); });
      container.appendChild(toEv);
      return;
    }

    if (rv.index >= queue.length) rv.index = queue.length - 1;
    if (rv.index < 0) rv.index = 0;
    var item = queue[rv.index];

    var built = buildCard(item, {
      position: (rv.index + 1) + " of " + queue.length,
    });
    container.appendChild(built.el);

    /* swipe left / right to move through the batch */
    var startX = null;
    built.el.addEventListener("touchstart", function (e) {
      startX = e.touches[0].clientX;
    }, { passive: true });
    built.el.addEventListener("touchend", function (e) {
      if (startX === null) return;
      var dx = (e.changedTouches[0] || {}).clientX - startX;
      startX = null;
      if (dx < -70) step(1);
      else if (dx > 70) step(-1);
    });

    container.setAttribute("tabindex", "-1");
    container.onkeydown = function (event) {
      if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    };

    function step(delta) {
      rv.index = Math.max(0, Math.min(queue.length - 1, rv.index + delta));
      render(container);
    }

    function finish(reviewed) {
      commit(item, built.state, reviewed).then(function () {
        U.haptic(reviewed ? [10, 30, 10] : 8);
        if (reviewed) rv.done += 1;
        var remaining = queue.length - 1;
        if (remaining <= 0) {
          rv.index = 0;
          ST.toast.show(
            reviewed ? "Reviewed. That was the last one." : "Saved.",
            { duration: 2600 }
          );
        } else if (rv.index >= remaining) {
          rv.index = remaining - 1;
        }
        render(container);
        /* The headline number is the whole reason to do this, so it must
           not go stale while you work. Debounced so a fast batch does not
           fire a request per card. */
        refreshImpactSoon(container);
      });
    }

    var actions = U.el('<div class="rv-actions"></div>');
    var mark = U.el(
      '<button type="button" class="btn primary rv-primary" aria-describedby="rv-claim">' +
      "Mark reviewed →</button>"
    );
    mark.addEventListener("click", function () { finish(true); });
    actions.appendChild(mark);

    var unsure = U.el('<button type="button" class="btn ghost">Not sure yet</button>');
    unsure.addEventListener("click", function () { finish(false); });
    actions.appendChild(unsure);
    container.appendChild(actions);

    var nav = U.el('<div class="rv-nav"></div>');
    var prev = U.el('<button type="button" class="btn quiet">← previous</button>');
    prev.disabled = rv.index === 0;
    prev.addEventListener("click", function () { step(-1); });
    nav.appendChild(prev);
    var skip = U.el('<button type="button" class="btn quiet">skip for now →</button>');
    skip.addEventListener("click", function () { step(1); });
    nav.appendChild(skip);
    container.appendChild(nav);
  }

  function impactCard(rv, local, queue) {
    var card = U.el('<section class="card rv-impact"></section>');
    var server = rv.impact;
    var topIds = queue.slice(0, 6).map(function (it) { return it.id; });

    if (server && typeof server.n_unknown_exposure === "number") {
      var total = (server.n_total_observations != null)
        ? server.n_total_observations
        : (server.n_unknown_exposure + (server.n_classified || 0));
      var gain = server.n_would_become_analyzable != null
        ? server.n_would_become_analyzable
        : (server.top_n_gain || null);

      if (server.n_unknown_exposure === 0) {
        card.appendChild(U.el(
          '<p class="rv-impact-num">' + (total || 0) +
          " <small>observations</small></p>"
        ));
        card.appendChild(U.el(
          '<p class="rv-impact-note">can all be classified. Nothing is being held back by ' +
          "an unreviewed food.</p>"
        ));
        card.appendChild(bar(1));
      } else {
        card.appendChild(U.el(
          '<p class="rv-impact-num">' + server.n_unknown_exposure +
          (total ? ' <small>of ' + total + " observations</small>" : " <small>observations</small>") +
          "</p>"
        ));
        card.appendChild(U.el(
          '<p class="rv-impact-note">can\'t be classified yet, because a food in the window ' +
          "has never been reviewed.</p>"
        ));
        card.appendChild(bar(total ? (total - server.n_unknown_exposure) / total : 0));
        if (gain) {
          card.appendChild(U.el(
            '<p class="rv-impact-gain">Reviewing the next ' +
            U.plural(Math.min(6, queue.length), "food") + " would make <b>" +
            gain + "</b> of them analyzable.</p>"
          ));
        }
      }
    } else {
      var gainLocal = local.wouldUnlock(topIds);
      var coverage = reviewedCoverage();
      card.appendChild(U.el(
        '<p class="rv-impact-num">' + local.blockedMeals +
        " <small>of " + local.meals + " recent meals</small></p>"
      ));
      card.appendChild(U.el(
        '<p class="rv-impact-note">contain a food that has never been reviewed, so nothing ' +
        "in the window after them can count as unexposed.</p>"
      ));
      card.appendChild(bar(local.meals ? (local.meals - local.blockedMeals) / local.meals : 0));
      if (gainLocal) {
        card.appendChild(U.el(
          '<p class="rv-impact-gain">Reviewing the next ' +
          U.plural(Math.min(6, queue.length), "food") + " would clear <b>" +
          gainLocal + "</b> of them.</p>"
        ));
      }
      card.appendChild(U.el(
        '<p class="rv-impact-src">Counted on this device, in meals. The exact ' +
        "observation counts come from the server when there is a connection.</p>"
      ));
      if (coverage.total) {
        card.appendChild(U.el(
          '<p class="rv-impact-src">' + coverage.reviewed + " of " + coverage.total +
          " foods you actually eat have been reviewed.</p>"
        ));
      }
    }

    if (rv.done) {
      card.appendChild(U.el(
        '<p class="rv-impact-gain">' + U.plural(rv.done, "food") +
        " reviewed in this sitting.</p>"
      ));
    }
    return card;
  }

  function bar(fraction) {
    var pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
    return U.el(
      '<div class="rv-bar" role="img" aria-label="' + Math.round(pct) +
      '% classifiable">' +
      '<span class="rv-bar-fill" style="width:' + pct + '%"></span></div>'
    );
  }

  /* --------------------------------------------------- server loading */

  var impactTimer = null;

  function refreshImpactSoon(container) {
    if (!navigator.onLine) return;
    clearTimeout(impactTimer);
    impactTimer = setTimeout(function () {
      impactTimer = null;
      /* Flush first: the server can only count what it has been told. */
      ST.sync.flush()
        .then(function () { return ST.api.reviewImpact(); })
        .then(function (payload) {
          if (!payload) return;
          ensureState().impact = payload;
          if (ST.state.view === "review" && container.isConnected) render(container);
        })
        .catch(function () { /* the local estimate carries on regardless */ });
    }, 700);
  }

  function loadServer() {
    if (!navigator.onLine) return Promise.resolve(false);
    var rv = ensureState();
    return Promise.all([
      ST.api.reviewQueue({ limit: 40 }).catch(function () { return null; }),
      ST.api.reviewImpact().catch(function () { return null; }),
    ]).then(function (res) {
      var rows = res[0]
        ? (Array.isArray(res[0]) ? res[0] : (res[0].items || res[0].queue || []))
        : [];
      if (rows.length) {
        /* Keep the server's ordering but use local frecency detail for the
           card, so it reads the same online and off. */
        rv.queue = rows.map(function (row) {
          var localItem = (ST.state.items || []).find(function (x) { return x.id === row.id; });
          return Object.assign({}, localItem || {}, row, {
            _blocks: row.blocks != null ? row.blocks : (localItem || {})._blocks,
            _unlocks: row.unlocks != null ? row.unlocks : (localItem || {})._unlocks,
            _count: (localItem || {})._count || row.n_consumptions || 0,
            _last: (localItem || {})._last,
          });
        });
        rv.source = "server";
      }
      if (res[1]) rv.impact = res[1];
      return true;
    });
  }

  /* --------------------------------- single item, from anywhere else */

  function openItemSheet(itemId) {
    var item = (ST.state.items || []).find(function (x) { return x.id === itemId; }) ||
      rawItem(itemId);
    if (!item) return;
    ST.sheet.open({
      title: "Review " + item.name,
      autofocus: false,
      render: function (body, ctx) {
        var built = buildCard(item, {});
        built.el.classList.add("rv-card-sheet");
        body.appendChild(built.el);
        var actions = U.el('<div class="sheet-actions"></div>');
        var mark = U.el('<button type="button" class="btn primary">Mark reviewed</button>');
        mark.addEventListener("click", function () {
          commit(item, built.state, true).then(function () {
            ctx.close(true);
            ST.toast.show("Reviewed: " + item.name, { duration: 2400 });
          });
        });
        actions.appendChild(mark);
        var save = U.el('<button type="button" class="btn ghost">Save tags only</button>');
        save.addEventListener("click", function () {
          commit(item, built.state, false).then(function () {
            ctx.close(true);
            ST.toast.show("Tags saved. Still counts as unknown.", { duration: 3000 });
          });
        });
        actions.appendChild(save);
        body.appendChild(actions);
      },
    });
  }

  ST.review = {
    render: render,
    loadServer: loadServer,
    openItemSheet: openItemSheet,
    tagsFor: tagsFor,
    isReviewed: isReviewed,
    suggestFor: suggestFor,
    localAnalysis: localAnalysis,
    reviewedCoverage: reviewedCoverage,
    commit: commit,
  };
})(window.ST);
