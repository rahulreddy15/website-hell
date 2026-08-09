/* app.js — boot, routing, status, session.

   Boot order matters: local data is painted before the network is touched
   at all, so opening the app in a basement with no signal shows the same
   screen as opening it at home. Authentication is checked afterwards and
   never gates capture.
*/

(function (ST) {
  "use strict";

  var U = ST.util;

  ST.state = {
    view: "today",
    session: { authenticated: null },
    pending: 0,
    settings: Object.assign({}, ST.settings ? ST.settings.DEFAULTS : {}),
    items: [], itemsRaw: [], meals: [], symptoms: [],
    itemAttrs: {}, attributes: null, attributeCoverage: null,
    days: {}, states: {}, censor: [],
    recentSearches: [], savedSearches: [],
    timelineDate: null,
    timelineSelection: null,
    explore: null,
    review: null,
    booted: false,
  };

  var viewEl = document.getElementById("view");
  var titleEl = document.getElementById("view-title");
  var subEl = document.getElementById("view-sub");
  var rail = document.getElementById("action-rail");
  var nav = document.getElementById("bottom-nav");
  var statusPill = document.getElementById("status-pill");

  var VIEWS = {
    today: { title: "Today", render: function (c) { ST.today.render(c); }, rail: true },
    explore: { title: "Explore", render: function (c) { ST.explore.render(c); }, rail: false },
    timeline: { title: "Timeline", render: function (c) { ST.timeline.render(c); }, rail: false },
    evidence: { title: "Evidence", render: function (c) { ST.evidence.render(c); }, rail: false },
    /* Not in the bottom nav on purpose: review is a task you are sent to
       from wherever its absence is being felt, not a place you browse. */
    review: { title: "Review", render: function (c) { ST.review.render(c); }, rail: false, back: "evidence" },
  };

  /* --------------------------------------------------------------- render */

  function render() {
    var view = VIEWS[ST.state.view] || VIEWS.today;
    titleEl.textContent = view.title;
    subEl.textContent = subtitleFor(ST.state.view);

    rail.hidden = !view.rail;
    document.body.dataset.rail = view.rail ? "on" : "off";
    setTopLeft(view.back || null);

    nav.querySelectorAll(".nav-item").forEach(function (b) {
      var on = b.dataset.route === ST.state.view;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });

    try {
      view.render(viewEl);
    } catch (err) {
      console.error(err);
      viewEl.innerHTML =
        '<p class="empty">Something went wrong drawing this screen.<br>' +
        "Your data is untouched — it is stored on the device.</p>";
    }

    U.applyLexicon(document);
    renderHints();
    renderStatus();
  }

  /* The top-left slot is settings everywhere except on a task screen with
     somewhere specific to go back to. */
  var SETTINGS_ICON = document.getElementById("settings-btn").innerHTML;
  var BACK_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';

  function setTopLeft(backRoute) {
    var btn = document.getElementById("settings-btn");
    if (backRoute) {
      btn.innerHTML = BACK_ICON;
      btn.setAttribute("aria-label", "Back to " + backRoute);
      btn.dataset.back = backRoute;
    } else {
      btn.innerHTML = SETTINGS_ICON;
      btn.setAttribute("aria-label", "Settings");
      delete btn.dataset.back;
    }
  }

  function subtitleFor(view) {
    if (view === "today") {
      return U.fmtDay(U.todayLocal(), { weekday: "long", month: "long", day: "numeric" });
    }
    if (view === "timeline") {
      return U.dayLabel(ST.state.timelineDate || U.todayLocal());
    }
    if (view === "evidence") return "description only · no inference";
    if (view === "review") return "what the record needs to say anything";
    return "";
  }

  function renderHints() {
    var last = (ST.state.meals || [])[0];
    var mealHint = document.getElementById("meal-hint");
    if (mealHint) {
      mealHint.textContent = last
        ? "last: " + ST.entry.mealTitle(last, ST.state.items)
        : "nothing logged yet";
    }
    var stoolHint = document.getElementById("stool-hint");
    if (stoolHint) {
      var todaysRecords = (ST.state.symptoms || []).filter(function (s) {
        return U.localDate(s) === U.todayLocal();
      }).length;
      stoolHint.textContent = todaysRecords
        ? todaysRecords + " today · saves on tap"
        : "saves on tap";
    }
  }

  function renderStatus() {
    var dot = statusPill.querySelector(".status-text");
    var state, text;
    if (ST.state.session.authenticated === false) {
      state = "auth"; text = "Signed out · " + ST.state.pending + " held";
    } else if (!navigator.onLine) {
      state = "offline";
      text = ST.state.pending ? "Offline · " + ST.state.pending + " held" : "Offline";
    } else if (ST.state.pending > 0) {
      state = "queued"; text = ST.state.pending + " saving…";
    } else {
      state = "ok"; text = "Saved";
    }
    statusPill.dataset.state = state;
    dot.textContent = text;
    statusPill.setAttribute(
      "aria-label",
      state === "auth"
        ? "Signed out. " + ST.state.pending + " records held on this device. Tap to sign in."
        : state === "offline"
        ? "Offline. " + ST.state.pending + " records held on this device."
        : state === "queued"
        ? ST.state.pending + " records waiting to sync. Tap to retry."
        : "Everything is saved and synced."
    );
  }

  function go(route) {
    if (!VIEWS[route]) route = "today";
    ST.state.view = route;
    if (route !== "timeline") ST.state.timelineSelection = null;
    if (route === "review") {
      if (!ST.state.review) ST.state.review = null;
      ST.review.loadServer().then(function (ok) {
        if (ok && ST.state.view === "review") render();
      }).catch(function () {});
    }
    if (window.location.hash !== "#/" + route) {
      history.replaceState(null, "", "#/" + route);
    }
    viewEl.scrollIntoView({ block: "start" });
    window.scrollTo(0, 0);
    render();
  }

  /* ---------------------------------------------------------------- login
     Shown as a sheet, not a wall. If a session expires at 3am the queue
     stays on the device and logging carries on regardless. */

  var loginOpen = false;

  function openLogin(options) {
    if (loginOpen) return;
    loginOpen = true;
    var opts = options || {};
    ST.sheet.open({
      title: "Sign in",
      onClose: function () { loginOpen = false; },
      render: function (body, ctx) {
        body.appendChild(U.el(
          '<p class="sheet-note">' +
          (ST.state.pending
            ? U.plural(ST.state.pending, "record") + " on this device are waiting to sync. " +
              "They stay here until you sign in — nothing is lost."
            : "Your record is stored on your own server.") +
          "</p>"
        ));
        var form = U.el(
          '<form><label class="field"><span>Password</span>' +
          '<input type="password" autocomplete="current-password" data-autofocus></label>' +
          '<p class="prose small" style="min-height:20px;color:var(--clay)"></p>' +
          '<button type="submit" class="btn wide primary">Sign in</button></form>'
        );
        var input = form.querySelector("input");
        var error = form.querySelector("p");
        form.addEventListener("submit", function (e) {
          e.preventDefault();
          error.textContent = "";
          ST.api.login(input.value).then(function () {
            ST.state.session.authenticated = true;
            loginOpen = false;
            ctx.close(true);
            ST.toast.show("Signed in. Syncing what was held.", { duration: 2600 });
            ST.sync.flush().then(function () {
              return ST.sync.hydrateFromServer();
            }).then(render);
          }).catch(function (err) {
            error.textContent = err instanceof ST.api.OfflineError
              ? "No connection. You can keep logging — it will sync later."
              : "That password was not accepted.";
          });
        });
        body.appendChild(form);

        var later = U.el(
          '<button type="button" class="btn wide quiet" style="margin-top:12px">' +
          "Not now — keep logging on this device</button>"
        );
        later.addEventListener("click", function () { loginOpen = false; ctx.close(true); });
        body.appendChild(later);
      },
    });
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    ST.settings
      .load()
      .then(function () { return ST.sync.refreshAllLocal(); })
      .then(function () {
        return Promise.all([
          ST.store.metaGet("recentSearches", []),
          ST.store.metaGet("savedSearches", []),
        ]);
      })
      .then(function (metaValues) {
        ST.state.recentSearches = metaValues[0] || [];
        ST.state.savedSearches = metaValues[1] || [];
        ST.state.booted = true;
        routeFromUrl();
        render();
        ST.sync.updatePending();
        handleLaunchIntent();
      })
      .then(function () {
        return ST.api.session().then(
          function (payload) {
            ST.state.session.authenticated =
              payload && (payload.authenticated === true || payload.ok === true ||
                          payload.session === true || payload.user);
            if (!ST.state.session.authenticated) ST.state.session.authenticated = false;
            renderStatus();
            if (ST.state.session.authenticated) {
              return ST.sync.flush()
                .then(ST.sync.hydrateFromServer)
                .then(render);
            }
            if (ST.state.pending > 0 || !ST.state.meals.length) openLogin();
          },
          function () { renderStatus(); }
        );
      })
      .catch(function (err) {
        console.error(err);
        ST.state.booted = true;
        render();
      });
  }

  function routeFromUrl() {
    var hash = String(window.location.hash || "").replace(/^#\/?/, "");
    if (VIEWS[hash]) ST.state.view = hash;
  }

  /* Home-screen shortcuts and the share target both land here. */
  function handleLaunchIntent() {
    var params = new URLSearchParams(window.location.search);
    var action = params.get("a");
    var shared = params.get("text") || params.get("title") || params.get("url");

    if (action === "stool") {
      setTimeout(function () { ST.entry.openStool(); }, 60);
    } else if (action === "meal") {
      setTimeout(function () { ST.entry.openMeal(); }, 60);
    } else if (shared) {
      setTimeout(function () {
        ST.entry.openMeal({ prefill: String(shared).slice(0, 80) });
      }, 60);
    }
    if (action || shared) {
      history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
  }

  /* ------------------------------------------------------------- wiring */

  document.getElementById("act-stool").addEventListener("click", function () {
    ST.entry.openStool();
  });
  document.getElementById("act-meal").addEventListener("click", function () {
    ST.entry.openMeal();
  });
  document.getElementById("act-symptom").addEventListener("click", function () {
    ST.entry.openOtherSymptom();
  });
  document.getElementById("settings-btn").addEventListener("click", function (event) {
    var back = event.currentTarget.dataset.back;
    if (back) return go(back);
    ST.settings.open();
  });

  nav.addEventListener("click", function (event) {
    var b = event.target.closest(".nav-item");
    if (b) go(b.dataset.route);
  });

  statusPill.addEventListener("click", function () {
    if (ST.state.session.authenticated === false) return openLogin();
    if (!navigator.onLine) {
      return ST.toast.show(
        U.plural(ST.state.pending, "record") + " held on this device. They go up when there is signal.",
        { duration: 3200 }
      );
    }
    ST.toast.show("Syncing…", { duration: 1200 });
    ST.sync.flush().then(function () { render(); });
  });

  window.addEventListener("hashchange", function () {
    routeFromUrl();
    render();
  });

  ST.bus.on("data-changed", function () {
    if (ST.state.booted) render();
  });
  ST.bus.on("status-changed", renderStatus);
  ST.bus.on("auth-required", function () {
    if (ST.state.session.authenticated === false) return;
    ST.state.session.authenticated = false;
    renderStatus();
    openLogin();
  });

  window.addEventListener("online", function () {
    renderStatus();
    ST.sync.flush().then(function () { render(); });
  });
  window.addEventListener("offline", renderStatus);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      ST.sync.flush();
      if (ST.state.booted && ST.state.view === "today") render();
    }
  });

  /* The evening prompt should appear without the user reopening the app. */
  setInterval(function () {
    if (ST.state.booted && ST.state.view === "today" && !ST.sheet.isOpen()) render();
  }, 60000);

  /* ----------------------------------------------------- service worker */

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register(new URL("sw.js", window.location.href).pathname, {
        scope: new URL("./", window.location.href).pathname,
      }).then(function (reg) {
        if ("sync" in reg) {
          reg.sync.register("st-flush").catch(function () {});
        }
      }).catch(function (err) {
        console.warn("Service worker registration failed", err);
      });
      navigator.serviceWorker.addEventListener("message", function (event) {
        if (event.data && event.data.type === "flush") ST.sync.flush();
      });
    });
  }

  ST.app = { render: render, go: go, openLogin: openLogin, renderStatus: renderStatus };

  boot();
})(window.ST);
