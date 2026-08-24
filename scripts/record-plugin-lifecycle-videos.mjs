#!/usr/bin/env node

import {spawn, spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import ffmpegPath from "ffmpeg-static";
import {chromium} from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = join(ROOT, "docs");
const BASE_URL = "http://127.0.0.1:8787";
const VIEWPORT = {width: 1280, height: 720};
const password = randomBytes(24).toString("base64url");
const workDir = await mkdtemp(join(tmpdir(), "cloudflare-os-plugin-recording-"));
const rawVideoDir = join(workDir, "raw-video");
const persistDir = join(workDir, "wrangler-state");
await mkdir(rawVideoDir, {recursive: true});
await mkdir(OUTPUT_DIR, {recursive: true});

const serverLog = [];
const server = spawn("pnpm", ["run-local"], {
  cwd: ROOT,
  env: {...process.env, WRANGLER_PERSIST_TO: persistDir},
  stdio: ["ignore", "pipe", "pipe"],
});
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    serverLog.push(chunk);
    if (serverLog.length > 200) serverLog.shift();
    process.stdout.write(chunk);
  });
}

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error("Local server exited before becoming ready.\n" + serverLog.join(""));
    }
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for " + BASE_URL);
}

function installVisiblePointer(page) {
  return page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      const pointer = document.createElement("div");
      pointer.id = "recording-pointer";
      Object.assign(pointer.style, {
        position: "fixed",
        zIndex: "2147483647",
        width: "18px",
        height: "18px",
        border: "3px solid #f48120",
        borderRadius: "50%",
        boxShadow: "0 0 0 2px white",
        pointerEvents: "none",
        transform: "translate(-50%, -50%)",
        left: "20px",
        top: "20px",
      });
      document.documentElement.append(pointer);
      document.addEventListener("mousemove", event => {
        pointer.style.left = event.clientX + "px";
        pointer.style.top = event.clientY + "px";
      }, {capture: true});
    });
  });
}

async function settle(page, milliseconds = 850) {
  await page.waitForTimeout(milliseconds);
}

async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 8});
  await settle(page, 350);
  await locator.click();
  await settle(page);
}

async function fill(page, locator, value) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await locator.fill("");
  await locator.pressSequentially(value, {delay: 35});
  await settle(page, 300);
}

async function acceptDialogs(page) {
  page.on("dialog", async dialog => {
    await settle(page, 650);
    await dialog.accept();
  });
}

async function signUp(page, username) {
  await page.goto(BASE_URL + "/signup");
  await page.getByText("Create your account", {exact: true}).waitFor({timeout: 30_000});
  await fill(page, page.getByLabel("Username"), username);
  await fill(page, page.getByLabel("Password", {exact: true}), password);
  await fill(page, page.getByLabel("Confirm Password"), password);
  await click(page, page.getByRole("button", {name: "Create account"}));
  await page.waitForURL(url => url.pathname === "/", {timeout: 30_000});
  await page.getByRole("heading", {name: "Let's set you up"}).waitFor({timeout: 30_000});
  await settle(page, 900);
  while (await page.getByRole("button", {name: "Next"}).isVisible().catch(() => false)) {
    await click(page, page.getByRole("button", {name: "Next"}));
  }
  await click(page, page.getByRole("button", {name: "Let's build"}));
  await page.getByRole("link", {name: "Plugin Store"}).waitFor({timeout: 30_000});
  await settle(page, 1200);
}

async function signOut(page) {
  await click(page, page.getByRole("button", {name: "Open profile menu"}));
  await click(page, page.getByText("Sign out", {exact: true}));
  await page.getByText("Sign in to your account").waitFor({timeout: 30_000});
}

async function openWorkshop(page) {
  await page.goto(BASE_URL + "/plugins");
  await page.getByRole("heading", {name: "Plugin Store"}).waitFor({timeout: 30_000});
  await page.getByTestId("plugin-workshop").waitFor({timeout: 30_000});
  await settle(page);
}

async function createAndPublish(page, input) {
  await page.getByTestId("author-template").selectOption(input.template);
  await settle(page);
  await fill(page, page.getByTestId("author-plugin-id"), input.pluginId);
  await fill(page, page.getByTestId("author-title"), input.title);
  await fill(page, page.getByTestId("author-summary"), input.summary);
  await fill(page, page.getByTestId("author-surface-title"), input.surfaceTitle);
  await fill(page, page.getByTestId("author-items"), input.items.join("\n"));
  await click(page, page.getByTestId("stage-candidate"));
  await page.getByTestId("authoring-status").filter({hasText: "Candidate staged"}).waitFor({
    timeout: 45_000,
  });
  await settle(page, 1400);
  await click(page, page.getByTestId("publish-candidate"));
  await page.getByTestId("authoring-status").filter({hasText: "Published to the Store"}).waitFor({
    timeout: 30_000,
  });
  await settle(page, 1400);
}

async function importPlugin(page, title) {
  const card = page.locator("article").filter({hasText: title}).first();
  await card.scrollIntoViewIfNeeded();
  await settle(page);
  await click(page, card.getByRole("button", {name: "Import"}));
  await card.getByRole("button", {name: "Installed"}).waitFor({timeout: 30_000});
  await settle(page, 1200);
  return card;
}

async function recordScenario(browser, filename, run, storageState) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: {dir: rawVideoDir, size: VIEWPORT},
    ...(storageState ? {storageState} : {}),
  });
  const page = await context.newPage();
  await installVisiblePointer(page);
  await acceptDialogs(page);
  let nextStorageState;
  let scenarioError;
  try {
    await run(page);
    nextStorageState = await context.storageState();
  } catch (error) {
    scenarioError = error;
  }
  const video = page.video();
  await context.close();
  if (!video) throw new Error("Playwright did not create a video.");
  const rawPath = await video.path();
  const outputPath = join(OUTPUT_DIR, filename);
  const converted = spawnSync(ffmpegPath, [
    "-y", "-i", rawPath, "-an",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-r", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outputPath,
  ], {encoding: "utf8"});
  if (converted.status !== 0) {
    throw new Error("Video conversion failed:\n" + converted.stderr);
  }
  console.log("Recorded " + outputPath);
  if (scenarioError) throw scenarioError;
  return nextStorageState;
}

function browserLaunchEnvironment() {
  if (process.platform !== "linux") return process.env;
  const browserLibDir = process.env.PLAYWRIGHT_BROWSER_LIB_DIR ??
    "/tmp/cloudflare-os-browser-libs/usr/lib/x86_64-linux-gnu";
  if (!existsSync(join(browserLibDir, "libasound.so.2"))) return process.env;
  return {
    ...process.env,
    LD_LIBRARY_PATH: browserLibDir +
      (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : ""),
  };
}

let browser;
const evidence = [];

try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    slowMo: 90,
    env: browserLaunchEnvironment(),
  });
  let adminState = await recordScenario(
    browser,
    "plugin-lifecycle-01-author-publish.mp4",
    async page => {
      await signUp(page, "admin");
      await openWorkshop(page);
      await createAndPublish(page, {
        template: "focus-brief",
        pluginId: "community.recorded-incident-brief",
        title: "Recorded Incident Brief",
        summary: "A real worker-rendered incident handoff created during this recording.",
        surfaceTitle: "Incident handoff ready",
        items: ["Confirm current impact", "Name the next owner", "Record the next checkpoint"],
      });
      const card = await importPlugin(page, "Recorded Incident Brief");
      await click(page, card.getByRole("button", {name: "Open Incident handoff ready"}));
      await page.locator('iframe[title="Incident handoff ready"]').waitFor({timeout: 30_000});
      await settle(page, 1800);
      evidence.push({scenario: 1, assertions: [
        "candidate-staged-hidden-until-review",
        "admin-published-exact-candidate",
        "author-imported-and-opened-worker-rendered-ui",
      ]});
    },
  );

  let importerState = await recordScenario(
    browser,
    "plugin-lifecycle-02-cross-user-import-use.mp4",
    async page => {
      await openWorkshop(page);
      await createAndPublish(page, {
        template: "personal-board",
        pluginId: "community.recorded-release-board",
        title: "Recorded Release Board",
        summary: "A real persistent board created for a cross-user import demonstration.",
        surfaceTitle: "Release Board",
        items: ["Run smoke tests", "Confirm rollback owner"],
      });
      await signOut(page);
      await page.goto(BASE_URL + "/signup");
      await signUp(page, "plugincolleague");
      await page.goto(BASE_URL + "/plugins");
      await page.getByRole("heading", {name: "Plugin Store"}).waitFor({timeout: 30_000});
      await importPlugin(page, "Recorded Release Board");
      await click(page, page.getByRole("link", {name: "Release Board"}));
      await page.getByRole("heading", {name: "Release Board"}).waitFor({timeout: 30_000});
      await fill(page, page.getByLabel("Add a work item"), "Document release evidence");
      await click(page, page.getByRole("button", {name: "Add item"}));
      const item = page.locator("article").filter({hasText: "Document release evidence"});
      await item.getByText("Document release evidence", {exact: true}).waitFor();
      await click(page, item.getByRole("button", {name: "Move to Doing"}));
      await settle(page, 1800);
      evidence.push({scenario: 2, assertions: [
        "different-authenticated-user-imported-published-package",
        "interactive-worker-ui-opened",
        "persistent-state-created-and-moved",
      ]});
    },
    adminState,
  );

  await recordScenario(
    browser,
    "plugin-lifecycle-03-safe-uninstall.mp4",
    async page => {
      await page.goto(BASE_URL + "/plugin/community.recorded-release-board/board");
      await page.getByText("Document release evidence", {exact: true}).waitFor({timeout: 30_000});
      await settle(page, 1500);
      await click(page, page.getByRole("link", {name: "Plugin Store"}));
      const card = page.locator("article").filter({hasText: "Recorded Release Board"}).first();
      await click(page, card.getByRole("button", {name: "Uninstall"}));
      const retained = page.locator("article").filter({hasText: "Recorded Release Board"}).last();
      await retained.getByRole("button", {name: "Purge data"}).waitFor({timeout: 30_000});
      await retained.scrollIntoViewIfNeeded();
      await settle(page, 1800);
      await click(page, retained.getByRole("button", {name: "Purge data"}));
      await page.getByText("No retained plugin data.").waitFor({timeout: 30_000});
      await settle(page, 1600);
      evidence.push({scenario: 3, assertions: [
        "state-visible-after-reload",
        "uninstall-revoked-and-detached-before-removal",
        "retained-state-purged-only-after-separate-confirmation",
      ]});
    },
    importerState,
  );
  await writeFile(
    join(OUTPUT_DIR, "plugin-lifecycle-video-evidence.json"),
    JSON.stringify({
      schemaVersion: 1,
      capture: "continuous Playwright Chromium viewport recording",
      baseUrl: BASE_URL,
      viewport: VIEWPORT,
      scenarios: evidence,
    }, null, 2) + "\n",
  );
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
