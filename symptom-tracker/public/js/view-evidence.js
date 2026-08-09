/* view-evidence.js — descriptive results, stated honestly.

   V1 does no inference. This screen describes what has been observed and
   is extremely clear about what that does and does not support.

   Rules it follows, without exception:
   - Two layers: a plain-English summary, expandable to the counts, the
     window, the missingness and the caveats that produced it.
   - Exposure is reported three ways — exposed, unexposed, and UNKNOWN.
     Collapsing unknown into unexposed is the zero-imputation error; it
     inflates the denominator and drags every result toward the null. The
     unknown count is therefore shown, never hidden.
   - No single score. No ranked table. No p-values.
   - Never a percentage without its sample size.
   - A null result is a result, in the same calm styling as anything else,
     with a concrete next step.
   - An empty result is never a dead end: if nothing can be classified yet
     the screen says exactly which foods are responsible and offers a
     route into reviewing them.
   - The words "trigger", "caused", "intolerant" and "safe food" do not
     appear, and server prose passes through ST.util.neutralise() first.
*/

(function (ST) {
  "use strict";

  var U = ST.util;

  /* Canonical windows, identical to the analysis layer and to the
     timeline's lag shading. A shaded band on screen must mean the same
     interval the numbers were computed over. */
  var WINDOWS = [
    { k: "0-6", label: "0–6 h", from: 0, to: 6 },
    { k: "6-24", label: "6–24 h", from: 6, to: 24 },
    { k: "24-48", label: "24–48 h", from: 24, to: 48 },
  ];

  /* Exactly five, matching the contract. There is no `hypothesis` tier —
     the whole v1 output is hypothesis-level by construction, so a tier
     saying so carries no information. Anything unrecognised maps DOWN to
     `unclear`, never up. */
  var TIERS = {
    observed: { label: "Observed", cls: "tier-observed" },
    suggestive: { label: "Suggestive", cls: "tier-suggestive" },
    unclear: { label: "Unclear", cls: "tier-unclear" },
    contradictory: { label: "Contradictory", cls: "tier-contradictory" },
    experiment: { label: "Experiment result", cls: "tier-experiment" },
  };

  function tierOf(payload) {
    var raw = String((payload && payload.evidence_tier) || "").toLowerCase();
    return TIERS[raw] || TIERS.unclear;
  }

  function num(payload, keys, dflt) {
    for (var i = 0; i < keys.length; i++) {
      if (payload && payload[keys[i]] !== undefined && payload[keys[i]] !== null) {
        return payload[keys[i]];
      }
    }
    return dflt;
  }

  function pct(v) {
    if (v === null || v === undefined) return null;
    var n = Number(v);
    if (isNaN(n)) return null;
    return Math.round(n <= 1 ? n * 100 : n);
  }

  function fmtNum(v) {
    if (v === null || v === undefined) return "—";
    var n = Number(v);
    if (isNaN(n)) return String(v);
    return Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(2);
  }

  /* --------------------------------------------------------- fragments */

  function ciBar(lo, hi, point) {
    if (lo === null || hi === null || lo === undefined || hi === undefined) return null;
    var min = Math.min(0, lo), max = Math.max(0, hi);
    var span = (max - min) || 1;
    var left = ((lo - min) / span) * 100;
    var width = ((hi - lo) / span) * 100;
    var px = point !== null && point !== undefined ? ((point - min) / span) * 100 : null;
    return U.el(
      '<div><div class="ci-bar">' +
      '<span class="ci-track"></span>' +
      '<span class="ci-range" style="left:' + left + "%;width:" + width + '%"></span>' +
      (px !== null ? '<span class="ci-point" style="left:' + px + '%"></span>' : "") +
      "</div>" +
      '<div class="ci-labels"><span>' + fmtNum(min) + "</span>" +
      "<span>Wilson interval</span><span>" + fmtNum(max) + "</span></div></div>"
    );
  }

  function reviewCta(label, sub) {
    var btn = U.el(
      '<button type="button" class="rv-entry">' +
      "<span><span class=\"rve-title\">" + U.esc(label) + "</span>" +
      (sub ? '<span class="rve-sub">' + U.esc(sub) + "</span>" : "") +
      "</span><span class=\"rve-go\">review →</span></button>"
    );
    btn.addEventListener("click", function () { ST.app.go("review"); });
    return btn;
  }

  /* ------------------------------------------------------------ copy */

  function summarySentence(attr, payload, win) {
    var nExp = num(payload, ["n_exposed"], null);
    var nUnexp = num(payload, ["n_unexposed"], null);
    var nUnknown = num(payload, ["n_unknown_exposure"], 0);
    var rExp = pct(num(payload, ["rate_exposed", "exposed_rate"], null));
    var rUnexp = pct(num(payload, ["rate_unexposed", "unexposed_rate"], null));
    var incomplete = num(payload, ["n_incomplete_days", "incomplete_days"], null);
    var name = U.prettyAttr(attr);
    var classified = (nExp || 0) + (nUnexp || 0);

    if (!classified && nUnknown) {
      return "Nothing can be classified for " + name + " yet. " + nUnknown +
        " observations fall after a meal containing a food that has never been " +
        "reviewed, so they count as unknown rather than as exposed or unexposed.";
    }

    if (nExp === null || nUnexp === null || classified === 0) {
      return "There is nothing logged yet that would let this be described one way or " +
        "the other.";
    }

    if (rExp === null || rUnexp === null) {
      return "Recorded so far: " + nExp + " observations with " + name + " and " +
        nUnexp + " without, in the " + win.label + " window after a meal.";
    }

    var diff = rExp - rUnexp;
    var same = Math.abs(diff) < 5;

    if (same) {
      return "No consistent difference detected yet. This is not evidence that " + name +
        " has no effect. " + nExp + " exposed and " + nUnexp + " unexposed observations" +
        (nUnknown ? ", " + nUnknown + " of unknown exposure" : "") +
        (incomplete ? ", " + U.plural(incomplete, "incomplete day") : "") + ".";
    }

    return "Loose stools were recorded after " + rExp + "% of the " + nExp +
      " meals containing " + name + ", and after " + rUnexp + "% of the " + nUnexp +
      " meals without it, within " + win.label + " of eating" +
      (nUnknown ? ". A further " + nUnknown + " observations could not be classified either way" : "") +
      (incomplete ? ". " + U.plural(incomplete, "day") + " in this period were logged as incomplete" : "") +
      ". That is a description of what was recorded, not a claim about what follows from what.";
  }

  function nextStep(payload, win) {
    var nExp = num(payload, ["n_exposed"], 0);
    var nUnexp = num(payload, ["n_unexposed"], 0);
    var nUnknown = num(payload, ["n_unknown_exposure"], 0);
    var identifiable = payload && payload.identifiable;
    var classified = nExp + nUnexp;

    if (nUnknown > classified) {
      return "<b>Next:</b> most observations here are unclassifiable because foods in " +
        "the window have not been reviewed. Reviewing them is the fastest thing you can " +
        "do to make this screen say something.";
    }
    if (nExp < 8 || nUnexp < 8) {
      return "<b>Next:</b> there are too few observations on one side to describe this " +
        "steadily. Keep logging normally; it will fill in on its own.";
    }
    if (identifiable === false) {
      return "<b>Next:</b> this almost always appears alongside something else in the log, " +
        "so the two cannot be told apart from passive records. Separating them needs a " +
        "deliberate rechallenge, which is a later version of this tool.";
    }
    return "<b>Next:</b> if you want to test this properly, eat it deliberately on a day " +
      "with an otherwise plain diet and log the following " + win.label +
      " carefully. Passive records can only ever narrow the list.";
  }

  /* -------------------------------------------------------------- card */

  function ratePair(payload, side) {
    var r = pct(num(payload, ["rate_" + side, side + "_rate"], null));
    var n = num(payload, ["n_" + side], null);
    if (r === null || n === null) return "—";
    return r + "% of " + n;   /* a percentage never appears without its n */
  }

  function evidenceCard(attr, payload, win, options) {
    var opts = options || {};
    var tier = tierOf(payload);
    var card = U.el('<section class="card ev-card"></section>');
    var nUnknown = num(payload, ["n_unknown_exposure"], 0);
    var classified = num(payload, ["n_exposed"], 0) + num(payload, ["n_unexposed"], 0);

    card.appendChild(U.el(
      '<div class="ev-head">' +
      '<span class="ev-name">' + U.esc(U.prettyAttr(attr)) + "</span>" +
      '<span class="tier ' + tier.cls + '">' + U.esc(tier.label) + "</span></div>"
    ));

    card.appendChild(U.el(
      '<p class="ev-summary">' + U.esc(U.neutralise(summarySentence(attr, payload, win))) + "</p>"
    ));

    var lo = num(payload, ["ci_low", "ci_lower"], null);
    var hi = num(payload, ["ci_high", "ci_upper"], null);
    if ((lo === null || hi === null) && Array.isArray(payload.ci)) {
      lo = payload.ci[0]; hi = payload.ci[1];
    }
    if (classified) {
      var bar = ciBar(lo, hi, num(payload, ["difference", "risk_difference"], null));
      if (bar) card.appendChild(bar);
    }

    if (nUnknown) {
      card.appendChild(U.el(
        '<div class="ev-unknown">' +
        '<span class="ev-unknown-n">' + nUnknown + "</span>" +
        "<span>observations could not be classified either way, because a food eaten in " +
        "the window has never been reviewed. They are excluded rather than counted as " +
        "unexposed — treating them as unexposed would quietly bias this toward " +
        "finding nothing.</span></div>"
      ));
    }

    (payload.warnings || []).forEach(function (w) {
      card.appendChild(U.el('<div class="ev-warn">' + U.esc(U.neutralise(w)) + "</div>"));
    });

    card.appendChild(U.el('<div class="ev-next">' + U.neutralise(nextStep(payload, win)) + "</div>"));

    if (opts.allowCta && nUnknown > classified) {
      card.appendChild(reviewCta(
        "Review the foods blocking this",
        nUnknown + " observations are waiting on it"
      ));
    }

    var more = U.el(
      "<details class='ev-more'><summary>Show the numbers behind this</summary></details>"
    );
    var rows = [
      ["lag window", win.from + "–" + win.to + " h after a meal"],
      ["outcome", "a record of Bristol type 6 or 7"],
      ["observations with it", num(payload, ["n_exposed"], "—")],
      ["observations without it", num(payload, ["n_unexposed"], "—")],
      ["unknown exposure", nUnknown || "—"],
      ["rate with it", ratePair(payload, "exposed")],
      ["rate without it", ratePair(payload, "unexposed")],
      ["interval", lo === null ? "not reported" : fmtNum(lo) + " to " + fmtNum(hi) + " (Wilson)"],
      ["days excluded as incomplete", num(payload, ["n_incomplete_days", "incomplete_days"], "—")],
      ["days excluded by a censor window", num(payload, ["n_censored_days", "censored_days"], "—")],
      ["separable from co-occurring foods", payload.identifiable === false ? "no" :
        payload.identifiable === true ? "yes" : "not assessed"],
    ];
    more.appendChild(U.el(
      '<table class="ev-table"><tbody>' +
      rows.map(function (r) {
        return "<tr><th>" + U.esc(r[0]) + "</th><td>" + U.esc(String(r[1])) + "</td></tr>";
      }).join("") +
      "</tbody></table>"
    ));

    /* The sensitivity block exists so the effect of the completeness
       filtering choice is visible rather than hidden. */
    var sens = payload.sensitivity;
    if (sens && typeof sens === "object") {
      more.appendChild(U.el(
        '<p class="ev-sens-head">If days of unknown completeness are included as well</p>'
      ));
      more.appendChild(U.el(
        '<table class="ev-table"><tbody>' +
        [
          ["observations with it", num(sens, ["n_exposed"], "—")],
          ["observations without it", num(sens, ["n_unexposed"], "—")],
          ["unknown exposure", num(sens, ["n_unknown_exposure"], "—")],
          ["rate with it", ratePair(sens, "exposed")],
          ["rate without it", ratePair(sens, "unexposed")],
        ].map(function (r) {
          return "<tr><th>" + U.esc(r[0]) + "</th><td>" + U.esc(String(r[1])) + "</td></tr>";
        }).join("") +
        "</tbody></table>"
      ));
      more.appendChild(U.el(
        '<p class="ev-disclaimer">If those two tables disagree, the disagreement is the ' +
        "finding: the result depends on which days you are willing to count.</p>"
      ));
    }

    more.appendChild(U.el(
      '<p class="ev-disclaimer">' +
      U.esc(U.neutralise(payload.disclaimer ||
        "Descriptive association only. Not a causal claim.")) +
      " Confounding by other foods, by illness, by stress and by what makes a person " +
      "reach for the phone in the first place is not adjusted for in this version.</p>"
    ));
    card.appendChild(more);

    return card;
  }

  /* --------------------------------------------------------------- view */

  function render(container) {
    container.innerHTML = "";
    var win = WINDOWS.find(function (w) { return w.k === ST.state.settings.evidenceWindow; }) ||
      WINDOWS[1];

    /* Slot for the review gate, deliberately ABOVE the explanation. When
       the screen cannot say anything, "here is why, and here is what to
       do" has to arrive before the essay about methodology. */
    var coverageSlot = U.el("<div></div>");
    container.appendChild(coverageSlot);
    var coverage = ST.review.reviewedCoverage();
    var localReview = ST.review.localAnalysis();
    if (coverage.total && coverage.reviewed < coverage.total) {
      coverageSlot.appendChild(reviewCta(
        coverage.total - coverage.reviewed === 1
          ? "1 food has not been reviewed"
          : (coverage.total - coverage.reviewed) + " foods have not been reviewed",
        "meals containing them can only count as unknown"
      ));
    }

    container.appendChild(U.el(
      '<section class="card" style="margin-top:12px">' +
      '<p class="prose">This version describes. It does not infer.</p>' +
      '<p class="prose small" style="margin-top:8px">Everything below is a count of what ' +
      "you recorded, split by whether a meal contained a given attribute and whether a " +
      "loose record followed it inside a chosen window. A difference here is a reason to " +
      "look more closely, and nothing more than that. Deliberate rechallenge — eating " +
      "something on purpose to see what happens — is the only thing in this design that " +
      "can support a stronger claim, and it is not built yet.</p>" +
      "</section>"
    ));

    var winRow = U.el('<div class="chip-row" role="group" aria-label="Lag window"></div>');
    WINDOWS.forEach(function (w) {
      var chip = U.el(
        '<button type="button" class="chip' + (w.k === win.k ? " is-on" : "") + '">' +
        U.esc(w.label) + "</button>"
      );
      chip.addEventListener("click", function () {
        ST.state.settings.evidenceWindow = w.k;
        ST.settings.persist();
        render(container);
      });
      winRow.appendChild(chip);
    });
    container.appendChild(U.el('<div class="section-head"><h2>Window after a meal</h2></div>'));
    container.appendChild(winRow);
    container.appendChild(U.el(
      '<p class="mono faint" style="font-size:10.5px;margin:0 2px 6px">' +
      "the same three windows the analysis layer uses, and the same shading on the timeline</p>"
    ));

    container.appendChild(U.el(
      '<div class="section-head"><h2>Pre-registered candidates</h2>' +
      '<span class="mono faint" style="font-size:10.5px">' + U.CANDIDATES.length + " fixed</span></div>"
    ));
    container.appendChild(U.el(
      '<p class="prose small" style="margin:0 0 10px">This list was fixed in advance and ' +
      "does not grow when something looks interesting. That is deliberate: a list that " +
      "grows to fit the data will always find something.</p>"
    ));

    var host = U.el("<div></div>");
    container.appendChild(host);

    if (!navigator.onLine) {
      host.appendChild(U.el(
        '<p class="empty">These counts are computed on the server, so they need a ' +
        "connection.<br>Logging does not — everything you record offline is safe.</p>"
      ));
      if (localReview.queue.length) {
        host.appendChild(reviewCta(
          "Reviewing works offline",
          localReview.queue.length + " foods are waiting"
        ));
      }
      return;
    }

    var loading = U.el('<p class="empty">Counting…</p>');
    host.appendChild(loading);

    var results = {};
    var pending = U.CANDIDATES.length;

    U.CANDIDATES.forEach(function (attr) {
      ST.api.rates({
        attribute: attr,
        lag_from_h: win.from,
        lag_to_h: win.to,
        outcome: "bristol67",
      }).then(function (payload) {
        results[attr] = payload || {};
      }).catch(function (err) {
        results[attr] = { _error: err instanceof ST.api.AuthError ? "auth" : "unavailable" };
      }).then(function () {
        pending -= 1;
        if (pending === 0) paint();
      });
    });

    function paint() {
      loading.remove();
      var usable = [];
      var maxUnknown = 0;
      var totalClassified = 0;

      U.CANDIDATES.forEach(function (attr) {
        var payload = results[attr];
        if (!payload || payload._error) return;
        usable.push(attr);
        /* Unknown-exposure counts describe the SAME set of observations
           seen through each candidate in turn. Summing them across
           candidates would multiply one number by fifteen and report a
           corpus far larger than the one that exists. Take the largest. */
        maxUnknown = Math.max(maxUnknown, num(payload, ["n_unknown_exposure"], 0));
        totalClassified += num(payload, ["n_exposed"], 0) + num(payload, ["n_unexposed"], 0);
      });

      if (!usable.length) {
        host.appendChild(U.el(
          '<p class="empty">These counts could not be fetched.<br>' +
          "Nothing you have logged is affected.</p>"
        ));
        return;
      }

      /* Nothing classified anywhere: the honest reading is "not enough
         reviewed data", not "no association". Say so, and give the route. */
      var gateShown = false;
      if (totalClassified === 0) {
        gateShown = true;
        coverageSlot.innerHTML = "";
        var gate = U.el('<section class="card ev-card"></section>');
        gate.appendChild(U.el(
          '<div class="ev-head"><span class="ev-name">not enough reviewed data yet</span>' +
          '<span class="tier tier-unclear">Unclear</span></div>'
        ));
        gate.appendChild(U.el(
          '<p class="ev-summary">' +
          (maxUnknown
            ? maxUnknown + " observations are logged and none of them can be classified " +
              "for any of the candidates yet, because the foods eaten before them have " +
              "not been reviewed."
            : "There are not yet enough logged observations to describe anything.") +
          " This is not a finding about any food. It is a statement about what the record " +
          "can currently support.</p>"
        ));
        gate.appendChild(U.el(
          '<div class="ev-next"><b>Next:</b> reviewing a food takes a few seconds and ' +
          "applies to every meal you have ever logged containing it, past and future.</div>"
        ));
        gate.appendChild(reviewCta(
          localReview.queue.length
            ? "Review " + U.plural(Math.min(6, localReview.queue.length), "food")
            : "Open the review queue",
          localReview.queue.length
            ? "ranked so the most useful ones come first"
            : "nothing is waiting right now"
        ));
        coverageSlot.appendChild(gate);
      }

      /* At most one per-card route into review. The point is made once. */
      var ctaBudget = gateShown ? 0 : 1;
      usable.forEach(function (attr) {
        var nUnknown = num(results[attr], ["n_unknown_exposure"], 0);
        var classified = num(results[attr], ["n_exposed"], 0) +
          num(results[attr], ["n_unexposed"], 0);
        var allow = ctaBudget > 0 && nUnknown > classified;
        if (allow) ctaBudget -= 1;
        host.appendChild(evidenceCard(attr, results[attr], win, { allowCta: allow }));
      });

      loadCooccurrence(host);
    }
  }

  function loadCooccurrence(host) {
    ST.api.cooccurrence({ min_count: 5 }).then(function (payload) {
      var pairs = (payload && (payload.pairs || payload.results)) || [];
      if (!pairs.length) return;
      var card = U.el('<section class="card" style="margin-top:14px"></section>');
      card.appendChild(U.el(
        '<div class="ev-head"><span class="ev-name">what cannot be separated</span></div>' +
        '<p class="prose small">These pairs almost always appear together in your log. ' +
        "Passive records cannot tell their effects apart, however much data accumulates. " +
        "Only eating one without the other can.</p>"
      ));
      card.appendChild(U.el(
        '<table class="ev-table"><tbody>' +
        pairs.slice(0, 12).map(function (p) {
          var a = U.esc(U.prettyAttr(p.a || p.left || p.attribute_a));
          var b = U.esc(U.prettyAttr(p.b || p.right || p.attribute_b));
          var together = p.co_count !== undefined ? p.co_count : p.together;
          var apart = p.discordant !== undefined ? p.discordant : p.discordant_count;
          return "<tr><th>" + a + " + " + b + "</th><td>" + U.esc(together) +
            " together · " + U.esc(apart === undefined ? "—" : apart) + " apart</td></tr>";
        }).join("") +
        "</tbody></table>"
      ));
      host.appendChild(card);
    }).catch(function () { /* optional */ });
  }

  ST.evidence = { render: render, WINDOWS: WINDOWS, TIERS: TIERS };
})(window.ST);
