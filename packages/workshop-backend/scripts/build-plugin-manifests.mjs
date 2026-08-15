// Generates the deployment's bundled plugin manifest registry from reviewable JSON files.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const sourceDir = resolve(
  packageRoot,
  process.env.PLUGIN_MANIFESTS_DIR ?? "plugin-manifests",
);
const outFile = resolve(
  packageRoot,
  process.env.PLUGIN_MANIFESTS_OUT ?? "src/generated/plugin-manifests.ts",
);

let directoryEntries = [];
try {
  directoryEntries = await readdir(sourceDir);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const files = directoryEntries.filter(file => file.endsWith(".json")).toSorted();
const codeFiles = directoryEntries.filter(file => file.endsWith(".js")).toSorted();
const manifests = [];
const codeArtifacts = new Map();

for (const file of codeFiles) {
  const bytes = await readFile(join(sourceDir, file));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new TypeError(`${file}: plugin code artifact must not start with a UTF-8 BOM`);
  }
  let code;
  try {
    code = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    throw new TypeError(`${file}: plugin code artifact must be valid UTF-8`);
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  codeArtifacts.set(digest, code);
}

function parseManifest(file, parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`${file}: manifest must be an object`);
  }
  const {
    schemaVersion,
    pluginId,
    packageVersion,
    requestedCapabilities,
    dependencies,
    runtime,
    ...unknown
  } = parsed;
  const unknownKeys = Object.keys(unknown);
  if (unknownKeys.length > 0) {
    throw new TypeError(`${file}: unknown keys: ${unknownKeys.join(", ")}`);
  }
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) {
    throw new TypeError(`${file}: schemaVersion must be 1, 2, or 3`);
  }
  for (const [name, value] of [["pluginId", pluginId], ["packageVersion", packageVersion]]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeError(`${file}: ${name} must be a non-empty string`);
    }
  }
  if (
    !Array.isArray(requestedCapabilities)
    || requestedCapabilities.some(
      capability => typeof capability !== "string" || capability.trim().length === 0,
    )
  ) {
    throw new TypeError(
      `${file}: requestedCapabilities must contain only non-empty strings`,
    );
  }
  if (new Set(requestedCapabilities).size !== requestedCapabilities.length) {
    throw new TypeError(`${file}: requestedCapabilities must not contain duplicates`);
  }
  if (schemaVersion === 1) {
    if (dependencies !== undefined || runtime !== undefined) {
      throw new TypeError(`${file}: dependencies require schemaVersion 2`);
    }
    return {schemaVersion, pluginId, packageVersion, requestedCapabilities};
  }
  if (
    !Array.isArray(dependencies)
    || dependencies.some(
      dependency => typeof dependency !== "string" || dependency.trim().length === 0,
    )
  ) {
    throw new TypeError(`${file}: dependencies must contain only non-empty strings`);
  }
  if (new Set(dependencies).size !== dependencies.length) {
    throw new TypeError(`${file}: dependencies must not contain duplicates`);
  }
  if (schemaVersion === 2) {
    if (runtime !== undefined) {
      throw new TypeError(`${file}: runtime requires schemaVersion 3`);
    }
    return {
      schemaVersion,
      pluginId,
      packageVersion,
      requestedCapabilities,
      dependencies: dependencies.toSorted(),
    };
  }
  if (
    typeof runtime !== "object" || runtime === null || Array.isArray(runtime) ||
    runtime.kind !== "dynamic-worker" ||
    !/^sha256:[0-9a-f]{64}$/.test(runtime.codeArtifactDigest) ||
    Object.keys(runtime).some(key => key !== "kind" && key !== "codeArtifactDigest")
  ) {
    throw new TypeError(
      `${file}: runtime must be a dynamic-worker descriptor with a canonical SHA-256 digest`,
    );
  }
  return {
    schemaVersion,
    pluginId,
    packageVersion,
    requestedCapabilities,
    dependencies: dependencies.toSorted(),
    runtime: {kind: runtime.kind, codeArtifactDigest: runtime.codeArtifactDigest},
  };
}

for (const file of files) {
  const parsed = JSON.parse(await readFile(join(sourceDir, file), "utf8"));
  manifests.push(parseManifest(file, parsed));
}

manifests.sort((left, right) => {
  if (left.pluginId !== right.pluginId) return left.pluginId < right.pluginId ? -1 : 1;
  if (left.packageVersion === right.packageVersion) return 0;
  return left.packageVersion < right.packageVersion ? -1 : 1;
});

for (let index = 1; index < manifests.length; index += 1) {
  const previous = manifests[index - 1];
  const current = manifests[index];
  if (
    previous.pluginId === current.pluginId
    && previous.packageVersion === current.packageVersion
  ) {
    throw new TypeError(
      `duplicate plugin manifest: ${current.pluginId}@${current.packageVersion}`,
    );
  }
}

for (const manifest of manifests) {
  if (
    manifest.schemaVersion === 3 &&
    !codeArtifacts.has(manifest.runtime.codeArtifactDigest)
  ) {
    throw new TypeError(
      `${manifest.pluginId}@${manifest.packageVersion}: code artifact not found: ` +
      manifest.runtime.codeArtifactDigest,
    );
  }
}

const sortedCodeArtifacts = Object.fromEntries(
  [...codeArtifacts.entries()].toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
);

const generated = `// GENERATED by scripts/build-plugin-manifests.mjs -- do not edit.

import type { PluginManifest } from "../plugin-manifest-registry.js";

export const BUNDLED_PLUGIN_MANIFESTS = ${JSON.stringify(manifests, null, 2)} as const satisfies readonly PluginManifest[];

export const BUNDLED_PLUGIN_CODE_ARTIFACTS = ${JSON.stringify(sortedCodeArtifacts, null, 2)} as const;
`;

await mkdir(dirname(outFile), {recursive: true});
await writeFile(outFile, generated);

console.log(`Bundled ${manifests.length} plugin manifest(s) from ${sourceDir} -> ${outFile}`);
