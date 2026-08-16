#!/usr/bin/env node
/**
 * v4 sound design — chat foley + component builds, from markers-v4.json.
 * Original DSP throughout (no Apple sounds, no samples): message pops are
 * synthesized chirps, component arrivals are ticks and knocks, section
 * lands get weighted subs, one riser into the closing splash, brand tone
 * under the final card. Output: render-cache-v4/sfx.wav
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const M = JSON.parse(await readFile(join(here, "markers-v4.json"), "utf8"));

const SR = 48000, DUR = 60;
const L = new Float64Array(SR * DUR), R = new Float64Array(SR * DUR);
const TAU = Math.PI * 2;
function add(t0, dur, fn, gain = 1) {
  const start = Math.floor(t0 * SR), n = Math.floor(dur * SR);
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= L.length) continue;
    const v = fn(i / SR, i / n) * gain;
    L[idx] += v; R[idx] += v;
  }
}
let rs = 0x2545f491;
const rng = () => { rs ^= rs << 13; rs >>>= 0; rs ^= rs >> 17; rs ^= rs << 5; rs >>>= 0; return (rs & 0xffff) / 32768 - 1; };

function subHit(t, gain = 0.5, base = 52) {
  let phase = 0, lastT = 0;
  add(t, 0.55, (tt) => {
    const f = base * (1 + 0.65 * Math.exp(-tt * 22));
    phase += TAU * f * (tt - lastT); lastT = tt;
    return (Math.sin(phase) + Math.sin(TAU * 180 * tt) * Math.exp(-tt * 60) * 0.25) *
           Math.min(1, tt / 0.004) * Math.exp(-tt * 7.5);
  }, gain);
}
function knock(t, gain = 0.2) {
  add(t, 0.16, (tt) => (Math.sin(TAU * 92 * tt) * 0.8 + Math.sin(TAU * 248 * tt) * 0.25) *
    Math.min(1, tt / 0.003) * Math.exp(-tt * 34), gain);
}
function tick(t, gain = 0.032) {
  add(t, 0.05, (tt) => (Math.sin(TAU * 2300 * tt) * 0.7 + Math.sin(TAU * 3400 * tt) * 0.3) *
    Math.min(1, tt / 0.001) * Math.exp(-tt * 160), gain);
}
function chirpUp(t, f0, f1, dur, gain) {   // send whoosh-pop
  let phase = 0, lastT = 0;
  add(t, dur, (tt, p) => {
    const f = lerp(f0, f1, p * p);
    phase += TAU * f * (tt - lastT); lastT = tt;
    return Math.sin(phase) * Math.sin(Math.PI * p);
  }, gain);
}
const lerp = (a, b, p) => a + (b - a) * p;
function pop(t, f = 620, gain = 0.16) {
  add(t, 0.12, (tt) => Math.sin(TAU * f * tt * (1 - tt * 1.8)) * Math.min(1, tt / 0.004) * Math.exp(-tt * 30), gain);
}
function shimmer(t0, dur, gain = 0.05) {
  let lp = 0;
  add(t0, dur, (tt, p) => {
    lp += (rng() - lp) * (0.15 + 0.25 * p);
    return lp * Math.sin(Math.PI * p) * 1.6;
  }, gain);
}
function riser(t0, dur, gain = 0.15) {
  let lp = 0;
  add(t0, dur, (tt, p) => {
    lp += (rng() - lp) * (0.002 + 0.28 * p * p);
    return lp * Math.pow(p, 1.6) * (p > 0.94 ? (1 - p) / 0.06 : 1) * 2.2;
  }, gain);
}
function brandTone(t, gain = 0.14) {
  add(t, 3.4, (tt) => {
    const attack = Math.min(1, tt / 0.5), rel = Math.exp(-Math.max(0, tt - 1.2) * 1.4);
    return (Math.sin(TAU * 220 * tt) * 0.55 + Math.sin(TAU * 329.63 * tt) * 0.3 +
            Math.sin(TAU * 110 * tt) * 0.35 + Math.sin(TAU * 659.25 * tt) * 0.06 * Math.exp(-tt * 2.2)) * attack * rel;
  }, gain);
}

/* ------------------------------------------------------------- the score */
/* chat */
for (let i = 0; i < 5; i++) tick(M.chat.typing[0] + 0.12 + i * 0.15, 0.014);   // typing dots, whisper
pop(M.chat.grayPop, 470, 0.15);                                                // receive
const [ts0, ts1] = M.chat.typeSpan;
for (let i = 0; i < 13; i++) tick(ts0 + (i + 0.5) * (ts1 - ts0) / 13, 0.018);  // keys
tick(M.chat.sendPress, 0.05);
chirpUp(M.chat.sendPress + 0.04, 500, 1350, 0.22, 0.12);                       // send swoosh
pop(M.chat.blueLand, 760, 0.15);                                               // land pop
tick(M.chat.delivered, 0.025);
riser(M.chat.push, 5.10 - M.chat.push, 0.10);                                  // push-in swell

subHit(M.splashArrive, 0.46, 50);

/* sections + builds */
for (const t of M.sections) knock(t + 0.10, 0.16);
for (const t of M.headers) tick(t + 0.05, 0.03);
M.pieceIns.forEach((t, i) => tick(t + 0.04, i % 2 ? 0.02 : 0.026));
for (const t of M.lands) subHit(t + 0.03, 0.34, 54);
shimmer(M.count[0], M.count[1] - M.count[0] + 0.15, 0.045);                    // count-up
knock(M.count[1] + 0.02, 0.2);
for (const t of M.triplet) add(t + 0.04, 0.09, (tt) =>
  Math.sin(TAU * 740 * tt) * Math.min(1, tt / 0.003) * Math.exp(-tt * 70), 0.05);

riser(M.riser[0], M.riser[1] - M.riser[0], 0.14);
subHit(M.splashClose + 0.05, 0.4, 46);
brandTone(M.brandTone);
tick(M.finalBeats[1], 0.028);
tick(M.finalBeats[2], 0.024);

let peak = 0;
for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = peak > 0.89 ? 0.89 / peak : 1;
const pcm = Buffer.alloc(44 + L.length * 4);
pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + L.length * 4, 4); pcm.write("WAVE", 8);
pcm.write("fmt ", 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22);
pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34);
pcm.write("data", 36); pcm.writeUInt32LE(L.length * 4, 40);
for (let i = 0; i < L.length; i++) {
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * norm * 32767))), 44 + i * 4);
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * norm * 32767))), 46 + i * 4);
}
await writeFile(join(here, "../render-cache-v4/sfx.wav"), pcm);
console.log(`v4 sfx stem written (peak ${(peak * norm).toFixed(3)})`);
