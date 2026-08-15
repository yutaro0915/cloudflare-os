import type { CollaboratorRole } from "@gadgets/workshop-shared/api";
import type { PluginRuntimeRealmIdentity } from "./dynamic-worker-plugin-activator.js";
import type { PluginRuntimeLoopbackProps } from "./plugin-runtime-loopback.js";
import type { RuntimePluginPlan } from "./plugin-reconciler.js";
import { WORKSPACE_METADATA_READ_CAPABILITY } from "./plugin-runtime-capabilities.js";

/** Minimal data returned to a plugin granted workspace metadata read access. */
export interface PluginWorkspaceMetadata {
  /** Owning workspace Durable Object ID. */
  readonly workspaceId: string;

  /** Current human-readable workspace title. */
  readonly title: string;

  /** Effective role of this authenticated runtime realm. */
  readonly role: CollaboratorRole;
}

/** Host constructors for fixed loopback bindings; raw namespaces never enter plugin env. */
export interface PluginRuntimeBindingFactory {
  /** Creates the lifecycle-only binding consumed solely by the trusted harness. */
  pluginHost(props: PluginRuntimeLoopbackProps): unknown;

  /** Creates the capability-specific metadata binding when and only when granted. */
  workspaceMetadata(props: PluginRuntimeLoopbackProps): unknown;
}

/** Builds the explicit Dynamic Worker env from one verified plan and host-minted realm identity. */
export function makePluginRuntimeCapabilityEnv(
    realm: PluginRuntimeRealmIdentity,
    plan: RuntimePluginPlan,
    activationKey: string,
    bindings: PluginRuntimeBindingFactory): Record<string, unknown> {
  const props: PluginRuntimeLoopbackProps = Object.freeze({
    overseerId: realm.overseerId,
    userId: realm.userId,
    role: realm.role,
    generation: realm.generation,
    pluginId: plan.installation.pluginId,
    activationKey,
    manifestDigest: plan.installation.manifestDigest,
  });
  return {
    PLUGIN_HOST: bindings.pluginHost(props),
    ...(plan.installation.grantedCapabilities.includes(WORKSPACE_METADATA_READ_CAPABILITY)
      ? {WORKSPACE_METADATA: bindings.workspaceMetadata(props)}
      : {}),
  };
}
