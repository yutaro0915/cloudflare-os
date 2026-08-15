import { describe, expect, it } from "vitest";
import { BundledPluginCodeArtifactStore } from "../src/bundled-plugin-artifacts.js";
import { VerifyingPluginCodeArtifactResolver } from "../src/plugin-code-artifact.js";

describe("bundled plugin code artifacts", () => {
  it("resolves immutable source only by its content address", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const store = new BundledPluginCodeArtifactStore({[digest]: "export default {};"});

    await expect(store.read(digest)).resolves.toBe("export default {};");
    await expect(store.read(`sha256:${"b".repeat(64)}`)).resolves.toBeNull();
  });

  it("round-trips non-ASCII source through runtime digest verification", async () => {
    const code = `export default {}; // 雪\n`;
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
    const digest = `sha256:${new Uint8Array(hash).toHex()}`;
    const resolver = new VerifyingPluginCodeArtifactResolver(
      new BundledPluginCodeArtifactStore({[digest]: code}),
    );

    await expect(resolver.resolve(digest)).resolves.toMatchObject({
      ok: true,
      artifact: {code, codeArtifactDigest: digest},
    });
  });
});
