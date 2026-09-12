/** Byte source for immutable prebundled plugin code artifacts. */
export interface PluginCodeArtifactStore {
  /** Reads exact UTF-8 JavaScript source by its expected content address. */
  read(codeArtifactDigest: string): Promise<string | null>;
}

/** Owned prebundled JavaScript verified against its expected content address. */
export interface VerifiedPluginCodeArtifact {
  /** SHA-256 content address verified from the returned UTF-8 bytes. */
  readonly codeArtifactDigest: string;

  /** Single prebundled ESM module loaded only behind the trusted host harness. */
  readonly code: string;

  /** UTF-8 size available for host policy enforcement. */
  readonly byteLength: number;
}

/** Result of resolving immutable plugin code without exposing its storage adapter. */
export type ResolvePluginCodeArtifactResult = {
  /** Artifact bytes matched their expected content address. */
  ok: true;

  /** Owned verified source. */
  artifact: VerifiedPluginCodeArtifact;
} | {
  /** Artifact could not be trusted. */
  ok: false;

  /** Stable failure that must prevent Worker Loader activation. */
  error: "ARTIFACT_NOT_FOUND" | "ARTIFACT_DIGEST_MISMATCH";
};

/** Reads and re-hashes plugin code every time its backing store is consulted. */
export class VerifyingPluginCodeArtifactResolver {
  /** Creates a verifier around one immutable artifact storage port. */
  constructor(private store: PluginCodeArtifactStore) {}

  /** Resolves exact UTF-8 source, or returns a local integrity failure without partial bytes. */
  async resolve(codeArtifactDigest: string): Promise<ResolvePluginCodeArtifactResult> {
    const code = await this.store.read(codeArtifactDigest);
    if (code === null) return {ok: false, error: "ARTIFACT_NOT_FOUND"};
    const bytes = new TextEncoder().encode(code);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = `sha256:${new Uint8Array(digest).toHex()}`;
    if (actual !== codeArtifactDigest) {
      return {ok: false, error: "ARTIFACT_DIGEST_MISMATCH"};
    }
    return {
      ok: true,
      artifact: Object.freeze({codeArtifactDigest, code, byteLength: bytes.byteLength}),
    };
  }
}
