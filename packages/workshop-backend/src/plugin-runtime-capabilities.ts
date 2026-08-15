/** First closed runtime capability supported by the isolated plugin host. */
export const WORKSPACE_METADATA_READ_CAPABILITY = "workspace.metadata.read";
/** Installation-scoped JSON state read capability. */
export const PLUGIN_STATE_READ_CAPABILITY = "plugin.state.read";

const SUPPORTED_PLUGIN_RUNTIME_CAPABILITIES = new Set<string>([
  WORKSPACE_METADATA_READ_CAPABILITY,
  PLUGIN_STATE_READ_CAPABILITY,
]);

/** Returns whether the isolated runtime host implements a manifest capability exactly. */
export function isSupportedPluginRuntimeCapability(capability: string): boolean {
  return SUPPORTED_PLUGIN_RUNTIME_CAPABILITIES.has(capability);
}
