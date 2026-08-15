/** Declarative plugin manifest before its immutable bytes and digest are verified. */
export interface PluginManifest {
  /** Schema version for the manifest document. */
  readonly schemaVersion: 1;

  /** Stable package identifier. */
  readonly pluginId: string;

  /** Exact package version represented by this manifest. */
  readonly packageVersion: string;

  /** Capabilities the package asks an installer to approve individually. */
  readonly requestedCapabilities: readonly string[];
}

/** An owned immutable plugin manifest with a digest verified by its registry adapter. */
export interface VerifiedPluginManifest extends PluginManifest {
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
  const snapshot: PluginManifest = Object.freeze({
    schemaVersion: manifest.schemaVersion,
    pluginId: manifest.pluginId,
    packageVersion: manifest.packageVersion,
    requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
  });
  const canonical = JSON.stringify(snapshot);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Object.freeze({
    ...snapshot,
    manifestDigest: `sha256:${new Uint8Array(digest).toHex()}`,
  });
}
