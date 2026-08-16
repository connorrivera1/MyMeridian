#!/usr/bin/env node
/**
 * Creates a deterministic black MyMeridian title frame in the application's
 * loaded typography. Intended for reveal-film editorial copy only; it never
 * recreates product UI or product data.
 *
 * Usage:
 *   node make-title-card.mjs --out source/assets/title.png --eyebrow "01" --title "Meet MyMeridian." --body "Profitability intelligence for Shopify."
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

const out = option("--out");
const eyebrow = option("--eyebrow");
const title = option("--title");
const body = option("--body");
const align = option("--align", "left");
const layout = option("--layout", "standard");
const backdropPath = option("--backdrop");
if (!out || !title) {
  console.error("Usage: make-title-card.mjs --out <png> --title <copy> [--eyebrow <copy>] [--body <copy>] [--align left|center]");
  process.exit(64);
}

// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- This talks solely to the local Chrome CDP process used to render a title card.
const targets = await fetch("http://127.0.0.1:9223/json/list").then((response) => response.json());
const target = targets.find((candidate) => candidate.type === "page") ?? targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error("No debuggable Chrome page was found on port 9223.");
const backdrop = backdropPath
  ? `url(data:image/png;base64,${(await readFile(resolve(backdropPath))).toString("base64")}) center / cover no-repeat`
  : "radial-gradient(ellipse at 65% 62%,rgba(255,255,255,.055),transparent 38%),#0a0a0a";

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
function call(method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveCall, reject: rejectCall, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(String(data));
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
  else request.resolve(message.result);
});
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener("error", rejectOpen, { once: true });
});

try {
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise((resolveLoad) => {
    const previous = socket.onmessage;
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.method === "Page.loadEventFired") resolveLoad();
    }, { once: false });
  });
  await call("Page.navigate", { url: "http://localhost:3000/app?range=30d" });
  await Promise.race([loaded, new Promise((resolveDelay) => setTimeout(resolveDelay, 5000))]);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 800));
  await call("Runtime.evaluate", {
    awaitPromise: true,
    expression: `(() => {
      const content = ${JSON.stringify({ eyebrow, title, body, align, layout, backdrop })};
      document.documentElement.dataset.theme = "dark";
      document.body.replaceChildren();
      document.body.style.cssText = "margin:0; width:100vw; height:100vh; overflow:hidden; background:#0a0a0a; color:#f5f5f5;";
      const style = document.createElement("style");
      style.textContent = \
        "#reveal-card{box-sizing:border-box;position:fixed;inset:0;display:flex;flex-direction:column;justify-content:" + (content.layout === "final" ? "flex-end" : "center") + ";padding:" + (content.layout === "final" ? "0 190px 104px" : "150px 190px") + ";background:" + content.backdrop + ";font-family:var(--font);text-align:" + content.align + ";}" +
        "#reveal-card .eyebrow{font-family:var(--font-display);font-size:16px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:rgba(245,245,245,.54);margin:0 0 34px;}" +
        "#reveal-card h1{font-family:var(--font-display);font-size:82px;line-height:1.03;letter-spacing:-.045em;max-width:1300px;white-space:pre-line;margin:0;font-weight:500;}" +
        "#reveal-card p{font-size:28px;line-height:1.4;letter-spacing:-.018em;max-width:900px;white-space:pre-line;color:rgba(245,245,245,.68);margin:30px 0 0;}" +
        "#reveal-card .rule{width:64px;height:2px;background:#f5f5f5;margin:46px 0 0;opacity:.86;}" +
        "#reveal-card.final .eyebrow{font-size:13px;margin:0 0 14px;}#reveal-card.final h1{font-size:36px;line-height:1.13;letter-spacing:-.03em;max-width:none;}#reveal-card.final p{font-size:16px;line-height:1.55;margin:18px 0 0;max-width:none;letter-spacing:.08em;}#reveal-card.final .rule{width:42px;margin:24px auto 0;}";
      document.head.append(style);
      const card = document.createElement("main"); card.id = "reveal-card"; if (content.layout === "final") card.classList.add("final");
      const over = document.createElement("div"); over.className = "eyebrow"; over.textContent = content.eyebrow;
      const heading = document.createElement("h1"); heading.textContent = content.title;
      const paragraph = document.createElement("p"); paragraph.textContent = content.body;
      const rule = document.createElement("div"); rule.className = "rule";
      card.append(over, heading, paragraph, rule); document.body.append(card);
      return document.fonts.ready.then(() => true);
    })()`,
  });
  const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  const file = resolve(out);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(screenshot.data, "base64"));
  console.log(`Saved ${file}`);
} finally {
  socket.close();
}
