/** A plugin manifest whose immutable bytes and digest were verified by its registry adapter. */
export interface VerifiedPluginManifest {
  /** Schema version for the manifest document. */
  readonly schemaVersion: 1;

  /** Stable package identifier. */
  readonly pluginId: string;

  /** Exact package version represented by this manifest. */
  readonly packageVersion: string;

  /** SHA-256 digest of the canonical manifest bytes. */
  readonly manifestDigest: string;

  /** Capabilities the package asks an installer to approve individually. */
  readonly requestedCapabilities: readonly string[];
}

/** Resolves one exact immutable plugin manifest without exposing its storage implementation. */
export interface PluginManifestResolver {
  /** Returns the exact version, or null when that package version is not in this registry. */
  resolve(pluginId: string, packageVersion: string): Promise<VerifiedPluginManifest | null>;
}

/** Manifest resolver backed by the immutable entries bundled into one deployment. */
export class BundledPluginManifestResolver implements PluginManifestResolver {
  readonly #entries: readonly VerifiedPluginManifest[];

  constructor(entries: readonly VerifiedPluginManifest[]) {
    this.#entries = entries;
  }

  async resolve(
      pluginId: string, packageVersion: string): Promise<VerifiedPluginManifest | null> {
    return this.#entries.find(
      entry => entry.pluginId === pluginId && entry.packageVersion === packageVersion,
    ) ?? null;
  }
}
