import type { InstallPluginRequest, InstallPluginResult } from "@gadgets/workshop-shared/api";
import type {
  PluginManifestResolver,
  VerifiedPluginManifest,
} from "./plugin-manifest-registry.js";

/** A structured-clone-safe value stored in plugin-owned configuration. */
export type PluginConfigurationValue =
  null | boolean | number | string | PluginConfigurationValue[] |
  { [key: string]: PluginConfigurationValue };

/** Scope-neutral plugin desired state accepted from trusted backend code. */
export interface PluginInstallationInput {
  /** Stable identifier for this installation lifecycle. */
  installationId: string;

  /** Stable package identifier from the resolved immutable manifest. */
  pluginId: string;

  /** Exact package version selected by the owner. */
  packageVersion: string;

  /** Content-addressed digest of the resolved immutable manifest. */
  manifestDigest: string;

  /** Whether reconciliation should attempt to run this installation. */
  enabled: boolean;

  /** Capabilities approved individually for this installation. */
  grantedCapabilities: string[];

  /** Plugin configuration approved for this installation. */
  config: PluginConfigurationValue;
}

/** Host-only owner authorization query derived from an exact local runtime gate. */
export interface PluginRuntimeCapabilityClaim {
  /** Explicit desired-state ownership scope. */
  scope: "deployment" | "workspace" | "user";

  /** Durable Object ID of the desired-state owner. */
  targetId: string;

  /** Stable installation lifecycle selected by the local gate. */
  installationId: string;

  /** Stable package identifier selected by the local gate. */
  pluginId: string;

  /** Immutable candidate or retained-active manifest digest. */
  manifestDigest: string;

  /** Exact host-supported capability being invoked. */
  capability: string;

  /** Staged candidates require exact digest; retained active versions may differ after update. */
  phase: "staged" | "active";
}

/** Host-only active lifecycle query executed before any untrusted plugin invocation. */
export interface PluginRuntimeLifecycleClaim {
  scope: "deployment" | "workspace" | "user";
  targetId: string;
  installationId: string;
  pluginId: string;
}

/** Host-only staged candidate query derived from an exact local gate snapshot. */
export interface PluginRuntimeCandidateClaim {
  scope: "deployment" | "workspace" | "user";
  targetId: string;
  installationId: string;
  pluginId: string;
  packageVersion: string;
  manifestDigest: string;
  grantedCapabilities: string[];
  config: PluginConfigurationValue;
  stateRef?: string;
}

function pluginConfigurationEqual(left: PluginConfigurationValue, right: PluginConfigurationValue):
    boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => pluginConfigurationEqual(value, right[index]!));
  }
  if (
    left === null || right === null ||
    typeof left !== "object" || typeof right !== "object"
  ) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(([key, value]) =>
    Object.hasOwn(right, key) && pluginConfigurationEqual(value, right[key]!));
}

/** Checks that a staged runtime still exactly represents current owner desired state. */
export function isPluginRuntimeCandidateCurrent(
    installation: PluginInstallationInput & {scope: string; targetId: string; stateRef?: string},
    claim: PluginRuntimeCandidateClaim): boolean {
  const currentGrants = new Set(installation.grantedCapabilities);
  return installation.scope === claim.scope &&
    installation.targetId === claim.targetId &&
    installation.installationId === claim.installationId &&
    installation.pluginId === claim.pluginId &&
    installation.packageVersion === claim.packageVersion &&
    installation.manifestDigest === claim.manifestDigest &&
    installation.enabled &&
    currentGrants.size === claim.grantedCapabilities.length &&
    claim.grantedCapabilities.every(capability => currentGrants.has(capability)) &&
    pluginConfigurationEqual(installation.config, claim.config) &&
    installation.stateRef === claim.stateRef;
}

/** Checks current owner SSOT without letting an update revoke a safely retained old digest. */
export function isPluginRuntimeCapabilityAuthorized(
    installation: PluginInstallationInput & {scope: string; targetId: string},
    claim: PluginRuntimeCapabilityClaim): boolean {
  return installation.scope === claim.scope &&
    installation.targetId === claim.targetId &&
    installation.installationId === claim.installationId &&
    installation.pluginId === claim.pluginId &&
    installation.enabled &&
    installation.grantedCapabilities.includes(claim.capability) &&
    (claim.phase === "active" || installation.manifestDigest === claim.manifestDigest);
}

/** Checks the stable active lifecycle while deliberately allowing a safely retained old digest. */
export function isPluginRuntimeLifecycleAuthorized(
    installation: PluginInstallationInput & {scope: string; targetId: string},
    claim: PluginRuntimeLifecycleClaim): boolean {
  return installation.scope === claim.scope &&
    installation.targetId === claim.targetId &&
    installation.installationId === claim.installationId &&
    installation.pluginId === claim.pluginId && installation.enabled;
}

/** Desired state persisted by one UserDurableObject. */
export interface UserPluginInstallation extends PluginInstallationInput {
  /** Schema version for the stored installation record. */
  schemaVersion: 1;

  /** Ownership scope stamped by UserDurableObject. */
  scope: "user";

  /** Durable Object ID stamped by the UserDurableObject that owns this record. */
  targetId: string;

  /** Opaque host-managed reference to optional plugin-owned persistent state. */
  stateRef?: string;
}

/** Persistent linearization marker that permanently revokes one installation lifecycle. */
export interface UserPluginInstallationRevocation {
  schemaVersion: 1;
  installationId: string;
  pluginId: string;
  stateRef?: string;
  startedAt: number;
  finalizedAt?: number;
}

/** Host-only pointer to state retained after its active installation was removed. */
export interface DetachedUserPluginStateRecord {
  schemaVersion: 1;
  installationId: string;
  pluginId: string;
  packageVersion: string;
  manifestDigest: string;
  stateRef: string;
  detachedAt: number;
}

const MAX_PLUGIN_CONFIGURATION_DEPTH = 32;
const MAX_PLUGIN_CONFIGURATION_VALUES = 10_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isUniqueNonemptyStringArray(value: unknown): value is string[] {
  if (!isDenseArray(value)) return false;
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) return false;
  }
  return new Set(value).size === value.length;
}

function isPluginConfiguration(
    value: unknown,
    budget: {remaining: number},
    ancestors = new Set<object>(),
    depth = 0): value is PluginConfigurationValue {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > MAX_PLUGIN_CONFIGURATION_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (!isDenseArray(value)) return false;
      for (const entry of value) {
        if (!isPluginConfiguration(entry, budget, ancestors, depth + 1)) return false;
      }
      return true;
    }
    if (!isPlainRecord(value)) return false;
    return Object.values(value).every(entry =>
      isPluginConfiguration(entry, budget, ancestors, depth + 1));
  } finally {
    ancestors.delete(value);
  }
}

/** Validates and owns one JSON value received across a plugin state RPC boundary. */
export function decodePluginConfigurationValue(value: unknown): PluginConfigurationValue {
  if (!isPluginConfiguration(value, {remaining: MAX_PLUGIN_CONFIGURATION_VALUES})) {
    throw new TypeError("Invalid plugin configuration value.");
  }
  return structuredClone(value);
}

function readInstallationBase(value: Record<string, unknown>): PluginInstallationInput | null {
  if (
    typeof value.installationId !== "string" || value.installationId.length === 0 ||
    typeof value.pluginId !== "string" || value.pluginId.length === 0 ||
    typeof value.packageVersion !== "string" || value.packageVersion.length === 0 ||
    typeof value.manifestDigest !== "string" ||
    !isCanonicalPluginManifestDigest(value.manifestDigest) ||
    typeof value.enabled !== "boolean" ||
    !isUniqueNonemptyStringArray(value.grantedCapabilities) ||
    !isPluginConfiguration(
      value.config,
      {remaining: MAX_PLUGIN_CONFIGURATION_VALUES},
    )
  ) {
    return null;
  }
  return {
    installationId: value.installationId,
    pluginId: value.pluginId,
    packageVersion: value.packageVersion,
    manifestDigest: value.manifestDigest,
    enabled: value.enabled,
    grantedCapabilities: [...value.grantedCapabilities],
    config: structuredClone(value.config),
  };
}

/** Validates an untyped UserDO runtime snapshot and stamps no ownership by inference. */
export function decodeUserPluginInstallationSnapshot(
    snapshot: unknown,
    expectedTargetId: string): UserPluginInstallation[] {
  if (!isDenseArray(snapshot)) {
    throw new TypeError("User plugin snapshot must be a dense array.");
  }
  return snapshot.map(value => {
    if (!isPlainRecord(value)) throw new TypeError("Invalid user plugin installation record.");
    const base = readInstallationBase(value);
    if (
      base === null || value.schemaVersion !== 1 || value.scope !== "user" ||
      value.targetId !== expectedTargetId ||
      (value.stateRef !== undefined && typeof value.stateRef !== "string")
    ) {
      throw new TypeError("Invalid user plugin installation record.");
    }
    return {
      ...base,
      schemaVersion: 1,
      scope: "user",
      targetId: expectedTargetId,
      ...(value.stateRef === undefined ? {} : {stateRef: value.stateRef}),
    };
  });
}

/** Desired state persisted by one workspace OverseerDurableObject. */
export interface WorkspacePluginInstallationRecord extends PluginInstallationInput {
  /** Schema version for the stored installation record. */
  schemaVersion: 1;

  /** Ownership scope stamped by the workspace host. */
  scope: "workspace";

  /** Durable Object ID of the workspace that owns this record. */
  targetId: string;

  /** Capability ceiling most recently approved by the workspace owner. */
  approvedCapabilities: string[];

  /** Opaque host-managed reference to optional plugin-owned persistent state. */
  stateRef?: string;
}

/** Desired state persisted by the deployment AdminSettings Durable Object. */
export interface DeploymentPluginInstallationRecord extends PluginInstallationInput {
  /** Schema version for the stored installation record. */
  schemaVersion: 1;

  /** Ownership scope stamped by AdminSettings. */
  scope: "deployment";

  /** Durable Object ID of the AdminSettings singleton that owns this record. */
  targetId: string;

  /** Opaque host-managed reference to optional plugin-owned persistent state. */
  stateRef?: string;
}

/** Validates an untyped AdminSettings runtime snapshot without trusting stored owner fields. */
export function decodeDeploymentPluginInstallationSnapshot(
    snapshot: unknown,
    expectedTargetId: string): DeploymentPluginInstallationRecord[] {
  if (!isDenseArray(snapshot)) {
    throw new TypeError("Deployment plugin snapshot must be a dense array.");
  }
  return snapshot.map(value => {
    if (!isPlainRecord(value)) {
      throw new TypeError("Invalid deployment plugin installation record.");
    }
    const base = readInstallationBase(value);
    if (
      base === null || value.schemaVersion !== 1 || value.scope !== "deployment" ||
      value.targetId !== expectedTargetId ||
      (value.stateRef !== undefined && typeof value.stateRef !== "string")
    ) {
      throw new TypeError("Invalid deployment plugin installation record.");
    }
    return {
      ...base,
      schemaVersion: 1,
      scope: "deployment",
      targetId: expectedTargetId,
      ...(value.stateRef === undefined ? {} : {stateRef: value.stateRef}),
    };
  });
}

/** Validated deployment policy projection consumed by one plugin runtime realm refresh. */
export interface PluginRuntimePolicySnapshot {
  /** Deployment-scoped desired installations owned by AdminSettings. */
  deployment: DeploymentPluginInstallationRecord[];

  /** Permanent canonical manifest digest denylist. */
  deniedManifestDigests: string[];
}

/** Validates the untyped atomic AdminSettings runtime policy snapshot. */
export function decodePluginRuntimePolicySnapshot(
    snapshot: unknown,
    expectedTargetId: string): PluginRuntimePolicySnapshot {
  if (!isPlainRecord(snapshot) || !isDenseArray(snapshot.deniedManifestDigests)) {
    throw new TypeError("Invalid plugin runtime policy snapshot.");
  }
  const deniedManifestDigests: string[] = [];
  for (const digest of snapshot.deniedManifestDigests) {
    if (
      typeof digest !== "string" || !isCanonicalPluginManifestDigest(digest) ||
      deniedManifestDigests.includes(digest)
    ) {
      throw new TypeError("Invalid plugin runtime policy snapshot.");
    }
    deniedManifestDigests.push(digest);
  }
  return {
    deployment: decodeDeploymentPluginInstallationSnapshot(
      snapshot.installations,
      expectedTargetId,
    ),
    deniedManifestDigests,
  };
}

/** Authenticated deployment administrator stamped into trusted host mutations. */
export interface PluginMutationActor {
  /** Durable Object ID of the authenticated user. */
  userId: string;

  /** Stable profile identifier used by the authenticated session. */
  profileId: string;
}

/** Append-only deployment denial of one immutable plugin manifest digest. */
export interface PluginManifestDenylistRecord {
  /** Canonical manifest content address that may never activate again. */
  manifestDigest: string;

  /** Admin UserDO ID stamped by the trusted host. */
  actorUserId: string;

  /** Admin profile identifier stamped by the trusted host. */
  actorProfileId: string;

  /** Host timestamp when the permanent denial was first recorded. */
  deniedAt: number;
}

/** Host-owned append-only audit evidence for one permanent manifest denial. */
export interface PluginManifestDenylistAuditEvent extends PluginManifestDenylistRecord {
  /** Monotonic sequence in the deployment denylist audit stream. */
  sequence: number;

  /** Permanent action; deny removal is intentionally not supported. */
  action: "PLUGIN_MANIFEST_DENIED";
}

/** Trusted AdminApi mutation input with actor fields captured at capability mint time. */
export interface DenyPluginManifestInput {
  /** Canonical immutable manifest digest selected by the administrator. */
  manifestDigest: string;

  /** Authenticated admin actor captured outside browser input. */
  actor: PluginMutationActor;
}

/** Verified manifest fields accepted by the AdminSettings persistence boundary. */
export interface PutDeploymentPluginInstallationInput {
  /** Stable package identifier from the verified manifest. */
  pluginId: string;

  /** Exact package version from the verified manifest. */
  packageVersion: string;

  /** Content-addressed digest from the verified manifest. */
  manifestDigest: string;

  /** Capabilities requested by the verified manifest and approved by the administrator. */
  grantedCapabilities: string[];

  /** Authenticated administrator captured when the AdminApi capability was minted. */
  actor: PluginMutationActor;
}

/** Host-owned append-only evidence of one deployment plugin desired-state mutation. */
export interface DeploymentPluginAuditEvent {
  /** Schema version for the stored audit event. */
  schemaVersion: 1;

  /** Monotonic sequence within the deployment. */
  sequence: number;

  /** Mutation recorded by this event. */
  action: "PLUGIN_DESIRED_STATE_PUT";

  /** UserDurableObject ID of the authenticated administrator. */
  actorUserId: string;

  /** Stable profile identifier of the authenticated administrator. */
  actorProfileId: string;

  /** Authority used for the mutation. */
  authority: "admin";

  /** Ownership scope stamped by AdminSettings. */
  scope: "deployment";

  /** Durable Object ID of the AdminSettings singleton that owns this event. */
  targetId: string;

  /** Host-issued identifier for the installation lifecycle. */
  installationId: string;

  /** Stable package identifier from the verified manifest. */
  pluginId: string;

  /** Exact package version from the verified manifest. */
  packageVersion: string;

  /** Content-addressed digest from the verified manifest. */
  manifestDigest: string;

  /** Capabilities granted to the exact manifest after the mutation. */
  grantedCapabilities: string[];

  /** Host timestamp in milliseconds since the Unix epoch. */
  recordedAt: number;
}

/** Host-owned append-only evidence of one workspace plugin desired-state mutation. */
export interface WorkspacePluginAuditEvent {
  /** Schema version for the stored audit event. */
  schemaVersion: 1;

  /** Monotonic sequence within the owning workspace. */
  sequence: number;

  /** Mutation recorded by this event. */
  action: "PLUGIN_DESIRED_STATE_PUT";

  /** UserDurableObject ID of the authenticated actor. */
  actorUserId: string;

  /** Stable profile identifier of the authenticated actor. */
  actorProfileId: string;

  /** Authority used for the mutation. */
  authority: "owner" | "build";

  /** Ownership scope stamped by the workspace host. */
  scope: "workspace";

  /** Durable Object ID of the workspace that owns this event. */
  targetId: string;

  /** Host-issued identifier for the installation lifecycle. */
  installationId: string;

  /** Stable package identifier from the verified manifest. */
  pluginId: string;

  /** Exact package version from the verified manifest. */
  packageVersion: string;

  /** Content-addressed digest from the verified manifest. */
  manifestDigest: string;

  /** Capability ceiling in effect after the mutation. */
  approvedCapabilities: string[];

  /** Capabilities granted to the exact manifest after the mutation. */
  grantedCapabilities: string[];

  /** Host timestamp in milliseconds since the Unix epoch. */
  recordedAt: number;
}

/** Host-owned append-only evidence of one user plugin desired-state mutation. */
export interface UserPluginAuditEvent {
  /** Schema version for the stored audit event. */
  schemaVersion: 1;

  /** Monotonic sequence within the owning UserDurableObject. */
  sequence: number;

  /** Mutation recorded by this event. */
  action: "PLUGIN_DESIRED_STATE_PUT" | "PLUGIN_UNINSTALLED";

  /** UserDurableObject ID stamped as the authenticated actor. */
  actorUserId: string;

  /** Ownership scope stamped by UserDurableObject. */
  scope: "user";

  /** UserDurableObject ID stamped as the desired-state owner. */
  targetId: string;

  /** Host-issued identifier for the installation lifecycle. */
  installationId: string;

  /** Stable package identifier from the verified manifest. */
  pluginId: string;

  /** Exact package version from the verified manifest. */
  packageVersion: string;

  /** Content-addressed digest from the verified manifest. */
  manifestDigest: string;

  /** Desired enabled state written by the mutation. */
  enabled: boolean;

  /** Manifest capabilities approved for the installation. */
  grantedCapabilities: string[];

  /** Host timestamp in milliseconds since the Unix epoch. */
  recordedAt: number;
}

/** Result of persisting resolved user-scoped plugin desired state. */
export type PutUserPluginInstallationResult = {
  /** The desired state was persisted. */
  ok: true;

  /** Existing lifecycle ID retained on update, or the host candidate accepted on first install. */
  installationId: string;
} | {
  /** The desired state was rejected without being persisted. */
  ok: false;

  /** Stable machine-readable reason for the rejection. */
  error: "INVALID_MANIFEST_DIGEST" | "UNINSTALL_IN_PROGRESS";
};

/** Transactional first phase of a user-scoped uninstall. */
export type BeginUserPluginUninstallResult = {
  ok: true;
  installationId: string;
} | {
  ok: false;
  error: "PLUGIN_NOT_INSTALLED" | "INSTALLATION_CHANGED" | "UNINSTALL_IN_PROGRESS";
};

/** Idempotent desired-state removal and optional state detach result. */
export type FinalizeUserPluginUninstallResult = {
  ok: true;
  installationId: string;
  retainedState: boolean;
} | {
  ok: false;
  error: "PLUGIN_NOT_INSTALLED" | "INSTALLATION_CHANGED" | "UNINSTALL_IN_PROGRESS";
};

/** Returns whether a manifest digest is in canonical content-addressed form. */
export function isCanonicalPluginManifestDigest(digest: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(digest);
}

/** Resolves an exact manifest only when foreground approvals exactly match its request. */
export async function resolveApprovedPluginManifest(
    resolver: PluginManifestResolver,
    request: InstallPluginRequest,
): Promise<
  {ok: true; manifest: VerifiedPluginManifest} |
  Extract<InstallPluginResult, {ok: false}>
> {
  const manifest = await resolver.resolve(request.pluginId, request.packageVersion);
  if (manifest === null) return {ok: false, error: "PLUGIN_VERSION_NOT_FOUND"};
  if (manifest.requestedCapabilities.length !== request.approvedCapabilities.length) {
    return {ok: false, error: "CAPABILITY_APPROVAL_MISMATCH"};
  }
  const approved = new Set(request.approvedCapabilities);
  if (
    approved.size !== request.approvedCapabilities.length ||
    !manifest.requestedCapabilities.every(capability => approved.has(capability))
  ) {
    return {ok: false, error: "CAPABILITY_APPROVAL_MISMATCH"};
  }
  return {ok: true, manifest};
}
