#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const specifications = [
  {
    scenario: 1,
    filename: "plugin-lifecycle-01-author-publish.mp4",
    minimumDuration: 30,
    milestones: [
      "incident-draft-preview",
      "incident-candidate-hidden",
      "incident-verification-evidence",
      "incident-publication-approval",
      "incident-published",
      "incident-import-review",
      "incident-installed",
      "incident-worker-ui-opened",
    ],
  },
  {
    scenario: 2,
    filename: "plugin-lifecycle-02-cross-user-import-use.mp4",
    minimumDuration: 45,
    milestones: [
      "board-draft-preview",
      "board-candidate-hidden",
      "board-verification-evidence",
      "board-publication-approval",
      "board-published",
      "reviewer-identity",
      "reviewer-import-review",
      "reviewer-installed",
      "reviewer-state-mutated",
      "reviewer-state-persisted-after-reload",
    ],
  },
  {
    scenario: 3,
    filename: "plugin-lifecycle-03-safe-uninstall.mp4",
    minimumDuration: 20,
    milestones: [
      "uninstall-state-present-before-removal",
      "uninstall-retention-review",
      "uninstall-complete-state-retained",
      "purge-separate-irreversible-review",
      "purge-complete",
    ],
  },
];

const durations = new Map();
for (const specification of specifications) {
  const path = join(ROOT, "docs", specification.filename);
  const probed = spawnSync(ffprobe.path, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,avg_frame_rate:format=duration",
    "-of", "json", path,
  ], {encoding: "utf8"});
  if (probed.status !== 0) {
    throw new Error(specification.filename + ": ffprobe failed\n" + probed.stderr);
  }
  const metadata = JSON.parse(probed.stdout);
  const stream = metadata.streams?.[0];
  const duration = Number(metadata.format?.duration);
  if (stream?.codec_name !== "h264" || stream.width !== 1600 || stream.height !== 900) {
    throw new Error(specification.filename + ": expected H.264 1600x900.");
  }
  if (!Number.isFinite(duration) || duration < specification.minimumDuration) {
    throw new Error(
      `${specification.filename}: expected at least ${specification.minimumDuration}s of interaction.`,
    );
  }
  durations.set(specification.filename, duration);

  const frames = spawnSync(ffmpegPath, [
    "-v", "error", "-i", path, "-vf", "fps=1", "-f", "framemd5", "-",
  ], {encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
  if (frames.status !== 0) {
    throw new Error(specification.filename + ": frame scan failed\n" + frames.stderr);
  }
  const hashes = frames.stdout.split("\n")
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.split(",").at(-1)?.trim())
    .filter(Boolean);
  const unique = new Set(hashes).size;
  if (unique < 12 || unique / hashes.length < 0.12) {
    throw new Error(specification.filename + ": insufficient changing content; possible still/slideshow.");
  }
  console.log(
    `${specification.filename}: H.264 1600x900, ${duration.toFixed(1)}s, ` +
      `${unique}/${hashes.length} unique sampled frames`,
  );
}

const evidence = JSON.parse(await readFile(
  join(ROOT, "docs", "plugin-lifecycle-video-evidence.json"),
  "utf8",
));
if (evidence.schemaVersion !== 2 ||
    evidence.capture !== "continuous Playwright Chromium viewport recording" ||
    evidence.viewport?.width !== 1600 || evidence.viewport?.height !== 900 ||
    evidence.scenarios?.length !== specifications.length) {
  throw new Error("Missing schema-v2 continuous browser-capture evidence.");
}

for (const specification of specifications) {
  const scenario = evidence.scenarios.find(candidate => candidate.scenario === specification.scenario);
  if (!scenario || scenario.filename !== specification.filename) {
    throw new Error(`Scenario ${specification.scenario}: evidence file mismatch.`);
  }
  const names = scenario.milestones?.map(milestone => milestone.name) ?? [];
  if (JSON.stringify(names) !== JSON.stringify(specification.milestones)) {
    throw new Error(`Scenario ${specification.scenario}: milestone sequence mismatch.`);
  }
  let previousTimestamp = -Infinity;
  const duration = durations.get(specification.filename);
  for (const milestone of scenario.milestones) {
    if (!Number.isFinite(milestone.timestampSeconds) ||
        milestone.timestampSeconds <= previousTimestamp ||
        milestone.timestampSeconds > duration + 3) {
      throw new Error(`Scenario ${specification.scenario}: invalid timestamp for ${milestone.name}.`);
    }
    if (previousTimestamp !== -Infinity && milestone.timestampSeconds - previousTimestamp < 1.5) {
      throw new Error(`Scenario ${specification.scenario}: ${milestone.name} was not held visibly.`);
    }
    if (milestone.expectedVisibleText &&
        !milestone.observedText?.includes(milestone.expectedVisibleText)) {
      throw new Error(`Scenario ${specification.scenario}: missing visible proof for ${milestone.name}.`);
    }
    previousTimestamp = milestone.timestampSeconds;
  }
  console.log(`Scenario ${specification.scenario}: ${names.length} semantic milestones verified`);
}
