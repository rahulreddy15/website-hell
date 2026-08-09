/* util.js — namespace, time, ids, copy lexicon, small DOM helpers.
   Loaded first; everything else hangs off window.ST. */

window.ST = window.ST || {};

(function (ST) {
  "use strict";

  /* ------------------------------------------------------------ escaping */

  function esc(value) {
    return String(value === null || value === undefined ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  /* FTS5 snippet() returns highlight markers. We escape everything, then
     re-enable only our own <mark> pair. Never trust the server with HTML. */
  function escSnippet(value, open, close) {
    var o = open || "[[", c = close || "]]";
    return esc(value)
      .replaceAll(esc(o), "<mark>")
      .replaceAll(esc(c), "</mark>");
  }

  /* ----------------------------------------------------------------- ids */

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    (window.crypto || {}).getRandomValues
      ? crypto.getRandomValues(b)
      : b.forEach(function (_, i) { b[i] = Math.floor(Math.random() * 256); });
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return (
      h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" +
      h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-" +
      h.slice(10, 16).join("")
    );
  }

  /* ---------------------------------------------------------------- time
     Decision #1: every event carries a UTC instant plus the local offset in
     minutes. Never a bare date, never naive local time. */

  function isoUtc(date) {
    return (date || new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  function tzOffsetMin(date) {
    // JS getTimezoneOffset() is minutes *behind* UTC; we store minutes ahead.
    return -(date || new Date()).getTimezoneOffset();
  }

  function stamp(date) {
    var d = date || new Date();
    return { ts_utc: isoUtc(d), tz_offset_min: tzOffsetMin(d) };
  }

  function parseTs(record) {
    return new Date(record.ts_utc);
  }

  /* Local calendar date of an event, using the offset it was recorded with
     (matches the generated local_date column server-side). */
  function localDate(record) {
    if (record && record.local_date) return record.local_date;
    var d = new Date(record && record.ts_utc ? record.ts_utc : Date.now());
    var off = record && typeof record.tz_offset_min === "number"
      ? record.tz_offset_min
      : tzOffsetMin(d);
    return new Date(d.getTime() + off * 60000).toISOString().slice(0, 10);
  }

  function todayLocal(date) {
    var d = date || new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  }

  function addDays(dateStr, n) {
    var d = new Date(dateStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(a, b) {
    return Math.round(
      (new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000
    );
  }

  function fmtClock(tsUtc) {
    var d = new Date(tsUtc);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function fmtDay(dateStr, opts) {
    return new Date(dateStr + "T12:00:00Z").toLocaleDateString(
      undefined,
      opts || { weekday: "short", month: "short", day: "numeric" }
    );
  }

  function dayLabel(dateStr) {
    var t = todayLocal();
    if (dateStr === t) return "Today";
    if (dateStr === addDays(t, -1)) return "Yesterday";
    return fmtDay(dateStr);
  }

  function relTime(tsUtc) {
    var mins = Math.round((Date.now() - new Date(tsUtc).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + " min ago";
    var h = Math.round(mins / 60);
    if (h < 24) return h + " h ago";
    var d = Math.round(h / 24);
    if (d === 1) return "yesterday";
    if (d < 30) return d + " d ago";
    return fmtDay(tsUtc.slice(0, 10), { month: "short", day: "numeric" });
  }

  /* Nocturnal is a clinically meaningful flag (schema field `nocturnal`).
     We default it from local clock time and always let the user override. */
  function isNocturnal(date) {
    var h = (date || new Date()).getHours();
    return h >= 0 && h < 5;
  }

  /* ------------------------------------------------------------ lexicon
     Discreet mode swaps every user-facing string that names a bodily
     function for a neutral one. Nothing else about the app changes shape,
     so muscle memory survives the switch. */

  var LEX = {
    plain: {
      logStool: "Bowel movement",
      repeatMeal: "Repeat meal",
      otherSymptom: "Other symptom",
      stoolSheet: "Bowel movement",
      stoolShort: "Stool",
      bristol: "Bristol type",
      pickPrompt: "Tap a type — it saves straight away.",
      savedStool: "Bowel movement saved",
      stoolPlural: "bowel movements",
      appTitle: "Record",
    },
    discreet: {
      logStool: "Log event",
      repeatMeal: "Repeat intake",
      otherSymptom: "Other note",
      stoolSheet: "Quick health check",
      stoolShort: "Event",
      bristol: "Type",
      pickPrompt: "Tap a type — it saves straight away.",
      savedStool: "Event saved",
      stoolPlural: "events",
      appTitle: "Record",
    },
  };

  function lex(key) {
    var set = ST.state && ST.state.settings && ST.state.settings.discreet
      ? LEX.discreet
      : LEX.plain;
    return set[key] !== undefined ? set[key] : LEX.plain[key] || key;
  }

  function applyLexicon(root) {
    (root || document).querySelectorAll("[data-lex]").forEach(function (el) {
      el.textContent = lex(el.dataset.lex);
    });
  }

  /* ------------------------------------------------------- banned words
     Section 11 of the plan: the UI must never say "trigger", "caused",
     "intolerant" or "safe food". Server-supplied prose (warnings,
     disclaimers) is passed through this before it is rendered, so a
     careless backend string can never leak causal language into the UI. */

  var NEUTRALISE = [
    [/\btriggers?\b/gi, "possible association"],
    [/\btriggering\b/gi, "co-occurring with"],
    [/\bcaused by\b/gi, "occurred after"],
    [/\bcauses?\b/gi, "co-occurs with"],
    [/\bcausing\b/gi, "co-occurring with"],
    [/\bcaused\b/gi, "occurred after"],
    [/\bintolerances?\b/gi, "repeated association"],
    [/\bintolerant\b/gi, "repeatedly associated"],
    [/\bsafe foods?\b/gi, "food with no association observed"],
    [/\ballerg(y|ic|ies)\b/gi, "reported reaction"],
  ];

  function neutralise(text) {
    var out = String(text || "");
    NEUTRALISE.forEach(function (pair) { out = out.replace(pair[0], pair[1]); });
    return out;
  }

  /* ------------------------------------------------------------ haptics */

  function haptic(pattern) {
    if (!navigator.vibrate) return;
    try { navigator.vibrate(pattern || 14); } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- misc */

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function on(root, selector, type, handler) {
    root.addEventListener(type, function (event) {
      var target = event.target.closest(selector);
      if (target && root.contains(target)) handler(event, target);
    });
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }

  /* Portion is ordinal, never a slider — a slider implies a precision the
     user does not have. `unknown` maps to NULL, honouring decision #5. */
  var PORTIONS = [
    { key: "taste", label: "taste" },
    { key: "small", label: "small" },
    { key: "medium", label: "medium" },
    { key: "large", label: "large" },
    { key: null, label: "unknown" },
  ];

  var SEVERITY = ["none", "mild", "moderate", "severe"];

  var CANDIDATES = [
    "total_fat", "lactose", "caffeine", "alcohol", "polyols", "excess_fructose",
    "capsaicin", "artificial_sweetener", "high_fodmap", "gluten", "dairy",
    "fried", "spicy", "carbonation", "meal_size",
  ];

  /* The same fifteen, grouped and worded the way a person thinks about food
     rather than the way a database names a column. Order is deliberate:
     the review card is scanned top to bottom and these groups are the ones
     that get answered together. */
  var ATTR_GROUPS = [
    {
      label: "dairy & grain",
      items: [
        { id: "dairy", label: "dairy", help: "milk, cheese, yoghurt, cream, butter" },
        { id: "lactose", label: "lactose", help: "unfermented milk sugar — aged cheese has little" },
        { id: "gluten", label: "gluten", help: "wheat, barley, rye" },
      ],
    },
    {
      label: "fat & heat",
      items: [
        { id: "total_fat", label: "high fat", help: "a notably fatty item for its size" },
        { id: "fried", label: "fried", help: "deep or shallow fried" },
        { id: "spicy", label: "spicy", help: "hot to eat, from any source" },
        { id: "capsaicin", label: "capsaicin", help: "chilli heat specifically" },
      ],
    },
    {
      label: "drinks",
      items: [
        { id: "caffeine", label: "caffeine", help: "coffee, tea, cola, energy drinks" },
        { id: "alcohol", label: "alcohol" },
        { id: "carbonation", label: "carbonated", help: "fizzy" },
      ],
    },
    {
      label: "sugars & FODMAPs",
      items: [
        { id: "artificial_sweetener", label: "sweetener", help: "aspartame, sucralose, stevia" },
        { id: "polyols", label: "polyols", help: "sorbitol, mannitol, xylitol, isomalt" },
        { id: "excess_fructose", label: "excess fructose", help: "apple, pear, honey, mango, HFCS" },
        { id: "high_fodmap", label: "high FODMAP", help: "onion, garlic, wheat, legumes, cauliflower" },
      ],
    },
    {
      label: "amount",
      items: [
        { id: "meal_size", label: "large portion", help: "this item is usually a big serving" },
      ],
    },
  ];

  var ATTR_META = {};
  ATTR_GROUPS.forEach(function (g) {
    g.items.forEach(function (a) { ATTR_META[a.id] = a; });
  });

  function prettyAttr(id) {
    if (ATTR_META[id]) return ATTR_META[id].label;
    return String(id || "").replace(/_/g, " ");
  }

  ST.util = {
    esc: esc, escSnippet: escSnippet, uuid: uuid,
    isoUtc: isoUtc, tzOffsetMin: tzOffsetMin, stamp: stamp, parseTs: parseTs,
    localDate: localDate, todayLocal: todayLocal, addDays: addDays,
    daysBetween: daysBetween, fmtClock: fmtClock, fmtDay: fmtDay,
    dayLabel: dayLabel, relTime: relTime, isNocturnal: isNocturnal,
    lex: lex, applyLexicon: applyLexicon, neutralise: neutralise,
    haptic: haptic, debounce: debounce, el: el, on: on, plural: plural,
    PORTIONS: PORTIONS, SEVERITY: SEVERITY, CANDIDATES: CANDIDATES,
    ATTR_GROUPS: ATTR_GROUPS, ATTR_META: ATTR_META,
    prettyAttr: prettyAttr,
  };
})(window.ST);
