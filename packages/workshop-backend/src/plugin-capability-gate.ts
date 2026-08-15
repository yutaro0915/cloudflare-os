import type {
  PluginCapabilityGatePreparation,
  PluginCapabilityGateRegistry,
} from "./dynamic-worker-plugin-activator.js";
import type { RuntimePluginPlan } from "./plugin-reconciler.js";

interface ActiveGate {
  activationKey: string;
  manifestDigest: string;
}

/** Exact non-secret claim used only by trusted host loopback diagnostics. */
export interface PluginRuntimeGateClaim {
  /** Complete activation identity captured by the Dynamic Worker binding. */
  activationKey: string;

  /** Immutable manifest digest selected by the current gate. */
  manifestDigest: string;
}

/** Creates explicit stable loopback bindings for one staged activation. */
export type PluginCapabilityEnvFactory = (
  plan: RuntimePluginPlan,
  activationKey: string,
) => Record<string, unknown>;

/**
 * Isolate-local selection gate for Dynamic Worker capability loopbacks.
 *
 * A reconstructed registry starts empty and therefore denies every cached worker until desired
 * state is reconciled again. The loopback Service Binding must call `isActive` on every operation;
 * possession of a previously issued stub is never sufficient authority.
 */
export class InMemoryPluginCapabilityGateRegistry implements PluginCapabilityGateRegistry {
  readonly #staged = new Map<string, ActiveGate & {pluginId: string}>();
  readonly #activeByPluginId = new Map<string, ActiveGate>();
  #closed = false;

  /** Creates a default-deny registry around a host-owned Service Binding factory. */
  constructor(private makeEnv: PluginCapabilityEnvFactory) {}

  /** Stages an unselected activation and its stable loopback bindings. */
  stage(plan: RuntimePluginPlan, activationKey: string): PluginCapabilityGatePreparation {
    if (this.#closed) throw new Error("Plugin capability gate realm is closed.");
    const pluginId = plan.installation.pluginId;
    const manifestDigest = plan.installation.manifestDigest;
    const env = this.makeEnv(plan, activationKey);
    this.#staged.set(activationKey, {activationKey, pluginId, manifestDigest});
    let state: "staged" | "committed" | "aborted" = "staged";
    return {
      env,
      commit: () => {
        if (this.#closed) throw new Error("Plugin capability gate realm is closed.");
        if (state !== "staged") throw new Error("Plugin capability gate is no longer staged.");
        if (!this.isStaged(pluginId, activationKey, manifestDigest)) {
          throw new Error("Plugin capability gate is no longer staged.");
        }
        state = "committed";
        this.#staged.delete(activationKey);
        this.#activeByPluginId.set(pluginId, {activationKey, manifestDigest});
        let revoked = false;
        return {
          revoke: () => {
            if (revoked) return;
            revoked = true;
            if (this.isActive(pluginId, activationKey, manifestDigest)) {
              this.#activeByPluginId.delete(pluginId);
            }
          },
        };
      },
      abort: () => {
        if (state !== "staged") return;
        state = "aborted";
        this.#staged.delete(activationKey);
      },
    };
  }

  /** Returns whether the fixed harness may complete its pre-commit handshake. */
  isStaged(pluginId: string, activationKey: string, manifestDigest: string): boolean {
    const staged = this.#staged.get(activationKey);
    return staged?.pluginId === pluginId && staged.manifestDigest === manifestDigest;
  }

  /** Returns whether a capability call belongs to the currently selected plugin activation. */
  isActive(pluginId: string, activationKey: string, manifestDigest: string): boolean {
    const active = this.#activeByPluginId.get(pluginId);
    return active?.activationKey === activationKey && active.manifestDigest === manifestDigest;
  }

  /** Immediately revokes an exact denied staged or active claim before physical cleanup. */
  denyClaim(pluginId: string, activationKey: string, manifestDigest: string): boolean {
    let denied = false;
    if (this.isStaged(pluginId, activationKey, manifestDigest)) {
      this.#staged.delete(activationKey);
      denied = true;
    }
    if (this.isActive(pluginId, activationKey, manifestDigest)) {
      this.#activeByPluginId.delete(pluginId);
      denied = true;
    }
    return denied;
  }

  /** Returns whether any current generation activation is selected for host diagnostics. */
  hasActivePlugin(pluginId: string): boolean {
    return this.#activeByPluginId.has(pluginId);
  }

  /** Returns an owned exact active claim for a trusted host diagnostic. */
  activeClaim(pluginId: string): PluginRuntimeGateClaim | undefined {
    const claim = this.#activeByPluginId.get(pluginId);
    return claim === undefined ? undefined : {...claim};
  }

  /** Permanently denies this realm before asynchronous runtime cleanup begins. */
  close(): void {
    this.#closed = true;
    this.#staged.clear();
    this.#activeByPluginId.clear();
  }
}
