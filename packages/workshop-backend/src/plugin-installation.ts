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
