import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
        schemaVersion: 5,
        pluginId: "example.notes",
        packageVersion: "1.0.0",
        requestedCapabilities: [],
        dependencies: [],
      },
      error: /schemaVersion must be 1, 2, 3, or 4/,
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

test("builds schema v3 with a fixed Dynamic Worker artifact descriptor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-runtime-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  const code = `export default { handshake() { return "ok"; } }; // 雪\n`;
  const codeArtifactDigest = `sha256:${createHash("sha256").update(code).digest("hex")}`;
  await writeFile(join(sourceDir, "runtime.js"), code);
  await writeFile(join(sourceDir, "runtime.json"), JSON.stringify({
    schemaVersion: 3,
    pluginId: "example.runtime",
    packageVersion: "1.0.0",
    requestedCapabilities: [],
    dependencies: [],
    runtime: {
      kind: "dynamic-worker",
      codeArtifactDigest,
    },
  }));

  await runBuild(sourceDir, outFile);

  const generated = await readFile(outFile, "utf8");
  assert.match(generated, /"schemaVersion": 3/);
  assert.match(generated, /"kind": "dynamic-worker"/);
  assert.match(generated, new RegExp(`"codeArtifactDigest": "${codeArtifactDigest}"`));
  const artifactLiteral = generated.match(
    /export const BUNDLED_PLUGIN_CODE_ARTIFACTS = ([\s\S]*?) as const;/,
  )?.[1];
  assert.ok(artifactLiteral, "generated module should contain the artifact map");
  assert.deepEqual(JSON.parse(artifactLiteral), {[codeArtifactDigest]: code});
});

test("builds schema v4 presentation and host/worker-rendered UI contributions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-ui-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  const runtimeCode = `export default { handshake() {} };\n`;
  const uiCode = `export default { render() { return { schemaVersion: 1, blocks: [] }; } };\n`;
  const runtimeDigest = `sha256:${createHash("sha256").update(runtimeCode).digest("hex")}`;
  const uiDigest = `sha256:${createHash("sha256").update(uiCode).digest("hex")}`;
  await writeFile(join(sourceDir, "runtime.js"), runtimeCode);
  await writeFile(join(sourceDir, "ui.js"), uiCode);
  await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
    schemaVersion: 4,
    pluginId: "example.ui",
    packageVersion: "1.0.0",
    requestedCapabilities: [],
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest: runtimeDigest},
    presentation: {title: "Example UI", summary: "Safe UI contributions."},
    uiContributions: [{
      contributionId: "details",
      slot: "user-plugin.details",
      title: "Details",
      renderer: {
        kind: "host-schema-v1",
        document: {schemaVersion: 1, blocks: [{kind: "text", text: "Hello"}]},
      },
    }, {
      contributionId: "sandbox",
      slot: "user-plugin.details",
      title: "Sandbox",
      renderer: {kind: "worker-rendered-document-v1", codeArtifactDigest: uiDigest, height: 240},
    }],
  }));

  await runBuild(sourceDir, outFile);

  const generated = await readFile(outFile, "utf8");
  assert.match(generated, /"schemaVersion": 4/);
  assert.match(generated, /"kind": "host-schema-v1"/);
  assert.match(generated, /"kind": "worker-rendered-document-v1"/);
  assert.match(generated, new RegExp(uiDigest));
});

test("rejects malformed or missing schema v4 UI contributions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-ui-invalid-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  const runtimeCode = `export default { handshake() {} };\n`;
  const runtimeDigest = `sha256:${createHash("sha256").update(runtimeCode).digest("hex")}`;
  await writeFile(join(sourceDir, "runtime.js"), runtimeCode);
  const base = {
    schemaVersion: 4,
    pluginId: "example.ui",
    packageVersion: "1.0.0",
    requestedCapabilities: [],
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest: runtimeDigest},
    presentation: {title: "Example", summary: "Summary"},
  };
  const contribution = {
    contributionId: "sandbox",
    slot: "user-plugin.details",
    title: "Sandbox",
    renderer: {
      kind: "worker-rendered-document-v1",
      codeArtifactDigest: `sha256:${"f".repeat(64)}`,
      height: 240,
    },
  };

  await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
    ...base,
    runtime: {kind: "dynamic-worker", codeArtifactDigest: `sha256:${"e".repeat(64)}`},
    uiContributions: [{
      contributionId: "details",
      slot: "user-plugin.details",
      title: "Details",
      renderer: {
        kind: "host-schema-v1",
        document: {schemaVersion: 1, blocks: [{kind: "text", text: "Safe"}]},
      },
    }],
  }));
  await assert.rejects(runBuild(sourceDir, outFile), /code artifact not found/);

  await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
    ...base,
    uiContributions: [contribution, contribution],
  }));
  await assert.rejects(runBuild(sourceDir, outFile), /uiContributions must/);

  await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
    ...base,
    uiContributions: [contribution],
  }));
  await assert.rejects(runBuild(sourceDir, outFile), /UI code artifact not found/);

  await writeFile(join(sourceDir, "plugin.json"), JSON.stringify({
    ...base,
    uiContributions: [{
      contributionId: "details",
      slot: "user-plugin.details",
      title: "Details",
      renderer: {
        kind: "host-schema-v1",
        document: {
          schemaVersion: 1,
          blocks: Array.from({length: 64}, () => ({kind: "text", text: "雪".repeat(2_000)})),
        },
      },
    }],
  }));
  await assert.rejects(runBuild(sourceDir, outFile), /plugin manifest exceeds the size limit/);
});

test("rejects missing or changed code referenced by a schema v3 manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-artifact-integrity-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);
  const original = `export default { handshake() {} };\n`;
  const digest = `sha256:${createHash("sha256").update(original).digest("hex")}`;
  await writeFile(join(sourceDir, "runtime.json"), JSON.stringify({
    schemaVersion: 3,
    pluginId: "example.runtime",
    packageVersion: "1.0.0",
    requestedCapabilities: [],
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest: digest},
  }));

  await assert.rejects(runBuild(sourceDir, outFile), /code artifact not found/);
  await writeFile(join(sourceDir, "runtime.js"), `${original}// changed`);
  await assert.rejects(runBuild(sourceDir, outFile), /code artifact not found/);
});

test("rejects BOM and malformed UTF-8 before hashing plugin source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-utf8-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);

  await writeFile(join(sourceDir, "runtime.js"), Uint8Array.from([
    0xef, 0xbb, 0xbf, ...Buffer.from("export default {};"),
  ]));
  await assert.rejects(runBuild(sourceDir, outFile), /must not start with a UTF-8 BOM/);

  await writeFile(join(sourceDir, "runtime.js"), Uint8Array.from([0xc3, 0x28]));
  await assert.rejects(runBuild(sourceDir, outFile), /must be valid UTF-8/);
});

test("rejects malformed schema v3 runtime descriptors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-manifests-runtime-invalid-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const sourceDir = join(root, "input");
  const outFile = join(root, "generated", "plugin-manifests.ts");
  await mkdir(sourceDir);

  for (const runtime of [
    undefined,
    {kind: "container", codeArtifactDigest: `sha256:${"a".repeat(64)}`},
    {kind: "dynamic-worker", codeArtifactDigest: "sha256:not-a-digest"},
    {kind: "dynamic-worker", codeArtifactDigest: `sha256:${"a".repeat(64)}`, env: {}},
  ]) {
    await writeFile(join(sourceDir, "runtime.json"), JSON.stringify({
      schemaVersion: 3,
      pluginId: "example.runtime",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies: [],
      runtime,
    }));
    await assert.rejects(runBuild(sourceDir, outFile), /runtime must/);
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
