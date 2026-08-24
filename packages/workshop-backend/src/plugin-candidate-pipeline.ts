import type {WorkerEntrypoint} from "cloudflare:workers";
import {
  DynamicWorkerInteractivePluginUi,
  WorkerLoaderInteractivePluginUiStarter,
} from "./dynamic-worker-interactive-plugin-ui.js";
import {
  DynamicWorkerPluginUiRenderer,
  WorkerLoaderPluginUiWorkerStarter,
} from "./dynamic-worker-plugin-ui-renderer.js";
import {
  VerifyingPluginCodeArtifactResolver,
  type PluginCodeArtifactStore,
} from "./plugin-code-artifact.js";
import {
  BundledPluginManifestResolver,
  type PluginManifest,
  type VerifiedPluginManifest,
} from "./plugin-manifest-registry.js";
import {
  pluginStoreCandidateSignaturePayload,
  type PluginStoreCandidateArtifact,
  type PluginStoreCandidateEvidence,
  type PluginStoreDurableObject,
} from "./plugin-store.js";
import type {PluginMutationActor} from "./plugin-installation.js";
import {runPluginUiRpcWithinDeadline} from "./plugin-ui-rpc-deadline.js";

const CANDIDATE_RUNTIME_TIMEOUT_MS = 5_000;

const RUNTIME_CONTRACT_HARNESS = `
import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  async verify() {
    const plugin = await import("plugin.js");
    if (typeof plugin.default?.handshake !== "function" ||
        typeof plugin.default?.invoke !== "function") {
      throw new TypeError("Plugin runtime must export default.handshake() and default.invoke().");
    }
    await plugin.default.handshake();
    await plugin.default.invoke();
  }
}
`;

interface RuntimeContractEntrypoint extends WorkerEntrypoint {
  verify(): Promise<void>;
}

/** Output of an AI or other unprivileged plugin candidate generator. */
export interface GeneratedPluginCandidate {
  /** Candidate manifest source; the pipeline recomputes its content address. */
  manifest: PluginManifest;

  /** Candidate executable bytes; no generator authority accompanies them. */
  artifacts: PluginStoreCandidateArtifact[];
}

/** Unprivileged generation port; implementations receive no Store or installation capability. */
export interface PluginCandidateGenerator {
  /** Produces candidate bytes from untrusted prompt data. */
  generate(prompt: string): Promise<GeneratedPluginCandidate>;
}

/** Explicit signing capability kept outside the generator and isolated test worker. */
export interface PluginCandidateSigner {
  /** Signs only the host-constructed canonical candidate envelope. */
  sign(payload: Uint8Array): Promise<{
    signerPublicKey: JsonWebKey;
    signature: Uint8Array;
  }>;
}

/** Host-side ephemeral signer for one process-local candidate submission capability. */
export class WebCryptoPluginCandidateSigner implements PluginCandidateSigner {
  readonly #keys = crypto.subtle.generateKey(
    {name: "ECDSA", namedCurve: "P-256"},
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;

  /** Signs only bytes constructed by the trusted candidate pipeline. */
  async sign(payload: Uint8Array): Promise<{
    signerPublicKey: JsonWebKey;
    signature: Uint8Array;
  }> {
    const keys = await this.#keys;
    const signerPublicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
    if (signerPublicKey instanceof ArrayBuffer) {
      throw new TypeError("Expected a JSON Web Key from JWK export.");
    }
    return {
      signerPublicKey,
      signature: new Uint8Array(await crypto.subtle.sign(
        {name: "ECDSA", hash: "SHA-256"},
        keys.privateKey,
        payload,
      )),
    };
  }
}

/** Existing owner approval revalidated before user/workspace auto-publication. */
export interface PluginCandidatePublicationAuthority {
  /** Auto-publication is intentionally unavailable for deployment scope. */
  scope: "workspace" | "user";

  /** Exact owner target that minted this authority. */
  targetId: string;

  /** Exact package identifier approved by the owner boundary. */
  pluginId: string;

  /** Existing capability ceiling; candidate requests must be a subset. */
  approvedCapabilities: string[];

  /** Authenticated actor stamped into Store audit. */
  actor: PluginMutationActor;
}

/** Isolated verification result consumed by the signing stage. */
export type PluginCandidateIsolationTestResult = {
  ok: true;
  evidence: PluginStoreCandidateEvidence;
} | {
  ok: false;
  error: "ARTIFACT_NOT_FOUND" | "ARTIFACT_DIGEST_MISMATCH" |
    "RUNTIME_CONTRACT_FAILED" | "UI_CONTRACT_FAILED";
};

class CandidateArtifactStore implements PluginCodeArtifactStore {
  readonly #artifacts: Map<string, string>;

  constructor(artifacts: PluginStoreCandidateArtifact[]) {
    this.#artifacts = new Map(artifacts.map(
      artifact => [artifact.codeArtifactDigest, artifact.code],
    ));
  }

  async read(codeArtifactDigest: string): Promise<string | null> {
    return this.#artifacts.get(codeArtifactDigest) ?? null;
  }
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${new Uint8Array(digest).toHex()}`;
}

function executableArtifactDigests(manifest: VerifiedPluginManifest): string[] {
  const digests: string[] = [];
  if (manifest.runtime !== undefined) digests.push(manifest.runtime.codeArtifactDigest);
  for (const contribution of manifest.uiContributions ?? []) {
    if (contribution.renderer.kind !== "host-schema-v1") {
      digests.push(contribution.renderer.codeArtifactDigest);
    }
  }
  return [...new Set(digests)].toSorted();
}

/** Runs every candidate runtime/UI artifact behind fixed no-network Dynamic Worker harnesses. */
export class DynamicWorkerPluginCandidateIsolationTester {
  constructor(
    private loader: WorkerLoader,
    private runtimeTimeoutMs = CANDIDATE_RUNTIME_TIMEOUT_MS,
  ) {}

  /** Returns content-addressable passing evidence only when every executable ABI validates. */
  async test(
      manifest: VerifiedPluginManifest,
      artifacts: PluginStoreCandidateArtifact[]): Promise<PluginCandidateIsolationTestResult> {
    const resolver = new VerifyingPluginCodeArtifactResolver(new CandidateArtifactStore(artifacts));
    const tested: string[] = [];
    if (manifest.runtime !== undefined) {
      const digest = manifest.runtime.codeArtifactDigest;
      const resolved = await resolver.resolve(digest);
      if (!resolved.ok) return resolved;
      const entrypoint = this.loader.load({
        compatibilityDate: "2026-02-01",
        compatibilityFlags: ["disallow_importable_env"],
        mainModule: "runtime-contract.js",
        modules: {
          "runtime-contract.js": RUNTIME_CONTRACT_HARNESS,
          "plugin.js": resolved.artifact.code,
        },
        env: {},
        globalOutbound: null,
        limits: {cpuMs: 50, subRequests: 1},
      }).getEntrypoint<RuntimeContractEntrypoint>();
      const pending = entrypoint.verify();
      try {
        await runPluginUiRpcWithinDeadline(
          pending,
          [entrypoint],
          this.runtimeTimeoutMs,
          "Plugin runtime candidate test timed out.",
          () => undefined,
        );
      } catch {
        return {ok: false, error: "RUNTIME_CONTRACT_FAILED"};
      }
      tested.push(digest);
    }

    for (const contribution of manifest.uiContributions ?? []) {
      if (contribution.renderer.kind === "worker-rendered-document-v1") {
        const renderer = new DynamicWorkerPluginUiRenderer(
          new WorkerLoaderPluginUiWorkerStarter(this.loader),
          resolver,
        );
        if (await renderer.render(contribution.renderer.codeArtifactDigest) === null) {
          return {ok: false, error: "UI_CONTRACT_FAILED"};
        }
        tested.push(contribution.renderer.codeArtifactDigest);
      } else if (contribution.renderer.kind === "worker-interactive-document-v1") {
        const renderer = new DynamicWorkerInteractivePluginUi(
          new WorkerLoaderInteractivePluginUiStarter(this.loader),
          resolver,
        );
        if (
          await renderer.interact(
            contribution.renderer.codeArtifactDigest,
            {kind: "open", state: null},
          ) === null
        ) return {ok: false, error: "UI_CONTRACT_FAILED"};
        tested.push(contribution.renderer.codeArtifactDigest);
      }
    }
    const content = JSON.stringify({
      schemaVersion: 1,
      manifestDigest: manifest.manifestDigest,
      testedArtifactDigests: [...new Set(tested)].toSorted(),
      isolation: {
        env: "none",
        network: "none",
        cpuMs: 50,
        subRequests: 1,
        wallClockMs: this.runtimeTimeoutMs,
      },
      outcome: "passed",
    });
    return {
      ok: true,
      evidence: {
        kind: "isolated-test",
        name: "dynamic worker candidate contracts",
        outcome: "passed",
        evidenceDigest: await sha256Text(content),
        content,
      },
    };
  }
}

/** Default-deny generate→isolate→sign→stage→policy-gated publish coordinator. */
export class PluginCandidatePipeline {
  constructor(
    private store: DurableObjectStub<PluginStoreDurableObject>,
    private generator: PluginCandidateGenerator,
    private tester: DynamicWorkerPluginCandidateIsolationTester,
    private signer: PluginCandidateSigner,
  ) {}

  /** Runs one candidate without ever giving generator/test code Store publication authority. */
  async run(input: {
    prompt: string;
    requestedScope: "deployment" | "workspace" | "user";
    producerId: string;
    producerKind?: "human" | "ai";
    publicationAuthority?: PluginCandidatePublicationAuthority;
  }): Promise<{
    ok: true;
    phase: "AWAITING_APPROVAL" | "PUBLISHED";
    candidateId: string;
    manifestDigest: string;
  } | {
    ok: false;
    error: "GENERATION_FAILED" | "INVALID_MANIFEST" | "ISOLATION_TEST_FAILED" |
      "SIGNING_FAILED" | "CANDIDATE_REJECTED" | "PUBLICATION_FAILED";
  }> {
    let generated: GeneratedPluginCandidate;
    try {
      generated = await this.generator.generate(input.prompt);
    } catch {
      return {ok: false, error: "GENERATION_FAILED"};
    }
    let manifest: VerifiedPluginManifest;
    try {
      const catalog = await BundledPluginManifestResolver.create([generated.manifest]);
      const [verified] = await catalog.list();
      if (verified === undefined) return {ok: false, error: "INVALID_MANIFEST"};
      manifest = verified;
    } catch {
      return {ok: false, error: "INVALID_MANIFEST"};
    }
    const tested = await this.tester.test(manifest, generated.artifacts);
    if (!tested.ok) return {ok: false, error: "ISOLATION_TEST_FAILED"};
    const payload = pluginStoreCandidateSignaturePayload({
      manifestDigest: manifest.manifestDigest,
      artifactDigests: executableArtifactDigests(manifest),
      evidenceDigests: [tested.evidence.evidenceDigest],
      requestedCapabilities: [...manifest.requestedCapabilities],
      requestedScope: input.requestedScope,
    });
    let signed: {signerPublicKey: JsonWebKey; signature: Uint8Array};
    try {
      signed = await this.signer.sign(payload);
    } catch {
      return {ok: false, error: "SIGNING_FAILED"};
    }
    const staged = await this.store.stageCandidate({
      manifest: generated.manifest,
      artifacts: generated.artifacts,
      evidence: [tested.evidence],
      requestedScope: input.requestedScope,
      producer: {kind: input.producerKind ?? "ai", id: input.producerId},
      ...signed,
    });
    if (!staged.ok) return {ok: false, error: "CANDIDATE_REJECTED"};

    const authority = input.publicationAuthority;
    const approvals = new Set(authority?.approvedCapabilities ?? []);
    if (
      input.requestedScope === "deployment" || authority === undefined ||
      authority.scope !== input.requestedScope || authority.pluginId !== manifest.pluginId ||
      approvals.size !== authority.approvedCapabilities.length ||
      !manifest.requestedCapabilities.every(capability => approvals.has(capability))
    ) {
      return {
        ok: true,
        phase: "AWAITING_APPROVAL",
        candidateId: staged.candidateId,
        manifestDigest: staged.manifestDigest,
      };
    }
    const published = await this.store.publishWithinApprovedScope({
      candidateId: staged.candidateId,
      scope: authority.scope,
      targetId: authority.targetId,
      pluginId: authority.pluginId,
      approvedCapabilities: [...authority.approvedCapabilities],
      actor: authority.actor,
    });
    if (!published.ok) return {ok: false, error: "PUBLICATION_FAILED"};
    return {
      ok: true,
      phase: "PUBLISHED",
      candidateId: staged.candidateId,
      manifestDigest: staged.manifestDigest,
    };
  }
}
