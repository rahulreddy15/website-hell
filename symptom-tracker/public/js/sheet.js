/* sheet.js — bottom sheet, toast with undo, and the privacy veil.

   Entry always happens in a bottom sheet, never a full page: the controls
   sit in the lower third of the screen where a thumb already is, and
   dismissing never loses the screen behind it. */

(function (ST) {
  "use strict";

  var U = ST.util;

  var root = document.getElementById("sheet-root");
  var panel = document.getElementById("sheet");
  var titleEl = document.getElementById("sheet-title");
  var bodyEl = document.getElementById("sheet-body");
  var scrim = document.getElementById("sheet-scrim");
  var closeBtn = document.getElementById("sheet-close");

  var current = null;
  var lastFocus = null;
  var openSeq = 0;

  function open(config) {
    var cfg = config || {};
    if (current && current.onClose) { try { current.onClose(true); } catch (e) {} }
    current = cfg;
    openSeq += 1;
    if (!root.hidden && document.activeElement === document.body) {
      /* keep the original return target when one sheet hands off to another */
    } else if (root.hidden) {
      lastFocus = document.activeElement;
    }

    titleEl.textContent = cfg.title || "";
    bodyEl.innerHTML = "";
    root.hidden = false;
    // force layout so the transform transition actually runs
    void panel.offsetHeight;
    root.classList.add("is-open");
    document.body.style.overflow = "hidden";

    if (cfg.render) cfg.render(bodyEl, { close: close, setTitle: setTitle });
    U.applyLexicon(bodyEl);

    requestAnimationFrame(function () {
      var target = bodyEl.querySelector("[data-autofocus]") ||
        bodyEl.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (target && cfg.autofocus !== false) target.focus({ preventScroll: true });
      bodyEl.scrollTop = 0;
    });
    return { close: close, body: bodyEl, setTitle: setTitle };
  }

  function setTitle(text) { titleEl.textContent = text; }

  function close(silent) {
    if (root.hidden) return;
    var seq = openSeq;
    root.classList.remove("is-open");
    document.body.style.overflow = "";
    var cfg = current;
    current = null;
    /* One sheet often hands straight off to another (pick a type, then the
       optional detail sheet). If that has happened by the time this runs,
       leave the new one alone. */
    var finish = function () {
      if (openSeq !== seq) return;
      root.hidden = true;
      bodyEl.innerHTML = "";
      if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
        document.documentElement.dataset.discreet === "on") finish();
    else setTimeout(finish, 260);
    if (cfg && cfg.onClose && !silent) { try { cfg.onClose(false); } catch (e) {} }
  }

  function isOpen() { return !root.hidden; }

  scrim.addEventListener("click", function () { close(); });
  closeBtn.addEventListener("click", function () { close(); });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && isOpen()) { event.preventDefault(); close(); }
    if (event.key !== "Tab" || !isOpen()) return;
    var focusables = panel.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  });

  /* drag the grip down to dismiss */
  (function dragToClose() {
    var head = panel.querySelector(".sheet-head");
    var startY = null;
    head.addEventListener("touchstart", function (e) {
      startY = e.touches[0].clientY;
    }, { passive: true });
    head.addEventListener("touchmove", function (e) {
      if (startY === null) return;
      var dy = e.touches[0].clientY - startY;
      if (dy > 0) panel.style.transform = "translateY(" + dy + "px)";
    }, { passive: true });
    head.addEventListener("touchend", function (e) {
      if (startY === null) return;
      var dy = (e.changedTouches[0] || {}).clientY - startY;
      panel.style.transform = "";
      startY = null;
      if (dy > 90) close();
    });
  })();

  ST.sheet = { open: open, close: close, isOpen: isOpen, setTitle: setTitle };

  /* ---------------------------------------------------------------- toast
     Every save shows one, and every save can be undone from it. This is
     what makes autosaving on a single tap safe. */

  var toastEl = document.getElementById("toast");
  var toastText = document.getElementById("toast-text");
  var toastAction = document.getElementById("toast-action");
  var toastTimer = null;
  var toastHandler = null;

  toastAction.addEventListener("click", function () {
    var fn = toastHandler;
    hideToast();
    if (fn) fn();
  });

  function showToast(message, options) {
    var opts = options || {};
    clearTimeout(toastTimer);
    toastText.textContent = message;
    toastHandler = opts.onAction || null;
    toastAction.hidden = !opts.onAction;
    toastAction.textContent = opts.actionLabel || "Undo";
    toastEl.hidden = false;
    void toastEl.offsetHeight;
    toastEl.classList.add("is-on");
    toastTimer = setTimeout(hideToast, opts.duration || (opts.onAction ? 9000 : 3200));
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.classList.remove("is-on");
    toastHandler = null;
    setTimeout(function () { if (!toastEl.classList.contains("is-on")) toastEl.hidden = true; }, 200);
  }

  ST.toast = { show: showToast, hide: hideToast };

  /* ----------------------------------------------------------------- veil
     Discreet mode: when the app loses focus the contents blur behind a
     blank card, so nothing is legible over a shoulder or in the app
     switcher. */

  var veil = document.getElementById("veil");

  function showVeil() {
    if (!ST.state.settings.discreet) return;
    veil.hidden = false;
    document.body.dataset.veiled = "1";
  }
  function hideVeil() {
    veil.hidden = true;
    delete document.body.dataset.veiled;
  }
  veil.addEventListener("click", hideVeil);
  veil.addEventListener("keydown", hideVeil);

  window.addEventListener("blur", showVeil);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") showVeil();
  });
  window.addEventListener("focus", function () {
    if (document.visibilityState === "visible") hideVeil();
  });

  ST.veil = { show: showVeil, hide: hideVeil };
})(window.ST);
