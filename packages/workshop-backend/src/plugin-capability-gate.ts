import type {
  PluginCapabilityGatePreparation,
  PluginCapabilityGateRegistry,
} from "./dynamic-worker-plugin-activator.js";
import type { RuntimePluginPlan } from "./plugin-reconciler.js";

interface ActiveGate {
  activationKey: string;
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
  readonly #staged = new Set<string>();
  readonly #activeByPluginId = new Map<string, ActiveGate>();

  /** Creates a default-deny registry around a host-owned Service Binding factory. */
  constructor(private makeEnv: PluginCapabilityEnvFactory) {}

  /** Stages an unselected activation and its stable loopback bindings. */
  stage(plan: RuntimePluginPlan, activationKey: string): PluginCapabilityGatePreparation {
    const pluginId = plan.installation.pluginId;
    const env = this.makeEnv(plan, activationKey);
    this.#staged.add(activationKey);
    let state: "staged" | "committed" | "aborted" = "staged";
    return {
      env,
      commit: () => {
        if (state !== "staged") throw new Error("Plugin capability gate is no longer staged.");
        state = "committed";
        this.#staged.delete(activationKey);
        this.#activeByPluginId.set(pluginId, {activationKey});
        let revoked = false;
        return {
          revoke: () => {
            if (revoked) return;
            revoked = true;
            if (this.isActive(pluginId, activationKey)) this.#activeByPluginId.delete(pluginId);
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
  isStaged(activationKey: string): boolean {
    return this.#staged.has(activationKey);
  }

  /** Returns whether a capability call belongs to the currently selected plugin activation. */
  isActive(pluginId: string, activationKey: string): boolean {
    return this.#activeByPluginId.get(pluginId)?.activationKey === activationKey;
  }
}
