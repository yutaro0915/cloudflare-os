import { BUNDLED_PLUGIN_MANIFESTS } from "./generated/plugin-manifests.js";
import {
  BundledPluginManifestResolver,
  type PluginManifestResolver,
} from "./plugin-manifest-registry.js";

/** Deployment-bundled manifest resolver verified once per Worker isolate. */
export const bundledPluginManifestResolver: Promise<PluginManifestResolver> =
  BundledPluginManifestResolver.create(BUNDLED_PLUGIN_MANIFESTS);
