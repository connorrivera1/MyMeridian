/*
 * The sky.
 *
 * A raymarched volumetric twilight whose sun crosses the meridian as the page
 * is scrolled — the same scene the app wakes up on, so the marketing page and
 * the product are visibly one world.
 *
 * This replaced a set of CSS wireframe ellipses over a flat gradient. That
 * version was cheap to run and looked it: an empty navy field with three
 * dotted arcs on top, which is exactly what a background looks like when it
 * was described rather than lit. A sky is the first thing a visitor sees and
 * the only thing on screen that has to carry the brand on its own.
 *
 * Quality is measured, not assumed: the governor below samples frame times,
 * steps the render buffer down when it cannot hold 30fps, and at the floor
 * retires the canvas entirely so the painted CSS scene stands alone. That
 * fallback is a complete picture, not a blank — see .sky-fallback.
 *
 * `prefers-reduced-motion` parks the sun mid-arc and draws exactly one frame.
 */
(function () {
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var ptrX = 0, ptrY = 0, camX = 0, camY = 0;

  /* ------------------------------------------------------------ shader */
  var canvas = document.getElementById("sky");
  var gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });

  var VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

  /*
   * A raymarched volumetric cloudscape.
   *
   * The previous sky was a gradient with a sun pasted on it, and it read as
   * one — flat, and no amount of CSS on top of it was going to fix that. This
   * marches a ray per pixel through a real density field, so the clouds have
   * interiors: light scatters through the thin parts, the thick parts occlude,
   * and the horizon sits at an actual distance rather than being a colour stop.
   *
   * The camera answers to both scroll and pointer, which is what makes it a
   * space you are inside rather than a picture you are looking at.
   *
   * Cost is controlled by the two step counts. STEPS marches the view ray;
   * LIGHT_STEPS marches toward the sun from each sample to get self-shadowing.
   * Both are deliberately low, with the noise doing more work than the marcher
   * — this has to hold 60fps on an integrated GPU, and a cloudscape nobody can
   * scroll smoothly is worse than a gradient.
   */
  var FRAG = [
    "precision highp float;",
    "uniform vec2 uRes;",
    "uniform float uTime;",
    "uniform float uProg;",
    "uniform vec2 uPointer;",

    // --- value noise + fbm ------------------------------------------------
    "float hash(vec3 p){ p = fract(p*0.3183099+vec3(0.71,0.113,0.419)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }",
    "float noise(vec3 x){",
    "  vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);",
    "  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),",
    "                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),",
    "             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),",
    "                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);",
    "}",

    // Three octaves, not five. Each octave is eight hash evaluations, and at
    // the resolution this renders the top two contributed detail finer than a
    // pixel — they cost a third of the frame and could not be seen.
    "float fbm(vec3 p){",
    "  float v=0.0, a=0.5;",
    "  for(int i=0;i<3;i++){ v+=a*noise(p); p*=2.02; a*=0.5; }",
    "  return v;",
    "}",
    // The erosion detail needs even less; two octaves is enough to break an
    // edge up.
    "float fbm2(vec3 p){ return 0.5*noise(p) + 0.25*noise(p*2.03); }",

    /*
     * Density of the cloud slab.
     *
     * Confined between two heights so the marcher can skip everything outside
     * it, and eroded by a second, finer fbm — that erosion is what gives the
     * edges their wispiness instead of the cotton-wool look that a single
     * octave-stack always produces.
     */
    "float density(vec3 p){",
    "  float h = (p.y - 1.2) / 2.6;",
    "  if (h < 0.0 || h > 1.0) return 0.0;",
    "  vec3 q = p + vec3(uTime*0.035, 0.0, uTime*0.012);",
    "  float base = fbm(q*0.55);",
    "  base = base - 0.44;",
    "  base -= 0.16*fbm2(q*2.3);",
    "  float shape = smoothstep(0.0,0.28,h) * smoothstep(1.0,0.55,h);",
    "  return clamp(base,0.0,1.0) * shape * 1.5;",
    "}",

    "void main(){",
    "  vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / uRes.y;",

    // Camera. Scroll lifts it and tilts the horizon; the pointer yaws it.
    "  float pr = clamp(uProg,0.0,1.0);",
    "  vec3 ro = vec3(0.0, 0.55 + pr*0.55, uTime*0.06);",
    "  float yaw = uPointer.x*0.10;",
    "  float pitch = -0.06 + uPointer.y*0.05 + pr*0.16;",
    "  vec3 rd = normalize(vec3(uv.x, uv.y + pitch, 1.25));",
    "  float cy = cos(yaw), sy = sin(yaw);",
    "  rd = vec3(rd.x*cy - rd.z*sy, rd.y, rd.x*sy + rd.z*cy);",

    // Sun climbs toward its meridian as the page is scrolled.
    "  vec3 sunDir = normalize(vec3(0.36, -0.06 + pr*0.42, 1.0));",
    "  float sunAmt = max(dot(rd, sunDir), 0.0);",

    // --- sky gradient behind the clouds ----------------------------------
    "  float horizon = smoothstep(-0.18, 0.42, rd.y);",
    "  vec3 zenith = vec3(0.035,0.048,0.115);",
    "  vec3 mid    = vec3(0.105,0.128,0.250);",
    "  vec3 low    = vec3(0.315,0.238,0.272);",
    "  vec3 ember  = vec3(0.560,0.350,0.245);",
    "  vec3 sky = mix(ember, low, smoothstep(0.0,0.10,rd.y));",
    "  sky = mix(sky, mid, smoothstep(0.05,0.34,rd.y));",
    "  sky = mix(sky, zenith, smoothstep(0.28,0.85,rd.y));",

    // Sun disc and its atmospheric bloom.
    "  sky += vec3(1.0,0.74,0.46) * pow(sunAmt, 220.0) * 2.2;",
    "  sky += vec3(1.0,0.62,0.36) * pow(sunAmt, 12.0) * 0.10 * (0.35+0.65*pr);",

    // --- march the slab ---------------------------------------------------
    "  vec3 col = sky;",
    "  if (rd.y > -0.02) {",
    "    float t = (1.2 - ro.y) / max(rd.y, 0.02);",
    "    t = max(t, 0.0);",
    "    float trans = 1.0;",
    "    vec3 scattered = vec3(0.0);",
    // Eighteen steps with a longer stride and a faster ramp. The slab is thin
    // and the noise is soft, so the marcher was oversampling it.
    "    const int STEPS = 18;",
    "    float stepLen = 0.28;",
    "    for (int i = 0; i < STEPS; i++) {",
    "      if (trans < 0.02) break;",
    "      vec3 pos = ro + rd * t;",
    "      if (pos.y > 3.9) break;",
    "      float d = density(pos);",
    "      if (d > 0.001) {",
    // Self-shadowing: march a short way toward the sun and accumulate what
    // the sample sits behind.
    "        float shadow = 0.0;",
    // Two shadow taps at a wider spacing. Self-shadowing needs to know roughly
    // how much cloud is between this sample and the sun, not precisely.
    "        const int LIGHT_STEPS = 2;",
    "        for (int j = 1; j <= LIGHT_STEPS; j++) {",
    "          shadow += density(pos + sunDir * (float(j)*0.42));",
    "        }",
    "        float light = exp(-shadow*1.05);",
    // Warm where lit, cool indigo in shadow — the two-colour split is what
    // reads as sunset rather than as grey cloud tinted orange.
    "        vec3 lit  = mix(vec3(0.16,0.175,0.28), vec3(0.86,0.66,0.46), light);",
    "        lit += vec3(1.0,0.58,0.30) * pow(sunAmt,10.0) * light * 0.30;",
    "        float absorb = d * stepLen * 1.9;",
    "        scattered += lit * absorb * trans;",
    "        trans *= exp(-absorb*1.35);",
    "      }",
    "      t += stepLen * (1.0 + float(i)*0.09);",
    "    }",
    "    col = col * trans + scattered;",
    "  }",

    /*
     * Ground haze, closing the bottom of the frame.
     *
     * This used to fade to `ember*0.42` — a mid-lightness, low-saturation
     * brown, which is the definition of mud, and it filled the entire lower
     * half of the hero because the camera looks slightly down. It was the
     * single biggest reason the page read as heavy.
     *
     * It now fades to the page's own reading surface (--ground), so the sky
     * does not just stop being brown: it lands on the colour the content
     * below stands on, and the hero and the first section become one
     * continuous surface instead of two.
     */
    "  col = mix(col, vec3(0.063,0.078,0.165), smoothstep(0.0,-0.20,rd.y));",

    // Vignette + grain. The grain matters: a clean gradient bands on 8-bit
    // displays and banding is the thing that makes a sky look computed.
    // Reinhard with a slight shoulder, then a gentle lift of the darks. This
    // is what keeps the sun reading as a bright *object* rather than as a hole
    // burned through the frame.
    "  col *= 0.92;",
    "  col = col / (col + vec3(0.72));",
    "  col = pow(col, vec3(0.92));",
    "  col *= 1.0 - 0.26*dot(uv,uv);",
    "  col += (hash(vec3(gl_FragCoord.xy, uTime))-0.5)*0.022;",

    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  var program = null, uRes, uTime, uProg, uPointer;
  // Camera yaw/pitch target, chased rather than snapped so the horizon glides.
  var ptrX = 0, ptrY = 0, camX = 0, camY = 0;

  function makeShader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
    return s;
  }

  if (gl) {
    var vs = makeShader(gl.VERTEX_SHADER, VERT);
    var fs = makeShader(gl.FRAGMENT_SHADER, FRAG);
    if (vs && fs) {
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) program = null;
    }
  }

  if (program) {
    gl.useProgram(program);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    uRes = gl.getUniformLocation(program, "uRes");
    uTime = gl.getUniformLocation(program, "uTime");
    uProg = gl.getUniformLocation(program, "uProg");
    uPointer = gl.getUniformLocation(program, "uPointer");
  } else {
    canvas.style.display = "none";
  }

  /*
   * Render scale, and the governor that owns it.
   *
   * This is a per-pixel raymarch, so cost is linear in buffer area and nothing
   * else moves the needle as much. The original ran at devicePixelRatio 1.5 —
   * 3 megapixels of volumetric marching per frame, which no GPU was ever going
   * to hold. It renders small and is stretched by CSS; the scene is soft enough
   * that the difference is invisible, and banding is already handled by the
   * grain in the shader.
   *
   * Because I cannot test this on every machine, the quality is not a guess: it
   * measures itself. If frames are consistently slow it steps the buffer down,
   * and if it is still slow at the floor it gives up entirely and reveals the
   * painted CSS scene, which is complete on its own.
   */
  var SCALES = [0.42, 0.3, 0.22];
  var scaleIndex = 0;

  function sizeCanvas() {
    if (!program) return;
    var scale = SCALES[scaleIndex];
    canvas.width = Math.max(1, Math.round(innerWidth * scale));
    canvas.height = Math.max(1, Math.round(innerHeight * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  sizeCanvas();

  // Frame-time sampling. Only long stretches count: a single slow frame is a
  // GC pause or a tab switch, not a verdict on the hardware.
  var slowFrames = 0, sampled = 0, lastFrameAt = 0;

  function governor(now) {
    if (lastFrameAt) {
      var dt = now - lastFrameAt;
      sampled++;
      if (dt > 34) slowFrames++;      // slower than ~30fps
      if (sampled === 45) {
        if (slowFrames > 22) {         // more than half the window was slow
          if (scaleIndex < SCALES.length - 1) {
            scaleIndex++;
            sizeCanvas();
          } else {
            // Out of headroom. Stop drawing and let the painted scene stand.
            canvas.style.display = "none";
            program = null;
            return false;
          }
        }
        sampled = 0;
        slowFrames = 0;
      }
    }
    lastFrameAt = now;
    return true;
  }

  /* --------------------------------------------- scroll-driven everything */
  var docH = 1, vh = innerHeight;

  function measure() {
    vh = innerHeight;
    docH = Math.max(1, document.documentElement.scrollHeight - vh);
  }
  measure();

  var progress = 0, target = 0, start = performance.now();
  var lastTick = 0;

  function frame(now) {
    lastTick = now;
    var sy = window.scrollY;
    // Under reduced motion the sun holds at a fixed point in its arc rather
    // than tracking the scroll.
    if (!reduced) {
      target = sy / docH;
      // critically damped chase so the sun glides rather than jitters
      progress += (target - progress) * 0.075;
    }

    if (program && !governor(now)) {
      // Shader retired; the CSS scene is the sky from here.
      return;
    }

    if (program) {
      // Ease the camera toward the pointer; an instantly-tracking camera reads
      // as a mouse-look toy rather than as weight.
      camX += (ptrX - camX) * 0.045;
      camY += (ptrY - camY) * 0.045;
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, reduced ? 40.0 : (now - start) / 1000);
      gl.uniform1f(uProg, progress);
      gl.uniform2f(uPointer, camX, camY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // The frames used to rotate on the X axis as they entered the viewport
    // and the hero card drifted against the scroll. Both were motion applied
    // to things that are meant to be read; the reveal fade does the arrival
    // and nothing keeps moving after it.


    // The cloudscape evolves on its own clock, so frames continue even with
    // no scroll and no pointer — unlike the old static gradient.
    if (!reduced) requestAnimationFrame(frame);
  }

  // One synchronous frame no matter what: throttled or occluded contexts may
  // never grant a rAF, and an undrawn canvas would sit black over the scene.
  // frame() schedules its own next frame, so this also starts the loop.
  if (reduced) progress = target = 0.35;
  frame(performance.now());

  // Where rAF is throttled to nothing (occluded windows, aggressive battery
  // savers), scrolling still repaints: drive frames from the event instead.
  // No scroll-driven frame here. It existed as a fallback for contexts that
  // throttle rAF to nothing, but while the loop is alive it only adds work
  // during the exact frames that are already the busiest — which is what makes
  // scrolling feel like it is catching.
  addEventListener("scroll", function () {
    if (!program && !reduced) frame(performance.now());
  }, { passive: true });

  // Deterministic settle for capture tooling: jump the damped chase to its
  // target and paint one frame.
  /*
   * Paint one deterministic frame. Named for this module alone: an earlier
   * version assigned window.__skySettle, which the page also defines, and
   * whichever script ran last silently won. The page's hook owns settling and
   * calls this.
   */
  window.__skyPaintOnce = function () {
    measure();
    target = window.scrollY / docH;
    progress = target;
    // IntersectionObserver can stall entirely in occluded windows — reveal
    // everything so a capture never freezes a section at opacity 0.
    frame(performance.now());
  };

  if (!reduced && matchMedia("(hover: hover) and (pointer: fine)").matches) {
    addEventListener("pointermove", function (e) {
      ptrX = (e.clientX / innerWidth) * 2 - 1;
      ptrY = (e.clientY / innerHeight) * 2 - 1;
    }, { passive: true });
  }

  addEventListener("resize", function () { sizeCanvas(); measure(); }, { passive: true });
  addEventListener("load", measure);})();
