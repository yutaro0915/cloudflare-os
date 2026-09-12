import {DurableObject} from "cloudflare:workers";
import {collection, createTypedStorage} from "@gadgets/typed-storage";
import {
  BundledPluginManifestResolver,
  type PluginManifest,
  type VerifiedPluginManifest,
} from "./plugin-manifest-registry.js";
import type {PluginMutationActor} from "./plugin-installation.js";

const MAX_CANDIDATE_ARTIFACTS = 16;
const MAX_CANDIDATE_ARTIFACT_BYTES = 256 * 1024;
const MAX_CANDIDATE_TOTAL_ARTIFACT_BYTES = 1024 * 1024;
const MAX_CANDIDATE_EVIDENCE = 16;
const MAX_CANDIDATE_EVIDENCE_BYTES = 64 * 1024;
const MAX_CANDIDATE_TOTAL_EVIDENCE_BYTES = 256 * 1024;

/** One exact code artifact supplied with a signed Store candidate. */
export interface PluginStoreCandidateArtifact {
  /** Canonical SHA-256 content address of the UTF-8 source. */
  codeArtifactDigest: string;

  /** Single ESM source module evaluated only by the fixed Dynamic Worker harness. */
  code: string;
}

/** Content-addressed verification evidence supplied with a signed Store candidate. */
export interface PluginStoreCandidateEvidence {
  /** Closed evidence category used by publication policy. */
  kind: "isolated-test" | "static-analysis";

  /** Human-readable bounded check name. */
  name: string;

  /** Only passing evidence may enter a publishable candidate. */
  outcome: "passed";

  /** Canonical SHA-256 address of the UTF-8 evidence body. */
  evidenceDigest: string;

  /** Immutable bounded evidence body retained for operator inspection. */
  content: string;
}

/** Producer identity attached to a staged candidate without granting publication authority. */
export interface PluginStoreCandidateProducer {
  /** Candidate origin; neither value grants Store publication authority. */
  kind: "human" | "ai";

  /** Stable host-selected producer identifier. */
  id: string;
}

/** Signed immutable input accepted by the Store staging boundary. */
export interface StagePluginStoreCandidateInput {
  /** Exact manifest source whose canonical digest is recomputed by the host. */
  manifest: PluginManifest;

  /** Exact artifact set referenced by the manifest, with no unreferenced extras. */
  artifacts: PluginStoreCandidateArtifact[];

  /** Passing content-addressed checks, including at least one isolated test. */
  evidence: PluginStoreCandidateEvidence[];

  /** Intended installation scope used by later approval policy. */
  requestedScope: "deployment" | "workspace" | "user";

  /** Unprivileged provenance recorded with the candidate. */
  producer: PluginStoreCandidateProducer;

  /** P-256 public key used only to verify this immutable candidate envelope. */
  signerPublicKey: JsonWebKey;

  /** ECDSA/SHA-256 signature over `pluginStoreCandidateSignaturePayload()`. */
  signature: Uint8Array;
}

interface StoredPluginStoreCandidate {
  candidateId: string;
  manifest: PluginManifest;
  manifestDigest: string;
  pluginId: string;
  packageVersion: string;
  artifacts: PluginStoreCandidateArtifact[];
  evidence: PluginStoreCandidateEvidence[];
  requestedCapabilities: string[];
  requestedScope: "deployment" | "workspace" | "user";
  producer: PluginStoreCandidateProducer;
  signerKeyDigest: string;
  signatureDigest: string;
  stagedAt: number;
  publishedAt?: number;
}

interface PublishedPluginManifestRecord {
  packageKey: string;
  candidateId: string;
  manifest: PluginManifest;
  manifestDigest: string;
  publishedAt: number;
}

interface PublishedPluginArtifactRecord extends PluginStoreCandidateArtifact {
  candidateId: string;
}

/** Append-only Store publication evidence owned outside plugin code. */
export interface PluginStoreAuditEvent {
  /** Monotonic sequence in the deployment Store stream. */
  sequence: number;

  /** Staging proves integrity; publication additionally proves admin approval. */
  action: "PLUGIN_CANDIDATE_STAGED" | "PLUGIN_CANDIDATE_PUBLISHED";

  /** Stable content address of the immutable candidate envelope. */
  candidateId: string;

  /** Stable package identifier from the verified manifest. */
  pluginId: string;

  /** Exact package version from the verified manifest. */
  packageVersion: string;

  /** Canonical manifest digest recomputed by the host. */
  manifestDigest: string;

  /** Unprivileged producer provenance. */
  producer: PluginStoreCandidateProducer;

  /** Admin identity exists only for the publication action. */
  actor?: PluginMutationActor;

  /** Authority path used for publication; absent for staging. */
  publicationAuthority?: "admin" | "approved-scope";

  /** Owner target revalidated by the host for approved-scope publication. */
  targetId?: string;

  /** Host timestamp in milliseconds since the Unix epoch. */
  recordedAt: number;
}

function makePluginStoreStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      candidates: collection<StoredPluginStoreCandidate>()({primaryKey: "candidateId"}),
      publishedManifests: collection<PublishedPluginManifestRecord>()({
        primaryKey: "packageKey",
      }),
      publishedArtifacts: collection<PublishedPluginArtifactRecord>()({
        primaryKey: "codeArtifactDigest",
      }),
      auditEvents: collection<PluginStoreAuditEvent>()({primaryKey: "sequence"}),
    },
    singletons: {
      nextAuditSequence: 0,
    },
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Invalid JSON number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Invalid JSON value.");
  const entries = Object.entries(value).filter(([, child]) => child !== undefined)
    .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) =>
    `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${new Uint8Array(digest).toHex()}`;
}

function referencedArtifactDigests(manifest: VerifiedPluginManifest): string[] {
  const digests: string[] = [];
  if (manifest.runtime !== undefined) digests.push(manifest.runtime.codeArtifactDigest);
  for (const contribution of manifest.uiContributions ?? []) {
    if (contribution.renderer.kind !== "host-schema-v1") {
      digests.push(contribution.renderer.codeArtifactDigest);
    }
  }
  return [...new Set(digests)].toSorted();
}

/** Builds the canonical bytes that an external candidate producer must sign. */
export function pluginStoreCandidateSignaturePayload(input: {
  manifestDigest: string;
  artifactDigests: string[];
  evidenceDigests: string[];
  requestedCapabilities: string[];
  requestedScope: "deployment" | "workspace" | "user";
}): Uint8Array {
  return new TextEncoder().encode(canonicalJson({
    schemaVersion: 1,
    manifestDigest: input.manifestDigest,
    artifactDigests: [...input.artifactDigests].toSorted(),
    evidenceDigests: [...input.evidenceDigests].toSorted(),
    requestedCapabilities: [...input.requestedCapabilities].toSorted(),
    requestedScope: input.requestedScope,
  }));
}

/** Content-addressed Store with signed staging and admin-approved atomic publication. */
export class PluginStoreDurableObject extends DurableObject<Cloudflare.Env> {
  readonly #storage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#storage = makePluginStoreStorage(ctx.storage);
  }

  /** Verifies and stages an immutable candidate without making it installable. */
  async stageCandidate(input: StagePluginStoreCandidateInput): Promise<{
    ok: true;
    candidateId: string;
    manifestDigest: string;
  } | {
    ok: false;
    error: "INVALID_MANIFEST" | "ARTIFACT_SET_MISMATCH" | "ARTIFACT_DIGEST_MISMATCH" |
      "EVIDENCE_REQUIRED" | "EVIDENCE_DIGEST_MISMATCH" | "INVALID_SIGNATURE" |
      "CANDIDATE_TOO_LARGE";
  }> {
    let manifest: VerifiedPluginManifest;
    try {
      const catalog = await BundledPluginManifestResolver.create([input.manifest]);
      const [verified] = await catalog.list();
      if (verified === undefined) return {ok: false, error: "INVALID_MANIFEST"};
      manifest = verified;
    } catch {
      return {ok: false, error: "INVALID_MANIFEST"};
    }

    if (
      input.artifacts.length > MAX_CANDIDATE_ARTIFACTS ||
      input.evidence.length > MAX_CANDIDATE_EVIDENCE
    ) return {ok: false, error: "CANDIDATE_TOO_LARGE"};
    const expectedArtifacts = referencedArtifactDigests(manifest);
    const suppliedArtifacts = input.artifacts.map(entry => entry.codeArtifactDigest).toSorted();
    if (
      new Set(suppliedArtifacts).size !== suppliedArtifacts.length ||
      canonicalJson(expectedArtifacts) !== canonicalJson(suppliedArtifacts)
    ) return {ok: false, error: "ARTIFACT_SET_MISMATCH"};
    let artifactBytes = 0;
    for (const artifact of input.artifacts) {
      const bytes = new TextEncoder().encode(artifact.code).byteLength;
      artifactBytes += bytes;
      if (bytes > MAX_CANDIDATE_ARTIFACT_BYTES ||
          await sha256Text(artifact.code) !== artifact.codeArtifactDigest) {
        return bytes > MAX_CANDIDATE_ARTIFACT_BYTES
          ? {ok: false, error: "CANDIDATE_TOO_LARGE"}
          : {ok: false, error: "ARTIFACT_DIGEST_MISMATCH"};
      }
    }
    if (artifactBytes > MAX_CANDIDATE_TOTAL_ARTIFACT_BYTES) {
      return {ok: false, error: "CANDIDATE_TOO_LARGE"};
    }

    if (
      input.evidence.length === 0 ||
      !input.evidence.some(entry => entry.kind === "isolated-test")
    ) return {ok: false, error: "EVIDENCE_REQUIRED"};
    let evidenceBytes = 0;
    for (const evidence of input.evidence) {
      if (evidence.name.length === 0 || evidence.name.length > 128) {
        return {ok: false, error: "EVIDENCE_REQUIRED"};
      }
      const bytes = new TextEncoder().encode(evidence.content).byteLength;
      evidenceBytes += bytes;
      if (bytes > MAX_CANDIDATE_EVIDENCE_BYTES) {
        return {ok: false, error: "CANDIDATE_TOO_LARGE"};
      }
      if (await sha256Text(evidence.content) !== evidence.evidenceDigest) {
        return {ok: false, error: "EVIDENCE_DIGEST_MISMATCH"};
      }
    }
    if (evidenceBytes > MAX_CANDIDATE_TOTAL_EVIDENCE_BYTES) {
      return {ok: false, error: "CANDIDATE_TOO_LARGE"};
    }

    const payload = pluginStoreCandidateSignaturePayload({
      manifestDigest: manifest.manifestDigest,
      artifactDigests: suppliedArtifacts,
      evidenceDigests: input.evidence.map(entry => entry.evidenceDigest),
      requestedCapabilities: [...manifest.requestedCapabilities],
      requestedScope: input.requestedScope,
    });
    let signatureValid = false;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        input.signerPublicKey,
        {name: "ECDSA", namedCurve: "P-256"},
        false,
        ["verify"],
      );
      signatureValid = await crypto.subtle.verify(
        {name: "ECDSA", hash: "SHA-256"},
        key,
        input.signature,
        payload,
      );
    } catch {
      return {ok: false, error: "INVALID_SIGNATURE"};
    }
    if (!signatureValid) return {ok: false, error: "INVALID_SIGNATURE"};

    const candidateId = await sha256Text(new TextDecoder().decode(payload));
    const signerKeyDigest = await sha256Text(canonicalJson(input.signerPublicKey));
    const signatureDigest = `sha256:${new Uint8Array(
      await crypto.subtle.digest("SHA-256", input.signature),
    ).toHex()}`;
    this.ctx.storage.transactionSync(() => {
      if (this.#storage.candidates.get(candidateId) !== undefined) return;
      const stagedAt = Date.now();
      this.#storage.candidates.put({
        candidateId,
        manifest: structuredClone(input.manifest),
        manifestDigest: manifest.manifestDigest,
        pluginId: manifest.pluginId,
        packageVersion: manifest.packageVersion,
        artifacts: structuredClone(input.artifacts),
        evidence: structuredClone(input.evidence),
        requestedCapabilities: [...manifest.requestedCapabilities],
        requestedScope: input.requestedScope,
        producer: structuredClone(input.producer),
        signerKeyDigest,
        signatureDigest,
        stagedAt,
      });
      const sequence = this.#storage.nextAuditSequence.get();
      this.#storage.auditEvents.put({
        sequence,
        action: "PLUGIN_CANDIDATE_STAGED",
        candidateId,
        pluginId: manifest.pluginId,
        packageVersion: manifest.packageVersion,
        manifestDigest: manifest.manifestDigest,
        producer: structuredClone(input.producer),
        recordedAt: stagedAt,
      });
      this.#storage.nextAuditSequence.put(sequence + 1);
    });
    return {ok: true, candidateId, manifestDigest: manifest.manifestDigest};
  }

  /** Atomically publishes one staged candidate under explicit deployment-admin approval. */
  approveAndPublish(candidateId: string, actor: PluginMutationActor): {
    ok: true;
    candidateId: string;
  } | {
    ok: false;
    error: "CANDIDATE_NOT_FOUND" | "PLUGIN_VERSION_ALREADY_PUBLISHED";
  } {
    return this.#publish(candidateId, actor, "admin");
  }

  /** Publishes only a user/workspace candidate within a host-revalidated capability ceiling. */
  publishWithinApprovedScope(input: {
    candidateId: string;
    scope: "workspace" | "user";
    targetId: string;
    pluginId: string;
    approvedCapabilities: string[];
    actor: PluginMutationActor;
  }): {
    ok: true;
    candidateId: string;
  } | {
    ok: false;
    error: "CANDIDATE_NOT_FOUND" | "PLUGIN_VERSION_ALREADY_PUBLISHED" |
      "PUBLICATION_AUTHORITY_DENIED";
  } {
    const candidate = this.#storage.candidates.get(input.candidateId);
    const approvals = new Set(input.approvedCapabilities);
    if (
      candidate === undefined || candidate.requestedScope !== input.scope ||
      candidate.pluginId !== input.pluginId ||
      approvals.size !== input.approvedCapabilities.length ||
      !candidate.requestedCapabilities.every(capability => approvals.has(capability))
    ) {
      return candidate === undefined
        ? {ok: false, error: "CANDIDATE_NOT_FOUND"}
        : {ok: false, error: "PUBLICATION_AUTHORITY_DENIED"};
    }
    return this.#publish(
      input.candidateId,
      input.actor,
      "approved-scope",
      input.targetId,
    );
  }

  #publish(
      candidateId: string,
      actor: PluginMutationActor,
      publicationAuthority: "admin" | "approved-scope",
      targetId?: string): {
    ok: true;
    candidateId: string;
  } | {
    ok: false;
    error: "CANDIDATE_NOT_FOUND" | "PLUGIN_VERSION_ALREADY_PUBLISHED";
  } {
    let result: {ok: true; candidateId: string} |
      {ok: false; error: "CANDIDATE_NOT_FOUND" | "PLUGIN_VERSION_ALREADY_PUBLISHED"} = {
        ok: false,
        error: "CANDIDATE_NOT_FOUND",
      };
    this.ctx.storage.transactionSync(() => {
      const candidate = this.#storage.candidates.get(candidateId);
      if (candidate === undefined) return;
      if (candidate.publishedAt !== undefined) {
        result = {ok: true, candidateId};
        return;
      }
      const packageKey = `${candidate.pluginId}@${candidate.packageVersion}`;
      if (this.#storage.publishedManifests.get(packageKey) !== undefined) {
        result = {ok: false, error: "PLUGIN_VERSION_ALREADY_PUBLISHED"};
        return;
      }
      const publishedAt = Date.now();
      this.#storage.publishedManifests.put({
        packageKey,
        candidateId,
        manifest: structuredClone(candidate.manifest),
        manifestDigest: candidate.manifestDigest,
        publishedAt,
      });
      for (const artifact of candidate.artifacts) {
        const existing = this.#storage.publishedArtifacts.get(artifact.codeArtifactDigest);
        if (existing !== undefined && existing.code !== artifact.code) {
          throw new Error("Published artifact content-address collision.");
        }
        this.#storage.publishedArtifacts.put({
          ...structuredClone(artifact),
          candidateId,
        });
      }
      const sequence = this.#storage.nextAuditSequence.get();
      this.#storage.auditEvents.put({
        sequence,
        action: "PLUGIN_CANDIDATE_PUBLISHED",
        candidateId,
        pluginId: candidate.pluginId,
        packageVersion: candidate.packageVersion,
        manifestDigest: candidate.manifestDigest,
        producer: structuredClone(candidate.producer),
        actor: structuredClone(actor),
        publicationAuthority,
        ...(targetId === undefined ? {} : {targetId}),
        recordedAt: publishedAt,
      });
      this.#storage.candidates.put({...candidate, publishedAt});
      this.#storage.nextAuditSequence.put(sequence + 1);
      result = {ok: true, candidateId};
    });
    return result;
  }

  /** Returns one published manifest source for a caller that will revalidate it. */
  async resolveManifest(pluginId: string, packageVersion: string): Promise<PluginManifest | null> {
    const record = this.#storage.publishedManifests.get(`${pluginId}@${packageVersion}`);
    return record === undefined ? null : structuredClone(record.manifest);
  }

  /** Lists all published manifest sources in deterministic package-key order. */
  async listManifests(): Promise<PluginManifest[]> {
    return Array.from(this.#storage.publishedManifests.list())
      .toSorted((left, right) => left.packageKey.localeCompare(right.packageKey))
      .map(record => structuredClone(record.manifest));
  }

  /** Reads published code only after its manifest and artifact visibility committed atomically. */
  async readArtifact(codeArtifactDigest: string): Promise<string | null> {
    return this.#storage.publishedArtifacts.get(codeArtifactDigest)?.code ?? null;
  }

  /** Lists append-only staging and publication evidence for trusted operators and tests. */
  async listAuditEventsForHost(): Promise<PluginStoreAuditEvent[]> {
    return Array.from(this.#storage.auditEvents.list());
  }
}
