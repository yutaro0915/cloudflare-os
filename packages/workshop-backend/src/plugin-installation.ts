import type { InstallPluginRequest, InstallPluginResult } from "@gadgets/workshop-shared/api";
import type {
  PluginManifestResolver,
  VerifiedPluginManifest,
} from "./plugin-manifest-registry.js";

/** A structured-clone-safe value stored in plugin-owned configuration. */
export type PluginConfigurationValue =
  null | boolean | number | string | PluginConfigurationValue[] |
  { [key: string]: PluginConfigurationValue };

/** Resolved plugin desired state accepted from trusted backend code. */
export interface UserPluginInstallationInput {
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

/** Desired state persisted by one UserDurableObject. */
export interface UserPluginInstallation extends UserPluginInstallationInput {
  /** Schema version for the stored installation record. */
  schemaVersion: 1;

  /** Ownership scope stamped by UserDurableObject. */
  scope: "user";

  /** Durable Object ID stamped by the UserDurableObject that owns this record. */
  targetId: string;

  /** Opaque host-managed reference to optional plugin-owned persistent state. */
  stateRef?: string;
}

/** Desired state persisted by one workspace OverseerDurableObject. */
export interface WorkspacePluginInstallationRecord extends UserPluginInstallationInput {
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
  action: "PLUGIN_DESIRED_STATE_PUT";

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
} | {
  /** The desired state was rejected without being persisted. */
  ok: false;

  /** Stable machine-readable reason for the rejection. */
  error: "INVALID_MANIFEST_DIGEST";
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
