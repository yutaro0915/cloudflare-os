import type {
  EffectivePluginConfigurationResult,
  EffectivePluginConflict,
  EffectivePluginInstallation,
} from "./plugin-effective-configuration.js";
import type { PluginRuntimeDescriptor } from "./plugin-manifest-registry.js";

/** One verified runtime candidate enriched with host-resolved plugin dependencies. */
export interface RuntimePluginPlan {
  /** Installation selected by the effective configuration resolver. */
  installation: EffectivePluginInstallation;

  /** Plugin identifiers required at runtime, from a verified immutable manifest. */
  dependencies: readonly string[];

  /** Isolated runtime artifact copied only from a digest-matched verified manifest. */
  runtime: PluginRuntimeDescriptor;
}

interface RuntimePluginPreflightFailureBase {
  /** Installation that could not be authorized as a runtime candidate. */
  installation: EffectivePluginInstallation;
}

/** One desired candidate rejected before activation, with an explicit old-runtime policy. */
export type RuntimePluginPreflightFailure = RuntimePluginPreflightFailureBase & ({
  /** Ordinary candidate failure may retain an independently safe old runtime. */
  retention: "allowed";

  /** Stable failure derived from exact immutable manifest verification. */
  reason:
    "MANIFEST_NOT_FOUND" | "MANIFEST_INTEGRITY_MISMATCH" |
    "RUNTIME_ARTIFACT_NOT_DECLARED" | "CAPABILITY_UNSUPPORTED";
} | {
  /** Deployment safety policy requires an old runtime with this digest to stop. */
  retention: "forbidden";

  /** Permanent deployment denial of this immutable manifest digest. */
  reason: "MANIFEST_DENYLISTED" | "RUNTIME_AUTHORITY_REVOKED";
});

/** Runtime boundary that atomically replaces or removes one isolated plugin activation. */
export interface PluginRuntimeAdapter<Lease> {
  /**
   * Prepare and commit `candidate`, replacing `previous` only on success. On rejection, the
   * candidate is logically revoked, isolate-local cleanup debt remains owned by the adapter, and
   * `previous` remains selected.
   */
  replace(
    candidate: RuntimePluginPlan,
    activationAttemptId: string,
    previous?: Lease,
  ): Promise<Lease>;

  /**
   * Logically revokes `active` before teardown. It rejects only when revocation failed and the
   * lease remains selected; isolate-local cleanup failure is retained and does not reject.
   */
  remove(active: Lease): Promise<void>;
}

/** Stable runtime identity exposed without leaking an adapter lease. */
export interface RuntimePluginIdentity {
  /** Stable identifier for this installation lifecycle. */
  installationId: string;

  /** Stable package identifier. */
  pluginId: string;

  /** Exact package version. */
  packageVersion: string;

  /** Content-addressed immutable manifest digest. */
  manifestDigest: string;
}

/** Reconciled state of one desired or retained plugin runtime. */
export type PluginReconciliationState = {
  /** Stable package identifier. */
  pluginId: string;

  /** The desired candidate is active. */
  status: "active";

  /** Runtime identity currently serving this plugin. */
  active: RuntimePluginIdentity;
} | {
  /** Stable package identifier. */
  pluginId: string;

  /** The desired candidate is waiting for a declared dependency. */
  status: "suspended";

  /** Candidate that could not yet be activated. */
  candidate: RuntimePluginIdentity;

  /** Stable dependency reason. */
  reason: "MISSING_DEPENDENCY" | "DEPENDENCY_UNAVAILABLE";

  /** Previous runtime retained while the candidate is suspended. */
  retainedActive?: RuntimePluginIdentity;
} | {
  /** Stable package identifier. */
  pluginId: string;

  /** Activation, dependency planning, or teardown failed for this plugin only. */
  status: "failed";

  /** Candidate that failed, omitted when removal itself failed. */
  candidate?: RuntimePluginIdentity;

  /** Stable failure reason. */
  reason:
    "ACTIVATION_FAILED" | "CYCLIC_DEPENDENCY" |
    "DEACTIVATION_FAILED" | "DEACTIVATION_BLOCKED" |
    RuntimePluginPreflightFailure["reason"];

  /** Previous runtime retained after the failed operation. */
  retainedActive?: RuntimePluginIdentity;
};

/** Host-enriched input accepted by the runtime reconciler. */
export type PluginReconciliationInput = {
  /** Effective configuration was unambiguous and enriched with verified dependencies. */
  ok: true;

  /** Complete desired runtime plan. */
  plans: readonly RuntimePluginPlan[];

  /** Desired candidates that failed trusted host verification before activation. */
  preflightFailures?: readonly RuntimePluginPreflightFailure[];
} | Extract<EffectivePluginConfigurationResult, {ok: false}>;

/** Plain-data result of one serialized reconciliation pass. */
export type PluginReconciliationResult = {
  /** Runtime state reflects the unambiguous desired plan as far as each plugin allowed. */
  ok: true;

  /** Per-plugin state sorted by plugin identifier. */
  states: PluginReconciliationState[];
} | {
  /** Effective configuration was ambiguous; runtime state was not changed. */
  ok: false;

  /** Stable machine-readable reason from effective configuration resolution. */
  error: "DUPLICATE_ENABLED_PLUGIN_ID";

  /** Conflict diagnostics copied without configuration or state references. */
  conflicts: EffectivePluginConflict[];

  /** Runtime identities retained without any adapter mutation. */
  active: RuntimePluginIdentity[];
};

interface ActivePlugin<Lease> {
  plan: RuntimePluginPlan;
  lease: Lease;
  leaseEpoch: string;
}

function identity(installation: EffectivePluginInstallation): RuntimePluginIdentity {
  return {
    installationId: installation.installationId,
    pluginId: installation.pluginId,
    packageVersion: installation.packageVersion,
    manifestDigest: installation.manifestDigest,
  };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => valuesEqual(value, b[index]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  return aEntries.length === bEntries.length && aEntries.every(([key, value]) =>
    Object.hasOwn(b, key) && valuesEqual(value, (b as Record<string, unknown>)[key]));
}

function plansEqual(a: RuntimePluginPlan, b: RuntimePluginPlan): boolean {
  return valuesEqual(a, b);
}

function findCyclicPluginIds(plans: ReadonlyMap<string, RuntimePluginPlan>): Set<string> {
  const visitState = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const stackIndex = new Map<string, number>();
  const cyclic = new Set<string>();

  const visit = (pluginId: string) => {
    visitState.set(pluginId, "visiting");
    stackIndex.set(pluginId, stack.length);
    stack.push(pluginId);
    for (const dependency of plans.get(pluginId)?.dependencies ?? []) {
      if (!plans.has(dependency)) continue;
      const state = visitState.get(dependency);
      if (state === undefined) {
        visit(dependency);
      } else if (state === "visiting") {
        const start = stackIndex.get(dependency);
        if (start !== undefined) {
          for (const member of stack.slice(start)) cyclic.add(member);
        }
      }
    }
    stack.pop();
    stackIndex.delete(pluginId);
    visitState.set(pluginId, "visited");
  };

  for (const pluginId of plans.keys()) {
    if (visitState.get(pluginId) === undefined) visit(pluginId);
  }
  return cyclic;
}

/** Rebuildable, Cordis-independent state machine over the plugin runtime adapter port. */
export class PluginReconciler<Lease> {
  readonly #active = new Map<string, ActivePlugin<Lease>>();
  readonly #invalidatedLeaseEpochs = new Map<string, string>();
  #reconciliationTail = Promise.resolve();

  /** Creates an empty runtime projection that will be rebuilt from desired state. */
  constructor(private runtime: PluginRuntimeAdapter<Lease>) {}

  /** Applies one desired snapshot and returns plain state without exposing runtime leases. */
  reconcile(input: PluginReconciliationInput): Promise<PluginReconciliationResult> {
    const snapshot = structuredClone(input);
    const run = this.#reconciliationTail.then(async () => {
      await this.#retryInvalidatedLeases();
      return this.#apply(this.#fenceInvalidatedLeases(snapshot));
    });
    this.#reconciliationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Removes active runtimes whose exact immutable manifest digest is centrally denied. */
  denyManifests(manifestDigests: readonly string[]): Promise<PluginReconciliationResult> {
    const denied = new Set(structuredClone(manifestDigests));
    const run = this.#reconciliationTail.then(() => {
      const plans: RuntimePluginPlan[] = [];
      const preflightFailures: RuntimePluginPreflightFailure[] = [];
      for (const current of this.#active.values()) {
        if (denied.has(current.plan.installation.manifestDigest)) {
          preflightFailures.push({
            installation: current.plan.installation,
            retention: "forbidden",
            reason: "MANIFEST_DENYLISTED",
          });
        } else {
          plans.push(current.plan);
        }
      }
      return this.#apply({ok: true, plans, preflightFailures});
    });
    this.#reconciliationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Force-removes one exact active lease after its logical host authority was revoked. */
  invalidateActive(pluginId: string, expectedLeaseEpoch: string): Promise<PluginReconciliationResult> {
    const run = this.#reconciliationTail.then(async () => {
      const current = this.#active.get(pluginId);
      if (current?.leaseEpoch !== expectedLeaseEpoch) {
        return this.#apply({
          ok: true,
          plans: Array.from(this.#active.values(), active => active.plan),
        });
      }
      this.#invalidatedLeaseEpochs.set(pluginId, expectedLeaseEpoch);
      const result = await this.#applyInvalidatedLease(pluginId, expectedLeaseEpoch);
      this.#clearSettledInvalidation(pluginId, expectedLeaseEpoch);
      return result;
    });
    this.#reconciliationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Returns the opaque epoch of the exact active reconciler lease. */
  activeLeaseEpoch(pluginId: string): string | undefined {
    return this.#active.get(pluginId)?.leaseEpoch;
  }

  async #retryInvalidatedLeases(): Promise<void> {
    for (const [pluginId, leaseEpoch] of this.#invalidatedLeaseEpochs) {
      await this.#applyInvalidatedLease(pluginId, leaseEpoch);
      this.#clearSettledInvalidation(pluginId, leaseEpoch);
    }
  }

  #clearSettledInvalidation(pluginId: string, leaseEpoch: string): void {
    if (this.#active.get(pluginId)?.leaseEpoch !== leaseEpoch) {
      this.#invalidatedLeaseEpochs.delete(pluginId);
    }
  }

  #applyInvalidatedLease(
      pluginId: string,
      leaseEpoch: string): Promise<PluginReconciliationResult> {
    const current = this.#active.get(pluginId);
    if (current?.leaseEpoch !== leaseEpoch) {
      return this.#apply({
        ok: true,
        plans: Array.from(this.#active.values(), active => active.plan),
      });
    }
    return this.#apply({
      ok: true,
      plans: Array.from(this.#active.entries())
        .filter(([currentPluginId]) => currentPluginId !== pluginId)
        .map(([, active]) => active.plan),
      preflightFailures: [{
        installation: current.plan.installation,
        retention: "forbidden",
        reason: "RUNTIME_AUTHORITY_REVOKED",
      }],
    });
  }

  #fenceInvalidatedLeases(input: PluginReconciliationInput): PluginReconciliationInput {
    if (!input.ok || this.#invalidatedLeaseEpochs.size === 0) return input;
    const blockedPluginIds = new Set(this.#invalidatedLeaseEpochs.keys());
    const preflightFailures = [...(input.preflightFailures ?? [])];
    for (const pluginId of blockedPluginIds) {
      const current = this.#active.get(pluginId);
      if (current !== undefined) {
        preflightFailures.push({
          installation: current.plan.installation,
          retention: "forbidden",
          reason: "RUNTIME_AUTHORITY_REVOKED",
        });
      }
    }
    return {
      ok: true,
      plans: input.plans.filter(plan => !blockedPluginIds.has(plan.installation.pluginId)),
      preflightFailures,
    };
  }

  async #apply(input: PluginReconciliationInput): Promise<PluginReconciliationResult> {
    if (!input.ok) {
      const active = Array.from(this.#active.values(), current =>
        identity(current.plan.installation)).toSorted((a, b) =>
          a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0);
      return {ok: false, error: input.error, conflicts: input.conflicts, active};
    }

    const statesByPluginId = new Map<string, PluginReconciliationState>();
    const plans = input.plans.toSorted((a, b) =>
      a.installation.pluginId < b.installation.pluginId ? -1 :
      a.installation.pluginId > b.installation.pluginId ? 1 : 0);
    const plansByPluginId = new Map(plans.map(plan => [plan.installation.pluginId, plan]));
    const preflightFailures = (input.preflightFailures ?? []).toSorted((a, b) =>
      a.installation.pluginId < b.installation.pluginId ? -1 :
      a.installation.pluginId > b.installation.pluginId ? 1 : 0);
    const failuresByPluginId = new Map(
      preflightFailures.map(failure => [failure.installation.pluginId, failure]),
    );
    const cyclicPluginIds = findCyclicPluginIds(plansByPluginId);
    const desiredPluginIds = new Set([
      ...plans.map(plan => plan.installation.pluginId),
      ...preflightFailures.map(failure => failure.installation.pluginId),
    ]);
    const processing = new Set<string>();
    const activeClosureCanRemain = (
        pluginId: string,
        memo = new Map<string, boolean>(),
        visiting = new Set<string>(),
    ): boolean => {
      const memoized = memo.get(pluginId);
      if (memoized !== undefined) return memoized;
      const current = this.#active.get(pluginId);
      if (current === undefined || visiting.has(pluginId)) return false;
      const failure = failuresByPluginId.get(pluginId);
      if (
        failure?.retention === "forbidden" &&
        failure.installation.manifestDigest === current.plan.installation.manifestDigest
      ) {
        return false;
      }
      const state = statesByPluginId.get(pluginId);
      const isConditionalCandidate = state?.status === "suspended" ||
        (state?.status === "failed" && (
          state.reason === "CYCLIC_DEPENDENCY" ||
          state.reason === "MANIFEST_NOT_FOUND" ||
          state.reason === "MANIFEST_INTEGRITY_MISMATCH" ||
          state.reason === "RUNTIME_ARTIFACT_NOT_DECLARED" ||
          state.reason === "CAPABILITY_UNSUPPORTED"
        ));
      if (
        isConditionalCandidate &&
        current.plan.dependencies.some(dependency => !desiredPluginIds.has(dependency))
      ) {
        memo.set(pluginId, false);
        return false;
      }

      visiting.add(pluginId);
      const result = current.plan.dependencies.every(dependency =>
        activeClosureCanRemain(dependency, memo, visiting));
      visiting.delete(pluginId);
      memo.set(pluginId, result);
      return result;
    };
    let processPlan: (plan: RuntimePluginPlan) => Promise<void>;
    const settleRetainedClosure = async (pluginId: string, visited: Set<string>): Promise<void> => {
      if (visited.has(pluginId)) return;
      visited.add(pluginId);
      const current = this.#active.get(pluginId);
      if (current === undefined) return;
      for (const dependency of current.plan.dependencies) {
        const dependencyPlan = plansByPluginId.get(dependency);
        if (dependencyPlan !== undefined) await processPlan(dependencyPlan);
        await settleRetainedClosure(dependency, visited);
      }
    };

    processPlan = async (plan: RuntimePluginPlan): Promise<void> => {
      const pluginId = plan.installation.pluginId;
      if (statesByPluginId.has(pluginId) || processing.has(pluginId)) return;
      const current = this.#active.get(plan.installation.pluginId);
      const recordUnavailable = async (
          state: Extract<PluginReconciliationState, {status: "suspended" | "failed"}>,
      ): Promise<void> => {
        if (current === undefined) {
          statesByPluginId.set(pluginId, state);
          return;
        }
        statesByPluginId.set(pluginId, {
          ...state,
          retainedActive: identity(current.plan.installation),
        });
      };
      if (cyclicPluginIds.has(pluginId)) {
        await recordUnavailable({
          pluginId,
          status: "failed",
          candidate: identity(plan.installation),
          reason: "CYCLIC_DEPENDENCY",
        });
        return;
      }
      if (plan.dependencies.some(dependency => !desiredPluginIds.has(dependency))) {
        await recordUnavailable({
          pluginId,
          status: "suspended",
          candidate: identity(plan.installation),
          reason: "MISSING_DEPENDENCY",
        });
        return;
      }

      processing.add(pluginId);
      for (const dependency of plan.dependencies) {
        const dependencyPlan = plansByPluginId.get(dependency);
        if (dependencyPlan !== undefined) await processPlan(dependencyPlan);
      }
      processing.delete(pluginId);
      for (const dependency of plan.dependencies) {
        await settleRetainedClosure(dependency, new Set());
      }
      if (plan.dependencies.some(dependency =>
        failuresByPluginId.has(dependency) || !activeClosureCanRemain(dependency))) {
        await recordUnavailable({
          pluginId,
          status: "suspended",
          candidate: identity(plan.installation),
          reason: "DEPENDENCY_UNAVAILABLE",
        });
        return;
      }
      if (current !== undefined && plansEqual(current.plan, plan)) {
        statesByPluginId.set(pluginId, {
          pluginId: plan.installation.pluginId,
          status: "active",
          active: identity(current.plan.installation),
        });
        return;
      }
      try {
        const leaseEpoch = crypto.randomUUID();
        const lease = await this.runtime.replace(plan, leaseEpoch, current?.lease);
        this.#active.set(plan.installation.pluginId, {
          plan,
          lease,
          leaseEpoch,
        });
        statesByPluginId.set(pluginId, {
          pluginId: plan.installation.pluginId,
          status: "active",
          active: identity(plan.installation),
        });
      } catch {
        statesByPluginId.set(pluginId, {
          pluginId: plan.installation.pluginId,
          status: "failed",
          candidate: identity(plan.installation),
          reason: "ACTIVATION_FAILED",
          ...(current === undefined ? {} : {retainedActive: identity(current.plan.installation)}),
        });
      }
    };

    for (const failure of preflightFailures) {
      const pluginId = failure.installation.pluginId;
      const current = this.#active.get(pluginId);
      const forbidsCurrent = failure.retention === "forbidden" &&
        current?.plan.installation.manifestDigest === failure.installation.manifestDigest;
      statesByPluginId.set(pluginId, {
        pluginId,
        status: "failed",
        candidate: identity(failure.installation),
        reason: failure.reason,
        ...(current === undefined || forbidsCurrent
          ? {} : {retainedActive: identity(current.plan.installation)}),
      });
    }
    for (const plan of plans) {
      await processPlan(plan);
    }
    const retainedPluginIds = new Set<string>();
    const retainClosure = (pluginId: string) => {
      if (retainedPluginIds.has(pluginId)) return;
      const current = this.#active.get(pluginId);
      if (current === undefined) return;
      retainedPluginIds.add(pluginId);
      for (const dependency of current.plan.dependencies) retainClosure(dependency);
    };
    const keepMemo = new Map<string, boolean>();
    for (const pluginId of desiredPluginIds) {
      if (activeClosureCanRemain(pluginId, keepMemo)) retainClosure(pluginId);
    }

    for (const pluginId of retainedPluginIds) {
      if (desiredPluginIds.has(pluginId)) continue;
      const current = this.#active.get(pluginId)!;
      statesByPluginId.set(pluginId, {
        pluginId,
        status: "failed",
        reason: "DEACTIVATION_BLOCKED",
        retainedActive: identity(current.plan.installation),
      });
    }

    const pendingRemovals = new Set(
      Array.from(this.#active.keys()).filter(pluginId => !retainedPluginIds.has(pluginId)),
    );
    for (const pluginId of pendingRemovals) {
      if (!desiredPluginIds.has(pluginId)) continue;
      const current = this.#active.get(pluginId)!;
      const state = statesByPluginId.get(pluginId);
      if (state?.status === "active") {
        statesByPluginId.set(pluginId, {
          pluginId,
          status: "suspended",
          candidate: identity(plansByPluginId.get(pluginId)!.installation),
          reason: "DEPENDENCY_UNAVAILABLE",
          retainedActive: identity(current.plan.installation),
        });
      }
    }
    while (pendingRemovals.size > 0) {
      let madeProgress = false;
      const candidates = [...pendingRemovals].toSorted();
      for (const pluginId of candidates) {
        const hasActiveDependent = Array.from(this.#active.entries()).some(
          ([dependentId, dependent]) => dependentId !== pluginId &&
            dependent.plan.dependencies.includes(pluginId),
        );
        if (hasActiveDependent) continue;

        madeProgress = true;
        pendingRemovals.delete(pluginId);
        const current = this.#active.get(pluginId)!;
        try {
          await this.runtime.remove(current.lease);
          this.#active.delete(pluginId);
          const state = statesByPluginId.get(pluginId);
          if (state?.status === "suspended") {
            statesByPluginId.set(pluginId, {
              pluginId,
              status: "suspended",
              candidate: state.candidate,
              reason: state.reason,
            });
          } else if (state?.status === "failed") {
            statesByPluginId.set(pluginId, {
              pluginId,
              status: "failed",
              ...(state.candidate === undefined ? {} : {candidate: state.candidate}),
              reason: state.reason,
            });
          }
        } catch {
          const desiredInstallation = plansByPluginId.get(pluginId)?.installation ??
            failuresByPluginId.get(pluginId)?.installation;
          statesByPluginId.set(pluginId, {
            pluginId,
            status: "failed",
            ...(desiredInstallation === undefined
              ? {} : {candidate: identity(desiredInstallation)}),
            reason: "DEACTIVATION_FAILED",
            retainedActive: identity(current.plan.installation),
          });
        }
      }
      if (madeProgress) continue;

      for (const pluginId of [...pendingRemovals].toSorted()) {
        const current = this.#active.get(pluginId)!;
        const desiredInstallation = plansByPluginId.get(pluginId)?.installation ??
          failuresByPluginId.get(pluginId)?.installation;
        statesByPluginId.set(pluginId, {
          pluginId,
          status: "failed",
          ...(desiredInstallation === undefined
            ? {} : {candidate: identity(desiredInstallation)}),
          reason: "DEACTIVATION_BLOCKED",
          retainedActive: identity(current.plan.installation),
        });
      }
      break;
    }
    const states = Array.from(statesByPluginId.values()).toSorted((a, b) =>
      a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0);
    return {ok: true, states};
  }
}
