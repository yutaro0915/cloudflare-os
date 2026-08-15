interface PluginManifestBase {
  /** Stable package identifier. */
  readonly pluginId: string;

  /** Exact package version represented by this manifest. */
  readonly packageVersion: string;

  /** Capabilities the package asks an installer to approve individually. */
  readonly requestedCapabilities: readonly string[];
}

/** Original declarative plugin manifest without package dependencies. */
export interface PluginManifestV1 extends PluginManifestBase {
  /** Schema version for the manifest document. */
  readonly schemaVersion: 1;
}

/** Declarative plugin manifest with exact package dependency identifiers. */
export interface PluginManifestV2 extends PluginManifestBase {
  /** Schema version for the manifest document. */
  readonly schemaVersion: 2;

  /** Packages that must already be active before this package can activate. */
  readonly dependencies: readonly string[];
}

/** Declarative plugin manifest before its immutable bytes and digest are verified. */
export type PluginManifest = PluginManifestV1 | PluginManifestV2;

/** An owned immutable plugin manifest with a digest verified by its registry adapter. */
export interface VerifiedPluginManifest extends PluginManifestBase {
  /** Schema version of the canonical source document. */
  readonly schemaVersion: 1 | 2;

  /** Canonical dependency set; schema v1 manifests resolve to an empty set. */
  readonly dependencies: readonly string[];

  /** SHA-256 digest of the canonical manifest bytes. */
  readonly manifestDigest: string;
}

/** Resolves one exact immutable plugin manifest without exposing its storage implementation. */
export interface PluginManifestResolver {
  /** Returns the exact version, or null when that package version is not in this registry. */
  resolve(pluginId: string, packageVersion: string): Promise<VerifiedPluginManifest | null>;
}

/** Manifest resolver backed by the immutable entries bundled into one deployment. */
export class BundledPluginManifestResolver implements PluginManifestResolver {
  readonly #entries: readonly VerifiedPluginManifest[];

  private constructor(entries: readonly VerifiedPluginManifest[]) {
    this.#entries = entries;
  }

  /** Verifies raw bundled manifests and owns immutable snapshots of the results. */
  static async create(entries: readonly PluginManifest[]): Promise<BundledPluginManifestResolver> {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const duplicate = entries.slice(0, index).some(
        candidate => candidate.pluginId === entry.pluginId &&
          candidate.packageVersion === entry.packageVersion,
      );
      if (duplicate) {
        throw new TypeError(
          `Duplicate bundled plugin manifest: ${entry.pluginId}@${entry.packageVersion}`,
        );
      }
    }
    const verified = await Promise.all(entries.map(verifyPluginManifest));
    return new BundledPluginManifestResolver(Object.freeze(verified));
  }

  async resolve(
      pluginId: string, packageVersion: string): Promise<VerifiedPluginManifest | null> {
    return this.#entries.find(
      entry => entry.pluginId === pluginId && entry.packageVersion === packageVersion,
    ) ?? null;
  }
}

async function verifyPluginManifest(manifest: PluginManifest): Promise<VerifiedPluginManifest> {
  if (
    manifest.schemaVersion === 2 &&
    (manifest.dependencies.some(dependency => dependency.trim().length === 0) ||
      new Set(manifest.dependencies).size !== manifest.dependencies.length)
  ) {
    throw new TypeError(
      `Invalid dependencies in ${manifest.pluginId}@${manifest.packageVersion}`,
    );
  }
  const snapshot: PluginManifest = manifest.schemaVersion === 1
    ? Object.freeze({
      schemaVersion: 1,
      pluginId: manifest.pluginId,
      packageVersion: manifest.packageVersion,
      requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
    })
    : Object.freeze({
      schemaVersion: 2,
      pluginId: manifest.pluginId,
      packageVersion: manifest.packageVersion,
      requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
      dependencies: Object.freeze([...manifest.dependencies].toSorted()),
    });
  const canonical = JSON.stringify(snapshot);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Object.freeze({
    ...snapshot,
    dependencies: Object.freeze(snapshot.schemaVersion === 1 ? [] : [...snapshot.dependencies]),
    manifestDigest: `sha256:${new Uint8Array(digest).toHex()}`,
  });
}
