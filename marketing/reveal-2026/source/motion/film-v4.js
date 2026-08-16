/*
 * MyMeridian 60s reveal — v4 "Living UI".
 *
 * No VO, no b-roll, no screenshot-and-zoom. The interface is deconstructed:
 * real components cropped from the 3840×2160 captures float on black, build
 * themselves (bars grow, rows cascade, chips land), with the film's numbers
 * set huge in Space Grotesk — the product's own display face. The hook is a
 * chat conversation that pushes through the blue bubble into the splash.
 * Still a pure function of time: SEEK(t).
 */
"use strict";

const D = 0.96;

/* ------------------------------------------------------------------ easing */
const EASE = {
  l: (p) => p,
  i: (p) => p * p * p,
  o: (p) => 1 - Math.pow(1 - p, 3),
  io: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  brand: (p) => 1 - Math.pow(1 - p, 4),
  back: (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2),
  expo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
};
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const lerp = (a, b, p) => a + (b - a) * p;

/* ------------------------------------------------------------------- data */
const STILL = (n) => `/stills/${n}`;
const P = {
  ovw: "app-overview-dark-1920x1080.png",
  bridge: "app-overview-money-bridge-dark-1920x1080.png",
  field: "app-orders-field-dark-1920x1080.png",
  ppotop: "app-orders-top-dark-1920x1080.png",
  drawer: "app-orders-losing-order-13123-dark-1920x1080.png",
  products: "app-products-bleeding-dark-1920x1080.png",
  acq: "app-acquisition-channels-dark-1920x1080.png",
  conn: "app-settings-ad-connections-dark-1920x1080.png",
  pricing: "app-pricing-dark-1920x1080.png",
  fulf: "app-fulfilment-dark-1920x1080.png",
  actions: "app-overview-actions-dark-1920x1080.png",
};

/*
 * Scene pieces: R = crop in measure space, pos = centre offset from frame
 * centre, s = display scale, z = parallax depth (-1 far … 1 near),
 * in = {t, st, dur}, styles: rise pop land wipeX growY circle.
 */
const SCENES = [
  { id: "meet", t0: 7.30, t1: 13.20,
    drift: { ry: [-0.8, 0.8], rx: [0.4, -0.4], x: [6, -6], y: [3, -3] },
    nums: [{ text: "$207,749", value: 207749, prefix: "$", size: 200,
             pos: [0, -70], count: [9.15, 10.05], out: 12.95 }],
    labels: [{ text: "Profit · before paid marketing · last 30 days",
               pos: [0, 66], center: true, in: 10.15, out: 12.95 }],
    pieces: [
      { plate: P.ovw, R: [848, 228, 912, 264], pos: [372, -148], s: 1.5, z: 0.5, radius: 8,
        in: { t: 10.35, st: "pop" }, out: 12.95, flat: true },
      { plate: P.ovw, R: [283, 280, 610, 324], pos: [-318, 158], s: 1.12, z: 0.2,
        in: { t: 10.55, st: "rise" }, out: 12.95 },
      { plate: P.ovw, R: [610, 280, 784, 324], pos: [-40, 158], s: 1.12, z: 0.3,
        in: { t: 10.70, st: "rise" }, out: 12.95 },
      { plate: P.ovw, R: [784, 280, 957, 324], pos: [208, 158], s: 1.12, z: 0.4,
        in: { t: 10.85, st: "rise" }, out: 12.95 },
    ],
  },

  { id: "bridge", t0: 13.20, t1: 19.50,
    header: { text: "See where every dollar goes.", in: 13.35, out: 19.20 },
    drift: { ry: [-1.3, 1.3], rx: [0.5, -0.5], x: [10, -10], y: [0, 0] },
    pieces: (() => {
      const bars = [
        { R: [386, 513, 601, 762], t: 14.00 },
        { R: [604, 513, 816, 762], t: 14.42 },
        { R: [824, 588, 1037, 762], t: 14.82 },
        { R: [1042, 600, 1256, 762], t: 15.18 },
        { R: [1263, 605, 1476, 762], t: 15.52 },
        { R: [1483, 611, 1695, 762], t: 15.86 },
      ];
      const cx = (386 + 1915) / 2, cy = (513 + 762) / 2;
      const s = 1.18;
      const out = bars.map((b) => ({
        plate: P.bridge, R: b.R, flat: true, radius: 6,
        pos: [((b.R[0] + b.R[2]) / 2 - cx) * D * s, ((b.R[1] + b.R[3]) / 2 - cy) * D * s + 30],
        s, z: 0.2, in: { t: b.t, st: "growY", dur: 0.6 }, out: 19.25,
      }));
      out.push({
        plate: P.bridge, R: [1702, 634, 1915, 762], flat: true, radius: 6,
        pos: [((1702 + 1915) / 2 - cx) * D * s, ((634 + 762) / 2 - cy) * D * s + 30],
        s, z: 0.45, in: { t: 16.40, st: "land", dur: 0.55 }, out: 19.25, glow: "white",
      });
      return out;
    })(),
  },

  { id: "orders", t0: 19.50, t1: 26.50,
    header: { text: "Find the sales that cost you money.", in: 19.65, out: 26.20 },
    drift: { ry: [1.2, -1.2], rx: [-0.4, 0.5], x: [-8, 8], y: [2, -4] },
    pieces: (() => {
      const rows = [
        { R: [1441, 20, 1975, 120], t: 22.30 },   // TRANSPARENT MATH · Order #13123
        { R: [1437, 253, 1970, 292], t: 22.55 },  // merchandise subtotal
        { R: [1437, 391, 1970, 423], t: 22.80 },  // refunds -409.78
        { R: [1437, 436, 1970, 472], t: 23.05 },  // net revenue 15.32
        { R: [1437, 542, 1970, 574], t: 23.30 },  // cost of goods
        { R: [1437, 778, 1970, 818], t: 23.55 },  // contribution -167.27
      ];
      const s = 0.95;
      let y = -252;
      const out = rows.map((r) => {
        const h = (r.R[3] - r.R[1]) * D * s;
        const piece = {
          plate: P.drawer, R: r.R, pos: [438, y + h / 2], s, z: 0.3,
          in: { t: r.t, st: "rise" }, out: 26.25, radius: 10,
        };
        y += h + 14;
        return piece;
      });
      out.push({
        plate: P.drawer, R: [1437, 863, 1970, 945], pos: [438, y + (945 - 863) * D * s / 2 + 6],
        s, z: 0.55, in: { t: 24.30, st: "land", dur: 0.55 }, out: 26.25, glow: "white", radius: 12,
      });
      out.unshift({
        plate: P.field, R: [360, 95, 1535, 865], pos: [-295, 30], s: 0.82, z: -0.3,
        in: { t: 20.10, st: "circle", dur: 1.15 }, out: 26.25, dimAt: 22.2, radius: 14,
      });
      out.push({
        plate: P.ppotop, R: [1548, 404, 1963, 585], pos: [-295, -318], s: 0.9, z: 0.15,
        in: { t: 21.05, st: "rise" }, out: 26.25, glow: "soft",
      });
      return out;
    })(),
  },

  { id: "products", t0: 26.50, t1: 31.50,
    header: { text: "Know what’s carrying your business.", in: 26.65, out: 28.75 },
    header2: { text: "— and what’s bleeding it.", in: 28.95, out: 31.25 },
    drift: { ry: [-1.0, 1.0], rx: [0.4, -0.6], x: [6, -8], y: [0, 2] },
    pieces: (() => {
      const green = [[322, 8, 1934, 50], [322, 48, 1934, 90], [322, 88, 1934, 130], [322, 128, 1934, 170]];
      const s = 0.94;
      const out = green.map((R, i) => ({
        plate: P.products, R, pos: [-20, -212 + i * 62], s, z: 0.15 + i * 0.08,
        in: { t: 27.00 + i * 0.20, st: "wipeX", dur: 0.55 }, out: 31.30, radius: 9,
      }));
      [[322, 486, 1934, 532], [322, 528, 1934, 576]].forEach((R, i) => out.push({
        plate: P.products, R, pos: [-20, 148 + i * 74], s, z: 0.5,
        in: { t: 29.20 + i * 0.25, st: "land", dur: 0.5 }, out: 31.30, glow: "ember", radius: 9,
      }));
      return out;
    })(),
  },

  { id: "channels", t0: 31.50, t1: 35.00,
    header: { text: "Know which channels actually pay.", in: 31.65, out: 34.75 },
    drift: { ry: [0.9, -0.9], rx: [-0.3, 0.4], x: [-6, 6], y: [2, -2] },
    pieces: (() => {
      const rows = [[290, 696, 1966, 768], [290, 832, 1966, 904], [290, 902, 1966, 974]];
      const chips = [[1204, 608, 1314, 650], [1204, 676, 1314, 718], [1204, 745, 1314, 787]];
      const s = 0.78;
      const out = rows.map((R, i) => ({
        plate: P.acq, R, pos: [-95, -108 + i * 92], s, z: 0.2 + i * 0.1,
        in: { t: 31.95 + i * 0.22, st: "rise" }, out: 34.78, radius: 10,
      }));
      chips.forEach((R, i) => out.push({
        plate: P.conn, R, pos: [618, -108 + i * 92], s: 1.15, z: 0.5,
        in: { t: 32.95 + i * 0.15, st: "pop" }, out: 34.78, radius: 999,
      }));
      return out;
    })(),
  },

  { id: "pricing", t0: 35.00, t1: 41.00,
    header: { text: "Find opportunities hiding in your pricing.", in: 35.15, out: 40.70 },
    drift: { ry: [-0.9, 1.1], rx: [0.3, -0.4], x: [5, -7], y: [0, 3] },
    caption: { text: "A modelled recommendation from observed price history — not a guarantee.",
               in: 38.60, out: 40.60 },
    arrows: [{ from: [-158, -42], to: [-34, -42], t: 36.50 }],
    pieces: [
      { plate: P.pricing, R: [318, 824, 474, 852], pos: [-428, -160], s: 1.25, z: 0.2,
        in: { t: 35.80, st: "rise" }, out: 40.75, flat: true, radius: 6 },
      { plate: P.pricing, R: [745, 836, 832, 902], pos: [-262, -42], s: 1.5, z: 0.3,
        in: { t: 36.10, st: "pop" }, out: 40.75 },
      { plate: P.pricing, R: [886, 830, 982, 907], pos: [88, -42], s: 1.65, z: 0.6,
        in: { t: 36.90, st: "land", dur: 0.5 }, out: 40.75, glow: "white" },
      { plate: P.pricing, R: [1284, 836, 1354, 902], pos: [330, -42], s: 1.5, z: 0.4,
        in: { t: 37.40, st: "pop" }, out: 40.75 },
      { plate: P.pricing, R: [1550, 846, 1622, 898], pos: [488, -42], s: 1.5, z: 0.45,
        in: { t: 37.70, st: "pop" }, out: 40.75, radius: 999 },
      { plate: P.pricing, R: [1353, 843, 1502, 902], pos: [205, 92], s: 1.2, z: 0.25,
        in: { t: 38.10, st: "rise" }, out: 40.75, flat: true, radius: 6 },
    ],
  },

  { id: "fulf", t0: 41.00, t1: 47.00,
    header: { text: "See problems before your customers do.", in: 41.15, out: 46.75 },
    drift: { ry: [1.0, -1.0], rx: [-0.4, 0.4], x: [-7, 7], y: [3, -2] },
    pieces: [
      { plate: P.fulf, R: [291, 266, 710, 457], pos: [-408, -96], s: 1.02, z: 0.35,
        in: { t: 41.70, st: "rise" }, out: 46.80, glow: "soft" },
      { plate: P.fulf, R: [310, 394, 666, 436], pos: [-425.5, -35.9], s: 1.02, z: 0.36,
        in: { t: 42.05, st: "wipeX", dur: 0.9 }, out: 46.80, flat: true },
      { plate: P.fulf, R: [1129, 266, 1550, 457], pos: [268, -134], s: 0.86, z: 0.15,
        in: { t: 42.40, st: "rise" }, out: 46.80 },
      { plate: P.fulf, R: [293, 650, 1965, 750], pos: [72, 92], s: 0.84, z: 0.25,
        in: { t: 42.95, st: "rise" }, out: 46.80, radius: 10 },
      { plate: P.fulf, R: [293, 754, 1965, 850], pos: [72, 210], s: 0.84, z: 0.55,
        in: { t: 43.35, st: "land", dur: 0.55 }, out: 46.80, glow: "ember", radius: 10 },
    ],
  },

  { id: "actions", t0: 47.00, t1: 53.50,
    drift: { ry: [-1.6, 1.4], rx: [0.6, -0.6], x: [12, -12], y: [4, -4] },
    triplet: [
      { t: 47.90, text: "Know what happened." },
      { t: 48.90, text: "Know why." },
      { t: 49.90, text: "Know what to do next." },
    ],
    tripletOut: 53.10,
    pieces: [[323, 232, 1933, 434], [323, 459, 1933, 661], [323, 686, 1933, 888], [323, 912, 1933, 1108]]
      .map((R, i) => ({
        plate: P.actions, R, pos: [252, -228 + i * 150], s: 0.62, z: 0.1 + i * 0.16,
        in: { t: 47.30 + i * 0.25, st: "rise" }, out: 53.30, radius: 12,
      })),
  },
];

const TITLES = [
  { t0: 7.45, t1: 9.15, out: 8.85, line: "Meet MyMeridian." },
];

const CHAT = {
  stampIn: 0.25,
  typing: [0.50, 1.30],
  grayPop: 1.35,
  inputIn: 1.90,
  typeSpan: [2.05, 3.40],
  typeText: "You should try MyMeridian!",
  sendPress: 3.50,
  fly: [3.55, 3.95],
  delivered: 4.25,
  push: [4.45, 5.20],
  wash: [4.70, 5.30],
  fadeOut: [5.02, 5.28],
};

const SPLASH_OPEN = { fade: [5.10, 5.35], map: [[5.25, 0], [6.65, 1210]], push: [6.65, 7.30] };
const SPLASH_CLOSE = { fade: [53.60, 53.90], map: [[53.70, 0], [55.80, 1000]] };
const FINAL = { tag: 56.30, soon: 58.15, url: 58.60 };
const END_FADE = [59.35, 59.95];

const CHUNKS = [0, 5.00, 7.30, 13.20, 19.50, 26.50, 31.50, 35.00, 41.00, 47.00, 53.50, 60.00];

/* ------------------------------------------------------------ DOM assembly */
const root = document.getElementById("root");
const shotsRoot = document.getElementById("shots");
const els = { scenes: new Map() };

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

const GLOWS = {
  white: "0 1px 0 rgba(245,245,245,0.09) inset, 0 30px 90px rgba(0,0,0,0.6), 0 0 70px rgba(245,245,245,0.16), 0 0 0 1px rgba(245,245,245,0.18)",
  soft: "0 1px 0 rgba(245,245,245,0.08) inset, 0 30px 80px rgba(0,0,0,0.6), 0 0 44px rgba(245,245,245,0.08)",
  ember: "0 1px 0 rgba(245,245,245,0.06) inset, 0 30px 80px rgba(0,0,0,0.65), 0 0 54px rgba(226,106,86,0.20), 0 0 0 1px rgba(226,106,86,0.22)",
};

function buildScenes() {
  for (const sc of SCENES) {
    const scene = document.createElement("div");
    scene.className = "scene";
    const group = document.createElement("div");
    group.className = "group";
    scene.appendChild(group);
    shotsRoot.appendChild(scene);
    const rec = { scene, group, pieces: [], nums: [], labels: [], headers: [], arrows: [], triplet: [] };

    for (const pc of (sc.pieces || [])) {
      const el = document.createElement("div");
      el.className = "piece" + (pc.flat ? " flat" : "");
      const rs = { x: pc.R[0] * D, y: pc.R[1] * D, w: (pc.R[2] - pc.R[0]) * D, h: (pc.R[3] - pc.R[1]) * D };
      const w = rs.w * pc.s, h = rs.h * pc.s;
      el.style.width = w + "px";
      el.style.height = h + "px";
      el.style.left = `calc(50% + ${pc.pos[0] - w / 2}px)`;
      el.style.top = `calc(50% + ${pc.pos[1] - h / 2}px)`;
      if (pc.radius != null) el.style.borderRadius = pc.radius + "px";
      if (pc.glow) el.style.boxShadow = GLOWS[pc.glow];
      const img = new Image();
      img.src = STILL(pc.plate);
      img.style.width = 1920 * pc.s + "px";
      img.style.height = 1080 * pc.s + "px";
      img.style.left = -rs.x * pc.s + "px";
      img.style.top = -rs.y * pc.s + "px";
      el.appendChild(img);
      group.appendChild(el);
      rec.pieces.push({ spec: pc, el, w, h });
    }

    for (const nm of (sc.nums || [])) {
      const el = document.createElement("div");
      el.className = "bignum";
      el.style.fontSize = nm.size + "px";
      el.style.left = "50%";
      el.style.top = "50%";
      el.textContent = nm.text;
      group.appendChild(el);
      rec.nums.push({ spec: nm, el });
    }
    for (const lb of (sc.labels || [])) {
      const el = document.createElement("div");
      el.className = "sidelabel";
      el.textContent = lb.text;
      if (lb.center) { el.style.left = "0"; el.style.right = "0"; el.style.textAlign = "center"; }
      el.style.top = `calc(50% + ${lb.pos[1]}px)`;
      group.appendChild(el);
      rec.labels.push({ spec: lb, el });
    }
    for (const key of ["header", "header2"]) {
      if (!sc[key]) continue;
      const el = document.createElement("div");
      el.className = "header-line";
      scene.appendChild(el);
      rec.headers.push({ spec: sc[key], el, letters: makeLetters(el, sc[key].text) });
    }
    if (sc.caption) {
      const el = document.createElement("div");
      el.className = "cap";
      el.textContent = sc.caption.text;
      scene.appendChild(el);
      rec.caption = { spec: sc.caption, el };
    }
    for (const ar of (sc.arrows || [])) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "arrowline");
      svg.setAttribute("width", "300"); svg.setAttribute("height", "60");
      const len = Math.hypot(ar.to[0] - ar.from[0], ar.to[1] - ar.from[1]);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M 8 30 L ${8 + len} 30`);
      path.setAttribute("stroke-dasharray", String(len));
      const head = document.createElementNS("http://www.w3.org/2000/svg", "path");
      head.setAttribute("d", `M ${8 + len - 12} 21 L ${8 + len} 30 L ${8 + len - 12} 39`);
      head.setAttribute("stroke-dasharray", "40");
      svg.appendChild(path); svg.appendChild(head);
      svg.style.left = `calc(50% + ${ar.from[0] - 8}px)`;
      svg.style.top = `calc(50% + ${ar.from[1] - 30}px)`;
      group.appendChild(svg);
      rec.arrows.push({ spec: ar, svg, path, head, len });
    }
    if (sc.triplet) {
      sc.triplet.forEach((tp, i) => {
        const el = document.createElement("div");
        el.className = "t3";
        el.style.cssText = `position:absolute;left:calc(50% - 700px);top:calc(50% + ${-84 + i * 78}px);font-size:37px;opacity:0;text-align:left;`;
        scene.appendChild(el);
        rec.triplet.push({ spec: tp, el, letters: makeLetters(el, tp.text) });
      });
    }
    els.scenes.set(sc.id, rec);
  }
}

function buildChat() {
  const chat = document.createElement("div");
  chat.className = "chat";
  chat.innerHTML = `
    <div class="thread">
      <div class="stamp">Today · 9:47 PM</div>
      <div class="typing"><i></i><i></i><i></i></div>
      <div class="bubble bub-gray">Ugh, I can’t keep track of everything!</div>
      <div class="bubble bub-blue">You should try <b>MyMeridian</b>!</div>
      <div class="delivered">Delivered</div>
      <div class="inputbar"><div class="inputtext"><span class="typed"></span><span class="caret"></span></div>
        <div class="sendbtn"></div></div>
    </div>`;
  root.insertBefore(chat, document.getElementById("grain"));
  const wash = document.createElement("div");
  wash.className = "bluewash";
  root.insertBefore(wash, document.getElementById("grain"));
  els.chat = {
    root: chat,
    thread: chat.querySelector(".thread"),
    stamp: chat.querySelector(".stamp"),
    typing: chat.querySelector(".typing"),
    dots: Array.from(chat.querySelectorAll(".typing i")),
    gray: chat.querySelector(".bub-gray"),
    blue: chat.querySelector(".bub-blue"),
    delivered: chat.querySelector(".delivered"),
    inputbar: chat.querySelector(".inputbar"),
    typed: chat.querySelector(".typed"),
    caret: chat.querySelector(".caret"),
    send: chat.querySelector(".sendbtn"),
    wash,
  };
}

function buildGlobal() {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:absolute;inset:0;z-index:50;pointer-events:none;";
  root.appendChild(overlay);
  els.overlay = overlay;

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
    return { card, letters: makeLetters(line, tt.line) };
  });

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
  root.appendChild(splash);
  els.splash = splash;
  els.finalTag = splash.querySelector(".final-tag");
  els.finalSoon = splash.querySelector(".final-soon");
  els.finalUrl = splash.querySelector(".final-url");
  els.finalTagLetters = makeLetters(els.finalTag, "Know what you kept. Know what to fix.");
  els.splashAnims = null;
  els.grain = document.getElementById("grain").getContext("2d");
  els.flash = document.getElementById("flash");
}

/* -------------------------------------------------------------- pieces */
function pieceState(pc, t) {
  const dur = pc.in.dur ?? 0.5;
  const p = seg(t, pc.in.t, pc.in.t + dur);
  const pout = pc.out ? EASE.io(seg(t, pc.out, pc.out + 0.28)) : 0;
  if (p <= 0 || pout >= 1) return null;
  const st = pc.in.st;
  const o = { opacity: Math.min(1, p * 1.6) * (1 - pout), tx: 0, ty: -14 * pout, sc: 1, blur: 0, clip: null };
  if (st === "rise") {
    const e = EASE.brand(p);
    o.ty += 34 * (1 - e); o.blur = 5 * (1 - p);
  } else if (st === "pop") {
    o.sc = lerp(0.9, 1, EASE.back(p));
  } else if (st === "land") {
    o.sc = lerp(1.14, 1, EASE.brand(p));
  } else if (st === "wipeX") {
    const e = EASE.brand(p);
    o.clip = `inset(0 ${(1 - e) * 100}% 0 0 round 9px)`;
    o.opacity = (p > 0 ? 1 : 0) * (1 - pout);
  } else if (st === "growY") {
    const e = EASE.brand(p);
    o.clip = `inset(${(1 - e) * 100}% 0 0 0)`;
    o.opacity = (p > 0 ? 1 : 0) * (1 - pout);
  } else if (st === "circle") {
    const e = EASE.io(p);
    o.clip = `circle(${e * 78}% at 50% 50%)`;
    o.opacity = (p > 0 ? 1 : 0) * (1 - pout);
  }
  return o;
}

function letterIn(letters, t, t0, stagger = 0.024, dur = 0.38) {
  letters.forEach((el, i) => {
    const p = clamp01((t - t0 - i * stagger) / dur);
    const e = EASE.brand(p);
    el.style.opacity = String(p === 0 ? 0 : Math.min(1, p * 1.4));
    el.style.transform = `translateY(${13 * (1 - e)}px)`;
    el.style.filter = p >= 1 ? "none" : `blur(${5 * (1 - e)}px)`;
  });
}
function blockOut(el, t, tOut, dur = 0.3) {
  const p = clamp01((t - tOut) / dur);
  if (p <= 0) return 1;
  el.style.transform = `translateY(${-10 * EASE.io(p)}px)`;
  el.style.filter = p >= 1 ? "none" : `blur(${5 * p}px)`;
  return 1 - p;
}
const fmtMoney = (v) => "$" + Math.round(v).toLocaleString("en-US");
function grain(t) {
  const g = els.grain;
  let s = ((Math.floor(t * 24) % 8) + 7) * 2654435761 >>> 0;
  const img = g.createImageData(480, 270);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    const v = (s & 0xff) < 22 ? (s >> 8) & 0x3f : 0;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ SEEK */
function SEEK(t) {
  /* chat */
  const C = els.chat;
  {
    const on = t < CHAT.fadeOut[1] + 0.1;
    C.root.style.opacity = on ? String(1 - EASE.io(seg(t, CHAT.fadeOut[0], CHAT.fadeOut[1]))) : "0";
    if (on) {
      C.stamp.style.opacity = String(EASE.io(seg(t, CHAT.stampIn, CHAT.stampIn + 0.4)));
      const tp = t >= CHAT.typing[0] && t < CHAT.typing[1];
      C.typing.style.opacity = tp ? String(Math.min(1, seg(t, CHAT.typing[0], CHAT.typing[0] + 0.2) * 1.5)) : "0";
      if (tp) C.dots.forEach((d, i) => {
        d.style.opacity = String(0.35 + 0.55 * (0.5 + 0.5 * Math.sin((t * 5.4 - i * 0.85) * Math.PI)));
      });
      const gp = EASE.back(seg(t, CHAT.grayPop, CHAT.grayPop + 0.42));
      C.gray.style.opacity = t >= CHAT.grayPop ? "1" : "0";
      C.gray.style.transform = `scale(${t >= CHAT.grayPop ? gp : 0.6})`;
      C.gray.style.transformOrigin = "12% 100%";
      C.inputbar.style.opacity = String(EASE.io(seg(t, CHAT.inputIn, CHAT.inputIn + 0.35)));
      const chars = Math.floor(lerp(0, CHAT.typeText.length, seg(t, CHAT.typeSpan[0], CHAT.typeSpan[1])));
      C.typed.textContent = t >= CHAT.fly[0] ? "" : CHAT.typeText.slice(0, chars);
      C.caret.style.opacity = t >= CHAT.fly[0] ? "0" : (Math.floor(t * 2.4) % 2 ? "0.15" : "1");
      const press = t >= CHAT.sendPress && t < CHAT.sendPress + 0.16;
      C.send.style.transform = press ? "scale(0.86)" : "scale(1)";
      /* blue bubble flight from input to slot */
      if (t < CHAT.fly[0]) {
        C.blue.style.opacity = "0";
      } else {
        const fp = EASE.io(seg(t, CHAT.fly[0], CHAT.fly[1]));
        const sx = -210, sy = 258;            // from near the input bar
        const tx2 = 0, ty2 = 0;
        const arc = -46 * Math.sin(Math.PI * fp);
        C.blue.style.opacity = String(Math.min(1, fp * 2));
        C.blue.style.transform = `translate(${lerp(sx, tx2, fp)}px, ${lerp(sy, ty2, fp) + arc}px) scale(${lerp(0.62, 1, fp)})`;
        C.blue.style.transformOrigin = "88% 100%";
      }
      C.delivered.style.opacity = String(EASE.io(seg(t, CHAT.delivered, CHAT.delivered + 0.35)));
      /* push-in toward the blue bubble */
      const pp = EASE.i(seg(t, CHAT.push[0], CHAT.push[1]));
      C.thread.style.transformOrigin = "62% 52%";
      C.thread.style.transform = `scale(${lerp(1, 2.75, pp)})`;
      C.root.style.filter = pp > 0 ? `blur(${pp * 3.5}px)` : "none";
    }
    const wp = seg(t, CHAT.wash[0], CHAT.wash[1]);
    C.wash.style.opacity = String(wp > 0 && wp < 1 ? 0.85 * Math.sin(Math.PI * wp) : 0);
  }

  /* scenes */
  for (const sc of SCENES) {
    const rec = els.scenes.get(sc.id);
    if (t < sc.t0 - 0.05 || t > sc.t1 + 0.1) {
      rec.scene.style.opacity = "0";
      rec.scene.style.visibility = "hidden";
      continue;
    }
    rec.scene.style.visibility = "visible";
    rec.scene.style.opacity = String(Math.min(EASE.io(seg(t, sc.t0, sc.t0 + 0.2)), 1 - EASE.io(seg(t, sc.t1 - 0.2, sc.t1))));

    const dp = seg(t, sc.t0, sc.t1);
    const dr = sc.drift || {};
    const ry = dr.ry ? lerp(dr.ry[0], dr.ry[1], dp) : 0;
    const rx = dr.rx ? lerp(dr.rx[0], dr.rx[1], dp) : 0;
    const gx = dr.x ? lerp(dr.x[0], dr.x[1], dp) : 0;
    const gy = dr.y ? lerp(dr.y[0], dr.y[1], dp) : 0;
    rec.group.style.transform = `translate(-50%, -50%) rotateX(${rx}deg) rotateY(${ry}deg)`;

    for (const { spec, el } of rec.pieces) {
      const st = pieceState(spec, t);
      if (!st) { el.style.opacity = "0"; continue; }
      el.style.opacity = String(st.opacity);
      const px = gx * (spec.z ?? 0), py = gy * (spec.z ?? 0);
      el.style.transform = `translate(${st.tx + px}px, ${st.ty + py}px) scale(${st.sc}) translateZ(${(spec.z ?? 0) * 60}px)`;
      el.style.clipPath = st.clip ?? "none";
      let f = st.blur > 0.05 ? `blur(${st.blur}px)` : "";
      if (spec.dimAt && t > spec.dimAt) f += ` brightness(${lerp(1, 0.7, EASE.io(seg(t, spec.dimAt, spec.dimAt + 0.5)))})`;
      el.style.filter = f || "none";
    }

    for (const { spec, el } of rec.nums) {
      const p = seg(t, spec.count[0], spec.count[1]);
      const pout = EASE.io(seg(t, spec.out, spec.out + 0.28));
      if (p <= 0 || pout >= 1) { el.style.opacity = "0"; continue; }
      el.textContent = fmtMoney(spec.value * EASE.expo(p));
      el.style.opacity = String(Math.min(1, p * 3) * (1 - pout));
      el.style.transform = `translate(-50%, -50%) translate(${spec.pos[0]}px, ${spec.pos[1]}px) scale(${lerp(0.97, 1, EASE.brand(p))})`;
      el.style.filter = p < 1 ? `blur(${(1 - p) * 1.5}px)` : "none";
    }
    for (const { spec, el } of rec.labels) {
      const o = EASE.io(seg(t, spec.in, spec.in + 0.45)) * (1 - EASE.io(seg(t, spec.out, spec.out + 0.28)));
      el.style.opacity = String(o);
    }
    rec.headers.forEach(({ spec, el, letters }) => {
      if (t < spec.in - 0.02 || t > spec.out + 0.35) { el.style.opacity = "0"; return; }
      letterIn(letters, t, spec.in);
      el.style.transform = "";
      el.style.filter = "";
      el.style.opacity = String(blockOut(el, t, spec.out, 0.28));
    });
    if (rec.caption) {
      const { spec, el } = rec.caption;
      el.style.opacity = String(EASE.io(seg(t, spec.in, spec.in + 0.4)) * (1 - EASE.io(seg(t, spec.out - 0.3, spec.out))));
    }
    for (const { spec, svg, path, head, len } of rec.arrows) {
      const p = EASE.brand(seg(t, spec.t, spec.t + 0.55));
      const pout = spec.out ? EASE.io(seg(t, 40.75, 41.0)) : EASE.io(seg(t, sc.t1 - 0.3, sc.t1));
      svg.style.opacity = String((p > 0 ? 1 : 0) * (1 - pout));
      path.setAttribute("stroke-dashoffset", String(len * (1 - p)));
      head.setAttribute("stroke-dashoffset", String(40 * (1 - clamp01((p - 0.75) / 0.25))));
    }
    rec.triplet.forEach(({ spec, el, letters }) => {
      if (t < spec.t - 0.02) { el.style.opacity = "0"; return; }
      letterIn(letters, t, spec.t, 0.02, 0.34);
      const rem = 1 - EASE.io(seg(t, sc.tripletOut ?? sc.t1, (sc.tripletOut ?? sc.t1) + 0.35));
      el.style.opacity = String(rem);
    });
  }

  /* big titles */
  TITLES.forEach((tt, i) => {
    const { card, letters } = els.titles[i];
    if (t < tt.t0 - 0.02 || t > tt.t1 + 0.05) { card.style.opacity = "0"; return; }
    card.style.opacity = "1";
    letterIn(letters, t, tt.t0);
    const inner = card.firstChild;
    inner.style.transform = "";
    inner.style.filter = "";
    card.style.opacity = String(blockOut(inner, t, tt.out));
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
  if (splashMs != null && els.splashAnims) for (const a of els.splashAnims) a.currentTime = splashMs;

  els.flash.style.opacity = String(EASE.io(seg(t, END_FADE[0], END_FADE[1])));
  grain(t);
  return "ok";
}

/* ------------------------------------------------------------------ boot */
buildChat();
buildScenes();
buildGlobal();

Promise.all([
  document.fonts.ready,
  ...Array.from(document.images).map((im) => im.decode().catch(() => null)),
]).then(() => {
  els.splashAnims = els.splash.getAnimations({ subtree: true });
  for (const a of els.splashAnims) a.pause();
  SEEK(0);
  window.__READY = true;
  window.__FONTS = {
    satoshi: document.fonts.check('560 16px Satoshi'),
    grotesk: document.fonts.check('500 16px "Space Grotesk Variable"'),
  };
});

window.SEEK = SEEK;
window.FILM = { duration: 60, fps: 60, chunks: CHUNKS };
window.MARKERS = {
  version: 4,
  chat: { typing: CHAT.typing, grayPop: CHAT.grayPop, typeSpan: CHAT.typeSpan,
          sendPress: CHAT.sendPress, blueLand: CHAT.fly[1], delivered: CHAT.delivered,
          push: CHAT.push[0] },
  splashArrive: SPLASH_OPEN.push[0],
  sections: [7.30, 13.20, 19.50, 26.50, 31.50, 35.00, 41.00, 47.00],
  count: SCENES[0].nums[0].count,
  pieceIns: SCENES.flatMap((sc) => (sc.pieces || []).map((p) => p.in.t)),
  lands: [16.40, 24.30, 29.20, 29.45, 36.90, 43.35],
  headers: SCENES.filter((s) => s.header).map((s) => s.header.in),
  triplet: SCENES.find((s) => s.id === "actions").triplet.map((x) => x.t),
  riser: [51.60, 53.70],
  splashClose: 53.70,
  brandTone: 56.10,
  finalBeats: [FINAL.tag, FINAL.soon, FINAL.url],
  end: END_FADE[0],
};
