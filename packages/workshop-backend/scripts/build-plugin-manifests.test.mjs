import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "build-plugin-manifests.mjs");

function runBuild(sourceDir, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        PLUGIN_MANIFESTS_DIR: sourceDir,
        PLUGIN_MANIFESTS_OUT: outFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => {
      if (code === 0) resolve();
      else reject(new Error(`manifest build exited ${code}: ${stderr}`));
    });
  });
}

test("builds a deterministic bundled manifest module from exact package versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "notes-v2.json"), JSON.stringify({
    schemaVersion: 1,
    pluginId: "example.notes",
    packageVersion: "2.0.0",
    requestedCapabilities: ["ui.panel", "agent.catalog.read"],
  }));
  await writeFile(join(sourceDir, "notes-v1.json"), JSON.stringify({
    schemaVersion: 1,
    pluginId: "example.notes",
    packageVersion: "1.0.0",
    requestedCapabilities: ["ui.panel"],
  }));

  await runBuild(sourceDir, outFile);

  const generated = await readFile(outFile, "utf8");
  const literal = generated.match(
    /export const BUNDLED_PLUGIN_MANIFESTS = ([\s\S]*?) as const satisfies/,
  )?.[1];
  assert.ok(literal, "generated module should contain the manifest array");
  assert.deepEqual(JSON.parse(literal), [
    {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      requestedCapabilities: ["ui.panel"],
    },
    {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      requestedCapabilities: ["ui.panel", "agent.catalog.read"],
    },
  ]);
});

test("builds an empty registry when the deployment has no manifest directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-empty-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "not-created");
  const outFile = join(root, "generated", "plugin-manifests.ts");

  await runBuild(sourceDir, outFile);

  const generated = await readFile(outFile, "utf8");
  assert.match(generated, /BUNDLED_PLUGIN_MANIFESTS = \[\]/);
});

test("rejects unknown manifest fields instead of silently discarding them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-invalid-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "notes.json"), JSON.stringify({
    schemaVersion: 1,
    pluginId: "example.notes",
    packageVersion: "1.0.0",
    requestedCapabilities: [],
    stateRef: "plugin-controlled-state",
  }));

  await assert.rejects(
    runBuild(sourceDir, outFile),
    /notes\.json: unknown keys: stateRef/,
  );
});

test("rejects a manifest whose root is not an object", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-null-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "notes.json"), "null");

  await assert.rejects(
    runBuild(sourceDir, outFile),
    /notes\.json: manifest must be an object/,
  );
});

test("builds schema v2 dependencies in deterministic order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-schema-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "notes.json"), JSON.stringify({
    schemaVersion: 2,
    pluginId: "example.notes",
    packageVersion: "1.0.0",
    requestedCapabilities: [],
    dependencies: ["example.storage", "example.auth"],
  }));

  await runBuild(sourceDir, outFile);

  const generated = await readFile(outFile, "utf8");
  assert.match(generated, /"schemaVersion": 2/);
  assert.match(
    generated,
    /"dependencies": \[\s*"example\.auth",\s*"example\.storage"\s*\]/,
  );
});

test("rejects malformed or duplicate schema v2 dependencies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-dependencies-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);

  for (const dependencies of ["example.auth", ["example.auth", " "], ["a", "a"]]) {
    await writeFile(join(sourceDir, "notes.json"), JSON.stringify({
      schemaVersion: 2,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies,
    }));

    await assert.rejects(runBuild(sourceDir, outFile), /dependencies must/);
  }
});

test("rejects dependency declarations that do not match their schema", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-schema-rejection-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);

  const invalid = [
    {
      manifest: {
        schemaVersion: 3,
        pluginId: "example.notes",
        packageVersion: "1.0.0",
        requestedCapabilities: [],
        dependencies: [],
      },
      error: /schemaVersion must be 1 or 2/,
    },
    {
      manifest: {
        schemaVersion: 1,
        pluginId: "example.notes",
        packageVersion: "1.0.0",
        requestedCapabilities: [],
        dependencies: [],
      },
      error: /dependencies require schemaVersion 2/,
    },
    {
      manifest: {
        schemaVersion: 2,
        pluginId: "example.notes",
        packageVersion: "1.0.0",
        requestedCapabilities: [],
      },
      error: /dependencies must contain only non-empty strings/,
    },
  ];

  for (const {manifest, error} of invalid) {
    await writeFile(join(sourceDir, "notes.json"), JSON.stringify(manifest));
    await assert.rejects(runBuild(sourceDir, outFile), error);
  }
});

test("rejects blank plugin and package identifiers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-identity-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);

  for (const field of ["pluginId", "packageVersion"]) {
    await writeFile(join(sourceDir, "notes.json"), JSON.stringify({
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      [field]: "   ",
    }));

    await assert.rejects(
      runBuild(sourceDir, outFile),
      new RegExp(`notes\\.json: ${field} must be a non-empty string`),
    );
  }
});

test("rejects malformed capability declarations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-capabilities-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);

  for (const requestedCapabilities of ["ui.panel", ["ui.panel", " "]]) {
    await writeFile(join(sourceDir, "notes.json"), JSON.stringify({
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      requestedCapabilities,
    }));

    await assert.rejects(
      runBuild(sourceDir, outFile),
      /notes\.json: requestedCapabilities must contain only non-empty strings/,
    );
  }
});

test("rejects duplicate requested capabilities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-capability-duplicate-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "notes.json"), JSON.stringify({
    schemaVersion: 1,
    pluginId: "example.notes",
    packageVersion: "1.0.0",
    requestedCapabilities: ["ui.panel", "ui.panel"],
  }));

  await assert.rejects(
    runBuild(sourceDir, outFile),
    /notes\.json: requestedCapabilities must not contain duplicates/,
  );
});

test("rejects duplicate exact plugin versions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-duplicate-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "notes-a.json"), JSON.stringify({
    schemaVersion: 1,
    pluginId: "example.notes",
    packageVersion: "1.0.0",
    requestedCapabilities: ["ui.panel"],
  }));
  await writeFile(join(sourceDir, "notes-b.json"), JSON.stringify({
    schemaVersion: 1,
    pluginId: "example.notes",
    packageVersion: "1.0.0",
    requestedCapabilities: ["agent.catalog.read"],
  }));

  await assert.rejects(
    runBuild(sourceDir, outFile),
    /duplicate plugin manifest: example\.notes@1\.0\.0/,
  );
});
