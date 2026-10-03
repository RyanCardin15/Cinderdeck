import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const starts = [3, 10, 18, 26, 34, 44, 50, 57];
const split = `[0:v]split=8${starts.map((_, i) => `[in${i}]`).join("")}`;
const clips = starts.map(
  (time, i) =>
    `[in${i}]trim=start=${time}:duration=2,setpts=PTS-STARTPTS[v${i}]`,
);
const join = `${starts.map((_, i) => `[v${i}]`).join("")}concat=n=8:v=1:a=0,fps=10,scale=960:-1:flags=lanczos,split[p][q]`;
const palette =
  "[p]palettegen=max_colors=128:stats_mode=diff[pal];[q][pal]paletteuse=dither=bayer:bayer_scale=4[gif]";
execFileSync(
  "ffmpeg",
  [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    path.join(root, "out/cinderdeck-showcase.mp4"),
    "-filter_complex",
    [split, ...clips, join, palette].join(";"),
    "-map",
    "[gif]",
    "-loop",
    "0",
    path.join(root, "out/cinderdeck-showcase.gif"),
  ],
  { stdio: "inherit" },
);
console.log(
  "Wrote out/cinderdeck-showcase.gif: 16 seconds, 960 × 540, 10 fps.",
);
