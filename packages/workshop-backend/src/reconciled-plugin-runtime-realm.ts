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
import type { PluginRuntimeGateClaim } from "./plugin-capability-gate.js";
import type { VerifyingPluginCodeArtifactResolver } from "./plugin-code-artifact.js";
import type { PluginManifestResolver } from "./plugin-manifest-registry.js";
import { PluginReconciler, type RuntimePluginPlan } from "./plugin-reconciler.js";
import type { PluginRuntimeRealm } from "./plugin-runtime-realms.js";
import { buildRuntimePluginPlans } from "./plugin-runtime-plan.js";

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
  readonly #runtime: CordisPluginRuntimeAdapter;
  readonly #reconciler: PluginReconciler<CordisPluginRuntimeLease>;
  #refreshTail = Promise.resolve();
  readonly #refreshTimeoutMs: number;

  /** Constructs an empty runtime projection without reading or mutating desired state. */
  constructor(private options: ReconciledPluginRuntimeRealmOptions) {
    this.#gates = new InMemoryPluginCapabilityGateRegistry(
      (plan, activationKey) => options.makeCapabilityEnv(plan, activationKey),
    );
    const activator = new DynamicWorkerPluginExecutionActivator(
      options.identity,
      options.starter,
      options.artifacts,
      this.#gates,
    );
    this.#runtime = new CordisPluginRuntimeAdapter(activator);
    this.#reconciler = new PluginReconciler(this.#runtime);
    this.#refreshTimeoutMs = options.refreshTimeoutMs ?? 15_000;
  }

  async refresh(): Promise<void> {
    const run = this.#refreshTail.then(() => this.#applyDesiredState());
    this.#refreshTail = run.then(() => undefined, () => undefined);
    await run;
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
    const allowed = phase === "staged"
      ? this.#gates.isStaged(pluginId, activationKey, manifestDigest)
      : this.#gates.isActive(pluginId, activationKey, manifestDigest);
    if (!allowed) throw new Error("Plugin runtime gate denied.");
  }

  assertPluginActive(pluginId: string): void {
    if (!this.#gates.hasActivePlugin(pluginId)) {
      throw new Error("Plugin runtime plugin is inactive.");
    }
  }

  /** Returns an owned exact active claim for trusted host loopback diagnostics. */
  activeClaim(pluginId: string): PluginRuntimeGateClaim | undefined {
    return this.#gates.activeClaim(pluginId);
  }

  denyPlugin(
      pluginId: string,
      activationKey: string,
      manifestDigest: string): boolean {
    return this.#gates.denyClaim(pluginId, activationKey, manifestDigest);
  }

  async #applyDesiredState(): Promise<void> {
    // The deadline covers only the side-effect-free cross-DO snapshot read. A late read result has
    // no continuation and therefore cannot race a later refresh or mutate the reconciler.
    const control = await withinDeadline(
      this.options.readControlState(),
      this.#refreshTimeoutMs,
    );
    await this.#reconciler.denyManifests(control.deniedManifestDigests);
    const effective = resolveEffectivePluginConfiguration(control.desiredState);
    if (!effective.ok) {
      await this.#reconciler.reconcile(effective);
      return;
    }
    const plans = await buildRuntimePluginPlans(
      effective.installations,
      await this.options.manifests,
      control.deniedManifestDigests,
    );
    await this.#reconciler.reconcile({ok: true, ...plans});
  }
}
