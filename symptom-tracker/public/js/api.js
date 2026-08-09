/* api.js — thin HTTP layer.

   The base URL is computed relative to wherever the app happens to be
   mounted (see food-planner/public/app.js), so the same build works at
   "/" during development and at "/tracker/" in production. Never
   hard-code "/api/".

   Nothing in here is allowed to be on the critical path of a save. Every
   call may fail, and failure is a normal, expected state. */

(function (ST) {
  "use strict";

  var BASE = new URL("api/", window.location.href).pathname;

  function AuthError(message) {
    this.name = "AuthError";
    this.message = message || "Sign-in required";
  }
  AuthError.prototype = Object.create(Error.prototype);

  function OfflineError(message) {
    this.name = "OfflineError";
    this.message = message || "No connection";
  }
  OfflineError.prototype = Object.create(Error.prototype);

  function request(path, options) {
    var opts = options || {};
    var clean = String(path).replace(/^\/+/, "").replace(/^api\//, "");
    var init = {
      method: opts.method || "GET",
      credentials: "same-origin",
      headers: Object.assign({ Accept: "application/json" }, opts.headers || {}),
    };
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal) init.signal = opts.signal;

    return fetch(BASE + clean, init).then(
      function (response) {
        if (response.status === 401) {
          ST.bus && ST.bus.emit("auth-required");
          throw new AuthError();
        }
        return response
          .json()
          .catch(function () { return {}; })
          .then(function (data) {
            if (!response.ok) {
              var err = new Error(data.error || "Request failed (" + response.status + ")");
              err.status = response.status;
              err.payload = data;
              throw err;
            }
            return data;
          });
      },
      function () {
        throw new OfflineError();
      }
    );
  }

  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === "") return;
      if (Array.isArray(v)) {
        v.forEach(function (item) {
          parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(item));
        });
      } else {
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
      }
    });
    return parts.length ? "?" + parts.join("&") : "";
  }

  ST.api = {
    BASE: BASE,
    request: request,
    qs: qs,
    AuthError: AuthError,
    OfflineError: OfflineError,

    session: function () { return request("auth/session"); },
    login: function (password) {
      return request("auth/login", { method: "POST", body: { password: password } });
    },
    logout: function () { return request("auth/logout", { method: "POST" }); },

    sync: function (batch) {
      return request("sync", { method: "POST", body: batch });
    },
    pull: function (since) {
      return request("sync" + qs({ since: since }));
    },

    items: function (params) { return request("items" + qs(params)); },
    meals: function (params) { return request("meals" + qs(params)); },
    symptoms: function (params) { return request("symptoms" + qs(params)); },
    days: function (params) { return request("days" + qs(params)); },
    censor: function () { return request("censor"); },
    search: function (params) { return request("search" + qs(params)); },
    timeline: function (params) { return request("timeline" + qs(params)); },
    rates: function (params) { return request("analysis/rates" + qs(params)); },
    cooccurrence: function (params) {
      return request("analysis/cooccurrence" + qs(params));
    },

    /* attributes and the review flow */
    attributes: function () { return request("attributes"); },
    itemAttributes: function (id) { return request("items/" + id + "/attributes"); },
    putItemAttributes: function (id, body) {
      return request("items/" + id + "/attributes", { method: "PUT", body: body });
    },
    reviewQueue: function (params) { return request("review/queue" + qs(params)); },
    reviewImpact: function () { return request("review/impact"); },

    deleteMeal: function (id) { return request("meals/" + id, { method: "DELETE" }); },
    deleteSymptom: function (id) { return request("symptoms/" + id, { method: "DELETE" }); },
    deleteCensor: function (id) { return request("censor/" + id, { method: "DELETE" }); },
    postCensor: function (row) { return request("censor", { method: "POST", body: row }); },
    postDay: function (date, row) {
      return request("days/" + date, { method: "POST", body: row });
    },
  };

  /* tiny event bus, used to decouple "the server said 401" from "show a
     login sheet" so a sync failure can never interrupt a capture. */
  var handlers = {};
  ST.bus = {
    on: function (name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
    },
    emit: function (name, payload) {
      (handlers[name] || []).forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error(e); }
      });
    },
  };
})(window.ST);
