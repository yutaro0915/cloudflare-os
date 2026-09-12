import {
  CordisPluginRuntimeAdapter,
  type CordisPluginRuntimeLease,
} from "./cordis-plugin-runtime-adapter.js";
import {
  DynamicWorkerPluginExecutionActivator,
  type PluginRuntimeRealmIdentity,
  type PluginWorkerStarter,
} from "./dynamic-worker-plugin-activator.js";
import type { EffectivePluginConfigurationInput } from "./plugin-effective-configuration.js";
import { resolveEffectivePluginConfiguration } from "./plugin-effective-configuration.js";
import { InMemoryPluginCapabilityGateRegistry } from "./plugin-capability-gate.js";
import type {
  PluginCapabilityAuthority,
  PluginActiveInstallationAuthority,
  PluginStagedInstallationAuthority,
} from "./plugin-capability-gate.js";
import type { VerifyingPluginCodeArtifactResolver } from "./plugin-code-artifact.js";
import type { PluginManifestResolver } from "./plugin-manifest-registry.js";
import { PluginReconciler, type RuntimePluginPlan } from "./plugin-reconciler.js";
import type {
  PluginReconciliationResult,
  RuntimePluginIdentity,
} from "./plugin-reconciler.js";
import type {
  PluginRuntimeLeaseClaim,
  PluginRuntimeRealm,
} from "./plugin-runtime-realms.js";
import { buildRuntimePluginPlans } from "./plugin-runtime-plan.js";
import type {
  PluginRuntimeStateView,
  PluginRuntimeStatusView,
} from "@gadgets/workshop-shared/api";

/** Atomic trusted control snapshot read before one realm reconciliation pass. */
export interface PluginRuntimeControlSnapshot {
  /** Desired installations from deployment, workspace, and user owners. */
  readonly desiredState: EffectivePluginConfigurationInput;

  /** Permanent manifest denials owned by deployment AdminSettings. */
  readonly deniedManifestDigests: readonly string[];
}

/** Trusted composition inputs for one authenticated plugin runtime realm. */
export interface ReconciledPluginRuntimeRealmOptions {
  /** Host-minted workspace/user/role generation identity. */
  readonly identity: PluginRuntimeRealmIdentity;

  /** Reads desired state and deployment deny policy without performing runtime mutation. */
  readonly readControlState: () => Promise<PluginRuntimeControlSnapshot>;

  /** Immutable manifest registry shared by all realms in the deployment isolate. */
  readonly manifests: PluginManifestResolver | Promise<PluginManifestResolver>;

  /** Re-verifies prebundled code on every cold Dynamic Worker callback. */
  readonly artifacts: VerifyingPluginCodeArtifactResolver;

  /** Starts exact host-authored Dynamic Worker definitions. */
  readonly starter: PluginWorkerStarter;

  /** Mints only stable loopback Service Bindings for one staged activation. */
  readonly makeCapabilityEnv: (
    plan: RuntimePluginPlan,
    activationKey: string,
  ) => Record<string, unknown>;

  /** Wall-clock ceiling for the cross-DO desired-state snapshot read. */
  readonly refreshTimeoutMs?: number;

  /** Persists or emits a safe status transition without receiving runtime authority. */
  readonly recordStatus?: (
    action:
      "PLUGIN_RUNTIME_RECONCILED" |
      "PLUGIN_RUNTIME_REFRESH_FAILED" |
      "PLUGIN_RUNTIME_INVOCATION_FAILED",
    status: PluginRuntimeStatusView,
  ) => void;
}

function activeState(active: RuntimePluginIdentity): PluginRuntimeStateView {
  return {pluginId: active.pluginId, status: "active", active: structuredClone(active)};
}

function projectResult(result: PluginReconciliationResult): PluginRuntimeStatusView {
  return {
    outcome: result.ok ? "ready" : "conflict",
    states: result.ok
      ? structuredClone(result.states)
      : result.active.map(activeState),
    observedAt: Date.now(),
  };
}

async function withinDeadline<T>(
    operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Plugin runtime refresh timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Deep realm host that owns three-scope resolution, reconciliation, Cordis, and gate lifecycle. */
export class ReconciledPluginRuntimeRealm implements PluginRuntimeRealm {
  readonly #gates: InMemoryPluginCapabilityGateRegistry;
  readonly #activator: DynamicWorkerPluginExecutionActivator;
  readonly #runtime: CordisPluginRuntimeAdapter;
  readonly #reconciler: PluginReconciler<CordisPluginRuntimeLease>;
  #refreshTail = Promise.resolve();
  readonly #refreshTimeoutMs: number;
  #lastStatus: PluginRuntimeStatusView = {
    outcome: "ready",
    states: [],
    observedAt: Date.now(),
  };

  /** Constructs an empty runtime projection without reading or mutating desired state. */
  constructor(private options: ReconciledPluginRuntimeRealmOptions) {
    this.#gates = new InMemoryPluginCapabilityGateRegistry(
      (plan, activationKey) => options.makeCapabilityEnv(plan, activationKey),
    );
    this.#activator = new DynamicWorkerPluginExecutionActivator(
      options.identity,
      options.starter,
      options.artifacts,
      this.#gates,
    );
    this.#runtime = new CordisPluginRuntimeAdapter(this.#activator);
    this.#reconciler = new PluginReconciler(this.#runtime);
    this.#refreshTimeoutMs = options.refreshTimeoutMs ?? 15_000;
  }

  async refresh(): Promise<void> {
    const run = this.#refreshTail.then(async () => {
      try {
        const result = await this.#applyDesiredState();
        this.#setStatus("PLUGIN_RUNTIME_RECONCILED", projectResult(result));
      } catch (error) {
        this.#setStatus("PLUGIN_RUNTIME_REFRESH_FAILED", {
          outcome: "refresh-failed",
          states: structuredClone(this.#lastStatus.states),
          observedAt: Date.now(),
        });
        throw error;
      }
    });
    this.#refreshTail = run.then(() => undefined, () => undefined);
    await run;
  }

  getStatus(): PluginRuntimeStatusView {
    return structuredClone(this.#lastStatus);
  }

  recordRuntimeFailure(pluginId: string): void {
    const authority = this.#gates.activeClaim(pluginId);
    const installation = authority === undefined ? undefined :
      this.activeInstallationAuthority(
        pluginId,
        authority.activationKey,
        authority.manifestDigest,
      )?.installation;
    const failed: PluginRuntimeStateView = {
      pluginId,
      status: "failed",
      ...(installation === undefined ? {} : {candidate: {
        installationId: installation.installationId,
        pluginId: installation.pluginId,
        packageVersion: installation.packageVersion,
        manifestDigest: installation.manifestDigest,
      }}),
      reason: "RUNTIME_INVOCATION_FAILED",
    };
    const states = this.#lastStatus.states
      .filter(state => state.pluginId !== pluginId)
      .concat(failed)
      .toSorted((a, b) => a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0);
    this.#setStatus("PLUGIN_RUNTIME_INVOCATION_FAILED", {
      outcome: "ready",
      states,
      observedAt: Date.now(),
    });
  }

  revokeAll(): void {
    this.#gates.close();
  }

  async close(): Promise<void> {
    await this.#refreshTail;
    await this.#reconciler.reconcile({ok: true, plans: [], preflightFailures: []});
    await this.#runtime.retryLocalCleanup();
  }

  assertGate(
      pluginId: string,
      activationKey: string,
      manifestDigest: string,
      phase: "staged" | "active"): void {
    const active = this.#gates.activeClaim(pluginId);
    const allowed = phase === "staged"
      ? this.#gates.isStaged(pluginId, activationKey, manifestDigest)
      : active?.activationKey === activationKey &&
        active.manifestDigest === manifestDigest &&
        active.leaseEpoch === this.#reconciler.activeLeaseEpoch(pluginId);
    if (!allowed) throw new Error("Plugin runtime gate denied.");
  }

  assertPluginActive(pluginId: string): void {
    const active = this.#gates.activeClaim(pluginId);
    if (
      active === undefined ||
      active.leaseEpoch !== this.#reconciler.activeLeaseEpoch(pluginId)
    ) {
      throw new Error("Plugin runtime plugin is inactive.");
    }
  }

  activeCapabilityAuthority(
      pluginId: string,
      activationKey: string,
      manifestDigest: string,
      capability: string): PluginCapabilityAuthority | undefined {
    const authority = this.#gates.capabilityAuthority(
      pluginId, activationKey, manifestDigest, capability, "active",
    );
    return authority?.leaseEpoch === this.#reconciler.activeLeaseEpoch(pluginId)
      ? authority
      : undefined;
  }

  activeInstallationAuthority(
      pluginId: string,
      activationKey: string,
      manifestDigest: string): PluginActiveInstallationAuthority | undefined {
    const authority = this.#gates.activeInstallationAuthority(
      pluginId, activationKey, manifestDigest,
    );
    return authority?.leaseEpoch === this.#reconciler.activeLeaseEpoch(pluginId)
      ? authority
      : undefined;
  }

  stagedInstallationAuthority(
      pluginId: string,
      activationKey: string,
      manifestDigest: string): PluginStagedInstallationAuthority | undefined {
    return this.#gates.stagedInstallationAuthority(pluginId, activationKey, manifestDigest);
  }

  /** Returns an owned exact active claim for trusted host loopback diagnostics. */
  activeClaim(pluginId: string): PluginRuntimeLeaseClaim | undefined {
    const claim = this.#gates.activeClaim(pluginId);
    const leaseEpoch = this.#reconciler.activeLeaseEpoch(pluginId);
    return claim === undefined || leaseEpoch === undefined || claim.leaseEpoch !== leaseEpoch
      ? undefined
      : claim;
  }

  /** Invokes the active plugin; success is evidence, but untrusted output is never returned. */
  async assertWorkspaceMetadataCapability(pluginId: string): Promise<void> {
    const claim = this.#gates.activeClaim(pluginId);
    if (claim === undefined) throw new Error("Plugin runtime plugin is inactive.");
    await this.#activator.invoke(claim.activationKey);
  }

  denyPlugin(
      pluginId: string,
      activationKey: string,
      manifestDigest: string): boolean {
    return this.#gates.denyClaim(pluginId, activationKey, manifestDigest);
  }

  denyStagedPlugin(
      pluginId: string,
      activationKey: string,
      manifestDigest: string): boolean {
    return this.#gates.denyStagedClaim(pluginId, activationKey, manifestDigest);
  }

  async removeRevokedPlugin(pluginId: string, leaseEpoch: string): Promise<void> {
    await this.#reconciler.invalidateActive(pluginId, leaseEpoch);
  }

  async #applyDesiredState(): Promise<PluginReconciliationResult> {
    // The deadline covers only the side-effect-free cross-DO snapshot read. A late read result has
    // no continuation and therefore cannot race a later refresh or mutate the reconciler.
    const control = await withinDeadline(
      this.options.readControlState(),
      this.#refreshTimeoutMs,
    );
    await this.#reconciler.denyManifests(control.deniedManifestDigests);
    const effective = resolveEffectivePluginConfiguration(control.desiredState);
    if (!effective.ok) {
      return this.#reconciler.reconcile(effective);
    }
    const plans = await buildRuntimePluginPlans(
      effective.installations,
      await this.options.manifests,
      control.deniedManifestDigests,
    );
    return this.#reconciler.reconcile({ok: true, ...plans});
  }

  #setStatus(
      action: Parameters<NonNullable<ReconciledPluginRuntimeRealmOptions["recordStatus"]>>[0],
      status: PluginRuntimeStatusView): void {
    this.#lastStatus = structuredClone(status);
    try {
      this.options.recordStatus?.(action, structuredClone(status));
    } catch {
      // Status diagnostics cannot change or restore runtime authority.
    }
  }
}
