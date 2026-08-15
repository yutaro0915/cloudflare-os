import type { WorkerEntrypoint } from "cloudflare:workers";
import type { CollaboratorRole } from "@gadgets/workshop-shared/api";
import type {
  ActivePluginExecution,
  PluginExecutionActivator,
  PreparedPluginExecution,
} from "./cordis-plugin-runtime-adapter.js";
import type {
  VerifyingPluginCodeArtifactResolver,
  VerifiedPluginCodeArtifact,
} from "./plugin-code-artifact.js";
import type { RuntimePluginPlan } from "./plugin-reconciler.js";

const PLUGIN_HARNESS_ABI = "plugin-harness-v1";
const PLUGIN_COMPATIBILITY_DATE = "2026-02-01";
const PLUGIN_COMPATIBILITY_FLAGS = ["disallow_importable_env"] as const;
const PLUGIN_LIMITS = {cpuMs: 50, subRequests: 16} as const;
const PLUGIN_RUNTIME_POLICY = "default-deny-v1";
const MAX_PLUGIN_ARTIFACT_BYTES = 256 * 1024;
const PLUGIN_HANDSHAKE_TIMEOUT_MS = 5_000;

const PLUGIN_HARNESS = `
import { WorkerEntrypoint } from "cloudflare:workers";
import plugin from "plugin.js";

export default class extends WorkerEntrypoint {
  async verify() {
    await this.env.PLUGIN_HOST.verifyStaged();
    if (typeof plugin?.handshake !== "function") {
      throw new TypeError("Plugin artifact must export default.handshake().");
    }
    await plugin.handshake();
  }
}
`;

interface PluginWorkerEntrypoint extends WorkerEntrypoint {
  verify(): Promise<void>;
}

/** Started Dynamic Worker control surface hidden from the domain activator. */
export interface PluginWorkerControl {
  /** Awaits host harness import, staged-gate verification, and plugin handshake. */
  verify(): Promise<void>;
}

/** Deep port that starts one host-composed Dynamic Worker definition. */
export interface PluginWorkerStarter {
  /** Starts or reuses an exact worker identity and returns its fixed control entrypoint. */
  start(
    id: string,
    getCode: () => Promise<WorkerLoaderWorkerCode>,
  ): Promise<PluginWorkerControl>;
}

/** Prepared installation-scoped capability gate passed into a Dynamic Worker as explicit env. */
export interface PluginCapabilityGatePreparation extends PreparedPluginExecution {
  /** Stable loopback Service Bindings only; raw DO/KV/D1 bindings are forbidden. */
  readonly env: Record<string, unknown>;
}

/** Stages installation-scoped, synchronously revocable capability routing. */
export interface PluginCapabilityGateRegistry {
  /** Creates an unselected gate whose bindings re-check this activation key on every call. */
  stage(plan: RuntimePluginPlan, activationKey: string): PluginCapabilityGatePreparation;
}

/** Stable authenticated locator for one user-role realm inside an owning workspace. */
export interface PluginRuntimeRealmLocator {
  /** Owning workspace Durable Object ID. */
  readonly overseerId: string;

  /** Authenticated User Durable Object ID. */
  readonly userId: string;

  /** Effective workspace role whose policy is bound into the cached Worker definition. */
  readonly role: CollaboratorRole;
}

/** Host-generated realm generation bound into cached Worker identity and loopback authority. */
export interface PluginRuntimeRealmIdentity extends PluginRuntimeRealmLocator {
  /** Opaque nonce that prevents a released warm Worker claim from becoming authoritative again. */
  readonly generation: string;
}

/** Production adapter around the repository's existing Worker Loader binding. */
export class WorkerLoaderPluginWorkerStarter implements PluginWorkerStarter {
  /** Wraps only the real `get` method instead of mirroring the Worker Loader API. */
  constructor(private loader: Pick<WorkerLoader, "get">) {}

  async start(
      id: string,
      getCode: () => Promise<WorkerLoaderWorkerCode>): Promise<PluginWorkerControl> {
    const entrypoint = this.loader.get(id, getCode).getEntrypoint<PluginWorkerEntrypoint>();
    return {verify: () => entrypoint.verify()};
  }
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("Plugin activation identity requires a finite JSON number other than -0.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError("Plugin activation identity must not contain cyclic JSON values.");
    }
    ancestors.add(value);
    try {
      return `[${value.map(entry => canonicalJson(entry, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Plugin activation identity accepts only plain JSON objects.");
    }
    if (ancestors.has(value)) {
      throw new TypeError("Plugin activation identity must not contain cyclic JSON values.");
    }
    ancestors.add(value);
    const entries = Object.entries(value).toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0);
    try {
      return `{${entries.map(([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalJson(entry, ancestors)}`).join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new TypeError("Plugin activation identity must contain only JSON values.");
}

/** Computes a fixed-length cache key from code, authority, configuration, and host policy. */
export async function pluginActivationKey(
    realm: PluginRuntimeRealmIdentity,
    plan: RuntimePluginPlan): Promise<string> {
  const canonical = canonicalJson({
    realm,
    scope: plan.installation.scope,
    targetId: plan.installation.targetId,
    installationId: plan.installation.installationId,
    pluginId: plan.installation.pluginId,
    packageVersion: plan.installation.packageVersion,
    manifestDigest: plan.installation.manifestDigest,
    codeArtifactDigest: plan.runtime.codeArtifactDigest,
    grantedCapabilities: [...plan.installation.grantedCapabilities].toSorted(),
    config: plan.installation.config,
    stateRef: plan.installation.stateRef ?? null,
    harnessAbi: PLUGIN_HARNESS_ABI,
    harnessSource: PLUGIN_HARNESS,
    compatibilityDate: PLUGIN_COMPATIBILITY_DATE,
    compatibilityFlags: PLUGIN_COMPATIBILITY_FLAGS,
    limits: PLUGIN_LIMITS,
    maxArtifactBytes: MAX_PLUGIN_ARTIFACT_BYTES,
    handshakeTimeoutMs: PLUGIN_HANDSHAKE_TIMEOUT_MS,
    runtimePolicy: PLUGIN_RUNTIME_POLICY,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return `plugin-worker:v1:${new Uint8Array(digest).toHex()}`;
}

async function verifyWithinDeadline(control: PluginWorkerControl): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      control.verify(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Plugin handshake timed out.")),
          PLUGIN_HANDSHAKE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function workerCode(
    artifact: VerifiedPluginCodeArtifact,
    env: Record<string, unknown>): WorkerLoaderWorkerCode {
  if (artifact.byteLength > MAX_PLUGIN_ARTIFACT_BYTES) {
    throw new RangeError("Plugin code artifact exceeds the host runtime limit.");
  }
  return {
    compatibilityDate: PLUGIN_COMPATIBILITY_DATE,
    compatibilityFlags: [...PLUGIN_COMPATIBILITY_FLAGS],
    mainModule: "plugin-harness.js",
    modules: {
      "plugin-harness.js": PLUGIN_HARNESS,
      "plugin.js": artifact.code,
    },
    env,
    globalOutbound: null,
    limits: {...PLUGIN_LIMITS},
  };
}

/** Isolates verified prebundled plugin code behind Dynamic Workers and revocable host gates. */
export class DynamicWorkerPluginExecutionActivator implements PluginExecutionActivator {
  /** Creates a default-deny activator without exposing Worker Loader details to Cordis. */
  constructor(
    private realm: PluginRuntimeRealmIdentity,
    private starter: PluginWorkerStarter,
    private artifacts: VerifyingPluginCodeArtifactResolver,
    private gates: PluginCapabilityGateRegistry,
  ) {}

  async prepare(
      candidate: RuntimePluginPlan,
      addCleanup: (label: string, step: () => void | Promise<void>) => void,
  ): Promise<PreparedPluginExecution> {
    if (candidate.installation.grantedCapabilities.length > 0) {
      throw new Error("Plugin capability bindings are not implemented for this runtime policy.");
    }
    const activationKey = await pluginActivationKey(this.realm, candidate);
    const gate = this.gates.stage(candidate, activationKey);
    addCleanup("plugin-capability-gate", () => gate.abort());
    try {
      const control = await this.starter.start(activationKey, async () => {
        const result = await this.artifacts.resolve(candidate.runtime.codeArtifactDigest);
        if (!result.ok) throw new Error(`Plugin code artifact rejected: ${result.error}`);
        return workerCode(result.artifact, gate.env);
      });
      await verifyWithinDeadline(control);
      return gate;
    } catch (error) {
      gate.abort();
      throw error;
    }
  }
}

/** Active gate alias used only to document the synchronous commit/revoke contract. */
export type DynamicWorkerPluginExecution = ActivePluginExecution;
