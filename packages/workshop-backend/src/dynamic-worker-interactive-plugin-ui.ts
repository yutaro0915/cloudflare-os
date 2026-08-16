import type {WorkerEntrypoint} from "cloudflare:workers";
import type {PluginConfigurationValue} from "./plugin-installation.js";
import {decodePluginConfigurationValue} from "./plugin-installation.js";
import type {PluginUiArtifactResolver} from "./dynamic-worker-plugin-ui-renderer.js";
import type {VerifiedPluginCodeArtifact} from "./plugin-code-artifact.js";
import type {UserPluginInteractiveDocument} from "@gadgets/workshop-shared/api";
import {snapshotUserPluginInteractiveDocument} from "./plugin-interactive-ui.js";

const INTERACTIVE_UI_COMPATIBILITY_DATE = "2026-02-01";
const INTERACTIVE_UI_FLAGS = ["disallow_importable_env"] as const;
const INTERACTIVE_UI_LIMITS = {cpuMs: 50, subRequests: 1} as const;
const INTERACTIVE_UI_TIMEOUT_MS = 5_000;
const MAX_INTERACTIVE_UI_ARTIFACT_BYTES = 256 * 1024;

const INTERACTIVE_UI_HARNESS = String.raw`
import { WorkerEntrypoint } from "cloudflare:workers";

const arrayIsArray = Array.isArray.bind(Array);
const hasOwn = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);
const objectKeys = Object.keys.bind(Object);
const getPrototypeOf = Object.getPrototypeOf.bind(Object);
const objectPrototype = Object.prototype;
const jsonStringify = JSON.stringify.bind(JSON);
const encode = TextEncoder.prototype.encode.call.bind(TextEncoder.prototype.encode);
const encoder = new TextEncoder();
const MAX_DOCUMENT_BYTES = 128 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const ID = /^[a-z0-9](?:[a-z0-9:._-]{0,126}[a-z0-9])?$/;

function plain(value) {
  if (typeof value !== "object" || value === null || arrayIsArray(value)) return false;
  const prototype = getPrototypeOf(value);
  return prototype === objectPrototype || prototype === null;
}

function only(value, expected) {
  const keys = objectKeys(value);
  if (keys.length !== expected.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    let found = false;
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (keys[index] === expected[expectedIndex]) found = true;
    }
    if (!found) return false;
  }
  return true;
}

function dense(value, max) {
  if (!arrayIsArray(value) || value.length > max || objectKeys(value).length !== value.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index)) return false;
  }
  return true;
}

function text(value, max, empty = false) {
  return typeof value === "string" && value.length <= max && (empty || value.trim().length > 0);
}

function projectDocument(value) {
  if (!plain(value) || !only(value, ["schemaVersion", "title", "form", "columns"]) ||
      value.schemaVersion !== 1 || !text(value.title, 120) || !dense(value.columns, 8)) {
    throw new TypeError("Invalid interactive plugin document.");
  }
  let form = null;
  if (value.form !== null) {
    const candidate = value.form;
    if (!plain(candidate) || !only(candidate, ["actionId", "label", "placeholder", "maxLength"]) ||
        typeof candidate.actionId !== "string" || !ID.test(candidate.actionId) ||
        !text(candidate.label, 80) || !text(candidate.placeholder, 120, true) ||
        !Number.isInteger(candidate.maxLength) || candidate.maxLength < 1 || candidate.maxLength > 500) {
      throw new TypeError("Invalid interactive plugin form.");
    }
    form = {actionId: candidate.actionId, label: candidate.label,
      placeholder: candidate.placeholder, maxLength: candidate.maxLength};
  }
  const columns = [];
  let totalItems = 0;
  for (let columnIndex = 0; columnIndex < value.columns.length; columnIndex += 1) {
    const column = value.columns[columnIndex];
    if (!plain(column) || !only(column, ["columnId", "title", "items"]) ||
        typeof column.columnId !== "string" || !ID.test(column.columnId) ||
        !text(column.title, 80) || !dense(column.items, 128)) {
      throw new TypeError("Invalid interactive plugin column.");
    }
    totalItems += column.items.length;
    if (totalItems > 256) throw new TypeError("Interactive plugin document has too many items.");
    const items = [];
    for (let itemIndex = 0; itemIndex < column.items.length; itemIndex += 1) {
      const item = column.items[itemIndex];
      if (!plain(item) || !only(item, ["itemId", "title", "actions"]) ||
          typeof item.itemId !== "string" || !ID.test(item.itemId) ||
          !text(item.title, 500) || !dense(item.actions, 16)) {
        throw new TypeError("Invalid interactive plugin item.");
      }
      const actions = [];
      for (let actionIndex = 0; actionIndex < item.actions.length; actionIndex += 1) {
        const action = item.actions[actionIndex];
        if (!plain(action) || !only(action, ["actionId", "label", "tone"]) ||
            typeof action.actionId !== "string" || !ID.test(action.actionId) ||
            !text(action.label, 80) || (action.tone !== "neutral" && action.tone !== "danger")) {
          throw new TypeError("Invalid interactive plugin action.");
        }
        actions[actionIndex] = {actionId: action.actionId, label: action.label, tone: action.tone};
      }
      items[itemIndex] = {itemId: item.itemId, title: item.title, actions};
    }
    columns[columnIndex] = {columnId: column.columnId, title: column.title, items};
  }
  const projected = {schemaVersion: 1, title: value.title, form, columns};
  if (encode(encoder, jsonStringify(projected)).byteLength > MAX_DOCUMENT_BYTES) {
    throw new RangeError("Interactive plugin document exceeds the size limit.");
  }
  return projected;
}

function projectState(value) {
  const serialized = jsonStringify(value);
  if (serialized === undefined || encode(encoder, serialized).byteLength > MAX_STATE_BYTES) {
    throw new RangeError("Interactive plugin state exceeds the size limit.");
  }
  return value;
}

export default class extends WorkerEntrypoint {
  async interact(request) {
    const module = await import("plugin-ui.js");
    const plugin = module.default;
    if (request.kind === "open") {
      if (typeof plugin?.render !== "function") {
        throw new TypeError("Interactive plugin must export default.render().");
      }
      return {state: projectState(request.state),
        document: projectDocument(await plugin.render({state: request.state}))};
    }
    if (typeof plugin?.reduce !== "function") {
      throw new TypeError("Interactive plugin must export default.reduce().");
    }
    const output = await plugin.reduce({state: request.state, revision: request.revision,
      action: request.action});
    if (!plain(output) || !only(output, ["state", "document"])) {
      throw new TypeError("Interactive plugin reducer returned an invalid result.");
    }
    return {state: projectState(output.state), document: projectDocument(output.document)};
  }
}
`;

/** Read-only open or one pure reducer action passed to the isolated UI artifact. */
export type InteractivePluginUiRequest = {
  readonly kind: "open";
  readonly state: PluginConfigurationValue | null;
} | {
  readonly kind: "action";
  readonly state: PluginConfigurationValue | null;
  readonly revision: number;
  readonly action: {readonly actionId: string; readonly input: string | null};
};

interface InteractivePluginUiEntrypoint extends WorkerEntrypoint {
  interact(request: InteractivePluginUiRequest): Promise<unknown>;
}

/** Deep port for one fresh, resource-limited interactive UI execution. */
export interface InteractivePluginUiWorkerStarter {
  /** Runs a verified definition and returns the worker-projected result only. */
  interact(
    getCode: () => Promise<WorkerLoaderWorkerCode>,
    request: InteractivePluginUiRequest,
  ): Promise<unknown>;
}

function disposeRpcValue(value: object): void {
  if (!(Symbol.dispose in value)) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === "function") dispose.call(value);
}

/** Production adapter around Worker Loader's fresh execution boundary. */
export class WorkerLoaderInteractivePluginUiStarter implements InteractivePluginUiWorkerStarter {
  constructor(private loader: Pick<WorkerLoader, "load">) {}

  async interact(
      getCode: () => Promise<WorkerLoaderWorkerCode>,
      request: InteractivePluginUiRequest): Promise<unknown> {
    const entrypoint = this.loader.load(await getCode())
      .getEntrypoint<InteractivePluginUiEntrypoint>();
    const pending = entrypoint.interact(request);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Interactive plugin UI timed out.")),
            INTERACTIVE_UI_TIMEOUT_MS,
          );
        }),
      ]);
      try {
        return structuredClone(result);
      } finally {
        if (typeof result === "object" && result !== null) disposeRpcValue(result);
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      disposeRpcValue(pending);
      disposeRpcValue(entrypoint);
    }
  }
}

function workerCode(artifact: VerifiedPluginCodeArtifact): WorkerLoaderWorkerCode {
  if (artifact.byteLength > MAX_INTERACTIVE_UI_ARTIFACT_BYTES) {
    throw new RangeError("Interactive plugin UI artifact exceeds the host runtime limit.");
  }
  return {
    compatibilityDate: INTERACTIVE_UI_COMPATIBILITY_DATE,
    compatibilityFlags: [...INTERACTIVE_UI_FLAGS],
    mainModule: "plugin-ui-harness.js",
    modules: {
      "plugin-ui-harness.js": INTERACTIVE_UI_HARNESS,
      "plugin-ui.js": artifact.code,
    },
    env: {},
    globalOutbound: null,
    limits: {...INTERACTIVE_UI_LIMITS},
  };
}

/** Executes a pure interactive artifact and returns only validated owned state and UI. */
export class DynamicWorkerInteractivePluginUi {
  constructor(
    private starter: InteractivePluginUiWorkerStarter,
    private artifacts: PluginUiArtifactResolver,
  ) {}

  /** Opens or reduces one snapshot without granting state or host authority to plugin code. */
  async interact(codeArtifactDigest: string, request: InteractivePluginUiRequest): Promise<{
    state: PluginConfigurationValue;
    document: UserPluginInteractiveDocument;
  } | null> {
    const resolved = await this.artifacts.resolve(codeArtifactDigest);
    if (!resolved.ok) return null;
    try {
      const output = await this.starter.interact(
        () => Promise.resolve(workerCode(resolved.artifact)),
        structuredClone(request),
      );
      if (
        typeof output !== "object" || output === null || Array.isArray(output) ||
        Object.keys(output).length !== 2 || !("state" in output) || !("document" in output)
      ) return null;
      const state = decodePluginConfigurationValue(Reflect.get(output, "state"));
      const document = snapshotUserPluginInteractiveDocument(Reflect.get(output, "document"));
      return document === null ? null : {state, document};
    } catch {
      return null;
    }
  }
}
