/*
 * The meridian globe — the brand mark at hero scale, turning as the page is
 * scrolled.
 *
 * Why the meridians are drawn as ellipses whose WIDTH changes, rather than as
 * a group spun with `rotateY`:
 *
 * A meridian is a great circle through the poles. Seen from outside the
 * sphere it projects to an ellipse whose vertical radius is always the
 * sphere's radius and whose horizontal radius is `R · |cos θ|`, where θ is the
 * angle between that meridian's plane and the viewing direction. At θ = 0 it
 * is a full circle; at θ = 90° it collapses to the vertical line down the
 * middle. Sweeping rx through that cosine is therefore not an approximation of
 * rotation — it is exactly what rotation looks like in projection.
 *
 * `rotateY` on a flat SVG cannot do this: the shape has no depth, so at 90° it
 * disappears into nothing and then reappears mirrored, which reads as a card
 * flipping rather than a sphere turning. The app's splash learned this the
 * same way and drives its opening spin from the same cosine.
 *
 * Scroll maps to rotation linearly: one full turn per TURNS_PER_PAGE of the
 * document. The value is damped rather than applied raw, so a flung scroll
 * arrives with weight instead of snapping.
 */
(function () {
  var svg = document.getElementById("globe");
  if (!svg) return;

  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var meridians = [].slice.call(svg.querySelectorAll("[data-longitude]"));
  if (!meridians.length) return;

  var R = Number(svg.getAttribute("data-radius")) || 170;
  var TURNS_PER_PAGE = 1.15;

  var target = 0;
  var current = 0;
  var frame = null;

  function draw(phase) {
    for (var i = 0; i < meridians.length; i++) {
      var el = meridians[i];
      var theta = Number(el.getAttribute("data-longitude")) * (Math.PI / 180);
      var cos = Math.cos(phase + theta);

      // A hairline floor: at rx exactly 0 some engines drop the ellipse
      // entirely, which flickers the line out for a frame at each pole
      // crossing instead of letting it pass through edge-on.
      el.setAttribute("rx", Math.max(0.35, Math.abs(cos) * R).toFixed(2));

      /*
       * Depth cue. |cos| is 1 when the meridian faces the viewer and 0 when it
       * is edge-on, so opacity tracking it makes the near meridians read as
       * nearer. Without it the wireframe is uniformly flat and stops reading
       * as a sphere at all — the single change that makes this look drawn
       * rather than generated.
       */
      var facing = Math.abs(cos);
      el.style.opacity = (0.16 + facing * 0.5).toFixed(3);
    }
  }

  function tick() {
    // Critically damped chase — the same easing the sun used, so the page keeps
    // one sense of weight now that the scene has changed.
    current += (target - current) * 0.085;
    draw(current);

    if (Math.abs(target - current) > 0.0005) {
      frame = requestAnimationFrame(tick);
    } else {
      current = target;
      draw(current);
      frame = null;
    }
  }

  function measure() {
    var scrollable = Math.max(
      1,
      document.documentElement.scrollHeight - innerHeight,
    );
    target = (window.scrollY / scrollable) * TURNS_PER_PAGE * Math.PI * 2;
  }

  function onScroll() {
    measure();
    if (reduced) {
      current = target;
      draw(current);
      return;
    }
    if (!frame) frame = requestAnimationFrame(tick);
  }

  measure();
  current = target;
  draw(current);

  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", function () {
    measure();
    current = target;
    draw(current);
  }, { passive: true });

  // Deterministic paint for capture tooling, mirroring the page's own hook.
  window.__globePaintOnce = function () {
    measure();
    current = target;
    draw(current);
  };
})();
