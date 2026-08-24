#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const files = [
  "plugin-lifecycle-01-author-publish.mp4",
  "plugin-lifecycle-02-cross-user-import-use.mp4",
  "plugin-lifecycle-03-safe-uninstall.mp4",
];

for (const file of files) {
  const path = join(ROOT, "docs", file);
  const probed = spawnSync(ffprobe.path, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate:format=duration",
    "-of", "json", path,
  ], {encoding: "utf8"});
  if (probed.status !== 0) throw new Error(file + ": ffprobe failed\n" + probed.stderr);
  const metadata = JSON.parse(probed.stdout);
  const stream = metadata.streams?.[0];
  const duration = Number(metadata.format?.duration);
  if (stream?.codec_name !== "h264" || stream.width !== 1280 || stream.height !== 720) {
    throw new Error(file + ": expected H.264 1280x720.");
  }
  if (!Number.isFinite(duration) || duration < 10) {
    throw new Error(file + ": recording is too short to evidence a real interaction.");
  }
  const frames = spawnSync(ffmpegPath, [
    "-v", "error", "-i", path, "-vf", "fps=1", "-f", "framemd5", "-",
  ], {encoding: "utf8", maxBuffer: 16 * 1024 * 1024});
  if (frames.status !== 0) throw new Error(file + ": frame scan failed\n" + frames.stderr);
  const hashes = frames.stdout.split("\n")
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.split(",").at(-1)?.trim())
    .filter(Boolean);
  const unique = new Set(hashes).size;
  if (unique < 8 || unique / hashes.length < 0.25) {
    throw new Error(file + ": insufficient changing screen content; possible slideshow/still.");
  }
  console.log(file + ": H.264 1280x720, " + duration.toFixed(1) + "s, " +
    unique + "/" + hashes.length + " unique sampled frames");
}

const evidence = JSON.parse(await readFile(
  join(ROOT, "docs", "plugin-lifecycle-video-evidence.json"),
  "utf8",
));
if (evidence.capture !== "continuous Playwright Chromium viewport recording" ||
    evidence.scenarios?.length !== 3) {
  throw new Error("Missing continuous browser-capture evidence.");
}
console.log("Browser interaction evidence: 3 scenarios");
