import type {
  DeploymentPluginInstallationRecord,
  PluginConfigurationValue,
  UserPluginInstallation,
  WorkspacePluginInstallationRecord,
} from "./plugin-installation.js";

/** Typed snapshots from the three owners that contribute to one effective configuration. */
export interface EffectivePluginConfigurationInput {
  /** Deployment-wide desired state owned by AdminSettings. */
  deployment: readonly DeploymentPluginInstallationRecord[];

  /** Shared desired state owned by the active workspace. */
  workspace: readonly WorkspacePluginInstallationRecord[];

  /** Personal desired state owned by the active user. */
  user: readonly UserPluginInstallation[];
}

/** One enabled installation normalized for the runtime reconciler. */
export interface EffectivePluginInstallation {
  /** Explicit ownership scope; it is never inferred from the target. */
  scope: "deployment" | "workspace" | "user";

  /** Durable Object ID of the desired-state owner. */
  targetId: string;

  /** Stable identifier for this installation lifecycle. */
  installationId: string;

  /** Stable package identifier. */
  pluginId: string;

  /** Exact package version selected by the owner. */
  packageVersion: string;

  /** Content-addressed digest of the immutable manifest. */
  manifestDigest: string;

  /** Capabilities granted to this exact installation. */
  grantedCapabilities: string[];

  /** Owner-approved structured configuration. */
  config: PluginConfigurationValue;

  /** Opaque host-managed reference to optional plugin-owned persistent state. */
  stateRef?: string;
}

/** Minimal source identity disclosed when enabled scopes conflict. */
export interface EffectivePluginConflictSource {
  /** Explicit ownership scope of the conflicting installation. */
  scope: EffectivePluginInstallation["scope"];

  /** Durable Object ID of the conflicting desired-state owner. */
  targetId: string;

  /** Stable identifier of the conflicting installation lifecycle. */
  installationId: string;
}

/** One plugin identifier declared by more than one enabled scope. */
export interface EffectivePluginConflict {
  /** Stable package identifier that cannot be resolved by implicit precedence. */
  pluginId: string;

  /** All enabled owners that declared this identifier. */
  sources: EffectivePluginConflictSource[];
}

/** Result of resolving enabled desired state without mutating any owner or runtime. */
export type EffectivePluginConfigurationResult = {
  /** All enabled plugin identifiers were unique. */
  ok: true;

  /** Deterministic reconciler input sorted by plugin identifier. */
  installations: EffectivePluginInstallation[];
} | {
  /** At least one enabled plugin identifier appeared in multiple scopes. */
  ok: false;

  /** Stable machine-readable reason; no partial configuration is returned. */
  error: "DUPLICATE_ENABLED_PLUGIN_ID";

  /** Deterministic diagnostics that omit plugin configuration and state references. */
  conflicts: EffectivePluginConflict[];
};

type InstallationRecord =
  DeploymentPluginInstallationRecord | WorkspacePluginInstallationRecord | UserPluginInstallation;

function comparePluginId(
    a: Pick<EffectivePluginInstallation, "pluginId">,
    b: Pick<EffectivePluginInstallation, "pluginId">): number {
  return a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0;
}

function normalize(record: InstallationRecord): EffectivePluginInstallation {
  return {
    scope: record.scope,
    targetId: record.targetId,
    installationId: record.installationId,
    pluginId: record.pluginId,
    packageVersion: record.packageVersion,
    manifestDigest: record.manifestDigest,
    grantedCapabilities: [...record.grantedCapabilities],
    config: structuredClone(record.config),
    ...(record.stateRef === undefined ? {} : {stateRef: record.stateRef}),
  };
}

/** Resolves the complete enabled configuration or rejects every ambiguous plugin identifier. */
export function resolveEffectivePluginConfiguration(
    input: EffectivePluginConfigurationInput): EffectivePluginConfigurationResult {
  const enabled = [
    ...input.deployment,
    ...input.workspace,
    ...input.user,
  ].filter(record => record.enabled).map(normalize);
  enabled.sort(comparePluginId);

  const byPluginId = new Map<string, EffectivePluginInstallation[]>();
  for (const installation of enabled) {
    const group = byPluginId.get(installation.pluginId);
    if (group === undefined) {
      byPluginId.set(installation.pluginId, [installation]);
    } else {
      group.push(installation);
    }
  }

  const conflicts: EffectivePluginConflict[] = [];
  for (const [pluginId, installations] of byPluginId) {
    if (installations.length < 2) continue;
    conflicts.push({
      pluginId,
      sources: installations.map(({scope, targetId, installationId}) => ({
        scope,
        targetId,
        installationId,
      })),
    });
  }

  if (conflicts.length > 0) {
    return {ok: false, error: "DUPLICATE_ENABLED_PLUGIN_ID", conflicts};
  }
  return {ok: true, installations: enabled};
}
