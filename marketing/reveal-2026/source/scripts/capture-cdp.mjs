#!/usr/bin/env node
/**
 * Capture a real Chrome-rendered MyMeridian page as a numbered PNG sequence.
 *
 * Usage:
 *   node capture-cdp.mjs --url http://localhost:3000/app --out raw/frames/overview --duration-ms 3000 --theme dark
 *
 * Chrome must already be running with remote debugging on 127.0.0.1:9223.
 * The script records DevTools' screencast frames, so all type, charts, and
 * product data are direct browser pixels rather than regenerated imagery.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const url = option("--url");
const out = option("--out");
const durationMs = Number(option("--duration-ms", "3000"));
const theme = option("--theme", "dark");
const scrollY = Number(option("--scroll-y", "0"));
const preload = process.argv.includes("--preload");

if (!url || !out || !Number.isFinite(durationMs) || durationMs <= 0) {
  console.error("Usage: capture-cdp.mjs --url <url> --out <directory> [--duration-ms 3000] [--theme dark|light]");
  process.exit(64);
}

const debugBase = "http://127.0.0.1:9223";
const outputDirectory = resolve(out);
await mkdir(outputDirectory, { recursive: true });

// nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- CDP listens only on the local capture process and is not a product network boundary.
const targets = await fetch(`${debugBase}/json/list`).then((response) => response.json());
const target = targets.find((candidate) => candidate.type === "page") ?? targets[0];
if (!target?.webSocketDebuggerUrl) {
  throw new Error("No debuggable Chrome page was found on port 9223.");
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const events = new Map();
const frameManifest = [];
let nextId = 1;
let frameNumber = 0;

function nextEvent(method) {
  return new Promise((resolveEvent) => {
    const waiting = events.get(method) ?? [];
    waiting.push(resolveEvent);
    events.set(method, waiting);
  });
}

function call(method, params = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveCall, reject: rejectCall, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

socket.addEventListener("message", async ({ data }) => {
  const message = JSON.parse(String(data));
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
    else request.resolve(message.result);
    return;
  }

  if (message.method === "Page.screencastFrame") {
    const name = `frame-${String(++frameNumber).padStart(6, "0")}.png`;
    const bytes = Buffer.from(message.params.data, "base64");
    await writeFile(resolve(outputDirectory, name), bytes);
    frameManifest.push({
      file: name,
      timestamp: message.params.metadata.timestamp,
      deviceWidth: message.params.metadata.deviceWidth,
      deviceHeight: message.params.metadata.deviceHeight,
    });
    await call("Page.screencastFrameAck", { sessionId: message.params.sessionId });
  }

  const waiting = events.get(message.method);
  if (waiting?.length) waiting.shift()(message.params);
});

await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener("error", rejectOpen, { once: true });
});

try {
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: theme === "light" ? "light" : "dark" }],
  });
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("meridian-theme", ${JSON.stringify(theme)}); } catch (_) {}`,
  });

  const startScreencast = () => call("Page.startScreencast", {
    format: "png",
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 1,
  });
  const loaded = nextEvent("Page.loadEventFired");
  if (preload) await startScreencast();
  await call("Page.navigate", { url });
  await loaded;
  if (!preload) {
    await call("Runtime.evaluate", {
      expression: `document.documentElement.dataset.theme = ${JSON.stringify(theme)}; window.scrollTo({ top: ${Number.isFinite(scrollY) ? scrollY : 0}, behavior: "instant" });`,
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    await startScreencast();
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
  await call("Page.stopScreencast");
  // The final accepted PNG can arrive immediately after stop acknowledgement.
  // Let that message flush before serializing the reusable capture manifest.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  await writeFile(
    resolve(outputDirectory, "capture.json"),
    `${JSON.stringify({ url, theme, scrollY, preload, durationMs, capturedAt: new Date().toISOString(), frames: frameManifest }, null, 2)}\n`,
  );
  console.log(`Captured ${frameManifest.length} real browser frames in ${outputDirectory}`);
} finally {
  socket.close();
}
