#!/usr/bin/env node
/**
 * v3 sound design — foley + impacts synthesized from markers-v3.json.
 * The hook cuts carry their own transients (tape rip, label press, scanner
 * beep); every section morph gets a weighted sub; spotlights tick quietly;
 * one riser into the closing splash; the brand tone under the final card.
 * Pure DSP, sample-locked to picture. Output: render-cache-v3/sfx.wav
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const M = JSON.parse(await readFile(join(here, "markers-v3.json"), "utf8"));

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

let rngS = 0x9e3779b9;
const rng = () => {
  rngS ^= rngS << 13; rngS >>>= 0; rngS ^= rngS >> 17; rngS ^= rngS << 5; rngS >>>= 0;
  return (rngS & 0xffff) / 32768 - 1;
};

function subHit(t, gain = 0.5, base = 52) {
  let phase = 0, lastT = 0;
  add(t, 0.55, (tt) => {
    const f = base * (1 + 0.65 * Math.exp(-tt * 22));
    phase += TAU * f * (tt - lastT); lastT = tt;
    const env = Math.min(1, tt / 0.004) * Math.exp(-tt * 7.5);
    return (Math.sin(phase) + Math.sin(TAU * 180 * tt) * Math.exp(-tt * 60) * 0.25) * env;
  }, gain);
}
function knock(t, gain = 0.2) {
  add(t, 0.16, (tt) => {
    const env = Math.min(1, tt / 0.003) * Math.exp(-tt * 34);
    return (Math.sin(TAU * 92 * tt) * 0.8 + Math.sin(TAU * 248 * tt) * 0.25) * env;
  }, gain);
}
function tick(t, gain = 0.04) {
  add(t, 0.05, (tt) => {
    const env = Math.min(1, tt / 0.001) * Math.exp(-tt * 160);
    return (Math.sin(TAU * 2300 * tt) * 0.7 + Math.sin(TAU * 3400 * tt) * 0.3) * env;
  }, gain);
}
function keyClick(t, gain = 0.07) {
  add(t, 0.06, (tt) => {
    const env = Math.min(1, tt / 0.0015) * Math.exp(-tt * 110);
    return (Math.sin(TAU * 1750 * tt) * 0.5 + rng() * 0.5) * env;
  }, gain);
}
function tapeRip(t, gain = 0.30) {
  let lp = 0, gate = 1;
  add(t, 0.55, (tt, p) => {
    const w = rng();
    lp += (w - lp) * 0.55;                    // keep the highs, tame lows
    if ((Math.floor(tt * 380) % 7) === 0) gate = 0.35 + Math.abs(rng()) * 0.65; // ragged
    const env = Math.min(1, tt / 0.02) * (1 - p) * (0.6 + 0.4 * Math.sin(TAU * 9 * tt));
    return (w - lp * 0.7) * gate * env;
  }, gain);
}
function scanBeep(t, gain = 0.10) {
  for (const [dt, f] of [[0, 1318.5], [0.095, 1760]]) {
    add(t + dt, 0.075, (tt) => {
      const env = Math.min(1, tt / 0.004) * (tt > 0.06 ? (0.075 - tt) / 0.015 : 1);
      return Math.sin(TAU * f * tt) * env;
    }, gain);
  }
}
function riser(t0, dur, gain = 0.15) {
  let lp = 0;
  add(t0, dur, (tt, p) => {
    const cut = 0.002 + 0.28 * p * p;
    lp += (rng() - lp) * cut;
    const env = Math.pow(p, 1.6) * (p > 0.94 ? (1 - p) / 0.06 : 1);
    return lp * env * 2.2;
  }, gain);
}
function brandTone(t, gain = 0.14) {
  add(t, 3.4, (tt) => {
    const attack = Math.min(1, tt / 0.5);
    const rel = Math.exp(-Math.max(0, tt - 1.2) * 1.4);
    return (Math.sin(TAU * 220 * tt) * 0.55 + Math.sin(TAU * 329.63 * tt) * 0.3 +
            Math.sin(TAU * 110 * tt) * 0.35 + Math.sin(TAU * 659.25 * tt) * 0.06 * Math.exp(-tt * 2.2))
           * attack * rel;
  }, gain);
}

/* ---------------------------------------------------------------- score */
tapeRip(M.hook.tapeRip);
knock(M.hook.labelPress, 0.26);
scanBeep(M.hook.scanBeep);
subHit(M.hook.blackSmash, 0.40, 46);
subHit(M.hook.keptHit, 0.46, 44);

subHit(M.splashOpen, 0.26, 44);
subHit(M.splashPush, 0.46, 50);

const bigCuts = new Set([10.9, 22.1, 29.4, 37.2, 42.6]);
for (const t of M.uiCuts) subHit(t + 0.02, bigCuts.has(t) ? 0.46 : 0.3);
for (const t of M.footageCuts) if (t > 4) knock(t + 0.02, 0.17);
for (const t of M.deviceBeats) knock(t, 0.22);
for (const t of M.keysTicks) keyClick(t);
M.spots.forEach((t, i) => tick(t + 0.06, i % 2 ? 0.026 : 0.034));
for (const tp of M.triplet) add(tp + 0.04, 0.09, (tt) => {
  const env = Math.min(1, tt / 0.003) * Math.exp(-tt * 70);
  return Math.sin(TAU * 740 * tt) * env;
}, 0.05);

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
await writeFile(join(here, "../render-cache-v3/sfx.wav"), pcm);
console.log(`v3 sfx stem written (peak ${(peak * norm).toFixed(3)})`);
