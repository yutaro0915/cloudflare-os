import {exports} from "cloudflare:workers";
import {abortAllDurableObjects} from "cloudflare:test";
import {newWebSocketRpcSession, type RpcStub} from "capnweb";
import type {PublicApi} from "@gadgets/workshop-shared/api";
import {describe, expect, it} from "vitest";
import {
  BundledPluginManifestResolver,
  type PluginManifest,
} from "../src/plugin-manifest-registry.js";
import {
  pluginStoreCandidateSignaturePayload,
  type PluginStoreCandidateEvidence,
  type StagePluginStoreCandidateInput,
} from "../src/plugin-store.js";
import {
  createPluginStoreCodeArtifactResolver,
  createPluginStoreManifestCatalog,
} from "../src/plugin-store-resolvers.js";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Expected WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${new Uint8Array(digest).toHex()}`;
}

async function signedCandidate(
    pluginId: string,
    packageVersion: string,
    code: string): Promise<StagePluginStoreCandidateInput> {
  const codeArtifactDigest = await sha256(code);
  const manifest: PluginManifest = {
    schemaVersion: 3,
    pluginId,
    packageVersion,
    requestedCapabilities: [],
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest},
  };
  const catalog = await BundledPluginManifestResolver.create([manifest]);
  const [verified] = await catalog.list();
  if (verified === undefined) throw new Error("Expected verified test manifest.");
  const evidenceContent = JSON.stringify({suite: "isolated-runtime", passed: true});
  const evidence: PluginStoreCandidateEvidence[] = [{
    kind: "isolated-test",
    name: "isolated runtime contract",
    outcome: "passed",
    evidenceDigest: await sha256(evidenceContent),
    content: evidenceContent,
  }];
  const keys = await crypto.subtle.generateKey(
    {name: "ECDSA", namedCurve: "P-256"},
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const signerPublicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const payload = pluginStoreCandidateSignaturePayload({
    manifestDigest: verified.manifestDigest,
    artifactDigests: [codeArtifactDigest],
    evidenceDigests: evidence.map(entry => entry.evidenceDigest),
    requestedCapabilities: [],
    requestedScope: "user",
  });
  const signature = new Uint8Array(await crypto.subtle.sign(
    {name: "ECDSA", hash: "SHA-256"},
    keys.privateKey,
    payload,
  ));
  return {
    manifest,
    artifacts: [{codeArtifactDigest, code}],
    evidence,
    requestedScope: "user",
    producer: {kind: "human", id: "reviewer@example.test"},
    signerPublicKey,
    signature,
  };
}

describe("content-addressed plugin Store publication", () => {
  it("keeps a signed evidenced candidate invisible until atomic admin publication", async () => {
    const store = exports.PluginStoreDurableObject.getByName("store-publication");
    const input = await signedCandidate(
      "store.dynamic-runtime",
      "1.0.0",
      "export default { handshake() {}, invoke() {} };",
    );
    const staged = await store.stageCandidate(input);
    expect(staged).toMatchObject({
      ok: true,
      candidateId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      manifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    if (!staged.ok) throw new Error("Expected signed candidate staging.");
    await expect(store.resolveManifest("store.dynamic-runtime", "1.0.0"))
      .resolves.toBeNull();
    await expect(store.readArtifact(input.artifacts[0]!.codeArtifactDigest))
      .resolves.toBeNull();

    await expect(store.approveAndPublish(staged.candidateId, {
      userId: "admin-user-do",
      profileId: "admin@example.test",
    })).resolves.toEqual({ok: true, candidateId: staged.candidateId});
    await expect(store.resolveManifest("store.dynamic-runtime", "1.0.0"))
      .resolves.toEqual(input.manifest);
    await expect(store.readArtifact(input.artifacts[0]!.codeArtifactDigest))
      .resolves.toBe(input.artifacts[0]!.code);

    await abortAllDurableObjects();
    const reconstructed = exports.PluginStoreDurableObject.getByName("store-publication");
    await expect(reconstructed.resolveManifest("store.dynamic-runtime", "1.0.0"))
      .resolves.toEqual(input.manifest);
    expect((await reconstructed.listAuditEventsForHost()).map(event => event.action)).toEqual([
      "PLUGIN_CANDIDATE_STAGED",
      "PLUGIN_CANDIDATE_PUBLISHED",
    ]);
  });

  it("rejects tampered signatures and missing isolated evidence without visibility", async () => {
    const store = exports.PluginStoreDurableObject.getByName("store-rejections");
    const signed = await signedCandidate(
      "store.rejected-runtime",
      "1.0.0",
      "export default { handshake() {}, invoke() {} };",
    );
    const tampered = structuredClone(signed);
    tampered.signature[0] = (tampered.signature[0] ?? 0) ^ 0xff;
    await expect(store.stageCandidate(tampered))
      .resolves.toEqual({ok: false, error: "INVALID_SIGNATURE"});
    await expect(store.stageCandidate({...signed, evidence: []}))
      .resolves.toEqual({ok: false, error: "EVIDENCE_REQUIRED"});
    await expect(store.listManifests()).resolves.toEqual([]);
    await expect(store.listAuditEventsForHost()).resolves.toEqual([]);
  });

  it("requires an authenticated admin capability before Store-backed install and artifact use", async () => {
    const store = exports.PluginStoreDurableObject.getByName("");
    const input = await signedCandidate(
      "store.installable-runtime",
      "1.0.0",
      "export default { handshake() {}, invoke() {} };",
    );
    const staged = await store.stageCandidate(input);
    if (!staged.ok) throw new Error("Expected installable Store candidate staging.");

    using publicApi = await connect();
    const username = "deploymentpluginadmin";
    const token = await publicApi.createAccount(username, username, PASSWORD_HASH);
    if (token === null) throw new Error("Expected configured Store admin account creation.");
    using authenticated = await publicApi.authenticate(token);
    await expect(authenticated.installUserPlugin({
      pluginId: input.manifest.pluginId,
      packageVersion: input.manifest.packageVersion,
      approvedCapabilities: [],
    })).resolves.toEqual({ok: false, error: "PLUGIN_VERSION_NOT_FOUND"});

    using admin = await authenticated.getAdminApi();
    if (admin === null) throw new Error("Expected Store admin capability.");
    await expect(admin.approvePluginStoreCandidate(staged.candidateId))
      .resolves.toEqual({ok: true, candidateId: staged.candidateId});
    await expect(authenticated.installUserPlugin({
      pluginId: input.manifest.pluginId,
      packageVersion: input.manifest.packageVersion,
      approvedCapabilities: [],
    })).resolves.toMatchObject({ok: true, installationId: expect.any(String)});

    const catalog = createPluginStoreManifestCatalog(store);
    await expect(catalog.resolve(input.manifest.pluginId, input.manifest.packageVersion))
      .resolves.toMatchObject({manifestDigest: staged.manifestDigest});
    const artifacts = createPluginStoreCodeArtifactResolver(store);
    await expect(artifacts.resolve(input.artifacts[0]!.codeArtifactDigest))
      .resolves.toMatchObject({ok: true, artifact: {code: input.artifacts[0]!.code}});
  });
});
