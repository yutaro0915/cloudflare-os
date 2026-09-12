import {exports} from "cloudflare:workers";
import {env} from "cloudflare:test";
import {describe, expect, it} from "vitest";
import type {PluginManifest} from "../src/plugin-manifest-registry.js";
import {
  DynamicWorkerPluginCandidateIsolationTester,
  PluginCandidatePipeline,
  type GeneratedPluginCandidate,
  type PluginCandidateSigner,
} from "../src/plugin-candidate-pipeline.js";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${new Uint8Array(digest).toHex()}`;
}

async function runtimeCandidate(
    pluginId: string,
    packageVersion: string,
    requestedCapabilities: string[] = [],
    code = "export default { async handshake() {}, async invoke() {} };",
): Promise<GeneratedPluginCandidate> {
  const codeArtifactDigest = await sha256(code);
  const manifest: PluginManifest = {
    schemaVersion: 3,
    pluginId,
    packageVersion,
    requestedCapabilities,
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest},
  };
  return {manifest, artifacts: [{codeArtifactDigest, code}]};
}

class TestCandidateSigner implements PluginCandidateSigner {
  readonly #keys: Promise<CryptoKeyPair>;

  constructor() {
    this.#keys = crypto.subtle.generateKey(
      {name: "ECDSA", namedCurve: "P-256"},
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>;
  }

  async sign(payload: Uint8Array): Promise<{
    signerPublicKey: JsonWebKey;
    signature: Uint8Array;
  }> {
    const keys = await this.#keys;
    return {
      signerPublicKey: await crypto.subtle.exportKey("jwk", keys.publicKey),
      signature: new Uint8Array(await crypto.subtle.sign(
        {name: "ECDSA", hash: "SHA-256"},
        keys.privateKey,
        payload,
      )),
    };
  }
}

describe("AI plugin candidate pipeline", () => {
  it("publishes only within an exact existing user capability approval", async () => {
    const store = exports.PluginStoreDurableObject.getByName("ai-candidate-approved");
    const generated = await runtimeCandidate(
      "ai.generated-approved",
      "1.0.0",
      ["workspace.metadata.read"],
    );
    const pipeline = new PluginCandidatePipeline(
      store,
      {generate: async prompt => {
        expect(prompt).toBe("build reviewed helper");
        return generated;
      }},
      new DynamicWorkerPluginCandidateIsolationTester(env.LOADER),
      new TestCandidateSigner(),
    );
    const result = await pipeline.run({
      prompt: "build reviewed helper",
      requestedScope: "user",
      producerId: "model:test",
      publicationAuthority: {
        scope: "user",
        targetId: "user-owner-do",
        pluginId: generated.manifest.pluginId,
        approvedCapabilities: ["workspace.metadata.read"],
        actor: {userId: "user-owner-do", profileId: "owner@example.test"},
      },
    });
    expect(result).toMatchObject({
      ok: true,
      phase: "PUBLISHED",
      candidateId: expect.stringMatching(/^sha256:/),
    });
    await expect(store.resolveManifest(
      generated.manifest.pluginId,
      generated.manifest.packageVersion,
    )).resolves.toEqual(generated.manifest);
    expect((await store.listAuditEventsForHost()).at(-1)).toMatchObject({
      action: "PLUGIN_CANDIDATE_PUBLISHED",
      publicationAuthority: "approved-scope",
      targetId: "user-owner-do",
    });
  });

  it("stages but does not publish without authority, for new grants, or for deployment", async () => {
    const scenarios = [
      {
        name: "missing-authority",
        scope: "workspace" as const,
        capabilities: [] as string[],
        authority: undefined,
      },
      {
        name: "new-capability",
        scope: "workspace" as const,
        capabilities: ["workspace.metadata.read"],
        authority: {
          scope: "workspace" as const,
          targetId: "workspace-owner-do",
          pluginId: "ai.new-capability",
          approvedCapabilities: [] as string[],
          actor: {userId: "owner-user-do", profileId: "owner@example.test"},
        },
      },
      {
        name: "deployment",
        scope: "deployment" as const,
        capabilities: [] as string[],
        authority: undefined,
      },
    ];
    for (const scenario of scenarios) {
      const pluginId = scenario.name === "new-capability"
        ? "ai.new-capability"
        : `ai.${scenario.name}`;
      const generated = await runtimeCandidate(pluginId, "1.0.0", scenario.capabilities);
      const store = exports.PluginStoreDurableObject.getByName(`ai-${scenario.name}`);
      const pipeline = new PluginCandidatePipeline(
        store,
        {generate: async () => generated},
        new DynamicWorkerPluginCandidateIsolationTester(env.LOADER),
        new TestCandidateSigner(),
      );
      await expect(pipeline.run({
        prompt: scenario.name,
        requestedScope: scenario.scope,
        producerId: "model:test",
        ...(scenario.authority === undefined
          ? {}
          : {publicationAuthority: scenario.authority}),
      })).resolves.toMatchObject({ok: true, phase: "AWAITING_APPROVAL"});
      await expect(store.resolveManifest(pluginId, "1.0.0")).resolves.toBeNull();
      expect((await store.listAuditEventsForHost()).map(event => event.action))
        .toEqual(["PLUGIN_CANDIDATE_STAGED"]);
    }
  });

  it("physically cancels a runtime contract test that never settles", async () => {
    const generated = await runtimeCandidate(
      "ai.nonsettling-runtime",
      "1.0.0",
      [],
      `export default {
        async handshake() { await new Promise(() => {}); },
        async invoke() {},
      };`,
    );
    const store = exports.PluginStoreDurableObject.getByName("ai-nonsettling-runtime");
    const pipeline = new PluginCandidatePipeline(
      store,
      {generate: async () => generated},
      new DynamicWorkerPluginCandidateIsolationTester(env.LOADER, 25),
      new TestCandidateSigner(),
    );

    await expect(pipeline.run({
      prompt: "nonsettling runtime",
      requestedScope: "user",
      producerId: "model:test",
    })).resolves.toEqual({ok: false, error: "ISOLATION_TEST_FAILED"});
    await expect(store.listAuditEventsForHost()).resolves.toEqual([]);
  });
});
