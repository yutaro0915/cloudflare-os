import type { EffectivePluginInstallation } from "./plugin-effective-configuration.js";
import type { PluginManifestResolver } from "./plugin-manifest-registry.js";
import type {
  PluginReconciliationInput,
  RuntimePluginPlan,
  RuntimePluginPreflightFailure,
} from "./plugin-reconciler.js";
import { isSupportedPluginRuntimeCapability } from "./plugin-runtime-capabilities.js";

/** Result of enriching one effective snapshot from verified immutable manifests. */
export type BuildRuntimePluginPlansResult = Omit<
  Extract<PluginReconciliationInput, {ok: true}>, "ok"
> & {preflightFailures: RuntimePluginPreflightFailure[]; plans: RuntimePluginPlan[]};

function approvalsExactlyMatch(
    requested: readonly string[], granted: readonly string[]): boolean {
  if (requested.length !== granted.length || new Set(granted).size !== granted.length) return false;
  const grantedSet = new Set(granted);
  return requested.every(capability => grantedSet.has(capability));
}

/**
 * Enriches desired installations only from digest-matched verified manifests.
 *
 * Invalid candidates remain explicit failures so the reconciler can suspend their dependents while
 * still honoring the system-wide requirement to continue unrelated plugins.
 */
export async function buildRuntimePluginPlans(
    installations: readonly EffectivePluginInstallation[],
    resolver: PluginManifestResolver,
    deniedManifestDigests: readonly string[] = []): Promise<BuildRuntimePluginPlansResult> {
  const snapshot = structuredClone(installations);
  const denied = new Set(deniedManifestDigests);
  const plans: RuntimePluginPlan[] = [];
  const preflightFailures: RuntimePluginPreflightFailure[] = [];
  for (const installation of snapshot) {
    if (denied.has(installation.manifestDigest)) {
      preflightFailures.push({
        installation,
        retention: "forbidden",
        reason: "MANIFEST_DENYLISTED",
      });
      continue;
    }
    const manifest = await resolver.resolve(installation.pluginId, installation.packageVersion);
    if (manifest === null) {
      preflightFailures.push({
        installation,
        retention: "allowed",
        reason: "MANIFEST_NOT_FOUND",
      });
      continue;
    }
    if (
      manifest.manifestDigest !== installation.manifestDigest ||
      !approvalsExactlyMatch(manifest.requestedCapabilities, installation.grantedCapabilities)
    ) {
      preflightFailures.push({
        installation,
        retention: "allowed",
        reason: "MANIFEST_INTEGRITY_MISMATCH",
      });
      continue;
    }
    if (manifest.runtime === undefined) {
      preflightFailures.push({
        installation,
        retention: "allowed",
        reason: "RUNTIME_ARTIFACT_NOT_DECLARED",
      });
      continue;
    }
    if (!installation.grantedCapabilities.every(isSupportedPluginRuntimeCapability)) {
      preflightFailures.push({
        installation,
        retention: "allowed",
        reason: "CAPABILITY_UNSUPPORTED",
      });
      continue;
    }
    plans.push({
      installation,
      dependencies: [...manifest.dependencies],
      runtime: {...manifest.runtime},
    });
  }
  return {plans, preflightFailures};
}
