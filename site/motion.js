/*
 * The page's three moving parts that are not the globe: the order field, the
 * ledger counters, and the billing toggle.
 *
 * Each one is a figure the product actually computes, so each one is drawn
 * from the real number rather than animated for its own sake. All three paint
 * a correct final state on the first frame if motion is refused, and expose
 * that same state through `__motionSettle` for capture tooling.
 */
(function () {
  "use strict";

  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var settlers = [];

  function onceVisible(element, run) {
    if (!("IntersectionObserver" in window)) { run(); return; }
    var observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          observer.disconnect();
          run();
          return;
        }
      }
    }, { threshold: 0.25, rootMargin: "0px 0px -8% 0px" });
    observer.observe(element);
  }

  /* ------------------------------------------------------------- easing */

  function easeOutExpo(t) {
    return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /* --------------------------------------------------------- order field */

  /*
   * 3,071 dots, one per order in the demo store's month, with the 383 that
   * lost money burning.
   *
   * The point the section is making is that a losing order is invisible on a
   * sales report, so the field is drawn in two beats: every order arrives
   * identical, and only then do the losses ignite. Reversing that order — or
   * running both at once — throws the whole argument away, because the reader
   * never sees the state the merchant is actually living in.
   *
   * Which dots lose is fixed, not re-rolled per visit: a seeded score per cell,
   * mostly noise with a low-frequency field mixed in so the losses clump the
   * way real ones do (a bad shipping zone, a mispriced variant) instead of
   * salting evenly across the grid. Even scatter looks generated; clumps look
   * measured.
   */
  (function orderField() {
    var canvas = document.getElementById("dotfield");
    if (!canvas || !canvas.getContext) return;

    var ctx = canvas.getContext("2d");
    var TOTAL = 3071;
    var LOSSES = 383;

    var cols = 0;
    var rows = 0;
    var cell = 0;
    var logicalW = 0;
    var logicalH = 0;
    var isLoss = null;
    var RECEIPT_INDEX = -1;
    var hoverIndex = -1;
    var readout = document.getElementById("dot-readout");
    var started = false;
    var startedAt = 0;
    var frame = null;

    // The two beats, in milliseconds from the field entering the viewport.
    var ARRIVE = 900;   // every order lands, left to right
    var HOLD = 260;     // a moment where they all look the same
    var IGNITE = 820;   // the losses catch

    /* mulberry32 — small, fast, and identical in every browser, which is the
       only property that matters here: the field must not change between a
       reload and a screenshot. */
    function seeded(seed) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function chooseLosses() {
      var random = seeded(13254); // the order number on the receipt beside it
      var scored = new Array(TOTAL);

      for (var i = 0; i < TOTAL; i++) {
        var col = i % cols;
        var row = (i / cols) | 0;

        /* Two sines at incommensurable frequencies: the sum never repeats
           across the grid, so the clumps do not tile. Weighted lightly —
           at any more than this the top 383 scores fall into contiguous
           bands and the field stops reading as orders and starts reading
           as a map. */
        var field =
          Math.sin(col * 0.21 + row * 0.13) +
          Math.sin(col * 0.077 - row * 0.31 + 1.7);

        scored[i] = {
          index: i,
          score: random() * 0.88 + ((field + 2) / 4) * 0.12
        };
      }

      scored.sort(function (a, b) { return b.score - a.score; });

      isLoss = new Uint8Array(TOTAL);
      for (var n = 0; n < LOSSES; n++) isLoss[scored[n].index] = 1;

      /*
       * One of these 383 is the order opened up in the receipt beside the
       * field. Without it the two halves of the section are a chart and an
       * unrelated invoice; with it the field has a way in — that dot is this
       * receipt, and there are 382 more like it.
       *
       * Deliberately not the first or last cell: it has to sit in the body
       * of the field to read as one of the crowd.
       */
      RECEIPT_INDEX = -1;
      for (var m = 0; m < LOSSES; m++) {
        var cand = scored[m].index;
        var cr = (cand / cols) | 0;
        var cc = cand % cols;
        if (cr > rows * 0.32 && cr < rows * 0.62 && cc > cols * 0.3 && cc < cols * 0.6) {
          RECEIPT_INDEX = cand;
          break;
        }
      }
      if (RECEIPT_INDEX < 0) RECEIPT_INDEX = scored[0].index;
    }

    function measure() {
      var cssW = canvas.clientWidth || 1120;

      /* One column short of a full rectangle is the honest shape for 3,071:
         the last row runs out mid-way, exactly as the tally does.

         The field keeps a constant 3:2 whatever the width, so the cell is
         always ~1/69th of the column: big enough at desktop to see a single
         order, small enough on a phone that the mass still fits on screen.
         A wider field would give bigger dots but leave the panel beside the
         receipt half empty. */
      var aspect = 1.5;
      rows = Math.max(8, Math.round(Math.sqrt(TOTAL / aspect)));
      cols = Math.ceil(TOTAL / rows);
      cell = cssW / cols;

      logicalW = cssW;
      logicalH = rows * cell;

      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(logicalW * dpr);
      canvas.height = Math.round(logicalH * dpr);
      canvas.style.height = logicalH.toFixed(2) + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      chooseLosses();
    }

    /* The page's ink, whichever theme is on. */
    function inkAlpha(a) {
      var rgb = getComputedStyle(document.documentElement)
        .getPropertyValue("--ink-rgb").trim() || "10, 10, 10";
      return "rgba(" + rgb + ", " + a + ")";
    }

    function draw(arrive, ignite) {
      ctx.clearRect(0, 0, logicalW, logicalH);

      /* Kept and lost orders are drawn at exactly the same radius. Enlarging
         the losses is the obvious way to make them read, and it is the one
         move this section cannot make: area is the quantity the eye actually
         totals, so a bigger dot is a bigger claim. The losses get their
         salience from colour and brightness instead, which costs the count
         nothing. */
      var radius = Math.max(1, cell * 0.26);
      var keepR = radius;
      var lossR = radius;

      /* Kept orders first, in one pass with one fill colour: 2,688 separate
         fillStyle writes is the difference between this painting in a frame
         and this dropping frames on a laptop. */
      ctx.fillStyle = inkAlpha(0.22);
      ctx.beginPath();
      for (var i = 0; i < TOTAL; i++) {
        if (isLoss[i]) continue;
        var a = dotArrival(i, arrive);
        if (a <= 0) continue;
        var col = i % cols;
        var row = (i / cols) | 0;
        var x = (col + 0.5) * cell;
        var y = (row + 0.5) * cell;
        ctx.moveTo(x + keepR * a, y);
        ctx.arc(x, y, keepR * a, 0, Math.PI * 2);
      }
      ctx.fill();

      /* A losing order that has not caught yet is still just an order, so it
         is drawn in the same periwinkle until its own moment. */
      ctx.fillStyle = inkAlpha(0.22);
      ctx.beginPath();
      for (var j = 0; j < TOTAL; j++) {
        if (!isLoss[j]) continue;
        if (lossHeat(j, ignite) >= 1) continue;
        var ja = dotArrival(j, arrive);
        if (ja <= 0) continue;
        var jcol = j % cols;
        var jrow = (j / cols) | 0;
        var jx = (jcol + 0.5) * cell;
        var jy = (jrow + 0.5) * cell;
        ctx.moveTo(jx + keepR * ja, jy);
        ctx.arc(jx, jy, keepR * ja, 0, Math.PI * 2);
      }
      ctx.fill();

      /*
       * The losses, once they catch.
       *
       * The glow is kept deliberately tight. A generous bloom looks better in
       * isolation but each ember then covers several cells of background, and
       * 383 of 3,071 starts reading as something nearer a third of the store —
       * which is precisely the kind of flattering distortion this section
       * exists to accuse everyone else of. The picture has to agree with the
       * 12.5% in the paragraph above it.
       */
      ctx.save();
      /* Monochrome: a losing order is the darkest mark in the field, and a
         kept one is a light tick. No glow — on paper a glow is a smudge. */
      ctx.shadowBlur = 0;
      ctx.fillStyle = inkAlpha(1);
      for (var k = 0; k < TOTAL; k++) {
        if (!isLoss[k]) continue;
        var heat = lossHeat(k, ignite);
        if (heat <= 0) continue;
        var ka = dotArrival(k, arrive);
        if (ka <= 0) continue;
        var kcol = k % cols;
        var krow = (k / cols) | 0;
        ctx.globalAlpha = heat;
        ctx.beginPath();
        ctx.arc((kcol + 0.5) * cell, (krow + 0.5) * cell, lossR * ka, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      /*
       * The one order that is also the receipt.
       *
       * Ringed rather than recoloured — recolouring it would make it a fourth
       * category in a field that only has two. The ring says "this one", and
       * the receipt beside it says the rest.
       */
      if (ignite >= 1 && RECEIPT_INDEX >= 0) {
        ringDot(RECEIPT_INDEX, inkAlpha(0.95), Math.max(1, cell * 0.14), radius * 2.1);
      }

      /* Whatever the pointer is currently over. */
      if (hoverIndex >= 0 && hoverIndex !== RECEIPT_INDEX) {
        ringDot(hoverIndex, inkAlpha(0.55), Math.max(1, cell * 0.12), radius * 1.9);
      }
    }

    function ringDot(i, colour, width, r) {
      var x = ((i % cols) + 0.5) * cell;
      var y = (((i / cols) | 0) + 0.5) * cell;
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    /* Arrival sweeps left to right with a soft edge, so the field fills like
       a ledger being read rather than a grid being switched on. */
    function dotArrival(i, progress) {
      if (progress >= 1) return 1;
      var col = i % cols;
      var row = (i / cols) | 0;
      var along = (col / cols) * 0.82 + (row / rows) * 0.18;
      var local = Math.max(0, Math.min(1, progress * 1.28 - along * 0.28));
      return local <= 0 ? 0 : easeOutCubic(local);
    }

    /* Ignition is staggered by the same seeded score, so the clumps light in
       ragged order instead of sweeping like a second wave. */
    function lossHeat(i, progress) {
      if (progress <= 0) return 0;
      if (progress >= 1) return 1;
      var stagger = ((i * 2654435761) >>> 0) / 4294967296;
      return Math.max(0, Math.min(1, (progress - stagger * 0.55) / 0.45));
    }

    function paintFinal() {
      draw(1, 1);
    }

    /*
     * The theme switch repaints the field.
     *
     * Everything else on the page recolours through CSS custom properties;
     * a canvas cannot, so the switch calls this and the dots are redrawn in
     * the current theme's ink. Reading the colours off the computed style
     * rather than hard-coding a pair keeps this honest if the tokens move.
     */
    window.__dotfieldRepaint = function () {
      if (!started) return;
      if (frame) { cancelAnimationFrame(frame); frame = null; }
      paintFinal();
    };

    function tick(now) {
      var elapsed = now - startedAt;
      var arrive = Math.min(1, elapsed / ARRIVE);
      var ignite = Math.min(1, Math.max(0, (elapsed - ARRIVE - HOLD) / IGNITE));

      draw(easeOutCubic(arrive), ignite);

      if (ignite < 1) {
        frame = requestAnimationFrame(tick);
      } else {
        frame = null;
      }
    }

    function run() {
      if (started) return;
      started = true;
      if (reduced || document.documentElement.classList.contains("settled")) {
        paintFinal();
        return;
      }
      startedAt = performance.now();
      frame = requestAnimationFrame(tick);
    }

    /*
     * Pointing at the field.
     *
     * The readout says which order it is and which side of zero it fell on —
     * and stops there. It would be trivial to attach a plausible dollar
     * figure to every dot, and it would be the one thing this page cannot
     * do: those 3,071 amounts are not computed here, so inventing them to
     * make the interaction feel richer would be the exact move the section
     * spends four paragraphs refusing.
     */
    function indexAt(clientX, clientY) {
      var box = canvas.getBoundingClientRect();
      var x = ((clientX - box.left) / box.width) * logicalW;
      var y = ((clientY - box.top) / box.height) * logicalH;
      var col = Math.floor(x / cell);
      var row = Math.floor(y / cell);
      if (col < 0 || col >= cols || row < 0 || row >= rows) return -1;
      var i = row * cols + col;
      if (i < 0 || i >= TOTAL) return -1;
      // Only register inside the dot itself, not the whitespace around it.
      var cx = (col + 0.5) * cell;
      var cy = (row + 0.5) * cell;
      var reach = Math.max(cell * 0.42, 5);
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > reach * reach) return -1;
      return i;
    }

    function showReadout(i, clientX, clientY) {
      if (!readout) return;
      var box = canvas.getBoundingClientRect();
      var isThis = i === RECEIPT_INDEX;
      readout.textContent = isThis
        ? "Order #13254 — the receipt alongside"
        : "Order " + (i + 1).toLocaleString("en-US") + " of 3,071 · " +
          (isLoss[i] ? "lost money" : "profitable");
      readout.className = "dot-readout is-on" +
        (isThis ? " is-this" : isLoss[i] ? " is-loss" : "");
      readout.style.left = (clientX - box.left) + "px";
      readout.style.top = (clientY - box.top) + "px";
    }

    function hideReadout() {
      hoverIndex = -1;
      if (readout) readout.className = "dot-readout";
      if (started && !frame) paintFinal();
    }

    canvas.addEventListener("pointermove", function (e) {
      if (!started || frame) return;
      var i = indexAt(e.clientX, e.clientY);
      if (i === hoverIndex) {
        if (i >= 0) showReadout(i, e.clientX, e.clientY);
        return;
      }
      hoverIndex = i;
      if (i < 0) { hideReadout(); return; }
      showReadout(i, e.clientX, e.clientY);
      paintFinal();
    }, { passive: true });

    canvas.addEventListener("pointerleave", hideReadout, { passive: true });

    measure();
    paintFinal();
    // Wipe it back to empty so the arrival actually has somewhere to arrive
    // from; a field already painted has nothing to show.
    if (!reduced) ctx.clearRect(0, 0, logicalW, logicalH);

    onceVisible(canvas, run);

    var resizeTimer = null;
    addEventListener("resize", function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        measure();
        if (frame) { cancelAnimationFrame(frame); frame = null; }
        // Mid-flight the sweep would restart from a stale clock, so a resize
        // resolves to the finished field rather than replaying it.
        if (started) paintFinal();
      }, 160);
    }, { passive: true });

    settlers.push(function () {
      started = true;
      if (frame) { cancelAnimationFrame(frame); frame = null; }
      measure();
      paintFinal();
    });
  })();

  /* -------------------------------------------------------- ledger counts */

  /*
   * Every figure on this page is one the app computes, so the counters count
   * to the real value and stop — no rolling odometer past it, no overshoot
   * bounce. The element already contains its final text, so a reader without
   * JavaScript reads the number, not a zero.
   */
  (function counters() {
    var nodes = [].slice.call(document.querySelectorAll("strong[data-count]"));
    if (!nodes.length) return;

    function format(node, value) {
      var decimals = Number(node.getAttribute("data-decimals")) || 0;
      var prefix = node.getAttribute("data-prefix") || "";
      var suffix = node.getAttribute("data-suffix") || "";
      return prefix + value.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      }) + suffix;
    }

    nodes.forEach(function (node) {
      var target = Number(node.getAttribute("data-count"));
      if (!isFinite(target)) return;

      var final = format(node, target);
      node.textContent = final;

      function settle() { node.textContent = final; }
      settlers.push(settle);

      if (reduced) return;

      var ran = false;
      onceVisible(node, function () {
        if (ran || document.documentElement.classList.contains("settled")) { settle(); return; }
        ran = true;

        var DURATION = 1100;
        var begin = performance.now();

        (function step(now) {
          var t = Math.min(1, (now - begin) / DURATION);
          node.textContent = format(node, target * easeOutExpo(t));
          if (t < 1) {
            requestAnimationFrame(step);
          } else {
            settle();
          }
        })(begin);
      });
    });
  })();

  /* -------------------------------------------------------- billing toggle */

  /*
   * The thumb is sized and moved from the selected button's own box rather
   * than from a hard-coded width, because "Annual · 2 months free" is a good
   * deal wider than "Monthly" and both labels change width when the variable
   * font finishes loading.
   */
  (function billing() {
    var toggle = document.querySelector(".billing-toggle");
    if (!toggle) return;

    var thumb = toggle.querySelector(".toggle-thumb");
    var buttons = [].slice.call(toggle.querySelectorAll("button[data-period]"));
    if (!thumb || !buttons.length) return;

    var prices = [].slice.call(document.querySelectorAll(".plan-price"));
    var subs = [].slice.call(document.querySelectorAll(".plan-sub"));
    var period = "monthly";

    function placeThumb(animate) {
      var selected = buttons.filter(function (b) { return b.getAttribute("data-period") === period; })[0];
      if (!selected) return;

      var host = toggle.getBoundingClientRect();
      var box = selected.getBoundingClientRect();

      if (!animate) thumb.style.transition = "none";
      thumb.style.width = box.width + "px";
      thumb.style.transform = "translateX(" + (box.left - host.left - 4) + "px)";
      if (!animate) {
        // Read back to flush the suppressed transition before restoring it.
        void thumb.offsetWidth;
        thumb.style.transition = "";
      }
    }

    function apply(next, animate) {
      period = next;

      buttons.forEach(function (button) {
        var on = button.getAttribute("data-period") === period;
        button.classList.toggle("is-selected", on);
        button.setAttribute("aria-pressed", on ? "true" : "false");
      });

      prices.forEach(function (price) {
        var amount = price.getAttribute("data-" + period);
        var unit = price.getAttribute("data-" + period + "-unit");
        if (!amount) return;
        price.textContent = amount;
        if (unit) {
          var small = document.createElement("small");
          small.textContent = unit;
          price.appendChild(small);
        }
      });

      subs.forEach(function (sub) {
        var text = sub.getAttribute("data-" + period);
        if (text) sub.textContent = text;
      });

      placeThumb(animate);
    }

    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        apply(button.getAttribute("data-period"), !reduced);
      });
    });

    apply("monthly", false);
    toggle.classList.add("is-ready");

    addEventListener("resize", function () { placeThumb(false); }, { passive: true });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { placeThumb(false); });
    }

    settlers.push(function () { placeThumb(false); });
  })();

  /* Deterministic paint for capture tooling, mirroring the page's own hook. */
  window.__motionSettle = function () {
    for (var i = 0; i < settlers.length; i++) settlers[i]();
  };
})();
