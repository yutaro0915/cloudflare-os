import { BUNDLED_PLUGIN_CODE_ARTIFACTS } from "./generated/plugin-manifests.js";
import {
  VerifyingPluginCodeArtifactResolver,
  type PluginCodeArtifactStore,
} from "./plugin-code-artifact.js";

/** Read-only code artifact store generated from deployment-reviewed prebundled ESM sources. */
export class BundledPluginCodeArtifactStore implements PluginCodeArtifactStore {
  readonly #entries: Readonly<Record<string, string>>;

  /** Owns an immutable digest-to-source snapshot without evaluating any artifact. */
  constructor(entries: Readonly<Record<string, string>>) {
    this.#entries = Object.freeze({...entries});
  }

  async read(codeArtifactDigest: string): Promise<string | null> {
    return this.#entries[codeArtifactDigest] ?? null;
  }
}

/** Deployment-bundled artifact resolver that re-hashes source on every cold Loader callback. */
export const bundledPluginCodeArtifactResolver = new VerifyingPluginCodeArtifactResolver(
  new BundledPluginCodeArtifactStore(BUNDLED_PLUGIN_CODE_ARTIFACTS),
);
