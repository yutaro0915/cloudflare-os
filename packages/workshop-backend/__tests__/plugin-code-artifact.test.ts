import { describe, expect, it } from "vitest";
import {
  VerifyingPluginCodeArtifactResolver,
  type PluginCodeArtifactStore,
} from "../src/plugin-code-artifact.js";

const CODE = `export default { handshake() { return "ok"; } };\n`;
const DIGEST = "sha256:5b056b8472e4c36854cb9fdaa5c173b5dada6ddf49e86006c5851eff8091e8c8";

class MutableArtifactStore implements PluginCodeArtifactStore {
  value: string | null = CODE;
  reads = 0;

  async read(codeArtifactDigest: string): Promise<string | null> {
    expect(codeArtifactDigest).toBe(DIGEST);
    this.reads += 1;
    return this.value;
  }
}

describe("plugin code artifact resolver", () => {
  it("returns owned bytes only after verifying their content address", async () => {
    const store = new MutableArtifactStore();
    const resolver = new VerifyingPluginCodeArtifactResolver(store);

    const result = await resolver.resolve(DIGEST);
    expect(result).toEqual({
      ok: true,
      artifact: {codeArtifactDigest: DIGEST, code: CODE, byteLength: 49},
    });
    if (!result.ok) throw new Error("Expected verified artifact.");
    expect(Reflect.set(result.artifact, "code", "forged code")).toBe(false);
    await expect(resolver.resolve(DIGEST)).resolves.toEqual(result);
  });

  it("distinguishes a missing artifact from content tampering and rechecks every read", async () => {
    const store = new MutableArtifactStore();
    const resolver = new VerifyingPluginCodeArtifactResolver(store);
    await expect(resolver.resolve(DIGEST)).resolves.toMatchObject({ok: true});

    store.value = `${CODE}// tampered`;
    await expect(resolver.resolve(DIGEST)).resolves.toEqual({
      ok: false,
      error: "ARTIFACT_DIGEST_MISMATCH",
    });
    store.value = null;
    await expect(resolver.resolve(DIGEST)).resolves.toEqual({
      ok: false,
      error: "ARTIFACT_NOT_FOUND",
    });
    expect(store.reads).toBe(3);
  });
});
