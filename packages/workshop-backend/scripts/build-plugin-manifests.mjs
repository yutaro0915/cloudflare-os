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
const MAX_PLUGIN_ARTIFACT_BYTES = 256 * 1024;
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
const UI_CONTRIBUTION_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

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
  if (bytes.byteLength > MAX_PLUGIN_ARTIFACT_BYTES) {
    throw new RangeError(`${file}: plugin code artifact exceeds the size limit`);
  }
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

function hasOnlyKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function boundedText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function parsePresentation(file, value) {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !hasOnlyKeys(value, ["title", "summary"]) ||
    !boundedText(value.title, 80) || !boundedText(value.summary, 240)
  ) {
    throw new TypeError(`${file}: presentation must contain bounded title and summary strings`);
  }
  return {title: value.title, summary: value.summary};
}

function parseDeclarativeDocument(file, value) {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "blocks"]) || value.schemaVersion !== 1 ||
    !Array.isArray(value.blocks) || value.blocks.length > 64
  ) throw new TypeError(`${file}: invalid host-schema-v1 document`);
  const blocks = value.blocks.map(block => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      throw new TypeError(`${file}: invalid host-schema-v1 document`);
    }
    if (
      block.kind === "text" && hasOnlyKeys(block, ["kind", "text"]) &&
      boundedText(block.text, 2_000)
    ) return {kind: "text", text: block.text};
    if (
      block.kind === "notice" && hasOnlyKeys(block, ["kind", "tone", "text"]) &&
      (block.tone === "info" || block.tone === "warning") && boundedText(block.text, 2_000)
    ) return {kind: "notice", tone: block.tone, text: block.text};
    if (
      block.kind === "list" && hasOnlyKeys(block, ["kind", "items"]) &&
      Array.isArray(block.items) && block.items.length <= 32 &&
      block.items.every(item => boundedText(item, 256))
    ) return {kind: "list", items: [...block.items]};
    throw new TypeError(`${file}: invalid host-schema-v1 document`);
  });
  return {schemaVersion: 1, blocks};
}

function parseUiContributions(file, value) {
  if (!Array.isArray(value) || value.length > 16) {
    throw new TypeError(`${file}: uiContributions must be a bounded array`);
  }
  const ids = new Set();
  const contributions = value.map(contribution => {
    if (
      typeof contribution !== "object" || contribution === null || Array.isArray(contribution) ||
      !hasOnlyKeys(contribution, ["contributionId", "slot", "title", "renderer"]) ||
      typeof contribution.contributionId !== "string" ||
      !UI_CONTRIBUTION_ID.test(contribution.contributionId) ||
      ids.has(contribution.contributionId) ||
      contribution.slot !== "user-plugin.details" ||
      !boundedText(contribution.title, 80) ||
      typeof contribution.renderer !== "object" || contribution.renderer === null ||
      Array.isArray(contribution.renderer)
    ) throw new TypeError(`${file}: uiContributions must contain valid unique entries`);
    ids.add(contribution.contributionId);
    const renderer = contribution.renderer;
    if (
      renderer.kind === "host-schema-v1" &&
      hasOnlyKeys(renderer, ["kind", "document"])
    ) {
      return {
        contributionId: contribution.contributionId,
        slot: contribution.slot,
        title: contribution.title,
        renderer: {kind: renderer.kind, document: parseDeclarativeDocument(file, renderer.document)},
      };
    }
    if (
      renderer.kind === "worker-rendered-document-v1" &&
      hasOnlyKeys(renderer, ["kind", "codeArtifactDigest", "height"]) &&
      /^sha256:[0-9a-f]{64}$/.test(renderer.codeArtifactDigest) &&
      Number.isInteger(renderer.height) && renderer.height >= 120 && renderer.height <= 800
    ) {
      return {
        contributionId: contribution.contributionId,
        slot: contribution.slot,
        title: contribution.title,
        renderer: {
          kind: renderer.kind,
          codeArtifactDigest: renderer.codeArtifactDigest,
          height: renderer.height,
        },
      };
    }
    throw new TypeError(`${file}: uiContributions must contain supported renderers`);
  });
  return contributions.toSorted((left, right) => left.contributionId < right.contributionId
    ? -1
    : left.contributionId > right.contributionId ? 1 : 0);
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
    presentation,
    uiContributions,
    ...unknown
  } = parsed;
  const unknownKeys = Object.keys(unknown);
  if (unknownKeys.length > 0) {
    throw new TypeError(`${file}: unknown keys: ${unknownKeys.join(", ")}`);
  }
  if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3 && schemaVersion !== 4) {
    throw new TypeError(`${file}: schemaVersion must be 1, 2, 3, or 4`);
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
    if (
      dependencies !== undefined || runtime !== undefined ||
      presentation !== undefined || uiContributions !== undefined
    ) {
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
    if (runtime !== undefined || presentation !== undefined || uiContributions !== undefined) {
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
  const runtimeSnapshot = {
    kind: runtime.kind,
    codeArtifactDigest: runtime.codeArtifactDigest,
  };
  if (schemaVersion === 3) {
    if (presentation !== undefined || uiContributions !== undefined) {
      throw new TypeError(`${file}: UI contributions require schemaVersion 4`);
    }
    return {
      schemaVersion,
      pluginId,
      packageVersion,
      requestedCapabilities,
      dependencies: dependencies.toSorted(),
      runtime: runtimeSnapshot,
    };
  }
  return {
    schemaVersion,
    pluginId,
    packageVersion,
    requestedCapabilities,
    dependencies: dependencies.toSorted(),
    runtime: runtimeSnapshot,
    presentation: parsePresentation(file, presentation),
    uiContributions: parseUiContributions(file, uiContributions),
  };
}

for (const file of files) {
  const parsed = JSON.parse(await readFile(join(sourceDir, file), "utf8"));
  const manifest = parseManifest(file, parsed);
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new RangeError(`${file}: plugin manifest exceeds the size limit`);
  }
  manifests.push(manifest);
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
    (manifest.schemaVersion === 3 || manifest.schemaVersion === 4) &&
    !codeArtifacts.has(manifest.runtime.codeArtifactDigest)
  ) {
    throw new TypeError(
      `${manifest.pluginId}@${manifest.packageVersion}: code artifact not found: ` +
      manifest.runtime.codeArtifactDigest,
    );
  }
  if (manifest.schemaVersion === 4) {
    for (const contribution of manifest.uiContributions) {
      if (
        contribution.renderer.kind === "worker-rendered-document-v1" &&
        !codeArtifacts.has(contribution.renderer.codeArtifactDigest)
      ) {
        throw new TypeError(
          `${manifest.pluginId}@${manifest.packageVersion}: UI code artifact not found: ` +
          contribution.renderer.codeArtifactDigest,
        );
      }
    }
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
let existing;
try {
  existing = await readFile(outFile, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (existing !== generated) await writeFile(outFile, generated);

console.log(`Bundled ${manifests.length} plugin manifest(s) from ${sourceDir} -> ${outFile}`);
