/*
 * MyMeridian 60s reveal — v3 "After close".
 *
 * Apple-ad structure: the merchant's physical world (graded Pexels b-roll,
 * hands and spaces only) intercut with the real product UI, hard cuts on
 * foley transients, a synthetic VO carrying the copy, and the exact splash
 * opening and closing the film. Still a pure function of time: SEEK(t).
 *
 * UI plate coordinates are in the 2000-wide measure space (×0.96 → stage).
 * Footage is pre-graded 30fps JPEG sequences under /seq/<tag>/.
 */
"use strict";

const D = 0.96;
const W = 1920, H = 1080;

/* ------------------------------------------------------------------ easing */
const EASE = {
  l: (p) => p,
  i: (p) => p * p * p,
  o: (p) => 1 - Math.pow(1 - p, 3),
  io: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  brand: (p) => 1 - Math.pow(1 - p, 4),
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
    if (t >= a.t && t <= b.t) return lerp(a[field], b[field], (EASE[b.e || "io"])(seg(t, a.t, b.t)));
  }
  return last[field];
}

/* --------------------------------------------------- corner-pin homography */
/* Maps the unit square to quad [[x0,y0]..[x3,y3]] (TL,TR,BR,BL) as matrix3d. */
function pinMatrix(w, h, q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - sy * dx2) / den;
  const hh = (dx1 * sy - dy1 * sx) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  // normalize from unit square to plate w×h
  return `matrix3d(${a / w},${d / w},0,${g / w},${b / h},${e / h},0,${hh / h},0,0,1,0,${c},${f},0,1)`;
}

/* ------------------------------------------------------------------- data */
const STILL = (n) => `/stills/${n}`;
const SEQ = (tag, i) => `/seq/${tag}/f-${String(i + 1).padStart(4, "0")}.jpg`;
const SEQ_LEN = { tape: 42, label: 42, scan: 42, silh: 48, typewarm: 48, aisle: 84,
  convey: 54, packdesk: 48, lockdeskA: 102, lockdeskB: 48, topdown: 48 };

const SCREEN_QUAD = [[633, 350], [1281, 352], [1283, 722], [634, 719]]; // lockdesk laptop

/* Footage shots: hard cuts, gentle punch-in, 30fps sequences. */
const FOOTAGE = [
  { id: "f-tape",    tag: "tape",     t0: 0.00, t1: 0.70, off: 0.15, punch: [1.02, 1.07] },
  { id: "f-label",   tag: "label",    t0: 0.70, t1: 1.40, off: 0.20, punch: [1.03, 1.08] },
  { id: "f-scan",    tag: "scan",     t0: 1.40, t1: 2.15, off: 0.25, punch: [1.02, 1.08] },
  { id: "f-silh",    tag: "silh",     t0: 4.30, t1: 4.95, off: 0.10, punch: [1.00, 1.03] },
  { id: "f-type",    tag: "typewarm", t0: 14.60, t1: 15.30, off: 0.25, punch: [1.01, 1.05] },
  { id: "f-pack",    tag: "packdesk", t0: 21.40, t1: 22.10, off: 0.20, punch: [1.02, 1.06] },
  { id: "f-topdown", tag: "topdown",  t0: 28.70, t1: 29.40, off: 0.20, punch: [1.01, 1.05] },
  { id: "f-convey",  tag: "convey",   t0: 35.40, t1: 36.45, off: 0.15, punch: [1.02, 1.06] },
  { id: "f-aisle",   tag: "aisle",    t0: 36.45, t1: 37.20, off: 0.60, punch: [1.01, 1.06] },
  { id: "f-deviceA", tag: "lockdeskA", t0: 9.60, t1: 10.90, off: 0.30, punch: [1.00, 1.035],
    pin: { still: "app-overview-dark-1920x1080.png", bright: 1.18, glow: 0.10 } },
  { id: "f-deviceB", tag: "lockdeskB", t0: 49.80, t1: 51.10, off: 0.15, punch: [1.00, 1.025],
    pin: { still: "app-overview-dark-1920x1080.png", bright: 0.55, glow: 0.04 } },
];

/* UI shots — same plates/coordinates as v2, retimed and tightened. */
const SHOTS = [
  { id: "ovw", plate: "app-overview-dark-1920x1080.png",
    vis: [6.70, 9.60],
    enter: { at: 6.70, dur: 0.55, type: "reveal" },
    exit:  { at: 9.55, dur: 0.05, type: "cut" },
    cam: [
      { t: 6.70, x: 1000, y: 480, z: 1.075, e: "o" },
      { t: 7.55, x: 1000, y: 562, z: 1.0, e: "io" },
      { t: 8.75, x: 1000, y: 562, z: 1.0, e: "io" },
      { t: 9.60, x: 770, y: 430, z: 1.22, e: "l" },
    ],
    shade: [{ t: 6.70, v: 0 }], spots: [], ulines: [],
  },
  { id: "bridge", plate: "app-overview-money-bridge-dark-1920x1080.png",
    vis: [10.90, 14.60],
    enter: { at: 10.90, dur: 0.05, type: "cut" },
    exit:  { at: 14.55, dur: 0.05, type: "cut" },
    cam: [
      { t: 10.90, x: 640, y: 615, z: 1.32, e: "o" },
      { t: 13.30, x: 1500, y: 618, z: 1.32, e: "l" },
      { t: 14.60, x: 1128, y: 605, z: 1.12, e: "io" },
    ],
    shade: [{ t: 10.90, v: 0 }, { t: 11.20, v: 0.44 }, { t: 13.90, v: 0.44 }, { t: 14.45, v: 0 }],
    spots: [
      { t0: 11.15, t1: 11.70, R: [386, 513, 601, 762] },
      { t0: 11.55, t1: 12.10, R: [604, 513, 816, 762] },
      { t0: 11.90, t1: 12.42, R: [824, 590, 1037, 762] },
      { t0: 12.22, t1: 12.74, R: [1042, 602, 1256, 762] },
      { t0: 12.54, t1: 13.06, R: [1263, 607, 1476, 762] },
      { t0: 12.86, t1: 13.38, R: [1483, 613, 1695, 762] },
      { t0: 13.25, t1: 14.35, R: [1702, 634, 1915, 762], glow: true },
    ],
    ulines: [],
  },
  { id: "ppotop", plate: "app-orders-top-dark-1920x1080.png",
    vis: [15.30, 17.10],
    enter: { at: 15.30, dur: 0.05, type: "cut" },
    exit:  { at: 16.95, dur: 0.35, type: "up" },
    cam: [
      { t: 15.30, x: 1000, y: 478, z: 1.12, e: "o" },
      { t: 16.20, x: 1450, y: 470, z: 1.27, e: "io" },
      { t: 17.10, x: 1468, y: 477, z: 1.30, e: "l" },
    ],
    shade: [{ t: 15.30, v: 0 }, { t: 15.70, v: 0.34 }, { t: 16.80, v: 0.34 }, { t: 17.10, v: 0 }],
    spots: [{ t0: 15.55, t1: 17.00, R: [1548, 404, 1963, 585], glow: true }],
    ulines: [{ t: 16.15, R: [1673, 545, 1728, 547], hold: 0.6 }],
  },
  { id: "field", plate: "app-orders-field-dark-1920x1080.png",
    vis: [16.95, 19.30],
    enter: { at: 16.95, dur: 0.35, type: "up" },
    exit:  { at: 19.00, dur: 0.30, type: "fade" },
    cam: [
      { t: 16.95, x: 900, y: 430, z: 1.16, e: "o" },
      { t: 17.90, x: 1000, y: 555, z: 1.18, e: "io" },
      { t: 18.45, x: 1049, y: 690, z: 1.32, e: "io" },
      { t: 19.30, x: 1049, y: 700, z: 1.32, e: "l" },
    ],
    shade: [{ t: 16.95, v: 0 }, { t: 17.50, v: 0.30 }, { t: 18.75, v: 0.30 }, { t: 19.05, v: 0 }],
    spots: [{ t0: 17.50, t1: 18.35, R: [348, 874, 614, 910] }],
    ulines: [{ t: 17.75, R: [480, 902, 600, 904], hold: 0.6 }],
    rings: [
      { t: 17.40, c: [568, 133], r: 13, hold: 0.8, soft: true },
      { t: 17.60, c: [1204, 209], r: 13, hold: 0.8, soft: true },
      { t: 17.85, c: [1049, 825], r: 17, hold: 1.15, main: true, glowAt: [18.70, 19.00] },
    ],
  },
  { id: "drawer", plate: "app-orders-losing-order-13123-dark-1920x1080.png",
    vis: [19.00, 21.40],
    enter: { at: 19.00, dur: 0.30, type: "fade" },
    exit:  { at: 21.35, dur: 0.05, type: "cut" },
    cam: [
      { t: 19.00, x: 1049, y: 700, z: 1.32, e: "io" },
      { t: 19.60, x: 1600, y: 430, z: 1.32, e: "io" },
      { t: 20.15, x: 1660, y: 530, z: 1.32, e: "io" },
      { t: 20.75, x: 1670, y: 720, z: 1.35, e: "io" },
      { t: 21.40, x: 1660, y: 885, z: 1.42, e: "io" },
    ],
    shade: [{ t: 19.25, v: 0 }, { t: 19.45, v: 0.36 }, { t: 21.10, v: 0.36 }, { t: 21.40, v: 0.1 }],
    spots: [
      { t0: 19.55, t1: 20.15, R: [1437, 438, 1970, 470] },
      { t0: 19.95, t1: 20.60, R: [1437, 391, 1970, 423] },
      { t0: 20.40, t1: 20.90, R: [1437, 542, 1970, 574] },
      { t0: 20.80, t1: 21.38, R: [1437, 865, 1970, 943], glow: true },
    ],
    ulines: [{ t: 20.15, R: [1888, 417, 1968, 419], hold: 0.5 }],
  },
  { id: "products", plate: "app-products-bleeding-dark-1920x1080.png",
    vis: [22.10, 25.60],
    enter: { at: 22.10, dur: 0.05, type: "cut" },
    exit:  { at: 25.55, dur: 0.05, type: "cut" },
    cam: [
      { t: 22.10, x: 1128, y: 125, z: 1.24, e: "o" },
      { t: 23.50, x: 1128, y: 165, z: 1.24, e: "io" },
      { t: 24.35, x: 1128, y: 515, z: 1.28, e: "io" },
      { t: 25.60, x: 1128, y: 528, z: 1.34, e: "l" },
    ],
    shade: [{ t: 22.10, v: 0 }, { t: 22.45, v: 0.38 }, { t: 25.20, v: 0.38 }, { t: 25.60, v: 0 }],
    spots: [
      { t0: 22.40, t1: 23.60, R: [318, 3, 1940, 140] },
      { t0: 24.45, t1: 25.50, R: [318, 486, 1940, 534] },
      { t0: 24.75, t1: 25.50, R: [318, 530, 1940, 578], glow: true },
    ],
    ulines: [],
  },
  { id: "acq", plate: "app-acquisition-channels-dark-1920x1080.png",
    vis: [25.60, 27.40],
    enter: { at: 25.60, dur: 0.05, type: "cut" },
    exit:  { at: 27.05, dur: 0.35, type: "push" },
    cam: [
      { t: 25.60, x: 1128, y: 705, z: 1.14, e: "o" },
      { t: 27.40, x: 1128, y: 800, z: 1.18, e: "l" },
    ],
    shade: [{ t: 25.60, v: 0 }, { t: 25.95, v: 0.34 }, { t: 27.10, v: 0.34 }, { t: 27.40, v: 0 }],
    spots: [
      { t0: 25.95, t1: 27.30, R: [290, 696, 1968, 772] },
      { t0: 26.25, t1: 27.30, R: [290, 832, 1968, 908] },
      { t0: 26.55, t1: 27.30, R: [290, 900, 1968, 976], glow: true },
    ],
    ulines: [],
  },
  { id: "conn", plate: "app-settings-ad-connections-dark-1920x1080.png",
    vis: [27.05, 28.70],
    enter: { at: 27.05, dur: 0.35, type: "push" },
    exit:  { at: 28.65, dur: 0.05, type: "cut" },
    cam: [
      { t: 27.05, x: 1128, y: 665, z: 1.22, e: "o" },
      { t: 28.70, x: 1128, y: 700, z: 1.26, e: "l" },
    ],
    shade: [{ t: 27.05, v: 0 }, { t: 27.55, v: 0.34 }, { t: 28.45, v: 0.34 }, { t: 28.70, v: 0 }],
    spots: [
      { t0: 27.60, t1: 28.60, R: [290, 592, 1968, 664] },
      { t0: 27.85, t1: 28.60, R: [290, 660, 1968, 733] },
      { t0: 28.10, t1: 28.60, R: [290, 729, 1968, 801] },
    ],
    ulines: [],
  },
  { id: "pricing", plate: "app-pricing-dark-1920x1080.png",
    vis: [29.40, 35.40],
    enter: { at: 29.40, dur: 0.05, type: "cut" },
    exit:  { at: 35.35, dur: 0.05, type: "cut" },
    cam: [
      { t: 29.40, x: 1128, y: 560, z: 1.03, e: "o" },
      { t: 30.30, x: 1128, y: 560, z: 1.03, e: "io" },
      { t: 30.70, x: 628, y: 353, z: 1.30, e: "io" },
      { t: 31.25, x: 1128, y: 353, z: 1.30, e: "io" },
      { t: 31.80, x: 1686, y: 353, z: 1.30, e: "io" },
      { t: 32.50, x: 1000, y: 870, z: 1.36, e: "io" },
      { t: 34.30, x: 1010, y: 872, z: 1.50, e: "l" },
      { t: 35.00, x: 1128, y: 800, z: 1.22, e: "io" },
      { t: 35.40, x: 1128, y: 795, z: 1.20, e: "l" },
    ],
    shade: [{ t: 29.40, v: 0 }, { t: 29.75, v: 0.40 }, { t: 34.80, v: 0.40 }, { t: 35.30, v: 0 }],
    spots: [
      { t0: 29.65, t1: 30.60, R: [287, 120, 585, 148] },
      { t0: 30.75, t1: 31.30, R: [289, 264, 848, 441] },
      { t0: 31.30, t1: 31.85, R: [846, 264, 1408, 441] },
      { t0: 31.85, t1: 32.45, R: [1406, 264, 1967, 441] },
      { t0: 32.60, t1: 34.90, R: [745, 838, 830, 900] },
      { t0: 32.95, t1: 34.90, R: [888, 832, 980, 905], glow: true },
      { t0: 33.35, t1: 34.90, R: [1286, 838, 1352, 900] },
      { t0: 33.70, t1: 34.90, R: [1552, 848, 1620, 896] },
      { t0: 34.00, t1: 34.90, R: [1355, 845, 1500, 900] },
    ],
    ulines: [{ t: 29.90, R: [289, 146, 583, 148], hold: 0.6 }],
  },
  { id: "fulf", plate: "app-fulfilment-dark-1920x1080.png",
    vis: [37.20, 42.60],
    enter: { at: 37.20, dur: 0.05, type: "cut" },
    exit:  { at: 42.55, dur: 0.05, type: "cut" },
    cam: [
      { t: 37.20, x: 500, y: 362, z: 1.20, e: "o" },
      { t: 38.90, x: 520, y: 365, z: 1.20, e: "io" },
      { t: 39.55, x: 1128, y: 690, z: 1.10, e: "io" },
      { t: 40.30, x: 1128, y: 800, z: 1.24, e: "io" },
      { t: 42.60, x: 1128, y: 802, z: 1.30, e: "l" },
    ],
    shade: [{ t: 37.20, v: 0 }, { t: 37.70, v: 0.36 }, { t: 42.30, v: 0.36 }, { t: 42.60, v: 0.05 }],
    spots: [
      { t0: 37.65, t1: 38.90, R: [304, 296, 672, 392], glow: true },
      { t0: 40.35, t1: 41.15, R: [288, 650, 1968, 750] },
      { t0: 40.95, t1: 42.20, R: [288, 750, 1968, 850], glow: true },
      { t0: 41.90, t1: 42.50, R: [288, 846, 1968, 946] },
    ],
    wipes: [{ t0: 37.50, t1: 38.50, R: [310, 396, 664, 434] }],
    ulines: [],
  },
  { id: "actions", plate: "app-overview-actions-dark-1920x1080.png",
    vis: [42.60, 49.80],
    enter: { at: 42.60, dur: 0.05, type: "cut" },
    exit:  { at: 49.75, dur: 0.05, type: "cut" },
    cam: [
      { t: 42.60, x: 1128, y: 335, z: 1.10, e: "o" },
      { t: 43.30, x: 1128, y: 342, z: 1.24, e: "io" },
      { t: 44.10, x: 1128, y: 336, z: 1.30, e: "io" },
      { t: 46.90, x: 1128, y: 352, z: 1.34, e: "l" },
      { t: 48.55, x: 1000, y: 560, z: 1.02, e: "io" },
      { t: 49.80, x: 1000, y: 562, z: 1.0, e: "l" },
    ],
    shade: [{ t: 42.60, v: 0 }, { t: 43.00, v: 0.34 }, { t: 48.30, v: 0.34 }, { t: 48.65, v: 0 }],
    spots: [
      { t0: 42.85, t1: 43.35, R: [320, 90, 700, 175] },
      { t0: 43.35, t1: 44.70, R: [340, 296, 1915, 322] },
      { t0: 44.66, t1: 46.10, R: [340, 324, 1915, 350] },
      { t0: 46.13, t1: 47.60, R: [340, 352, 1915, 378] },
      { t0: 46.90, t1: 47.60, R: [1755, 388, 1832, 425], glow: true },
    ],
    ulines: [],
  },
];

const TITLES = [
  { t0: 0.45, t1: 2.15, out: 1.95, line: "You know what you sold.", small: true },
  { t0: 2.45, t1: 4.62, out: 4.35, line: "But do you know what you kept?", em: "kept?" },
];

const L3S = [
  { t0: 11.65, t1: 14.15, line: "See where every dollar goes." },
  { t0: 15.70, t1: 18.80, line: "Find the sales that cost you money." },
  { t0: 38.10, t1: 42.10, line: "See problems before your customers do." },
];

const CAPS = [
  { t0: 33.90, t1: 35.20, line: "A modelled recommendation from observed price history — not a guarantee." },
];

const TRIPLET = [
  { t: 43.30, line: "Know what happened." },
  { t: 44.66, line: "Know why." },
  { t: 46.13, line: "Know what to do next." },
];
const TRIPLET_OUT = 48.40;

const SPLASH_OPEN = { fade: [4.90, 5.10], map: [[5.00, 0], [6.50, 1210]], push: [6.50, 7.20] };
const SPLASH_CLOSE = { fade: [52.40, 52.70], map: [[52.50, 0], [54.60, 1000]] };
const FINAL = { tag: 55.55, soon: 57.95, url: 58.45 };
const END_FADE = [59.35, 59.95];

const VO = [
  { t: 0.55, line: 0 }, { t: 2.55, line: 1 }, { t: 6.70, line: 2 }, { t: 7.90, line: 3 },
  { t: 11.60, line: 4 }, { t: 15.50, line: 5 }, { t: 22.00, line: 6 }, { t: 25.95, line: 7 },
  { t: 29.80, line: 8 }, { t: 38.10, line: 9 }, { t: 43.30, line: 10 }, { t: 55.30, line: 11 },
];

const CHUNKS = [0, 2.35, 4.90, 7.20, 10.90, 14.60, 17.10, 21.40, 25.60, 28.70, 35.40, 42.60, 49.80, 60.00];

/* ------------------------------------------------------------ DOM assembly */
const rr = (R) => ({ x: R[0] * D, y: R[1] * D, w: (R[2] - R[0]) * D, h: (R[3] - R[1]) * D });
const shotsRoot = document.getElementById("shots");
const els = { shots: new Map(), footage: new Map() };

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
  /* footage shots (below UI shots in z) */
  for (const f of FOOTAGE) {
    const root = document.createElement("div");
    root.className = "shot";
    root.id = `shot-${f.id}`;
    const cam = document.createElement("div");
    cam.className = "cam";
    const img = new Image();
    img.className = "plate";
    img.src = SEQ(f.tag, 0);
    cam.appendChild(img);

    let pinEls = null;
    if (f.pin) {
      const q = SCREEN_QUAD.map(([x, y]) => [x, y]); // already stage-true (measured at 1920)
      const under = document.createElement("div");
      under.style.cssText = "position:absolute;left:0;top:0;width:100px;height:100px;background:#050505;transform-origin:0 0;";
      // overscan the black quad 1.5% to swallow the original screen edge
      const cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
      const qBig = q.map(([x, y]) => [x + (x - cx) * 0.02, y + (y - cy) * 0.02]);
      under.style.transform = pinMatrix(100, 100, qBig);
      cam.appendChild(under);

      const ui = new Image();
      ui.src = STILL(f.pin.still);
      ui.style.cssText = `position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0;filter:brightness(${f.pin.bright}) blur(0.4px);`;
      ui.style.transform = pinMatrix(1920, 1080, q);
      cam.appendChild(ui);

      const glow = document.createElement("div");
      glow.style.cssText = `position:absolute;left:0;top:0;width:1920px;height:1080px;transform-origin:0 0;pointer-events:none;background:radial-gradient(58% 58% at 50% 46%, rgba(235,240,255,${f.pin.glow}), transparent 75%);`;
      glow.style.transform = pinMatrix(1920, 1080, q.map(([x, y]) => [x + (x - cx) * 0.35, y + (y - cy) * 0.35]));
      cam.appendChild(glow);
      pinEls = { under, ui, glow };
    }

    root.appendChild(cam);
    shotsRoot.appendChild(root);
    els.footage.set(f.id, { root, cam, img, pinEls, lastIdx: -1 });
  }

  /* UI shots (same structure as v2) */
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
      Object.assign(el.style, { left: cx - rad + "px", top: cy - rad + "px", width: rad * 2 + "px", height: rad * 2 + "px" });
      if (rg.soft) el.style.borderColor = "rgba(245,245,245,0.55)";
      cam.appendChild(el);
      return el;
    });

    root.appendChild(cam);
    shotsRoot.appendChild(root);
    els.shots.set(shot.id, { root, cam, plate, shade, spotEls, wipeEls, ulineEls, ringEls });
  }

  /* overlay */
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:absolute;inset:0;z-index:50;pointer-events:none;";
  document.getElementById("root").appendChild(overlay);
  els.overlay = overlay;

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
    if (tt.small) line.style.fontSize = "58px";
    line.style.textShadow = "0 4px 40px rgba(0,0,0,0.85)";
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

  /* splash — identical to v2 */
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
  els.splashAnims = null;

  els.grain = document.getElementById("grain").getContext("2d");
  els.flash = document.getElementById("flash");
}

/* -------------------------------------------------------------- helpers */
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
  /* footage */
  for (const f of FOOTAGE) {
    const s = els.footage.get(f.id);
    if (t < f.t0 || t >= f.t1 + 0.02) {
      s.root.style.opacity = "0";
      s.root.style.visibility = "hidden";
      continue;
    }
    s.root.style.visibility = "visible";
    s.root.style.opacity = "1";
    const local = t - f.t0 + f.off;
    const idx = Math.min(SEQ_LEN[f.tag] - 1, Math.max(0, Math.floor(local * 30)));
    if (idx !== s.lastIdx) { s.img.src = SEQ(f.tag, idx); s.lastIdx = idx; }
    const p = seg(t, f.t0, f.t1);
    const sc = lerp(f.punch[0], f.punch[1], p);
    s.cam.style.transform = `scale(${sc})`;
    s.cam.style.transformOrigin = "50% 50%";
  }

  /* UI shots */
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
      if (en.type === "cut") { opacity = t >= en.at ? 1 : 0; }
      else {
        opacity = p;
        if (en.type === "push") { dx = 44 * (1 - p); blur = 3 * (1 - p); }
        if (en.type === "up") { dy = 42 * (1 - p); blur = 2.5 * (1 - p); }
        if (en.type === "reveal") { scale = lerp(1.07, 1.0, p); blur = 5 * (1 - p); }
      }
    }
    if (ex && t > ex.at) {
      const p = EASE.i(seg(t, ex.at, ex.at + ex.dur));
      if (ex.type === "cut") { opacity = t >= ex.at + ex.dur ? 0 : opacity; }
      else {
        opacity = Math.min(opacity, 1 - p);
        if (ex.type === "push") { dx = -44 * p; blur = Math.max(blur, 4 * p); }
        if (ex.type === "up") { dy = -42 * p; blur = Math.max(blur, 3 * p); }
        if (ex.type === "recede") { scale = lerp(1.0, 0.94, p); blur = Math.max(blur, 4 * p); }
      }
    }
    s.root.style.opacity = String(opacity);
    s.root.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    s.root.style.filter = blur > 0.05 ? `blur(${blur}px)` : "none";

    applyCamera(shot, t);
    s.shade.style.opacity = String(kf(t, shot.shade, "v"));

    (shot.spots || []).forEach((sp, i) => {
      const el = s.spotEls[i];
      const pin = EASE.brand(seg(t, sp.t0, sp.t0 + 0.26));
      const pout = seg(t, sp.t1 - 0.22, sp.t1);
      el.style.opacity = String(pin * (1 - EASE.io(pout)));
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
      const fade = 1 - EASE.io(seg(t, rg.t + rg.hold, rg.t + rg.hold + 0.45));
      const glowUp = rg.glowAt ? EASE.io(seg(t, rg.glowAt[0], rg.glowAt[1])) : 0;
      el.style.opacity = String((rg.soft ? 0.75 : 0.95) * p * Math.max(fade, rg.main ? 1 : 0));
      el.style.transform = `scale(${lerp(1.6, 1, p)})`;
      if (rg.main) el.style.boxShadow = `0 0 ${18 + 30 * glowUp}px rgba(245,245,245,${0.35 + 0.4 * glowUp}), inset 0 0 10px rgba(245,245,245,0.18)`;
    });
  }

  /* titles */
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

  /* lower thirds + scrim */
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
    box.style.opacity = String(blockOut(box, t, l3.t1, 0.28));
  });

  CAPS.forEach((c, i) => {
    const el = els.caps[i];
    el.style.opacity = String(EASE.io(seg(t, c.t0, c.t0 + 0.4)) * (1 - EASE.io(seg(t, c.t1 - 0.3, c.t1))));
  });

  TRIPLET.forEach((tp, i) => {
    const { el, letters } = els.triplet[i];
    if (t < tp.t - 0.02) { el.style.opacity = "0"; return; }
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
    const [m0, m1] = SPLASH_OPEN.map;
    splashMs = lerp(m0[1], m1[1], seg(t, m0[0], m1[0]));
    if (t > SPLASH_OPEN.push[0]) {
      const p = EASE.i(seg(t, SPLASH_OPEN.push[0], SPLASH_OPEN.push[1]));
      splashScale = lerp(1, 2.35, p);
      splashOpacity = Math.min(splashOpacity, 1 - p);
      splashMs = 1210;
    }
    els.finalTag.parentElement.style.opacity = "0";
  } else if (t >= SPLASH_CLOSE.fade[0]) {
    splashOpacity = EASE.io(seg(t, SPLASH_CLOSE.fade[0], SPLASH_CLOSE.fade[1]));
    const [m0, m1] = SPLASH_CLOSE.map;
    splashMs = lerp(m0[1], m1[1], seg(t, m0[0], m1[0]));
    els.finalTag.parentElement.style.opacity = "1";
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

  els.flash.style.opacity = String(EASE.io(seg(t, END_FADE[0], END_FADE[1])));
  grain(t);
  return "ok";
}

/* ------------------------------------------------------------------ boot */
build();

const plateImgs = Array.from(document.images);
const seqPreload = [];
for (const f of FOOTAGE) {
  for (let i = 0; i < SEQ_LEN[f.tag]; i++) {
    const im = new Image();
    im.src = SEQ(f.tag, i);
    seqPreload.push(im);
  }
}
Promise.all([
  document.fonts.ready,
  ...plateImgs.map((im) => im.decode().catch(() => null)),
  ...seqPreload.map((im) => im.decode().catch(() => null)),
]).then(() => {
  els.splashAnims = els.splash.getAnimations({ subtree: true });
  for (const a of els.splashAnims) a.pause();
  SEEK(0);
  window.__READY = true;
  window.__FONTS = { satoshi: document.fonts.check('560 16px Satoshi') };
});

window.SEEK = SEEK;
window.FILM = { duration: 60, fps: 60, chunks: CHUNKS };
window.MARKERS = {
  version: 3,
  hook: { tapeRip: 0.10, labelPress: 0.82, scanBeep: 1.62, blackSmash: 2.17, keptHit: 3.55 },
  footageCuts: FOOTAGE.map((f) => f.t0),
  uiCuts: [10.90, 15.30, 17.10, 19.00, 22.10, 25.60, 27.40, 29.40, 37.20, 42.60],
  deviceBeats: [9.62, 49.85],
  keysTicks: [14.72, 14.92, 15.12],
  beltAmb: [35.40, 36.45],
  spots: SHOTS.flatMap((s) => (s.spots || []).map((x) => x.t0)),
  splashOpen: 5.00, splashPush: 6.50, splashClose: 52.50,
  riser: [50.40, 52.50],
  brandTone: 55.35,
  finalBeats: [FINAL.tag, FINAL.soon, FINAL.url],
  triplet: TRIPLET.map((x) => x.t),
  vo: VO.map((v) => ({ t: v.t, line: v.line })),
  end: END_FADE[0],
};
