import {bundledPluginCodeArtifactStore} from "./bundled-plugin-artifacts.js";
import {bundledPluginManifestResolver} from "./bundled-plugin-manifests.js";
import {
  VerifyingPluginCodeArtifactResolver,
  type PluginCodeArtifactStore,
} from "./plugin-code-artifact.js";
import {
  BundledPluginManifestResolver,
  type PluginManifestCatalog,
  type VerifiedPluginManifest,
} from "./plugin-manifest-registry.js";
import type {PluginStoreDurableObject} from "./plugin-store.js";

/** Revalidating catalog that joins approved Store packages with reviewed bundled fallback. */
export class StoreBackedPluginManifestCatalog implements PluginManifestCatalog {
  constructor(
    private store: DurableObjectStub<PluginStoreDurableObject>,
    private fallback: Promise<PluginManifestCatalog> = bundledPluginManifestResolver,
  ) {}

  /** Resolves Store content first while making bundled package keys non-overridable. */
  async resolve(pluginId: string, packageVersion: string):
      Promise<VerifiedPluginManifest | null> {
    const fallback = await this.fallback;
    const bundled = await fallback.resolve(pluginId, packageVersion);
    if (bundled !== null) return bundled;
    const raw = await this.store.resolveManifest(pluginId, packageVersion);
    if (raw === null) return null;
    try {
      const verified = await BundledPluginManifestResolver.create([raw]);
      return verified.resolve(pluginId, packageVersion);
    } catch {
      return null;
    }
  }

  /** Lists a deterministic union while dropping any Store collision with bundled package keys. */
  async list(): Promise<readonly VerifiedPluginManifest[]> {
    const fallback = await this.fallback;
    const bundled = await fallback.list();
    let published: readonly VerifiedPluginManifest[] = [];
    try {
      const raw = await this.store.listManifests();
      published = await (await BundledPluginManifestResolver.create(raw)).list();
    } catch {
      published = [];
    }
    const bundledKeys = new Set(bundled.map(
      manifest => `${manifest.pluginId}@${manifest.packageVersion}`,
    ));
    return [...bundled, ...published.filter(
      manifest => !bundledKeys.has(`${manifest.pluginId}@${manifest.packageVersion}`),
    )].toSorted((left, right) =>
      left.pluginId.localeCompare(right.pluginId) ||
      left.packageVersion.localeCompare(right.packageVersion));
  }
}

class StoreBackedPluginCodeArtifactStore implements PluginCodeArtifactStore {
  constructor(private store: DurableObjectStub<PluginStoreDurableObject>) {}

  async read(codeArtifactDigest: string): Promise<string | null> {
    return await this.store.readArtifact(codeArtifactDigest) ??
      bundledPluginCodeArtifactStore.read(codeArtifactDigest);
  }
}

/** Creates a manifest catalog backed by published Store content plus bundled fallback. */
export function createPluginStoreManifestCatalog(
    store: DurableObjectStub<PluginStoreDurableObject>): PluginManifestCatalog {
  return new StoreBackedPluginManifestCatalog(store);
}

/** Creates a resolver that re-hashes Store and bundled artifact bytes before every use. */
export function createPluginStoreCodeArtifactResolver(
    store: DurableObjectStub<PluginStoreDurableObject>): VerifyingPluginCodeArtifactResolver {
  return new VerifyingPluginCodeArtifactResolver(new StoreBackedPluginCodeArtifactStore(store));
}
