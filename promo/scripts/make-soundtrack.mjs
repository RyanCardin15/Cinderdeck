// Original deterministic score. No samples, remote media, or third-party music.
// 120 BPM, D minor / Bb / F / C. Soft pulses, plucked arpeggios, tactile UI cues.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sr = 48000,
  duration = 60,
  total = sr * duration;
const left = new Float32Array(total),
  right = new Float32Array(total);
let seed = 912614;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
};
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
function add(at, len, fn, level = 0.1, pan = 0) {
  const start = Math.round(at * sr),
    count = Math.min(Math.round(len * sr), total - start);
  const l = Math.sqrt((1 - pan) / 2) * level,
    r = Math.sqrt((1 + pan) / 2) * level;
  for (let i = 0; i < count; i++) {
    if (start + i < 0) continue;
    const v = fn(i / sr, i / count);
    left[start + i] += v * l;
    right[start + i] += v * r;
  }
}
const chords = [
  [50, 57, 60, 64, 69],
  [46, 53, 57, 60, 65],
  [53, 60, 64, 67, 72],
  [48, 55, 58, 62, 67],
];
function pad(at, chord, len = 4.7, volume = 0.044) {
  chord.forEach((m, k) =>
    add(
      at,
      len,
      (t, p) => {
        const env = Math.min(1, t / 0.9) * Math.min(1, (len - t) / 1.1);
        return (
          env *
          (Math.sin(2 * Math.PI * hz(m) * t) +
            0.4 * Math.sin(2 * Math.PI * hz(m) * 1.002 * t) +
            0.15 * Math.sin(4 * Math.PI * hz(m) * t)) *
          (0.94 + 0.06 * Math.sin(t * 2.1 + k))
        );
      },
      volume,
      (k - 2) * 0.29,
    ),
  );
}
for (let at = 0; at < 54; at += 4) pad(at, chords[Math.floor(at / 4) % 4]);
pad(54, [50, 57, 60, 64, 69, 74], 6, 0.05);
function pluck(at, m, vol = 0.11, pan = 0) {
  const freq = hz(m),
    len = 1.4;
  const tone = (t) =>
    (Math.sin(2 * Math.PI * freq * t) +
      0.34 * Math.sin(4 * Math.PI * freq * t) +
      0.12 * Math.sin(6 * Math.PI * freq * t)) *
    Math.exp(-t * 5.2) *
    Math.min(1, t / 0.008);
  add(at, len, (t) => tone(t), vol, pan);
  add(at + 0.25, len, (t) => tone(t), vol * 0.19, -pan);
  add(at + 0.5, len, (t) => tone(t), vol * 0.09, pan);
}
const pattern = [0, 2, 4, 1, 3, 2, 4, 2];
for (let at = 6, index = 0; at < 54; at += 0.25, index++) {
  const chord = chords[Math.floor(at / 4) % 4];
  const sparse = at >= 37 && at < 47;
  if (sparse && index % 3 !== 0) continue;
  pluck(
    at,
    chord[pattern[index % 8]] + 12,
    sparse ? 0.055 : at < 14 ? 0.065 : 0.085,
    Math.sin(index * 1.7) * 0.45,
  );
}
for (let at = 14; at < 54; at += 0.5) {
  const sparse = at >= 37 && at < 47,
    beat = Math.round(at * 2);
  if (!sparse || beat % 4 === 0) {
    add(
      at,
      0.32,
      (t) =>
        Math.sin(2 * Math.PI * (45 * t + (12 * (1 - Math.exp(-t * 35))) / 35)) *
        Math.exp(-t * 13) *
        Math.min(1, t / 0.003),
      sparse ? 0.14 : 0.25,
    );
    const rootNote = chords[Math.floor(at / 4) % 4][0] - 12;
    add(
      at + 0.014,
      0.42,
      (t) =>
        (Math.sin(2 * Math.PI * hz(rootNote) * t) +
          0.13 * Math.sin(4 * Math.PI * hz(rootNote) * t)) *
        Math.exp(-t * 5) *
        Math.min(1, t / 0.015),
      0.13,
    );
  }
  if (!sparse) {
    add(
      at + 0.25,
      0.055,
      (t) => noise() * Math.exp(-t * 80) * Math.sin(t * 22000),
      0.022,
      beat % 2 === 0 ? -0.3 : 0.3,
    );
    if (beat % 2 === 1)
      add(
        at,
        0.15,
        (t) =>
          (noise() * 0.6 + Math.sin(2 * Math.PI * 185 * t) * 0.2) *
          Math.exp(-t * 35) *
          Math.min(1, t / 0.002),
        0.042,
        0.15,
      );
  }
}
// Scene changes: soft broadband sweep followed by a tuned low impact.
for (const at of [6, 14, 23, 31, 37, 47, 54]) {
  let filtered = 0;
  add(
    at - 0.42,
    0.7,
    (t, p) => {
      filtered = filtered * 0.85 + noise() * 0.15;
      return filtered * Math.sin(Math.PI * p) ** 2;
    },
    0.15,
    0.1,
  );
  add(
    at,
    0.75,
    (t) =>
      Math.sin(2 * Math.PI * hz(38) * t) *
      Math.exp(-t * 7) *
      Math.min(1, t / 0.006),
    0.17,
  );
}
// Sonic feedback aligned with important on-screen interactions.
for (const at of [
  7.66, 8.05, 8.66, 9.05, 17, 18.2, 19.4, 25.9, 27.15, 29.15, 32.8, 33.73, 34.9,
  35.87, 41.21, 44.35, 48.3, 48.8, 49.3, 49.8, 50.3,
]) {
  pluck(at, at > 40 && at < 45 ? 74 : 86, 0.03, 0.15);
}
pluck(54, 74, 0.14, -0.2);
pluck(54.12, 81, 0.09, 0.2);
pluck(54.25, 86, 0.05, 0);
// Gentle tape saturation and a deliberate tail to exact program duration.
let peak = 0;
for (let i = 0; i < total; i++) {
  const t = i / sr,
    fade = Math.min(1, t / 1.25) * Math.min(1, Math.max(0, (60 - t) / 1.8));
  left[i] = Math.tanh(left[i] * 1.3) * fade;
  right[i] = Math.tanh(right[i] * 1.3) * fade;
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
}
const gain = 0.82 / peak,
  bytes = Buffer.alloc(44 + total * 4);
bytes.write("RIFF", 0);
bytes.writeUInt32LE(bytes.length - 8, 4);
bytes.write("WAVEfmt ", 8);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20);
bytes.writeUInt16LE(2, 22);
bytes.writeUInt32LE(sr, 24);
bytes.writeUInt32LE(sr * 4, 28);
bytes.writeUInt16LE(4, 32);
bytes.writeUInt16LE(16, 34);
bytes.write("data", 36);
bytes.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  bytes.writeInt16LE(
    Math.round(Math.max(-1, Math.min(1, left[i] * gain)) * 32767),
    44 + i * 4,
  );
  bytes.writeInt16LE(
    Math.round(Math.max(-1, Math.min(1, right[i] * gain)) * 32767),
    46 + i * 4,
  );
}
fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.writeFileSync(path.join(root, "public", "soundtrack-raw.wav"), bytes);
console.log(
  `Original stereo score: ${duration}s, ${sr}Hz; peak ${peak.toFixed(3)}. Normalize with the documented FFmpeg command.`,
);
