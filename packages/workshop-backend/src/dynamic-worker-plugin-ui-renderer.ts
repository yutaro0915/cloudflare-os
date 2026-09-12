import type {WorkerEntrypoint} from "cloudflare:workers";
import type {DeclarativePluginUiDocument} from "./plugin-manifest-registry.js";
import {snapshotPluginUiDocument} from "./plugin-manifest-registry.js";
import type {
  ResolvePluginCodeArtifactResult,
  VerifiedPluginCodeArtifact,
} from "./plugin-code-artifact.js";
import {runPluginUiRpcWithinDeadline} from "./plugin-ui-rpc-deadline.js";
import {WORKER_COMPATIBILITY_DATE} from "./worker-compatibility.js";

const UI_COMPATIBILITY_FLAGS = ["disallow_importable_env"] as const;
const UI_LIMITS = {cpuMs: 50, subRequests: 1} as const;
const UI_RENDER_TIMEOUT_MS = 5_000;
const MAX_UI_ARTIFACT_BYTES = 256 * 1024;

const UI_HARNESS = `
import { WorkerEntrypoint } from "cloudflare:workers";

const arrayIsArray = Array.isArray.bind(Array);
const hasOwn = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);
const objectKeys = Object.keys.bind(Object);
const getPrototypeOf = Object.getPrototypeOf.bind(Object);
const objectPrototype = Object.prototype;
const stringTrim = String.prototype.trim.call.bind(String.prototype.trim);
const encode = TextEncoder.prototype.encode.call.bind(TextEncoder.prototype.encode);
const encoder = new TextEncoder();
const MAX_OUTPUT_BYTES = 256 * 1024;

function plainObject(value) {
  if (typeof value !== "object" || value === null || arrayIsArray(value)) return false;
  const prototype = getPrototypeOf(value);
  return prototype === objectPrototype || prototype === null;
}

function onlyKeys(value, expected) {
  const actual = objectKeys(value);
  if (actual.length !== expected.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    let matched = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (actual[index] === expected[expectedIndex]) matched = true;
    }
    if (!matched) return false;
  }
  return true;
}

function denseArray(value, max) {
  if (!arrayIsArray(value) || value.length > max || objectKeys(value).length !== value.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index)) return false;
  }
  return true;
}

function text(value, max, budget) {
  if (typeof value !== "string" || stringTrim(value).length === 0 || value.length > max) return false;
  budget.bytes += encode(encoder, value).byteLength + 16;
  return budget.bytes <= MAX_OUTPUT_BYTES;
}

function project(value) {
  const budget = {bytes: 128};
  if (!plainObject(value) || !onlyKeys(value, ["schemaVersion", "blocks"]) || value.schemaVersion !== 1) {
    throw new TypeError("Plugin UI renderer returned an invalid document.");
  }
  if (!denseArray(value.blocks, 64)) {
    throw new TypeError("Plugin UI renderer returned invalid blocks.");
  }
  const blocks = [];
  for (let blockIndex = 0; blockIndex < value.blocks.length; blockIndex += 1) {
    const block = value.blocks[blockIndex];
    if (!plainObject(block)) throw new TypeError("Plugin UI renderer returned an invalid block.");
    if (block.kind === "text" && onlyKeys(block, ["kind", "text"]) && text(block.text, 2000, budget)) {
      blocks[blockIndex] = {kind: "text", text: block.text};
      continue;
    }
    if (
      block.kind === "notice" && onlyKeys(block, ["kind", "tone", "text"]) &&
      (block.tone === "info" || block.tone === "warning") && text(block.text, 2000, budget)
    ) {
      blocks[blockIndex] = {kind: "notice", tone: block.tone, text: block.text};
      continue;
    }
    if (block.kind === "list" && onlyKeys(block, ["kind", "items"]) && denseArray(block.items, 32)) {
      const items = [];
      let valid = true;
      for (let itemIndex = 0; itemIndex < block.items.length; itemIndex += 1) {
        if (!text(block.items[itemIndex], 256, budget)) valid = false;
        items[itemIndex] = block.items[itemIndex];
      }
      if (valid) {
        blocks[blockIndex] = {kind: "list", items};
        continue;
      }
    }
    throw new TypeError("Plugin UI renderer returned an invalid block.");
  }
  return {schemaVersion: 1, blocks};
}

export default class extends WorkerEntrypoint {
  async render() {
    const module = await import("plugin-ui.js");
    if (typeof module.default?.render !== "function") {
      throw new TypeError("Plugin UI artifact must export default.render().");
    }
    return project(await module.default.render());
  }
}
`;

interface PluginUiWorkerEntrypoint extends WorkerEntrypoint {
  render(): Promise<DeclarativePluginUiDocument>;
}

/** Minimal verified artifact resolver consumed by the isolated UI renderer. */
export interface PluginUiArtifactResolver {
  /** Resolves and rehashes one exact UI code artifact. */
  resolve(codeArtifactDigest: string): Promise<ResolvePluginCodeArtifactResult>;
}

/** Deep port that runs a fixed UI harness in one resource-limited Dynamic Worker. */
export interface PluginUiWorkerStarter {
  /** Starts a fresh worker definition and returns only its bounded render result. */
  render(getCode: () => Promise<WorkerLoaderWorkerCode>): Promise<unknown>;
}

/** Production adapter around Worker Loader's fresh-load boundary. */
export class WorkerLoaderPluginUiWorkerStarter implements PluginUiWorkerStarter {
  /** Wraps the native loader without mirroring any wider API. */
  constructor(private loader: Pick<WorkerLoader, "load">) {}

  async render(getCode: () => Promise<WorkerLoaderWorkerCode>): Promise<unknown> {
    const entrypoint = this.loader.load(await getCode()).getEntrypoint<PluginUiWorkerEntrypoint>();
    const pending = entrypoint.render();
    return runPluginUiRpcWithinDeadline(
      pending,
      [entrypoint],
      UI_RENDER_TIMEOUT_MS,
      "Plugin UI render timed out.",
      result => structuredClone(result),
    );
  }
}

function workerCode(artifact: VerifiedPluginCodeArtifact): WorkerLoaderWorkerCode {
  if (artifact.byteLength > MAX_UI_ARTIFACT_BYTES) {
    throw new RangeError("Plugin UI artifact exceeds the host runtime limit.");
  }
  return {
    compatibilityDate: WORKER_COMPATIBILITY_DATE,
    compatibilityFlags: [...UI_COMPATIBILITY_FLAGS],
    mainModule: "plugin-ui-harness.js",
    modules: {
      "plugin-ui-harness.js": UI_HARNESS,
      "plugin-ui.js": artifact.code,
    },
    env: {},
    globalOutbound: null,
    limits: {...UI_LIMITS},
  };
}

/** Executes untrusted document renderers only in Dynamic Workers and returns a closed host document. */
export class DynamicWorkerPluginUiRenderer {
  /** Creates an isolated renderer from the real Worker boundary and verified artifact port. */
  constructor(
    private starter: PluginUiWorkerStarter,
    private artifacts: PluginUiArtifactResolver,
  ) {}

  /** Renders one exact artifact, collapsing invalid untrusted output to null. */
  async render(codeArtifactDigest: string): Promise<DeclarativePluginUiDocument | null> {
    const result = await this.artifacts.resolve(codeArtifactDigest);
    if (!result.ok) return null;
    try {
      const output = await this.starter.render(() => Promise.resolve(workerCode(result.artifact)));
      return snapshotPluginUiDocument(output);
    } catch {
      return null;
    }
  }
}
