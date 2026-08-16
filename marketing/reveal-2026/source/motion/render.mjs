#!/usr/bin/env node
/**
 * Deterministic frame renderer for the MyMeridian reveal.
 *
 * Serves the stage locally, drives a private headless Chrome through CDP,
 * calls SEEK(t) for every subframe and screenshots the result. Three
 * subframes per output frame (180° shutter) are averaged by ffmpeg's tmix
 * for true motion blur. Chunks encode independently so any section can be
 * re-rendered alone.
 *
 * Usage:
 *   node render.mjs --preview "7.5,13.5,17"     # QA stills into preview/
 *   node render.mjs --chunks 0,1,2              # render chunk indices
 *   node render.mjs                             # render everything + concat
 *   node render.mjs --dump-markers              # markers.json for the mix
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");                     // reveal-2026/
const meridianRoot = resolve(projectRoot, "../..");             // repo root
const stillsDir = join(projectRoot, "raw/stills");
const seqDir = join(projectRoot, "raw/footage/seq");
const fontsDir = join(meridianRoot, "public/fonts");
const scratch = process.env.REVEAL_SCRATCH ||
  "/private/tmp/claude-501/-Users-connorrivera-KAIRA/70cd36f7-bded-4b7d-9e16-7758b2071b68/scratchpad/frames";
const previewDir = join(projectRoot, "source/motion/preview");

const CHROME = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const PORT = 4460, DEBUG_PORT = 9224;
const FPS = 60, SS = 3; // subframes per frame, spread over half the interval

function opt(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = (name) => process.argv.includes(name);

const stageFile = opt("--stage", "stage.html");
const cacheDir = join(projectRoot, opt("--cache", "source/render-cache-v2"));
const markersFile = opt("--markers-out", "markers.json");

/* ------------------------------------------------------------- tiny server */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png",
  ".jpg": "image/jpeg", ".woff2": "font/woff2", ".css": "text/css", ".txt": "text/plain" };
const server = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  let file = null;
  if (url === "/") file = join(here, stageFile);
  else if (url === "/film.js") file = join(here, "film.js");
  else if (url === "/film-v3.js") file = join(here, "film-v3.js");
  else if (url === "/film-v4.js") file = join(here, "film-v4.js");
  else if (url.startsWith("/stills/")) file = join(stillsDir, url.slice(8));
  else if (url.startsWith("/seq/")) file = join(seqDir, url.slice(5));
  else if (url.startsWith("/fonts/")) file = join(fontsDir, url.slice(7));
  if (!file || !existsSync(file)) { res.writeHead(404); return res.end("nope"); }
  res.writeHead(200, { "Content-Type": MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/* ---------------------------------------------------------------- CDP glue */
class CDP {
  constructor(ws) {
    this.ws = ws; this.pending = new Map(); this.id = 0;
    ws.addEventListener("message", ({ data }) => {
      const m = JSON.parse(String(data));
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result);
      }
    });
  }
  call(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

let chrome = null;
async function startChrome() {
  chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
    "--force-color-profile=srgb", "--window-size=1920,1080",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- The script starts this loopback-only CDP endpoint itself; it is never a product request.
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener("open", res, { once: true });
          ws.addEventListener("error", rej, { once: true });
        });
        return new CDP(ws);
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("chrome did not come up");
}

const cdp = await startChrome();
process.on("exit", () => { try { chrome?.kill(); } catch {} });
process.on("SIGINT", () => process.exit(130));

await cdp.call("Page.enable");
await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await cdp.call("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 200; i++) {
  const { result } = await cdp.call("Runtime.evaluate", { expression: "window.__READY === true", returnByValue: true });
  if (result.value === true) break;
  await new Promise((r) => setTimeout(r, 150));
}
const fonts = (await cdp.call("Runtime.evaluate", { expression: "JSON.stringify(window.__FONTS)", returnByValue: true })).result.value;
const film = JSON.parse((await cdp.call("Runtime.evaluate", { expression: "JSON.stringify(window.FILM)", returnByValue: true })).result.value);
console.log(`stage ready · fonts=${fonts} · duration=${film.duration}s · chunks=${film.chunks.length - 1}`);

async function seek(t) {
  const { result, exceptionDetails } = await cdp.call("Runtime.evaluate", {
    expression: `SEEK(${t.toFixed(6)})`, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`SEEK(${t}) threw: ${exceptionDetails.text} ${exceptionDetails.exception?.description || ""}`);
  if (result.value !== "ok") throw new Error(`SEEK(${t}) returned ${result.value}`);
}
async function shoot(format = "jpeg", quality = 92) {
  for (let attempt = 0; ; attempt++) {
    try {
      const shot = await cdp.call("Page.captureScreenshot", format === "jpeg" ? { format, quality } : { format });
      return Buffer.from(shot.data, "base64");
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

/* -------------------------------------------------------------- markers */
if (flag("--dump-markers")) {
  const markers = (await cdp.call("Runtime.evaluate", { expression: "JSON.stringify(window.MARKERS)", returnByValue: true })).result.value;
  await writeFile(join(here, markersFile), markers);
  console.log(`${markersFile} written`);
  process.exit(0);
}

/* -------------------------------------------------------------- preview */
const preview = opt("--preview", null);
if (preview) {
  await mkdir(previewDir, { recursive: true });
  for (const ts of preview.split(",").map(Number)) {
    await seek(ts);
    await new Promise((r) => setTimeout(r, 60));
    const buf = await shoot("png");
    const name = `t${ts.toFixed(2).replace(".", "_")}.png`;
    await writeFile(join(previewDir, name), buf);
    console.log(`preview ${name}`);
  }
  process.exit(0);
}

/* --------------------------------------------------------------- render */
await mkdir(cacheDir, { recursive: true });
const wanted = opt("--chunks", null);
const indices = wanted ? wanted.split(",").map(Number)
  : Array.from({ length: film.chunks.length - 1 }, (_, i) => i);

for (const ci of indices) {
  const a = film.chunks[ci], b = film.chunks[ci + 1];
  const outFrames = Math.round((b - a) * FPS);
  const dir = join(scratch, `chunk-${String(ci).padStart(2, "0")}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const t0 = Date.now();
  let n = 0;
  for (let f = 0; f < outFrames; f++) {
    for (let s = 0; s < SS; s++) {
      const t = a + f / FPS + s / (FPS * 2 * SS); // 180° shutter
      await seek(t);
      const buf = await shoot("jpeg", 92);
      await writeFile(join(dir, `sub-${String(n++).padStart(6, "0")}.jpg`), buf);
    }
    if (f % 120 === 0 && f > 0) {
      const rate = n / ((Date.now() - t0) / 1000);
      console.log(`chunk ${ci}: frame ${f}/${outFrames} (${rate.toFixed(1)} subs/s)`);
    }
  }

  const outFile = join(cacheDir, `chunk-${String(ci).padStart(2, "0")}.mp4`);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-framerate", "180", "-i", join(dir, "sub-%06d.jpg"),
    "-vf", "tmix=frames=3:weights='1 1 1',select='eq(mod(n\\,3)\\,2)',setpts=N/(60*TB),format=yuv420p",
    "-fps_mode", "vfr",
    "-c:v", "libx264", "-preset", "slow", "-crf", "15",
    outFile,
  ]);
  const got = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", outFile]).toString().trim();
  console.log(`chunk ${ci}: ${outFrames} frames wanted, ${got} encoded -> ${outFile}`);
  if (!flag("--keep-frames")) await rm(dir, { recursive: true, force: true });
}

/* concat when everything exists */
const files = (await readdir(cacheDir)).filter((f) => /^chunk-\d\d\.mp4$/.test(f)).sort();
if (files.length === film.chunks.length - 1 && !wanted) {
  const list = files.map((f) => `file '${join(cacheDir, f)}'`).join("\n");
  await writeFile(join(cacheDir, "concat.txt"), list);
  const lock = join(cacheDir, "picture-lock.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
    "-i", join(cacheDir, "concat.txt"), "-c", "copy", lock]);
  console.log(`picture lock -> ${lock}`);
}
process.exit(0);
