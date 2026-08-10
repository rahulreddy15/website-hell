/* bristol.js — the Bristol picker.

   This is the single most-used control in the app: it is hit several times
   a day, usually in a hurry, usually one-handed, often at night.

   Shape decisions, and why:
   - A horizontal strip of seven large cards, tapped. Not a wheel picker
     (hides its neighbours, and you cannot see what you are choosing
     between), not a bare slider (encodes order but destroys recognition).
   - Every card carries the number, a short standard description, an
     abstract silhouette and a selected-state ring. Colour is the fourth
     redundant channel, never the only one.
   - The palette is a low-saturation diverging ramp: ochre at the hard end,
     neutral at type 4, slate-blue at the loose end. Not a traffic light.
     Type 4 is not "good" and type 7 is not "danger" — that is a clinical
     judgement this app has no business making on the user's behalf.
   - Arrow keys move focus but never select, because selecting writes a
     record immediately.
*/

(function (ST) {
  "use strict";

  var U = ST.util;

  var TYPES = [
    {
      n: 1, short: "hard lumps",
      full: "Separate hard lumps, like nuts. Hard to pass.",
      sil: '<circle cx="12" cy="22" r="5"/><circle cx="25" cy="17" r="4.3"/><circle cx="37" cy="23" r="4.7"/><circle cx="49" cy="18" r="4"/>',
    },
    {
      n: 2, short: "lumpy sausage",
      full: "Sausage-shaped, but lumpy.",
      sil: '<rect x="7" y="14" width="50" height="13" rx="6.5"/><circle cx="18" cy="16" r="5"/><circle cx="31" cy="25" r="5"/><circle cx="44" cy="16" r="4.6"/>',
    },
    {
      n: 3, short: "cracked sausage",
      full: "Like a sausage, with cracks on the surface.",
      sil: '<rect x="7" y="15" width="50" height="11" rx="5.5"/><path d="M20 15v11M32 15v11M44 15v11" stroke="var(--sil-bg)" stroke-width="2.4" stroke-dasharray="3 3" fill="none"/>',
    },
    {
      n: 4, short: "smooth, soft sausage",
      full: "Like a sausage or snake, smooth and soft.",
      sil: '<path d="M9 22C20 13 32 29 55 19" stroke="currentColor" stroke-width="11" stroke-linecap="round" fill="none"/>',
    },
    {
      n: 5, short: "soft blobs",
      full: "Soft blobs with clear-cut edges. Passed easily.",
      sil: '<ellipse cx="16" cy="22" rx="9" ry="7"/><ellipse cx="35" cy="19" rx="8" ry="6.4"/><ellipse cx="51" cy="24" rx="6.5" ry="5.4"/>',
    },
    {
      n: 6, short: "mushy, ragged",
      full: "Fluffy pieces with ragged edges. A mushy stool.",
      sil: '<path d="M4 22 8 16 11 21 16 12 20 20 25 15 31 21 34 13 39 19 44 16 48 22 53 14 57 20 60 18 59 28 54 33 48 27 42 32 36 28 30 33 23 27 17 32 11 28 6 31Z"/>',
    },
    {
      n: 7, short: "watery",
      full: "Watery, no solid pieces. Entirely liquid.",
      sil: '<ellipse cx="32" cy="27" rx="25" ry="5.5"/><path d="M12 17c5-4 10 4 15 0s10-4 15 0 8 2 10 0" stroke="currentColor" stroke-width="2" fill="none" opacity="0.7"/>',
    },
  ];

  function color(n) { return "var(--b" + n + ")"; }
  function byNumber(n) { return TYPES[Math.min(7, Math.max(1, n)) - 1]; }

  function silSvg(type) {
    return (
      '<svg viewBox="0 0 64 40" aria-hidden="true" fill="currentColor">' +
      type.sil +
      "</svg>"
    );
  }

  function cardHtml(type, selected, withFull) {
    return (
      '<button type="button" class="b-card" role="radio"' +
      ' aria-checked="' + (selected ? "true" : "false") + '"' +
      ' tabindex="' + (selected ? "0" : "-1") + '"' +
      ' data-bristol="' + type.n + '"' +
      ' style="--b-color:' + color(type.n) + '"' +
      ' aria-label="Type ' + type.n + ", " + U.esc(type.short) + '">' +
      '<span class="b-kicker" aria-hidden="true">type</span>' +
      '<span class="b-num" aria-hidden="true">' + type.n + "</span>" +
      '<span class="b-sil">' + silSvg(type) + "</span>" +
      '<span class="b-label" aria-hidden="true">' + U.esc(type.short) + "</span>" +
      (withFull ? '<span class="b-ref-desc">' + U.esc(type.full) + "</span>" : "") +
      "</button>"
    );
  }

  /* ------------------------------------------------------------- strip */

  function strip(options) {
    var opts = options || {};
    var wrap = U.el(
      '<div class="bristol-wrap">' +
      '<p class="b-hint">' + U.esc(opts.hint || "") + "</p>" +
      '<div class="bristol-strip" role="radiogroup" aria-label="' +
      U.esc(U.lex("bristol")) + '"></div>' +
      "</div>"
    );
    if (!opts.hint) wrap.querySelector(".b-hint").remove();

    var group = wrap.querySelector(".bristol-strip");
    group.innerHTML = TYPES.map(function (t) {
      return cardHtml(t, opts.selected === t.n, false);
    }).join("");

    function cards() { return Array.prototype.slice.call(group.querySelectorAll(".b-card")); }

    /* Marks which edges actually continue, so the CSS can fade only those.
       Also the only thing standing between the user and "I did not know it
       scrolled", which is how types 1 and 7 stayed unreachable. */
    function updateOverflow() {
      var max = group.scrollWidth - group.clientWidth;
      if (max <= 1) { group.dataset.overflow = "none"; return; }
      var atStart = group.scrollLeft <= 1;
      var atEnd = group.scrollLeft >= max - 1;
      group.dataset.overflow = atStart ? "end" : atEnd ? "start" : "both";
    }
    group.addEventListener("scroll", updateOverflow, { passive: true });
    if (window.ResizeObserver) {
      /* Observed rather than a window listener so it is collected with the
         sheet instead of outliving it. */
      new ResizeObserver(updateOverflow).observe(group);
    }

    function setFocus(index) {
      var list = cards();
      var i = Math.max(0, Math.min(list.length - 1, index));
      list.forEach(function (c, j) { c.tabIndex = j === i ? 0 : -1; });
      list[i].focus();
      list[i].scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" });
      updateOverflow();
    }

    function select(n, source) {
      cards().forEach(function (c) {
        var on = Number(c.dataset.bristol) === n;
        c.setAttribute("aria-checked", on ? "true" : "false");
        c.tabIndex = on ? 0 : -1;
      });
      U.haptic(18);
      if (opts.onSelect) opts.onSelect(n, source);
    }

    group.addEventListener("click", function (event) {
      var card = event.target.closest(".b-card");
      if (!card) return;
      select(Number(card.dataset.bristol), "tap");
    });

    group.addEventListener("keydown", function (event) {
      var card = event.target.closest(".b-card");
      if (!card) return;
      var list = cards();
      var i = list.indexOf(card);
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault(); setFocus(i + 1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault(); setFocus(i - 1);
      } else if (event.key === "Home") {
        event.preventDefault(); setFocus(0);
      } else if (event.key === "End") {
        event.preventDefault(); setFocus(list.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); select(Number(card.dataset.bristol), "key");
      }
    });

    // Start the strip near the middle so all seven feel equally available
    // rather than implying 1 is the default.
    requestAnimationFrame(function () {
      var target = opts.selected ? opts.selected : 4;
      var card = group.querySelector('[data-bristol="' + target + '"]');
      if (card) card.scrollIntoView({ block: "nearest", inline: "center" });
      updateOverflow();
    });

    return wrap;
  }

  /* ------------------------------------------------- reference grid view
     Doubles as a scroll-free way to reach every type. The strip is still
     the fast path, but the control that records the study's primary
     outcome should not have exactly one route to it. */

  function referenceGrid(options) {
    var opts = options || {};
    var wrap = U.el(
      '<div class="b-grid" role="' + (opts.onSelect ? "radiogroup" : "list") + '"' +
      (opts.onSelect ? ' aria-label="' + U.esc(U.lex("bristol")) + '"' : "") +
      "></div>"
    );
    wrap.innerHTML = TYPES.map(function (t) {
      var sel = opts.selected === t.n;
      return (
        (opts.onSelect
          ? '<button type="button" class="b-card" role="radio" aria-checked="' +
            (sel ? "true" : "false") + '" data-bristol="' + t.n +
            '" aria-label="Type ' + t.n + ", " + U.esc(t.short) + '"'
          : '<div class="b-card" role="listitem"') +
        ' style="--b-color:' + color(t.n) + '">' +
        '<span class="b-kicker" aria-hidden="true">type</span>' +
        '<span class="b-num" aria-hidden="true">' + t.n + "</span>" +
        '<span class="b-sil">' + silSvg(t) + "</span>" +
        '<span class="b-label">' + U.esc(t.short) + "</span>" +
        '<span class="b-ref-desc">' + U.esc(t.full) + "</span>" +
        (opts.onSelect ? "</button>" : "</div>")
      );
    }).join("");

    if (opts.onSelect) {
      wrap.addEventListener("click", function (event) {
        var card = event.target.closest(".b-card");
        if (!card) return;
        U.haptic(18);
        opts.onSelect(Number(card.dataset.bristol), "grid");
      });
    }
    return wrap;
  }

  /* ------------------------------------------ one-tap correction control
     Mis-tapping 6 instead of 7 has to be a single tap to fix, straight
     from the event row. No edit screen, no confirmation dialog. */

  function miniRow(selected, onSelect) {
    var row = U.el(
      '<div class="quickfix">' +
      '<p class="quickfix-label">Correct the type</p>' +
      '<div class="quickfix-row" role="radiogroup" aria-label="Correct ' +
      U.esc(U.lex("bristol")) + '"></div>' +
      "</div>"
    );
    var group = row.querySelector(".quickfix-row");
    group.innerHTML = TYPES.map(function (t) {
      return (
        '<button type="button" role="radio" data-bristol="' + t.n + '"' +
        ' style="--b-color:' + color(t.n) + '"' +
        ' aria-checked="' + (selected === t.n ? "true" : "false") + '"' +
        ' aria-label="Type ' + t.n + ", " + U.esc(t.short) + '">' + t.n + "</button>"
      );
    }).join("");
    group.addEventListener("click", function (event) {
      var b = event.target.closest("[data-bristol]");
      if (!b) return;
      var n = Number(b.dataset.bristol);
      group.querySelectorAll("[data-bristol]").forEach(function (x) {
        x.setAttribute("aria-checked", Number(x.dataset.bristol) === n ? "true" : "false");
      });
      U.haptic(12);
      onSelect(n);
    });
    return row;
  }

  ST.bristol = {
    TYPES: TYPES,
    color: color,
    byNumber: byNumber,
    strip: strip,
    referenceGrid: referenceGrid,
    miniRow: miniRow,
    silSvg: silSvg,
  };
})(window.ST);
