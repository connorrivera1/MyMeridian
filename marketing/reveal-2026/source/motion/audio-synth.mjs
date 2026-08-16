#!/usr/bin/env node
/**
 * Deterministic sound design for the MyMeridian reveal.
 *
 * Reads markers.json (exported straight from the film timeline, so every hit
 * is sample-locked to picture) and synthesizes the SFX stem: sub impacts on
 * section morphs, near-silent interface ticks on spotlights, one restrained
 * riser into the closing splash, and the brand tone under the final card.
 * All DSP is plain math — no samples, no AI — output is a 48k stereo WAV.
 *
 *   node audio-synth.mjs            -> ../render-cache-v2/sfx.wav
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const markers = JSON.parse(await readFile(join(here, "markers.json"), "utf8"));

const SR = 48000, DUR = 60;
const L = new Float64Array(SR * DUR);
const R = new Float64Array(SR * DUR);

const TAU = Math.PI * 2;
function add(t0, dur, fn, gain = 1, pan = 0) {
  const start = Math.floor(t0 * SR);
  const n = Math.floor(dur * SR);
  const gl = gain * Math.min(1, 1 - pan);
  const gr = gain * Math.min(1, 1 + pan);
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= L.length) continue;
    const v = fn(i / SR, i / n);
    L[idx] += v * gl;
    R[idx] += v * gr;
  }
}

/* deep, soft sub impact: sine with exponential pitch drop + fast attack */
function subHit(t, gain = 0.5, base = 52) {
  let phase = 0, lastT = 0;
  add(t, 0.55, (tt, p) => {
    const f = base * (1 + 0.65 * Math.exp(-tt * 22));
    phase += TAU * f * (tt - lastT); lastT = tt;
    const env = Math.min(1, tt / 0.004) * Math.exp(-tt * 7.5);
    const body = Math.sin(phase);
    const knock = Math.sin(TAU * 180 * tt) * Math.exp(-tt * 60) * 0.25;
    return (body + knock) * env;
  }, gain);
}

/* tiny interface tick: two short partials, barely there */
function tick(t, gain = 0.05) {
  add(t, 0.05, (tt) => {
    const env = Math.min(1, tt / 0.001) * Math.exp(-tt * 160);
    return (Math.sin(TAU * 2300 * tt) * 0.7 + Math.sin(TAU * 3400 * tt) * 0.3) * env;
  }, gain);
}

/* softer, lower blip for text/line arrivals */
function blip(t, gain = 0.045) {
  add(t, 0.09, (tt) => {
    const env = Math.min(1, tt / 0.003) * Math.exp(-tt * 70);
    return Math.sin(TAU * 740 * tt) * env;
  }, gain);
}

/* filtered-noise riser: deterministic xorshift noise through a rising tilt */
function riser(t0, dur, gain = 0.16) {
  let s = 88172645463325252n;
  const rand = () => {
    s ^= s << 13n; s &= 0xffffffffffffffffn;
    s ^= s >> 7n; s ^= s << 17n; s &= 0xffffffffffffffffn;
    return Number(s % 20000n) / 10000 - 1;
  };
  let lp = 0;
  add(t0, dur, (tt, p) => {
    const cut = 0.002 + 0.28 * p * p;            // opening low-pass
    lp += (rand() - lp) * cut;
    const env = Math.pow(p, 1.6) * (p > 0.94 ? (1 - p) / 0.06 : 1); // swell, snap off
    return lp * env * 2.2;
  }, gain);
}

/* the meridian tone: soft fifth, slow attack, long release */
function brandTone(t, gain = 0.14) {
  add(t, 3.4, (tt, p) => {
    const attack = Math.min(1, tt / 0.5);
    const rel = Math.exp(-Math.max(0, tt - 1.2) * 1.4);
    const a = Math.sin(TAU * 220 * tt) * 0.55;      // A3
    const e = Math.sin(TAU * 329.63 * tt) * 0.3;    // E4
    const sub = Math.sin(TAU * 110 * tt) * 0.35;    // A2 anchor
    const shimmer = Math.sin(TAU * 659.25 * tt) * 0.06 * Math.exp(-tt * 2.2);
    return (a + e + sub + shimmer) * attack * rel;
  }, gain);
}

/* ------------------------------------------------------------ the score */
/* opening lines land as near-silent blips */
for (const t of markers.titles) blip(t + 0.05, 0.05);

/* splash open: soft low arrival, then the push-through gets the first real hit */
subHit(markers.splashOpen, 0.3, 44);
subHit(markers.splashPush, 0.46, 50);

/* every section morph: one sub impact, weight varied so it breathes */
const morphs = markers.cuts.filter((t) => t > 7);
const weights = { "11.15": 0.5, "15.05": 0.44, "19.45": 0.5, "24.45": 0.44, "28.85": 0.4, "31.05": 0.3, "32.95": 0.46, "41.05": 0.5, "47.65": 0.52 };
for (const t of morphs) subHit(t + 0.02, weights[String(t)] ?? 0.4);

/* spotlights: interface ticks (quieter when they come in bursts) */
markers.spots.forEach((t, i) => tick(t + 0.06, i % 2 ? 0.034 : 0.042));

/* lower-third lines arrive with a soft blip */
for (const t of markers.l3s) blip(t + 0.1, 0.04);
for (const t of markers.triplet) blip(t + 0.05, 0.055);

/* the close: riser into the splash, brand tone under the lockup, final beats tick */
riser(markers.splashClose - 2.1, 2.1, 0.15);
subHit(markers.splashClose + 0.05, 0.42, 46);
brandTone(markers.finalBeats[0] - 0.15);
tick(markers.finalBeats[1], 0.03);
tick(markers.finalBeats[2], 0.026);

/* gentle collective ceiling so nothing spikes */
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
const out = join(here, "../render-cache-v2/sfx.wav");
await writeFile(out, pcm);
console.log(`sfx stem -> ${out} (peak ${(peak * norm).toFixed(3)})`);
