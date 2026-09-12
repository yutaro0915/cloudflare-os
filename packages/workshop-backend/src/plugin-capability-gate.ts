import type {
  PluginCapabilityGatePreparation,
  PluginCapabilityGateRegistry,
} from "./dynamic-worker-plugin-activator.js";
import type { RuntimePluginPlan } from "./plugin-reconciler.js";
import type { EffectivePluginInstallation } from "./plugin-effective-configuration.js";

interface ActiveGate {
  activationKey: string;
  leaseEpoch: string;
  manifestDigest: string;
  installation: EffectivePluginInstallation;
}

/** Exact non-secret claim used only by trusted host loopback diagnostics. */
export interface PluginRuntimeGateClaim {
  /** Complete activation identity captured by the Dynamic Worker binding. */
  activationKey: string;

  /** Opaque reconciler lease epoch atomically selected with this gate. */
  leaseEpoch: string;

  /** Immutable manifest digest selected by the current gate. */
  manifestDigest: string;
}

/** Host-owned installation authority selected by one exact local capability gate. */
export interface PluginCapabilityAuthority {
  /** Installation snapshot approved when this runtime was staged. */
  installation: EffectivePluginInstallation;

  /** Actual current local gate phase, never inferred by a remote caller. */
  phase: "staged" | "active";

  /** Opaque activation token captured by the selected gate. */
  leaseEpoch: string;
}

/** Exact staged installation snapshot used for a final owner-SSOT commit check. */
export interface PluginStagedInstallationAuthority {
  /** Candidate installation captured before its untrusted handshake started. */
  installation: EffectivePluginInstallation;
}

/** Exact active installation selected by the local token-matched gate. */
export interface PluginActiveInstallationAuthority {
  installation: EffectivePluginInstallation;
  leaseEpoch: string;
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
  stage(
      plan: RuntimePluginPlan,
      activationKey: string,
      leaseEpoch: string): PluginCapabilityGatePreparation {
    if (this.#closed) throw new Error("Plugin capability gate realm is closed.");
    const pluginId = plan.installation.pluginId;
    const manifestDigest = plan.installation.manifestDigest;
    const env = this.makeEnv(plan, activationKey);
    const installation = structuredClone(plan.installation);
    this.#staged.set(activationKey, {
      activationKey,
      leaseEpoch,
      pluginId,
      manifestDigest,
      installation,
    });
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
        this.#activeByPluginId.set(pluginId, {
          activationKey,
          leaseEpoch,
          manifestDigest,
          installation,
        });
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

  /** Checks a host-known capability against one exact staged or active immutable claim. */
  isCapabilityGranted(
      pluginId: string,
      activationKey: string,
      manifestDigest: string,
      capability: string,
      phase: "staged" | "active" | "staged-or-active"): boolean {
    const matches = (claim: ActiveGate | undefined) =>
      claim?.activationKey === activationKey &&
      claim.manifestDigest === manifestDigest &&
      claim.installation.grantedCapabilities.includes(capability);
    if (phase !== "active") {
      const staged = this.#staged.get(activationKey);
      if (staged?.pluginId === pluginId && matches(staged)) return true;
    }
    return phase !== "staged" && matches(this.#activeByPluginId.get(pluginId));
  }

  /** Returns an owned authority snapshot only for an exact granted local claim. */
  capabilityAuthority(
      pluginId: string,
      activationKey: string,
      manifestDigest: string,
      capability: string,
      phase: "staged" | "active"): PluginCapabilityAuthority | undefined {
    if (!this.isCapabilityGranted(
      pluginId, activationKey, manifestDigest, capability, phase,
    )) return undefined;
    const claim = phase === "staged"
      ? this.#staged.get(activationKey)
      : this.#activeByPluginId.get(pluginId);
    return claim === undefined ? undefined : {
      installation: structuredClone(claim.installation),
      phase,
      leaseEpoch: claim.leaseEpoch,
    };
  }

  /** Returns an owned candidate only while this exact immutable claim remains staged. */
  stagedInstallationAuthority(
      pluginId: string,
      activationKey: string,
      manifestDigest: string): PluginStagedInstallationAuthority | undefined {
    const claim = this.#staged.get(activationKey);
    if (
      claim?.pluginId !== pluginId ||
      claim.manifestDigest !== manifestDigest
    ) return undefined;
    return {installation: structuredClone(claim.installation)};
  }

  /** Returns an owned installation snapshot only for one exact active claim. */
  activeInstallationAuthority(
      pluginId: string,
      activationKey: string,
      manifestDigest: string): PluginActiveInstallationAuthority | undefined {
    if (!this.isActive(pluginId, activationKey, manifestDigest)) return undefined;
    const claim = this.#activeByPluginId.get(pluginId);
    return claim === undefined ? undefined : {
      installation: structuredClone(claim.installation),
      leaseEpoch: claim.leaseEpoch,
    };
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

  /** Aborts only an exact staged candidate without touching a same-digest active lease. */
  denyStagedClaim(pluginId: string, activationKey: string, manifestDigest: string): boolean {
    if (!this.isStaged(pluginId, activationKey, manifestDigest)) return false;
    this.#staged.delete(activationKey);
    return true;
  }

  /** Returns whether any current generation activation is selected for host diagnostics. */
  hasActivePlugin(pluginId: string): boolean {
    return this.#activeByPluginId.has(pluginId);
  }

  /** Returns an owned exact active claim for a trusted host diagnostic. */
  activeClaim(pluginId: string): PluginRuntimeGateClaim | undefined {
    const claim = this.#activeByPluginId.get(pluginId);
    return claim === undefined ? undefined : {
      activationKey: claim.activationKey,
      leaseEpoch: claim.leaseEpoch,
      manifestDigest: claim.manifestDigest,
    };
  }

  /** Permanently denies this realm before asynchronous runtime cleanup begins. */
  close(): void {
    this.#closed = true;
    this.#staged.clear();
    this.#activeByPluginId.clear();
  }
}
