#!/usr/bin/env node

import {spawn, spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {once} from "node:events";
import {existsSync} from "node:fs";
import {mkdtemp, mkdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {performance} from "node:perf_hooks";
import {fileURLToPath} from "node:url";
import ffmpegPath from "ffmpeg-static";
import {chromium} from "playwright";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = join(ROOT, "docs");
const BASE_URL = "http://127.0.0.1:8787";
const VIEWPORT = {width: 1600, height: 900};
const password = randomBytes(24).toString("base64url");
const workDir = await mkdtemp(join(tmpdir(), "cloudflare-os-plugin-recording-"));
const rawVideoDir = join(workDir, "raw-video");
const milestoneDir = join(workDir, "milestones");
const persistDir = join(workDir, "wrangler-state");
await Promise.all([
  mkdir(rawVideoDir, {recursive: true}),
  mkdir(milestoneDir, {recursive: true}),
  mkdir(OUTPUT_DIR, {recursive: true}),
]);

const serverLog = [];
const server = spawn("pnpm", ["run-local"], {
  cwd: ROOT,
  detached: process.platform !== "win32",
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

async function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  if (process.platform === "win32") server.kill("SIGINT");
  else process.kill(-server.pid, "SIGINT");
  await Promise.race([
    once(server, "exit"),
    new Promise(resolve => setTimeout(resolve, 5_000)),
  ]);
  if (server.exitCode === null && server.signalCode === null) {
    if (process.platform === "win32") server.kill("SIGTERM");
    else process.kill(-server.pid, "SIGTERM");
    await once(server, "exit");
  }
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

async function settle(page, milliseconds = 900) {
  await page.waitForTimeout(milliseconds);
}

async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {steps: 10});
  }
  await settle(page, 350);
  await locator.click();
  await settle(page);
}

async function fill(page, locator, value) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await locator.fill("");
  await locator.pressSequentially(value, {delay: 28});
  await settle(page, 250);
}

async function finishOnboarding(page) {
  await page.getByRole("heading", {name: "Let's set you up"}).waitFor({timeout: 30_000});
  while (await page.getByRole("button", {name: "Next"}).isVisible().catch(() => false)) {
    await page.getByRole("button", {name: "Next"}).click();
  }
  await page.getByRole("button", {name: "Let's build"}).click();
  await page.getByRole("link", {name: "Plugin Store"}).waitFor({timeout: 30_000});
}

async function createAccount(page, username) {
  await page.goto(BASE_URL + "/signup");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", {exact: true}).fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", {name: "Create account"}).click();
  await finishOnboarding(page);
}

async function prepareAccounts(browser) {
  const adminContext = await browser.newContext({viewport: VIEWPORT});
  const adminPage = await adminContext.newPage();
  await createAccount(adminPage, "admin");
  const adminState = await adminContext.storageState();
  await adminContext.close();

  const reviewerContext = await browser.newContext({viewport: VIEWPORT});
  const reviewerPage = await reviewerContext.newPage();
  await createAccount(reviewerPage, "pluginreviewer");
  await reviewerContext.close();
  return adminState;
}

async function signOut(page) {
  await click(page, page.getByRole("button", {name: "Open profile menu"}));
  await click(page, page.getByText("Sign out", {exact: true}));
  await page.getByText("Sign in to your account").waitFor({timeout: 30_000});
}

async function signIn(page, username) {
  await page.goto(BASE_URL + "/login");
  await page.getByText("Sign in to your account").waitFor({timeout: 30_000});
  await fill(page, page.getByLabel("Username"), username);
  await fill(page, page.getByLabel("Password", {exact: true}), password);
  await click(page, page.getByRole("button", {name: "Sign in"}));
  await page.getByRole("link", {name: "Plugin Store"}).waitFor({timeout: 30_000});
}

async function openWorkshop(page) {
  await page.goto(BASE_URL + "/plugins");
  await page.getByRole("heading", {name: "Plugin Store"}).waitFor({timeout: 30_000});
  await page.getByTestId("plugin-workshop").waitFor({timeout: 30_000});
  await settle(page);
}

async function createAndPublish(page, mark, prefix, input) {
  await page.getByTestId("author-template").selectOption(input.template);
  await settle(page);
  await fill(page, page.getByTestId("author-plugin-id"), input.pluginId);
  await fill(page, page.getByTestId("author-title"), input.title);
  await fill(page, page.getByTestId("author-summary"), input.summary);
  await fill(page, page.getByTestId("author-surface-title"), input.surfaceTitle);
  await fill(page, page.getByTestId("author-items"), input.items.join("\n"));
  await mark(`${prefix}-draft-preview`, page.getByTestId("author-draft-preview"), input.surfaceTitle);

  await click(page, page.getByTestId("stage-candidate"));
  const candidate = page.getByTestId("candidate-review");
  await candidate.waitFor({timeout: 45_000});
  await mark(`${prefix}-candidate-hidden`, candidate, "UNPUBLISHED · HIDDEN FROM STORE");
  await mark(`${prefix}-verification-evidence`, page.getByTestId("candidate-checks"),
    "Candidate signature verified");

  await click(page, page.getByTestId("open-publication-review"));
  await mark(`${prefix}-publication-approval`, page.getByTestId("publication-review"),
    "Final deployment-admin approval");
  await click(page, page.getByTestId("confirm-publication"));
  await page.getByTestId("candidate-visibility").filter({hasText: "PUBLISHED TO EVERY USER"})
    .waitFor({timeout: 30_000});
  await mark(`${prefix}-published`, candidate, "PUBLISHED TO EVERY USER");
}

async function importPlugin(page, mark, prefix, title) {
  const card = page.locator("article").filter({hasText: title}).first();
  await card.scrollIntoViewIfNeeded();
  await click(page, card.getByRole("button", {name: "Import"}));
  await mark(`${prefix}-import-review`, card.getByTestId("import-review"),
    "Review exact package before import");
  await click(page, card.getByTestId("confirm-import"));
  await card.getByRole("button", {name: "Installed"}).waitFor({timeout: 30_000});
  await mark(`${prefix}-installed`, card, "Installed");
  return card;
}

async function recordScenario(browser, scenario, filename, storageState, run) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: {dir: rawVideoDir, size: VIEWPORT},
    storageState,
  });
  const page = await context.newPage();
  await installVisiblePointer(page);
  const startedAt = performance.now();
  const milestones = [];

  async function mark(name, locator, expectedVisibleText) {
    await locator.waitFor({state: "visible", timeout: 30_000});
    await locator.scrollIntoViewIfNeeded();
    const observedText = (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (expectedVisibleText && !observedText.includes(expectedVisibleText)) {
      throw new Error(`${name}: expected visible text not found: ${expectedVisibleText}`);
    }
    await settle(page, 2_400);
    const timestampSeconds = (performance.now() - startedAt) / 1000;
    await page.screenshot({path: join(milestoneDir, `${scenario}-${name}.png`)});
    milestones.push({
      name,
      timestampSeconds: Number(timestampSeconds.toFixed(3)),
      expectedVisibleText,
      observedText: observedText.slice(0, 1000),
    });
  }

  let nextStorageState;
  let scenarioError;
  try {
    await run(page, mark);
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
    "-c:v", "libx264", "-preset", "medium", "-crf", "19",
    "-r", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    outputPath,
  ], {encoding: "utf8"});
  if (converted.status !== 0) {
    throw new Error("Video conversion failed:\n" + converted.stderr);
  }
  if (scenarioError) throw scenarioError;
  console.log("Recorded " + outputPath);
  return {
    storageState: nextStorageState,
    evidence: {scenario, filename, milestones},
  };
}

let browser;
const scenarios = [];

try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    slowMo: 80,
    env: browserLaunchEnvironment(),
  });
  let adminState = await prepareAccounts(browser);

  const authoring = await recordScenario(
    browser,
    1,
    "plugin-lifecycle-01-author-publish.mp4",
    adminState,
    async (page, mark) => {
      await openWorkshop(page);
      await createAndPublish(page, mark, "incident", {
        template: "focus-brief",
        pluginId: "community.recorded-incident-brief",
        title: "Recorded Incident Brief",
        summary: "A worker-rendered incident handoff created and reviewed in this recording.",
        surfaceTitle: "Incident handoff ready",
        items: ["Confirm current impact", "Name the next owner", "Record the next checkpoint"],
      });
      const card = await importPlugin(page, mark, "incident", "Recorded Incident Brief");
      await click(page, card.getByRole("button", {name: "Open Incident handoff ready"}));
      const frame = page.locator('iframe[title="Incident handoff ready"]');
      await frame.waitFor({timeout: 30_000});
      await mark("incident-worker-ui-opened", frame, "");
    },
  );
  adminState = authoring.storageState;
  scenarios.push(authoring.evidence);

  const crossUser = await recordScenario(
    browser,
    2,
    "plugin-lifecycle-02-cross-user-import-use.mp4",
    adminState,
    async (page, mark) => {
      await openWorkshop(page);
      await createAndPublish(page, mark, "board", {
        template: "personal-board",
        pluginId: "community.recorded-release-board",
        title: "Recorded Release Board",
        summary: "A persistent release board created for a reviewed cross-user import.",
        surfaceTitle: "Release Board",
        items: ["Run smoke tests", "Confirm rollback owner"],
      });

      await signOut(page);
      await signIn(page, "pluginreviewer");
      await page.goto(BASE_URL + "/profile");
      const reviewerIdentity = page.getByText("pluginreviewer", {exact: true}).first();
      await mark("reviewer-identity", reviewerIdentity, "pluginreviewer");

      await page.goto(BASE_URL + "/plugins");
      await page.getByRole("heading", {name: "Plugin Store"}).waitFor({timeout: 30_000});
      await importPlugin(page, mark, "reviewer", "Recorded Release Board");
      await click(page, page.getByRole("link", {name: "Release Board"}));
      await page.getByRole("heading", {name: "Release Board"}).waitFor({timeout: 30_000});
      await fill(page, page.getByLabel("Add a work item"), "Document release evidence");
      await click(page, page.getByRole("button", {name: "Add item"}));
      const item = page.locator("article").filter({hasText: "Document release evidence"});
      await item.getByText("Document release evidence", {exact: true}).waitFor();
      await click(page, item.getByRole("button", {name: "Move to Doing"}));
      await mark("reviewer-state-mutated", item, "Document release evidence");

      await page.reload();
      await page.getByRole("heading", {name: "Release Board"}).waitFor({timeout: 30_000});
      const persistedItem = page.locator("article").filter({hasText: "Document release evidence"});
      await mark("reviewer-state-persisted-after-reload", persistedItem,
        "Document release evidence");
    },
  );
  scenarios.push(crossUser.evidence);

  const uninstall = await recordScenario(
    browser,
    3,
    "plugin-lifecycle-03-safe-uninstall.mp4",
    crossUser.storageState,
    async (page, mark) => {
      await page.goto(BASE_URL + "/plugins");
      await page.getByRole("heading", {name: "Plugin Store"}).waitFor({timeout: 30_000});
      await click(page, page.getByRole("link", {name: "Release Board"}));
      const persistedItem = page.locator("article").filter({hasText: "Document release evidence"});
      await mark("uninstall-state-present-before-removal", persistedItem,
        "Document release evidence");

      await page.goto(BASE_URL + "/plugins");
      const card = page.locator("article").filter({hasText: "Recorded Release Board"}).first();
      await card.scrollIntoViewIfNeeded();
      await click(page, card.getByRole("button", {name: "Uninstall"}));
      await mark("uninstall-retention-review", card.getByTestId("uninstall-review"),
        "It is not deleted by uninstall.");
      await click(page, card.getByTestId("confirm-uninstall"));
      const retained = page.locator("article").filter({hasText: "Detached state retained after uninstall"});
      await retained.waitFor({timeout: 30_000});
      await page.getByRole("link", {name: "Release Board"}).waitFor({state: "detached"});
      await mark("uninstall-complete-state-retained", retained,
        "Detached state retained after uninstall");

      await click(page, retained.getByRole("button", {name: "Purge data"}));
      await mark("purge-separate-irreversible-review", retained.getByTestId("purge-review"),
        "This is separate from uninstall and cannot be undone.");
      await click(page, retained.getByTestId("confirm-purge"));
      const emptyState = page.getByText("No retained plugin data.", {exact: true});
      await emptyState.waitFor({timeout: 30_000});
      await mark("purge-complete", emptyState, "No retained plugin data.");
    },
  );
  scenarios.push(uninstall.evidence);

  await writeFile(
    join(OUTPUT_DIR, "plugin-lifecycle-video-evidence.json"),
    JSON.stringify({
      schemaVersion: 2,
      capture: "continuous Playwright Chromium viewport recording",
      baseUrl: BASE_URL,
      viewport: VIEWPORT,
      scenarios,
    }, null, 2) + "\n",
  );
  console.log("Milestone review frames: " + milestoneDir);
} finally {
  await browser?.close();
  await stopServer();
}
