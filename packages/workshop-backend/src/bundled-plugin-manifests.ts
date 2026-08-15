import { BUNDLED_PLUGIN_MANIFESTS } from "./generated/plugin-manifests.js";
import {
  BundledPluginManifestResolver,
  type PluginManifestCatalog,
} from "./plugin-manifest-registry.js";

/** Deployment-bundled manifest resolver verified once per Worker isolate. */
export const bundledPluginManifestResolver: Promise<PluginManifestCatalog> =
  BundledPluginManifestResolver.create(BUNDLED_PLUGIN_MANIFESTS);
