/* view-settings.js — settings, discreet mode, session, and the data panel. */

(function (ST) {
  "use strict";

  var U = ST.util;

  var DEFAULTS = {
    discreet: false,
    promptEnabled: true,
    promptTime: "21:00",
    promptSnoozeUntil: null,
    lagWindow: "6-24",
    evidenceWindow: "4-12",
  };

  function load() {
    return ST.store.metaGet("settings", null).then(function (saved) {
      ST.state.settings = Object.assign({}, DEFAULTS, saved || {});
      apply();
      return ST.state.settings;
    });
  }

  function persist() {
    apply();
    return ST.store.metaSet("settings", ST.state.settings);
  }

  function apply() {
    document.documentElement.dataset.discreet = ST.state.settings.discreet ? "on" : "off";
    U.applyLexicon(document);
    document.title = U.lex("appTitle");
  }

  function open() {
    ST.sheet.open({
      title: "Settings",
      autofocus: false,
      render: function (body) {
        /* ---------------------------------------------------- discreet */
        body.appendChild(U.el('<div class="section-head" style="margin-top:4px"><h2>In public</h2></div>'));
        var box = U.el('<div class="card" style="padding:4px 14px"></div>');
        box.appendChild(ST.entry.flagToggle(
          "Discreet mode",
          "Neutral wording throughout, illustrations hidden until you tap a card, dimmer palette, no motion, and the screen blurs when the app loses focus.",
          ST.state.settings.discreet,
          function (v) {
            ST.state.settings.discreet = v;
            persist();
            ST.app.render();
          }
        ));
        body.appendChild(box);

        /* ------------------------------------------------ daily prompt */
        body.appendChild(U.el('<div class="section-head"><h2>The daily question</h2></div>'));
        body.appendChild(U.el(
          '<p class="prose small" style="margin:0 0 10px">Asked once, in the evening. ' +
          "It is the denominator for every count in this app: without it there is no way " +
          "to tell a day you did not eat from a day you did not log.</p>"
        ));
        var pbox = U.el('<div class="card" style="padding:4px 14px"></div>');
        pbox.appendChild(ST.entry.flagToggle(
          "Ask about completeness",
          "One prompt a day. It can always be dismissed.",
          ST.state.settings.promptEnabled,
          function (v) { ST.state.settings.promptEnabled = v; persist(); ST.app.render(); }
        ));
        body.appendChild(pbox);

        var timeField = U.el(
          '<label class="field"><span>Ask at</span>' +
          '<input type="time" value="' + U.esc(ST.state.settings.promptTime) + '"></label>'
        );
        timeField.querySelector("input").addEventListener("change", function (e) {
          ST.state.settings.promptTime = e.target.value || "21:00";
          ST.state.settings.promptSnoozeUntil = null;
          persist();
          ST.app.render();
        });
        body.appendChild(timeField);

        /* ------------------------------------------------------ review */
        body.appendChild(U.el('<div class="section-head"><h2>Food attributes</h2></div>'));
        var cov = ST.review.reviewedCoverage();
        var localReview = ST.review.localAnalysis();
        body.appendChild(U.el(
          '<p class="prose small" style="margin:0 0 10px">' +
          (cov.total
            ? cov.reviewed + " of " + cov.total + " foods you actually eat have been " +
              "reviewed against the candidate list."
            : "Nothing has been logged yet.") +
          " Until a food is reviewed, every meal containing it counts as unknown rather " +
          "than as unexposed, which is what keeps the results honest and also what keeps " +
          "them empty.</p>"
        ));
        var reviewBtn = U.el(
          '<button type="button" class="btn wide primary">' +
          (localReview.queue.length
            ? "Review " + U.plural(localReview.queue.length, "food")
            : "Open the review queue") +
          "</button>"
        );
        reviewBtn.addEventListener("click", function () {
          ST.sheet.close(true);
          ST.app.go("review");
        });
        body.appendChild(reviewBtn);

        /* ------------------------------------------------------- data */
        body.appendChild(U.el('<div class="section-head"><h2>Data</h2></div>'));
        var stats = U.el(
          "<dl class='kv'>" +
          "<dt>meals held</dt><dd>" + (ST.state.meals || []).length + "</dd>" +
          "<dt>records held</dt><dd>" + (ST.state.symptoms || []).length + "</dd>" +
          "<dt>foods known</dt><dd>" + (ST.state.items || []).length + "</dd>" +
          "<dt>foods reviewed</dt><dd>" + cov.reviewed + " of " + cov.total + "</dd>" +
          "<dt>waiting to sync</dt><dd>" + (ST.state.pending || 0) + "</dd>" +
          "<dt>connection</dt><dd>" + (navigator.onLine ? "online" : "offline") + "</dd>" +
          "<dt>session</dt><dd>" +
          (ST.state.session.authenticated === true ? "signed in"
            : ST.state.session.authenticated === false ? "signed out" : "unknown") +
          "</dd></dl>"
        );
        body.appendChild(stats);

        var syncBtn = U.el('<button type="button" class="btn wide ghost">Sync now</button>');
        syncBtn.addEventListener("click", function () {
          ST.toast.show("Syncing…", { duration: 1400 });
          ST.sync.flush()
            .then(function () { return ST.sync.hydrateFromServer(); })
            .then(function () {
              ST.app.render();
              ST.toast.show("Up to date", { duration: 2000 });
            })
            .catch(function () {
              ST.toast.show("Could not reach the server. Nothing was lost.", { duration: 3200 });
            });
        });
        body.appendChild(syncBtn);

        var exportBtn = U.el(
          '<button type="button" class="btn wide ghost" style="margin-top:8px">' +
          "Export a copy (JSON)</button>"
        );
        exportBtn.addEventListener("click", exportJson);
        body.appendChild(exportBtn);

        /* ---------------------------------------------------- session */
        var authBtn = U.el(
          '<button type="button" class="btn wide ghost" style="margin-top:8px">' +
          (ST.state.session.authenticated === true ? "Sign out" : "Sign in") + "</button>"
        );
        authBtn.addEventListener("click", function () {
          if (ST.state.session.authenticated === true) {
            ST.api.logout().catch(function () {}).then(function () {
              ST.state.session.authenticated = false;
              ST.sheet.close(true);
              ST.app.renderStatus();
              ST.toast.show("Signed out. Anything on this device stays here.", { duration: 3200 });
            });
          } else {
            ST.sheet.close(true);
            ST.app.openLogin();
          }
        });
        body.appendChild(authBtn);

        /* --------------------------------------------------- reference */
        body.appendChild(U.el('<div class="section-head"><h2>Reference</h2></div>'));
        var ref = U.el('<button type="button" class="btn wide ghost">' +
          U.esc(U.lex("bristol")) + " reference</button>");
        ref.addEventListener("click", function () { ST.entry.openReference(); });
        body.appendChild(ref);

        body.appendChild(U.el(
          '<p class="prose small" style="margin-top:18px">This tool sits alongside a ' +
          "medical workup; it does not replace one. Chronic diarrhoea has explanations no " +
          "diary can find — coeliac disease, bile acid malabsorption, microscopic colitis, " +
          "pancreatic insufficiency, giardia, inflammatory bowel disease. A pattern " +
          "recorded here is a reason to ask a better question at an appointment.</p>"
        ));
      },
    });
  }

  function exportJson() {
    var payload = {
      exported_at: U.isoUtc(),
      meals: ST.state.meals,
      symptom_events: ST.state.symptoms,
      items: ST.state.itemsRaw,
      item_attributes: ST.state.itemAttrs,
      day_logs: ST.state.days,
      state_logs: ST.state.states,
      censor_windows: ST.state.censor,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "record-" + U.todayLocal() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  ST.settings = { load: load, persist: persist, open: open, apply: apply, DEFAULTS: DEFAULTS };
})(window.ST);
