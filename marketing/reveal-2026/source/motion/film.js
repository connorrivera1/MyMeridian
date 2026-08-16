/*
 * MyMeridian 60s reveal — deterministic timeline.
 *
 * The whole film is a pure function of time: window.SEEK(t) lays out every
 * pixel for that instant. No wall clock, no rAF, no transitions — a renderer
 * steps t and screenshots. Every plate is a real 3840×2160 capture of the
 * product; motion, dimming and spotlights are applied on top of those pixels,
 * never regenerated.
 *
 * Coordinates in the shot data are in the 2000×1125 inspection space used
 * while measuring the captures; D converts to the 1920×1080 stage.
 */
"use strict";

const D = 0.96;
const W = 1920, H = 1080;
const CX = 1000, CY = 562.5; // frame centre in measure space

/* ------------------------------------------------------------------ easing */
const EASE = {
  l: (p) => p,
  i: (p) => p * p * p,
  o: (p) => 1 - Math.pow(1 - p, 3),
  io: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  brand: (p) => 1 - Math.pow(1 - p, 4), // ≈ cubic-bezier(0.16,1,0.3,1)
};
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;

function kf(t, keys, field) {
  if (t <= keys[0].t) return keys[0][field];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last[field];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const p = (EASE[b.e || "io"])(seg(t, a.t, b.t));
      return lerp(a[field], b[field], p);
    }
  }
  return last[field];
}

/* ------------------------------------------------------------------- data */
const STILL = (n) => `/stills/${n}`;

const SHOTS = [
  { id: "ovw", plate: "app-overview-dark-1920x1080.png",
    vis: [6.55, 11.70],
    enter: { at: 6.55, dur: 0.55, type: "reveal" },     // under the splash push
    exit:  { at: 11.15, dur: 0.55, type: "push" },
    cam: [
      { t: 6.55, x: 1000, y: 480, z: 1.075, e: "o" },
      { t: 7.45, x: 1000, y: 562, z: 1.0,  e: "io" },
      { t: 9.15, x: 1000, y: 562, z: 1.0,  e: "io" },
      { t: 10.15, x: 770, y: 420, z: 1.30, e: "io" },
      { t: 11.70, x: 775, y: 423, z: 1.34, e: "l" },
    ],
    shade: [{ t: 6.55, v: 0 }],
    spots: [],
    ulines: [{ t: 10.45, R: [290, 258, 818, 261], hold: 1.0 }],
  },

  { id: "bridge", plate: "app-overview-money-bridge-dark-1920x1080.png",
    vis: [11.15, 15.55],
    enter: { at: 11.15, dur: 0.55, type: "push" },
    exit:  { at: 15.05, dur: 0.50, type: "push" },
    cam: [
      { t: 11.15, x: 640, y: 615, z: 1.32, e: "o" },
      { t: 13.95, x: 1500, y: 618, z: 1.32, e: "l" },
      { t: 15.55, x: 1128, y: 605, z: 1.10, e: "io" },
    ],
    shade: [{ t: 11.15, v: 0 }, { t: 11.85, v: 0.44 }, { t: 14.15, v: 0.44 }, { t: 14.75, v: 0 }],
    spots: [
      { t0: 11.80, t1: 12.40, R: [386, 513, 601, 762] },
      { t0: 12.20, t1: 12.80, R: [604, 513, 816, 762] },
      { t0: 12.58, t1: 13.15, R: [824, 590, 1037, 762] },
      { t0: 12.94, t1: 13.50, R: [1042, 602, 1256, 762] },
      { t0: 13.30, t1: 13.86, R: [1263, 607, 1476, 762] },
      { t0: 13.66, t1: 14.22, R: [1483, 613, 1695, 762] },
      { t0: 14.05, t1: 15.00, R: [1702, 634, 1915, 762], glow: true },
    ],
    ulines: [],
  },

  { id: "ppotop", plate: "app-orders-top-dark-1920x1080.png",
    vis: [15.05, 17.30],
    enter: { at: 15.05, dur: 0.50, type: "push" },
    exit:  { at: 16.95, dur: 0.35, type: "up" },        // scroll on into the field
    cam: [
      { t: 15.05, x: 1000, y: 480, z: 1.10, e: "o" },
      { t: 16.10, x: 1450, y: 470, z: 1.26, e: "io" },
      { t: 17.30, x: 1470, y: 478, z: 1.30, e: "l" },
    ],
    shade: [{ t: 15.05, v: 0 }, { t: 15.65, v: 0.34 }, { t: 16.75, v: 0.34 }, { t: 17.10, v: 0 }],
    spots: [{ t0: 15.60, t1: 17.05, R: [1548, 404, 1963, 585], glow: true }],
    ulines: [{ t: 16.20, R: [1673, 545, 1728, 547], hold: 0.7 }],
  },

  { id: "field", plate: "app-orders-field-dark-1920x1080.png",
    vis: [16.95, 19.75],
    enter: { at: 16.95, dur: 0.35, type: "up" },
    exit:  { at: 19.45, dur: 0.30, type: "fade" },      // match cut into the drawer
    cam: [
      { t: 16.95, x: 900, y: 430, z: 1.16, e: "o" },
      { t: 18.00, x: 1000, y: 560, z: 1.18, e: "io" },
      { t: 18.60, x: 1049, y: 690, z: 1.32, e: "io" },
      { t: 19.75, x: 1049, y: 700, z: 1.32, e: "l" },
    ],
    shade: [{ t: 16.95, v: 0 }, { t: 17.55, v: 0.30 }, { t: 18.90, v: 0.30 }, { t: 19.30, v: 0 }],
    spots: [{ t0: 17.35, t1: 18.45, R: [348, 874, 614, 910] }],
    ulines: [{ t: 17.70, R: [480, 902, 600, 904], hold: 0.8 }],
    rings: [
      { t: 17.30, c: [568, 133], r: 13, hold: 0.9, soft: true },
      { t: 17.50, c: [1204, 209], r: 13, hold: 0.9, soft: true },
      { t: 17.85, c: [1049, 825], r: 17, hold: 1.9, main: true },
    ],
  },

  { id: "drawer", plate: "app-orders-losing-order-13123-dark-1920x1080.png",
    vis: [19.45, 24.95],
    enter: { at: 19.45, dur: 0.30, type: "fade" },
    exit:  { at: 24.45, dur: 0.50, type: "push" },
    cam: [
      { t: 19.45, x: 1049, y: 700, z: 1.32, e: "io" },
      { t: 20.55, x: 1600, y: 430, z: 1.32, e: "io" },
      { t: 21.60, x: 1660, y: 520, z: 1.32, e: "io" },
      { t: 22.60, x: 1680, y: 700, z: 1.34, e: "io" },
      { t: 23.30, x: 1660, y: 880, z: 1.40, e: "io" },
      { t: 24.95, x: 1655, y: 885, z: 1.42, e: "l" },
    ],
    shade: [{ t: 19.75, v: 0 }, { t: 20.10, v: 0.36 }, { t: 24.10, v: 0.36 }, { t: 24.60, v: 0 }],
    spots: [
      { t0: 19.95, t1: 21.05, R: [1437, 20, 1975, 118] },
      { t0: 20.75, t1: 21.45, R: [1437, 438, 1970, 470] },
      { t0: 21.25, t1: 22.05, R: [1437, 391, 1970, 423] },
      { t0: 22.05, t1: 22.65, R: [1437, 542, 1970, 574] },
      { t0: 22.50, t1: 23.10, R: [1437, 671, 1970, 703] },
      { t0: 23.20, t1: 24.60, R: [1437, 865, 1970, 943], glow: true },
    ],
    ulines: [{ t: 21.55, R: [1888, 417, 1968, 419], hold: 0.7 }],
  },

  { id: "products", plate: "app-products-bleeding-dark-1920x1080.png",
    vis: [24.45, 29.35],
    enter: { at: 24.45, dur: 0.50, type: "push" },
    exit:  { at: 28.85, dur: 0.50, type: "push" },
    cam: [
      { t: 24.45, x: 1128, y: 125, z: 1.24, e: "o" },
      { t: 26.30, x: 1128, y: 165, z: 1.24, e: "io" },
      { t: 27.40, x: 1128, y: 515, z: 1.28, e: "io" },
      { t: 29.35, x: 1128, y: 528, z: 1.36, e: "l" },
    ],
    shade: [{ t: 24.45, v: 0 }, { t: 25.20, v: 0.38 }, { t: 28.35, v: 0.38 }, { t: 28.85, v: 0 }],
    spots: [
      { t0: 25.00, t1: 26.35, R: [318, 3, 1940, 140] },
      { t0: 26.80, t1: 28.75, R: [318, 486, 1940, 534] },
      { t0: 27.15, t1: 28.75, R: [318, 530, 1940, 578], glow: true },
    ],
    ulines: [],
  },

  { id: "acq", plate: "app-acquisition-channels-dark-1920x1080.png",
    vis: [28.85, 31.55],
    enter: { at: 28.85, dur: 0.50, type: "push" },
    exit:  { at: 31.05, dur: 0.45, type: "push" },
    cam: [
      { t: 28.85, x: 1128, y: 700, z: 1.14, e: "o" },
      { t: 31.55, x: 1128, y: 812, z: 1.18, e: "l" },
    ],
    shade: [{ t: 28.85, v: 0 }, { t: 29.50, v: 0.34 }, { t: 30.90, v: 0.34 }, { t: 31.30, v: 0 }],
    spots: [
      { t0: 29.45, t1: 31.05, R: [290, 696, 1968, 772] },
      { t0: 29.85, t1: 31.05, R: [290, 832, 1968, 908] },
      { t0: 30.25, t1: 31.05, R: [290, 900, 1968, 976], glow: true },
    ],
    ulines: [],
  },

  { id: "conn", plate: "app-settings-ad-connections-dark-1920x1080.png",
    vis: [31.05, 33.45],
    enter: { at: 31.05, dur: 0.45, type: "push" },
    exit:  { at: 32.95, dur: 0.50, type: "push" },
    cam: [
      { t: 31.05, x: 1128, y: 665, z: 1.22, e: "o" },
      { t: 33.45, x: 1128, y: 700, z: 1.26, e: "l" },
    ],
    shade: [{ t: 31.05, v: 0 }, { t: 31.65, v: 0.34 }, { t: 32.80, v: 0.34 }, { t: 33.20, v: 0 }],
    spots: [
      { t0: 31.60, t1: 33.00, R: [290, 592, 1968, 664] },
      { t0: 31.85, t1: 33.00, R: [290, 660, 1968, 733] },
      { t0: 32.10, t1: 33.00, R: [290, 729, 1968, 801] },
    ],
    ulines: [],
  },

  { id: "pricing", plate: "app-pricing-dark-1920x1080.png",
    vis: [32.95, 41.55],
    enter: { at: 32.95, dur: 0.50, type: "push" },
    exit:  { at: 41.05, dur: 0.50, type: "push" },
    cam: [
      { t: 32.95, x: 1128, y: 560, z: 1.02, e: "o" },
      { t: 34.55, x: 1128, y: 560, z: 1.02, e: "io" },
      { t: 34.95, x: 628, y: 353, z: 1.30, e: "io" },
      { t: 35.55, x: 1128, y: 353, z: 1.30, e: "io" },
      { t: 36.15, x: 1686, y: 353, z: 1.30, e: "io" },
      { t: 37.05, x: 1000, y: 870, z: 1.36, e: "io" },
      { t: 39.30, x: 1010, y: 872, z: 1.52, e: "l" },
      { t: 40.20, x: 1128, y: 800, z: 1.22, e: "io" },
      { t: 41.55, x: 1128, y: 795, z: 1.20, e: "l" },
    ],
    shade: [{ t: 32.95, v: 0 }, { t: 33.65, v: 0.40 }, { t: 40.00, v: 0.40 }, { t: 40.60, v: 0 }],
    spots: [
      { t0: 33.60, t1: 34.70, R: [287, 120, 585, 148] },
      { t0: 34.80, t1: 35.50, R: [289, 264, 848, 441] },
      { t0: 35.45, t1: 36.10, R: [846, 264, 1408, 441] },
      { t0: 36.05, t1: 36.75, R: [1406, 264, 1967, 441] },
      { t0: 37.10, t1: 40.10, R: [745, 838, 830, 900] },
      { t0: 37.55, t1: 40.10, R: [888, 832, 980, 905], glow: true },
      { t0: 38.20, t1: 40.10, R: [1286, 838, 1352, 900] },
      { t0: 38.70, t1: 40.10, R: [1552, 848, 1620, 896] },
      { t0: 39.05, t1: 40.10, R: [1355, 845, 1500, 900] },
    ],
    ulines: [{ t: 33.85, R: [289, 146, 583, 148], hold: 0.8 }],
  },

  { id: "fulf", plate: "app-fulfilment-dark-1920x1080.png",
    vis: [41.05, 48.15],
    enter: { at: 41.05, dur: 0.50, type: "push" },
    exit:  { at: 47.65, dur: 0.50, type: "push" },
    cam: [
      { t: 41.05, x: 500, y: 362, z: 1.20, e: "o" },
      { t: 43.05, x: 520, y: 365, z: 1.20, e: "io" },
      { t: 43.95, x: 1128, y: 690, z: 1.10, e: "io" },
      { t: 44.85, x: 1128, y: 800, z: 1.24, e: "io" },
      { t: 47.15, x: 1128, y: 802, z: 1.30, e: "l" },
      { t: 48.15, x: 1128, y: 800, z: 1.30, e: "l" },
    ],
    shade: [{ t: 41.05, v: 0 }, { t: 41.85, v: 0.36 }, { t: 47.00, v: 0.36 }, { t: 47.60, v: 0 }],
    spots: [
      { t0: 41.80, t1: 43.15, R: [304, 296, 672, 392], glow: true },
      { t0: 44.15, t1: 45.10, R: [288, 650, 1968, 750] },
      { t0: 44.75, t1: 46.55, R: [288, 750, 1968, 850], glow: true },
      { t0: 46.15, t1: 47.15, R: [288, 846, 1968, 946] },
    ],
    wipes: [{ t0: 41.60, t1: 42.75, R: [310, 396, 664, 434] }],
    ulines: [],
  },

  { id: "actions", plate: "app-overview-actions-dark-1920x1080.png",
    vis: [47.65, 54.45],
    enter: { at: 47.65, dur: 0.50, type: "push" },
    exit:  { at: 53.85, dur: 0.60, type: "recede" },
    cam: [
      { t: 47.65, x: 1128, y: 335, z: 1.10, e: "o" },
      { t: 49.20, x: 1128, y: 342, z: 1.24, e: "io" },
      { t: 50.05, x: 1128, y: 336, z: 1.30, e: "io" },
      { t: 52.55, x: 1128, y: 352, z: 1.34, e: "l" },
      { t: 53.30, x: 1000, y: 560, z: 1.02, e: "io" },
      { t: 54.45, x: 1000, y: 562, z: 1.0, e: "l" },
    ],
    shade: [{ t: 47.65, v: 0 }, { t: 48.40, v: 0.34 }, { t: 53.15, v: 0.34 }, { t: 53.60, v: 0 }],
    spots: [
      { t0: 48.35, t1: 49.25, R: [320, 90, 700, 175] },
      { t0: 49.30, t1: 50.75, R: [340, 296, 1915, 322] },
      { t0: 50.70, t1: 52.05, R: [340, 324, 1915, 350] },
      { t0: 52.00, t1: 53.30, R: [340, 352, 1915, 378] },
      { t0: 52.55, t1: 53.30, R: [1755, 388, 1832, 425], glow: true },
    ],
    ulines: [],
  },
];

/* Big centred lines on black. */
const TITLES = [
  { t0: 0.30, t1: 2.35, out: 2.05, line: "You know what you sold." },
  { t0: 2.65, t1: 4.70, out: 4.42, line: "But do you know what you kept?", em: "kept?" },
];

/* Lower-third product lines. */
const L3S = [
  { t0: 7.45, t1: 9.30, line: "Meet MyMeridian." },
  { t0: 9.40, t1: 10.95, line: "Profitability intelligence for Shopify." },
  { t0: 12.05, t1: 14.75, line: "See where every dollar goes." },
  { t0: 15.90, t1: 19.00, line: "Find the sales that cost you money." },
  { t0: 25.15, t1: 26.85, line: "Know what’s carrying your business." },
  { t0: 26.95, t1: 28.55, line: "And what’s bleeding it." },
  { t0: 29.60, t1: 32.70, line: "Know which channels actually pay." },
  { t0: 35.10, t1: 38.90, line: "Find opportunities hiding in your pricing." },
  { t0: 42.35, t1: 47.15, line: "See problems before your customers do." },
];

const CAPS = [
  { t0: 39.30, t1: 40.90, line: "A modelled recommendation from observed price history — not a guarantee." },
];

const TRIPLET = [
  { t: 49.30, line: "Know what happened." },
  { t: 50.70, line: "Know why." },
  { t: 52.00, line: "Know what to do next." },
];
const TRIPLET_OUT = 53.55;

/* Splash timing (film-time → splash-animation ms). */
const SPLASH_OPEN = { fade: [4.55, 4.80], map: [[4.70, 0], [6.30, 1210]], push: [6.30, 7.05] };
const SPLASH_CLOSE = { fade: [54.45, 54.75], map: [[54.55, 0], [56.45, 900]] };
const FINAL = { tag: 56.85, soon: 57.90, url: 58.35 };
const END_FADE = [59.35, 59.95];

const CHUNKS = [0, 2.35, 4.70, 7.05, 11.15, 15.05, 19.45, 24.45, 28.85, 32.95, 41.05, 47.65, 53.85, 60.00];

/* ------------------------------------------------------------ DOM assembly */
const rr = (R) => ({ x: R[0] * D, y: R[1] * D, w: (R[2] - R[0]) * D, h: (R[3] - R[1]) * D });
const shotsRoot = document.getElementById("shots");
const els = { shots: new Map() };

function makeLetters(target, text) {
  target.textContent = "";
  const letters = [];
  for (const ch of text) {
    const s = document.createElement("span");
    s.className = "letter";
    s.textContent = ch;
    if (ch === " ") s.innerHTML = "&nbsp;";
    target.appendChild(s);
    letters.push(s);
  }
  return letters;
}

function build() {
  for (const shot of SHOTS) {
    const root = document.createElement("div");
    root.className = "shot";
    root.id = `shot-${shot.id}`;
    const cam = document.createElement("div");
    cam.className = "cam";
    const plate = new Image();
    plate.className = "plate";
    plate.src = STILL(shot.plate);
    cam.appendChild(plate);
    const shade = document.createElement("div");
    shade.className = "shade";
    cam.appendChild(shade);

    const spotEls = (shot.spots || []).map((sp) => {
      const win = document.createElement("div");
      win.className = "spotwin";
      const r = rr(sp.R);
      Object.assign(win.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
      const img = new Image();
      img.src = STILL(shot.plate);
      img.style.left = -r.x + "px";
      img.style.top = -r.y + "px";
      win.appendChild(img);
      cam.appendChild(win);
      return win;
    });

    const wipeEls = (shot.wipes || []).map((wp) => {
      const win = document.createElement("div");
      win.className = "spotwin";
      win.style.boxShadow = "none";
      win.style.borderRadius = "4px";
      const r = rr(wp.R);
      Object.assign(win.style, { left: r.x + "px", top: r.y + "px", width: "0px", height: r.h + "px" });
      const img = new Image();
      img.src = STILL(shot.plate);
      img.style.left = -r.x + "px";
      img.style.top = -r.y + "px";
      win.appendChild(img);
      cam.appendChild(win);
      return win;
    });

    const ulineEls = (shot.ulines || []).map((ul) => {
      const el = document.createElement("div");
      el.className = "uline";
      const r = rr(ul.R);
      Object.assign(el.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px" });
      cam.appendChild(el);
      return el;
    });

    const ringEls = (shot.rings || []).map((rg) => {
      const el = document.createElement("div");
      el.className = "ring";
      const cx = rg.c[0] * D, cy = rg.c[1] * D, rad = rg.r * D;
      Object.assign(el.style, {
        left: cx - rad + "px", top: cy - rad + "px",
        width: rad * 2 + "px", height: rad * 2 + "px",
      });
      if (rg.soft) el.style.borderColor = "rgba(245,245,245,0.55)";
      cam.appendChild(el);
      return el;
    });

    root.appendChild(cam);
    shotsRoot.appendChild(root);
    els.shots.set(shot.id, { root, cam, plate, shade, spotEls, wipeEls, ulineEls, ringEls });
  }

  /* global overlay: titles, lower thirds, captions, triplet */
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:absolute;inset:0;z-index:50;pointer-events:none;";
  document.getElementById("root").appendChild(overlay);
  els.overlay = overlay;

  /* soft scrim that separates lower-left copy from busy UI underneath */
  const scrim = document.createElement("div");
  scrim.style.cssText = "position:absolute;left:0;bottom:0;width:1040px;height:420px;opacity:0;" +
    "background:radial-gradient(130% 140% at 6% 98%, rgba(0,0,0,0.78), rgba(0,0,0,0) 66%);";
  overlay.appendChild(scrim);
  els.scrim = scrim;

  els.titles = TITLES.map((tt) => {
    const card = document.createElement("div");
    card.className = "titlecard";
    const inner = document.createElement("div");
    inner.className = "inner";
    const line = document.createElement("div");
    line.className = "tline";
    inner.appendChild(line);
    card.appendChild(inner);
    overlay.appendChild(card);
    const letters = makeLetters(line, tt.line);
    if (tt.em) {
      const start = tt.line.indexOf(tt.em);
      for (let i = start; i < start + tt.em.length; i++) letters[i].classList.add("em");
    }
    return { card, letters };
  });

  els.l3s = L3S.map((l3) => {
    const box = document.createElement("div");
    box.className = "l3";
    box.style.opacity = "0";
    const rule = document.createElement("div");
    rule.className = "rule";
    const line = document.createElement("div");
    line.className = "line";
    box.appendChild(rule);
    box.appendChild(line);
    overlay.appendChild(box);
    const letters = makeLetters(line, l3.line);
    return { box, rule, letters };
  });

  els.caps = CAPS.map((c) => {
    const el = document.createElement("div");
    el.className = "cap";
    el.textContent = c.line;
    overlay.appendChild(el);
    return el;
  });

  const tri = document.createElement("div");
  tri.className = "triplet";
  els.triplet = TRIPLET.map((tp) => {
    const el = document.createElement("div");
    el.className = "t3";
    tri.appendChild(el);
    return { el, letters: makeLetters(el, tp.line) };
  });
  overlay.appendChild(tri);

  /* splash — exact markup from site/index.html, dark theme */
  const splash = document.createElement("div");
  splash.className = "splash";
  splash.innerHTML = `
    <div class="splash-inner">
      <div class="splash-globe">
        <svg class="mark spinning" width="112" height="112" viewBox="0 0 96 96" fill="none" aria-hidden="true">
          <defs>
            <filter id="stage-splash-glow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="2.6" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <g stroke="currentColor" stroke-width="2" opacity="0.8" stroke-linecap="round">
            <circle cx="48" cy="48" r="34" />
            <ellipse class="meridian-a" cx="48" cy="48" rx="24.5" ry="34" />
            <ellipse class="meridian-b" cx="48" cy="48" rx="13.5" ry="34" />
            <ellipse class="meridian-c" cx="48" cy="48" rx="0" ry="34" />
            <path d="M48 14v68" />
          </g>
          <path d="M48 14 A 15 34 0 0 1 48 82" stroke="var(--gold)" stroke-width="2.5" stroke-linecap="round" filter="url(#stage-splash-glow)" />
        </svg>
      </div>
      <div class="splash-word" aria-hidden="true">
        <span>M</span><span>y</span><span>M</span><span>e</span><span>r</span><span>i</span><span>d</span><span>i</span><span>a</span><span>n</span>
      </div>
    </div>
    <div class="final-extra">
      <div class="final-tag"></div>
      <div class="final-soon">Coming soon</div>
      <div class="final-url">mymeridian.io</div>
    </div>`;
  document.getElementById("root").appendChild(splash);
  els.splash = splash;
  els.finalTag = splash.querySelector(".final-tag");
  els.finalSoon = splash.querySelector(".final-soon");
  els.finalUrl = splash.querySelector(".final-url");
  els.finalTagLetters = makeLetters(els.finalTag, "Know what you kept. Know what to fix.");
  els.splashAnims = null; // collected once fonts are ready

  els.grain = document.getElementById("grain").getContext("2d", { willReadFrequently: false });
  els.flash = document.getElementById("flash");
}

/* -------------------------------------------------------------- renderers */
function applyCamera(shot, t) {
  const s = els.shots.get(shot.id);
  const zx = kf(t, shot.cam, "z");
  let fx = kf(t, shot.cam, "x") * D;
  let fy = kf(t, shot.cam, "y") * D;
  const halfW = W / 2 / zx, halfH = H / 2 / zx;
  fx = Math.min(W - halfW, Math.max(halfW, fx));
  fy = Math.min(H - halfH, Math.max(halfH, fy));
  s.cam.style.transform = `translate(${W / 2 - fx * zx}px, ${H / 2 - fy * zx}px) scale(${zx})`;
}

function letterIn(letters, t, t0, stagger = 0.026, dur = 0.40) {
  letters.forEach((el, i) => {
    const p = clamp01((t - t0 - i * stagger) / dur);
    const e = EASE.brand(p);
    el.style.opacity = String(p === 0 ? 0 : Math.min(1, p * 1.4));
    el.style.transform = `translateY(${14 * (1 - e)}px)`;
    el.style.filter = p >= 1 ? "none" : `blur(${6 * (1 - e)}px)`;
  });
}

function blockOut(el, t, tOut, dur = 0.30) {
  const p = clamp01((t - tOut) / dur);
  if (p <= 0) return 1;
  el.style.transform = `translateY(${-10 * EASE.io(p)}px)`;
  el.style.filter = p >= 1 ? "none" : `blur(${5 * p}px)`;
  return 1 - p;
}

function grain(t) {
  const g = els.grain;
  const bucket = Math.floor(t * 24) % 8;
  let s = (bucket + 7) * 2654435761 >>> 0;
  const img = g.createImageData(480, 270);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    const v = (s & 0xff) < 22 ? (s >> 8) & 0x3f : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ SEEK */
function SEEK(t) {
  /* shots */
  for (const shot of SHOTS) {
    const s = els.shots.get(shot.id);
    const [v0, v1] = shot.vis;
    if (t < v0 - 0.05 || t > v1 + 0.05) {
      s.root.style.opacity = "0";
      s.root.style.visibility = "hidden";
      continue;
    }
    s.root.style.visibility = "visible";

    let opacity = 1, dx = 0, dy = 0, scale = 1, blur = 0;
    const en = shot.enter, ex = shot.exit;
    if (en && t < en.at + en.dur) {
      const p = EASE.o(seg(t, en.at, en.at + en.dur));
      opacity = p;
      if (en.type === "push") { dx = 44 * (1 - p); blur = 3 * (1 - p); }
      if (en.type === "up") { dy = 42 * (1 - p); blur = 2.5 * (1 - p); }
      if (en.type === "reveal") { scale = lerp(1.07, 1.0, p); blur = 5 * (1 - p); }
    }
    if (ex && t > ex.at) {
      const p = EASE.i(seg(t, ex.at, ex.at + ex.dur));
      opacity = Math.min(opacity, 1 - p);
      if (ex.type === "push") { dx = -44 * p; blur = Math.max(blur, 4 * p); }
      if (ex.type === "up") { dy = -42 * p; blur = Math.max(blur, 3 * p); }
      if (ex.type === "recede") { scale = lerp(1.0, 0.94, p); blur = Math.max(blur, 4 * p); }
    }
    s.root.style.opacity = String(opacity);
    s.root.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    s.root.style.filter = blur > 0.05 ? `blur(${blur}px)` : "none";

    applyCamera(shot, t);
    s.shade.style.opacity = String(kf(t, shot.shade.map((k) => ({ t: k.t, v: k.v })), "v"));

    (shot.spots || []).forEach((sp, i) => {
      const el = s.spotEls[i];
      const pin = EASE.brand(seg(t, sp.t0, sp.t0 + 0.28));
      const pout = seg(t, sp.t1 - 0.24, sp.t1);
      const o = pin * (1 - EASE.io(pout));
      el.style.opacity = String(o);
      el.style.transform = `scale(${lerp(0.988, 1, pin)})`;
      if (sp.glow) {
        const pulse = 0.22 + 0.20 * pin * (1 - pout);
        el.style.boxShadow = `0 0 0 1px rgba(245,245,245,${0.24 + 0.3 * pin * (1 - pout)}), 0 24px 70px rgba(0,0,0,0.55), 0 0 60px rgba(245,245,245,${pulse})`;
      }
    });

    (shot.wipes || []).forEach((wp, i) => {
      const el = s.wipeEls[i];
      const r = rr(wp.R);
      const p = EASE.brand(seg(t, wp.t0, wp.t1));
      const fade = 1 - EASE.io(seg(t, wp.t1 + 1.2, wp.t1 + 1.7));
      el.style.opacity = String((p > 0 ? 1 : 0) * fade);
      el.style.width = r.w * p + "px";
    });

    (shot.ulines || []).forEach((ul, i) => {
      const el = s.ulineEls[i];
      const p = EASE.brand(seg(t, ul.t, ul.t + 0.5));
      const fade = 1 - EASE.io(seg(t, ul.t + ul.hold + 0.5, ul.t + ul.hold + 0.9));
      el.style.opacity = String(Math.min(1, p * 2) * fade);
      el.style.transform = `scaleX(${p})`;
    });

    (shot.rings || []).forEach((rg, i) => {
      const el = s.ringEls[i];
      const p = EASE.brand(seg(t, rg.t, rg.t + 0.5));
      let fade = 1 - EASE.io(seg(t, rg.t + rg.hold, rg.t + rg.hold + 0.45));
      if (rg.main) fade = Math.max(fade, 0); // main ring simply holds until the cut
      const glowUp = rg.main ? EASE.io(seg(t, 19.15, 19.45)) : 0;
      el.style.opacity = String((rg.soft ? 0.75 : 0.95) * p * fade);
      el.style.transform = `scale(${lerp(1.6, 1, p)})`;
      if (rg.main) {
        el.style.boxShadow = `0 0 ${18 + 30 * glowUp}px rgba(245,245,245,${0.35 + 0.4 * glowUp}), inset 0 0 10px rgba(245,245,245,0.18)`;
      }
    });
  }

  /* titles on black */
  TITLES.forEach((tt, i) => {
    const { card, letters } = els.titles[i];
    if (t < tt.t0 - 0.02 || t > tt.t1 + 0.05) { card.style.opacity = "0"; return; }
    card.style.opacity = "1";
    letterIn(letters, t, tt.t0);
    const inner = card.firstChild;
    inner.style.transform = "";
    inner.style.filter = "";
    const rem = blockOut(inner, t, tt.out);
    card.style.opacity = String(rem);
    if (tt.em && t > tt.t0 + 0.9) {
      const p = EASE.io(seg(t, tt.t0 + 0.9, tt.t0 + 1.4));
      letters.forEach((el) => {
        if (!el.classList.contains("em")) el.style.opacity = String(Math.max(0, 1 - 0.34 * p));
      });
    }
  });

  /* lower thirds (and the scrim that rides under them + the triplet) */
  let scrimO = 0;
  L3S.forEach((l3) => {
    const on = EASE.io(seg(t, l3.t0, l3.t0 + 0.4)) * (1 - EASE.io(seg(t, l3.t1, l3.t1 + 0.3)));
    scrimO = Math.max(scrimO, on);
  });
  {
    const triOn = EASE.io(seg(t, TRIPLET[0].t, TRIPLET[0].t + 0.4)) *
      (1 - EASE.io(seg(t, TRIPLET_OUT, TRIPLET_OUT + 0.35)));
    scrimO = Math.max(scrimO, triOn);
  }
  els.scrim.style.opacity = String(scrimO * 0.92);

  L3S.forEach((l3, i) => {
    const { box, rule, letters } = els.l3s[i];
    if (t < l3.t0 - 0.02 || t > l3.t1 + 0.35) { box.style.opacity = "0"; return; }
    const pr = EASE.brand(seg(t, l3.t0, l3.t0 + 0.45));
    rule.style.transform = `scaleX(${pr})`;
    letterIn(letters, t, l3.t0 + 0.08, 0.022, 0.36);
    box.style.transform = "";
    box.style.filter = "";
    const rem = blockOut(box, t, l3.t1, 0.28);
    box.style.opacity = String(rem);
  });

  /* captions */
  CAPS.forEach((c, i) => {
    const el = els.caps[i];
    const o = EASE.io(seg(t, c.t0, c.t0 + 0.4)) * (1 - EASE.io(seg(t, c.t1 - 0.3, c.t1)));
    el.style.opacity = String(o);
  });

  /* triplet */
  TRIPLET.forEach((tp, i) => {
    const { el, letters } = els.triplet[i];
    if (t < tp.t - 0.02) { el.style.opacity = "0"; return; }
    el.style.opacity = "1";
    letterIn(letters, t, tp.t, 0.02, 0.34);
    const rem = 1 - EASE.io(seg(t, TRIPLET_OUT, TRIPLET_OUT + 0.35));
    el.style.opacity = String(rem);
    el.style.transform = `translateY(${-8 * EASE.io(seg(t, TRIPLET_OUT, TRIPLET_OUT + 0.35))}px)`;
  });

  /* splash */
  const sp = els.splash;
  let splashMs = null, splashOpacity = 0, splashScale = 1;
  if (t >= SPLASH_OPEN.fade[0] - 0.02 && t <= SPLASH_OPEN.push[1] + 0.02) {
    splashOpacity = EASE.io(seg(t, SPLASH_OPEN.fade[0], SPLASH_OPEN.fade[1]));
    const [m] = SPLASH_OPEN.map;
    const [m0, m1] = SPLASH_OPEN.map;
    splashMs = lerp(m0[1], m1[1], seg(t, m0[0], m1[0]));
    if (t > SPLASH_OPEN.push[0]) {
      const p = EASE.i(seg(t, SPLASH_OPEN.push[0], SPLASH_OPEN.push[1]));
      splashScale = lerp(1, 2.35, p);
      splashOpacity = Math.min(splashOpacity, 1 - p);
      splashMs = 1210; // hold the assembled lockup while pushing through
    }
    els.finalTag.parentElement.style.opacity = "0";
  } else if (t >= SPLASH_CLOSE.fade[0]) {
    splashOpacity = EASE.io(seg(t, SPLASH_CLOSE.fade[0], SPLASH_CLOSE.fade[1]));
    const [m0, m1] = SPLASH_CLOSE.map;
    splashMs = lerp(m0[1], m1[1], seg(t, m0[0], m1[0]));
    els.finalTag.parentElement.style.opacity = "1";
    /* final card content */
    letterIn(els.finalTagLetters, t, FINAL.tag, 0.016, 0.34);
    els.finalTag.style.opacity = t >= FINAL.tag ? "1" : "0";
    els.finalSoon.style.opacity = String(EASE.io(seg(t, FINAL.soon, FINAL.soon + 0.5)));
    els.finalUrl.style.opacity = String(EASE.io(seg(t, FINAL.url, FINAL.url + 0.5)));
  }
  sp.style.opacity = String(splashOpacity);
  sp.style.transform = splashScale === 1 ? "" : `scale(${splashScale})`;
  if (splashMs != null && els.splashAnims) {
    for (const a of els.splashAnims) a.currentTime = splashMs;
  }

  /* end fade */
  els.flash.style.opacity = String(EASE.io(seg(t, END_FADE[0], END_FADE[1])));

  grain(t);
  return "ok";
}

/* ------------------------------------------------------------------ boot */
build();

const plateImgs = Array.from(document.images);
Promise.all([
  document.fonts.ready,
  ...plateImgs.map((im) => im.decode().catch(() => null)),
]).then(() => {
  els.splashAnims = els.splash.getAnimations({ subtree: true });
  for (const a of els.splashAnims) a.pause();
  SEEK(0);
  window.__READY = true;
  window.__FONTS = {
    satoshi: document.fonts.check('560 16px Satoshi') || document.fonts.check('500 16px Satoshi'),
    jakarta: document.fonts.check('560 16px "Plus Jakarta Sans Variable"'),
  };
});

window.SEEK = SEEK;
window.FILM = { duration: 60, fps: 60, chunks: CHUNKS };
window.MARKERS = {
  titles: TITLES.map((x) => x.t0),
  l3s: L3S.map((x) => x.t0),
  cuts: SHOTS.map((s) => s.enter?.at ?? s.vis[0]),
  spots: SHOTS.flatMap((s) => (s.spots || []).map((x) => x.t0)),
  splashOpen: SPLASH_OPEN.map[0][0],
  splashPush: SPLASH_OPEN.push[0],
  splashClose: SPLASH_CLOSE.map[0][0],
  finalBeats: [FINAL.tag, FINAL.soon, FINAL.url],
  triplet: TRIPLET.map((x) => x.t),
  end: END_FADE[0],
};
