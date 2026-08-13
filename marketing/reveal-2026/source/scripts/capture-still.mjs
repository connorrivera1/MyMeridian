#!/usr/bin/env node
/**
 * Capture one real MyMeridian screen as a 3840×2160 PNG (1920×1080 @ 2x).
 * Reuses the already-authenticated debug Chrome on 127.0.0.1:9223 so every
 * pixel is the actual product — no regeneration of UI, charts, or numbers.
 *
 * Usage:
 *   node capture-still.mjs --url http://localhost:3000/app --scroll-y 470 \
 *     --out ../raw/stills/app-overview-actions-dark-1920x1080.png [--theme dark] [--settle-ms 900]
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const url = option("--url");
const out = option("--out");
const theme = option("--theme", "dark");
const scrollY = Number(option("--scroll-y", "0"));
const settleMs = Number(option("--settle-ms", "900"));
if (!url || !out) {
  console.error("Usage: capture-still.mjs --url <url> --out <file.png> [--scroll-y 0] [--theme dark]");
  process.exit(64);
}

const targets = await fetch("http://127.0.0.1:9223/json/list").then((r) => r.json());
const target = targets.find((t) => t.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error("No debuggable page on 9223");

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
function call(method, params = {}) {
  return new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
const loadFired = [];
socket.addEventListener("message", ({ data }) => {
  const m = JSON.parse(String(data));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result);
  } else if (m.method === "Page.loadEventFired") {
    loadFired.forEach((f) => f());
  }
});
await new Promise((res, rej) => {
  socket.addEventListener("open", res, { once: true });
  socket.addEventListener("error", rej, { once: true });
});

try {
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false });
  await call("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: theme }],
  });
  const loaded = new Promise((res) => loadFired.push(res));
  await call("Page.navigate", { url });
  await loaded;
  // Let hydration finish first — React re-patches data-theme on <html> back to
  // the server value, so an early flip is silently reverted.
  await new Promise((r) => setTimeout(r, settleMs));
  await call("Runtime.evaluate", {
    expression: `try { localStorage.setItem("meridian-theme", ${JSON.stringify(theme)}); } catch (e) {}
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      window.scrollTo({ top: ${scrollY}, behavior: "instant" });`,
  });
  await new Promise((r) => setTimeout(r, 600));
  const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(resolve(out), Buffer.from(shot.data, "base64"));
  console.log(`Captured ${url} (scrollY=${scrollY}, ${theme}) -> ${out}`);
  // Leave the rig the way the other capture flows expect it.
  await call("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
} finally {
  socket.close();
}
