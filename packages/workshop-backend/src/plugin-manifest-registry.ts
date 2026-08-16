interface PluginManifestBase {
  /** Stable package identifier. */
  readonly pluginId: string;

  /** Exact package version represented by this manifest. */
  readonly packageVersion: string;

  /** Capabilities the package asks an installer to approve individually. */
  readonly requestedCapabilities: readonly string[];
}

const PLUGIN_UI_STATE_MUTATE_CAPABILITY = "plugin.ui.state.mutate";

const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;

/** Original declarative plugin manifest without package dependencies. */
export interface PluginManifestV1 extends PluginManifestBase {
  /** Schema version for the manifest document. */
  readonly schemaVersion: 1;
}

/** Declarative plugin manifest with exact package dependency identifiers. */
export interface PluginManifestV2 extends PluginManifestBase {
  /** Schema version for the manifest document. */
  readonly schemaVersion: 2;

  /** Packages that must already be active before this package can activate. */
  readonly dependencies: readonly string[];
}

/** Host-supported runtime descriptor cryptographically bound into a manifest. */
export interface PluginRuntimeDescriptor {
  /** Runtime family selected by the trusted host. */
  readonly kind: "dynamic-worker";

  /** SHA-256 content address of one prebundled ESM code artifact. */
  readonly codeArtifactDigest: string;
}

/** Safe presentation metadata rendered by the trusted Plugin Center. */
export interface PluginPresentation {
  /** Human-readable package title. */
  readonly title: string;

  /** Short package summary. */
  readonly summary: string;
}

/** Closed declarative document rendered only by trusted host components. */
export interface DeclarativePluginUiDocument {
  /** Schema version of the bounded host-rendered document. */
  readonly schemaVersion: 1;

  /** Ordered display blocks; raw HTML, CSS, URLs, and handlers are not representable. */
  readonly blocks: readonly (
    | {readonly kind: "text"; readonly text: string}
    | {readonly kind: "notice"; readonly tone: "info" | "warning"; readonly text: string}
    | {readonly kind: "list"; readonly items: readonly string[]}
  )[];
}

/** One digest-bound contribution to the initial user plugin details surface. */
export type PluginUiContributionDescriptor = {
  readonly contributionId: string;
  readonly slot: "user-plugin.details";
  readonly title: string;
  readonly renderer: {
    readonly kind: "host-schema-v1";
    readonly document: DeclarativePluginUiDocument;
  };
} | {
  readonly contributionId: string;
  readonly slot: "user-plugin.details";
  readonly title: string;
  readonly renderer: {
    readonly kind: "worker-rendered-document-v1";
    readonly codeArtifactDigest: string;
    readonly height: number;
  };
} | {
  /** Stable contribution identifier within one manifest. */
  readonly contributionId: string;

  /** Host-owned navigation placement; manifests cannot choose a URL. */
  readonly slot: "user-plugin.navigation";

  /** Human-readable navigation and page title. */
  readonly title: string;

  /** Pure state reducer and closed document renderer executed in a Dynamic Worker. */
  readonly renderer: {
    readonly kind: "worker-interactive-document-v1";
    readonly codeArtifactDigest: string;
  };
};

/** Installation-lifetime state ownership declared independently from runtime capabilities. */
export interface PluginStateDescriptor {
  /** One isolated state object follows one installation until detach and explicit purge. */
  readonly kind: "installation";
}

/** Declarative plugin manifest that can produce an isolated runtime candidate. */
export interface PluginManifestV3 extends PluginManifestBase {
  /** Schema version for the manifest document. */
  readonly schemaVersion: 3;

  /** Packages that must already be active before this package can activate. */
  readonly dependencies: readonly string[];

  /** Immutable runtime artifact selected by this exact package version. */
  readonly runtime: PluginRuntimeDescriptor;
}

/** Runtime plugin manifest with digest-bound Plugin Center UI contributions. */
export interface PluginManifestV4 extends PluginManifestBase {
  /** Schema version for UI-capable packages. */
  readonly schemaVersion: 4;

  /** Packages that must already be active before this package can activate. */
  readonly dependencies: readonly string[];

  /** Immutable runtime artifact selected by this exact package version. */
  readonly runtime: PluginRuntimeDescriptor;

  /** Safe package presentation metadata. */
  readonly presentation: PluginPresentation;

  /** Ordered UI contributions; verification canonicalizes by contribution ID. */
  readonly uiContributions: readonly PluginUiContributionDescriptor[];
}

/** Interactive user plugin manifest with installation-owned state and navigation contributions. */
export interface PluginManifestV5 extends PluginManifestBase {
  /** Schema version for interactive user packages. */
  readonly schemaVersion: 5;

  /** Packages that must already be active before this package can activate. */
  readonly dependencies: readonly string[];

  /** Immutable runtime artifact selected by this exact package version. */
  readonly runtime: PluginRuntimeDescriptor;

  /** Safe package presentation metadata. */
  readonly presentation: PluginPresentation;

  /** Installation-scoped state ownership selected by the trusted host. */
  readonly state: PluginStateDescriptor;

  /** Digest-bound details and navigation contributions. */
  readonly uiContributions: readonly PluginUiContributionDescriptor[];
}

/** Declarative plugin manifest before its immutable bytes and digest are verified. */
export type PluginManifest =
  PluginManifestV1 | PluginManifestV2 | PluginManifestV3 | PluginManifestV4 | PluginManifestV5;

/** An owned immutable plugin manifest with a digest verified by its registry adapter. */
export interface VerifiedPluginManifest extends PluginManifestBase {
  /** Schema version of the canonical source document. */
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5;

  /** Canonical dependency set; schema v1 manifests resolve to an empty set. */
  readonly dependencies: readonly string[];

  /** Verified runtime descriptor; absent for metadata-only schema v1 and v2 manifests. */
  readonly runtime?: PluginRuntimeDescriptor;

  /** Verified presentation metadata for schema v4 packages. */
  readonly presentation?: PluginPresentation;

  /** Verified owned UI contributions for schema v4 packages. */
  readonly uiContributions?: readonly PluginUiContributionDescriptor[];

  /** Verified state ownership for schema v5 packages. */
  readonly state?: PluginStateDescriptor;

  /** SHA-256 digest of the canonical manifest bytes. */
  readonly manifestDigest: string;
}

/** Resolves one exact immutable plugin manifest without exposing its storage implementation. */
export interface PluginManifestResolver {
  /** Returns the exact version, or null when that package version is not in this registry. */
  resolve(pluginId: string, packageVersion: string): Promise<VerifiedPluginManifest | null>;
}

/** Exact resolver plus deterministic enumeration for trusted catalog projections. */
export interface PluginManifestCatalog extends PluginManifestResolver {
  /** Returns immutable verified entries in registry order. */
  list(): Promise<readonly VerifiedPluginManifest[]>;
}

/** Returns whether a verified manifest declares installation state owned only by UserDO. */
export function isUserOnlyPluginManifest(manifest: VerifiedPluginManifest): boolean {
  return manifest.schemaVersion === 5 && manifest.state?.kind === "installation";
}

/** Manifest resolver backed by the immutable entries bundled into one deployment. */
export class BundledPluginManifestResolver implements PluginManifestCatalog {
  readonly #entries: readonly VerifiedPluginManifest[];

  private constructor(entries: readonly VerifiedPluginManifest[]) {
    this.#entries = entries;
  }

  /** Verifies raw bundled manifests and owns immutable snapshots of the results. */
  static async create(entries: readonly PluginManifest[]): Promise<BundledPluginManifestResolver> {
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const duplicate = entries.slice(0, index).some(
        candidate => candidate.pluginId === entry.pluginId &&
          candidate.packageVersion === entry.packageVersion,
      );
      if (duplicate) {
        throw new TypeError(
          `Duplicate bundled plugin manifest: ${entry.pluginId}@${entry.packageVersion}`,
        );
      }
    }
    const verified = await Promise.all(entries.map(verifyPluginManifest));
    return new BundledPluginManifestResolver(Object.freeze(verified));
  }

  async resolve(
      pluginId: string, packageVersion: string): Promise<VerifiedPluginManifest | null> {
    return this.#entries.find(
      entry => entry.pluginId === pluginId && entry.packageVersion === packageVersion,
    ) ?? null;
  }

  async list(): Promise<readonly VerifiedPluginManifest[]> {
    return this.#entries;
  }
}

async function verifyPluginManifest(manifest: PluginManifest): Promise<VerifiedPluginManifest> {
  if (
    manifest.schemaVersion !== 1 &&
    (manifest.dependencies.some(dependency => dependency.trim().length === 0) ||
      new Set(manifest.dependencies).size !== manifest.dependencies.length)
  ) {
    throw new TypeError(
      `Invalid dependencies in ${manifest.pluginId}@${manifest.packageVersion}`,
    );
  }
  if (
    (manifest.schemaVersion === 3 || manifest.schemaVersion === 4 || manifest.schemaVersion === 5) &&
    (manifest.runtime.kind !== "dynamic-worker" ||
      !/^sha256:[0-9a-f]{64}$/.test(manifest.runtime.codeArtifactDigest) ||
      Object.keys(manifest.runtime).some(
        key => key !== "kind" && key !== "codeArtifactDigest",
      ))
  ) {
    throw new TypeError(
      `Invalid runtime descriptor in ${manifest.pluginId}@${manifest.packageVersion}`,
    );
  }
  if (manifest.schemaVersion === 4 || manifest.schemaVersion === 5) {
    if (!isValidPresentation(manifest.presentation)) {
      throw new TypeError(`Invalid presentation in ${manifest.pluginId}@${manifest.packageVersion}`);
    }
    if (!isValidUiContributions(manifest.uiContributions)) {
      throw new TypeError(
        `Invalid UI contributions in ${manifest.pluginId}@${manifest.packageVersion}`,
      );
    }
    if (
      manifest.schemaVersion === 5 && (
        typeof manifest.state !== "object" || manifest.state === null ||
        Array.isArray(manifest.state) || manifest.state.kind !== "installation" ||
        !hasOnlyKeys(manifest.state, ["kind"])
      )
    ) {
      throw new TypeError(`Invalid state descriptor in ${manifest.pluginId}@${manifest.packageVersion}`);
    }
    if (
      manifest.schemaVersion === 5 &&
      manifest.uiContributions.some(contribution =>
        contribution.slot === "user-plugin.navigation" &&
        contribution.renderer.kind === "worker-interactive-document-v1") &&
      !manifest.requestedCapabilities.includes(PLUGIN_UI_STATE_MUTATE_CAPABILITY)
    ) {
      throw new TypeError(
        `Interactive UI capability missing in ${manifest.pluginId}@${manifest.packageVersion}`,
      );
    }
    if (
      manifest.schemaVersion === 4 &&
      manifest.uiContributions.some(contribution => contribution.slot !== "user-plugin.details")
    ) {
      throw new TypeError(
        `Invalid UI contributions in ${manifest.pluginId}@${manifest.packageVersion}`,
      );
    }
  }
  const snapshot: PluginManifest = manifest.schemaVersion === 1
    ? Object.freeze({
      schemaVersion: 1,
      pluginId: manifest.pluginId,
      packageVersion: manifest.packageVersion,
      requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
    })
    : manifest.schemaVersion === 2 ? Object.freeze({
      schemaVersion: 2,
      pluginId: manifest.pluginId,
      packageVersion: manifest.packageVersion,
      requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
      dependencies: Object.freeze([...manifest.dependencies].toSorted()),
    }) : manifest.schemaVersion === 3 ? Object.freeze({
      schemaVersion: 3,
      pluginId: manifest.pluginId,
      packageVersion: manifest.packageVersion,
      requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
      dependencies: Object.freeze([...manifest.dependencies].toSorted()),
      runtime: Object.freeze({
        kind: "dynamic-worker",
        codeArtifactDigest: manifest.runtime.codeArtifactDigest,
      }),
    }) : manifest.schemaVersion === 4 ? Object.freeze({
      schemaVersion: 4,
      pluginId: manifest.pluginId,
      packageVersion: manifest.packageVersion,
      requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
      dependencies: Object.freeze([...manifest.dependencies].toSorted()),
      runtime: Object.freeze({
        kind: "dynamic-worker",
        codeArtifactDigest: manifest.runtime.codeArtifactDigest,
      }),
      presentation: Object.freeze({
        title: manifest.presentation.title,
        summary: manifest.presentation.summary,
      }),
      uiContributions: snapshotUiContributions(manifest.uiContributions),
    }) : Object.freeze({
      schemaVersion: 5,
      pluginId: manifest.pluginId,
      packageVersion: manifest.packageVersion,
      requestedCapabilities: Object.freeze([...manifest.requestedCapabilities]),
      dependencies: Object.freeze([...manifest.dependencies].toSorted()),
      runtime: Object.freeze({
        kind: "dynamic-worker",
        codeArtifactDigest: manifest.runtime.codeArtifactDigest,
      }),
      presentation: Object.freeze({
        title: manifest.presentation.title,
        summary: manifest.presentation.summary,
      }),
      state: Object.freeze({kind: "installation" as const}),
      uiContributions: snapshotUiContributions(manifest.uiContributions),
    });
  const canonical = JSON.stringify(snapshot);
  const canonicalBytes = new TextEncoder().encode(canonical);
  if (canonicalBytes.byteLength > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new RangeError(
      `Plugin manifest exceeds size limit: ${manifest.pluginId}@${manifest.packageVersion}`,
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", canonicalBytes);
  return Object.freeze({
    ...snapshot,
    dependencies: Object.freeze(snapshot.schemaVersion === 1 ? [] : [...snapshot.dependencies]),
    ...(snapshot.schemaVersion === 3 || snapshot.schemaVersion === 4 || snapshot.schemaVersion === 5
      ? {runtime: snapshot.runtime}
      : {}),
    ...(snapshot.schemaVersion === 4 || snapshot.schemaVersion === 5 ? {
      presentation: snapshot.presentation,
      uiContributions: snapshot.uiContributions,
    } : {}),
    ...(snapshot.schemaVersion === 5 ? {state: snapshot.state} : {}),
    manifestDigest: `sha256:${new Uint8Array(digest).toHex()}`,
  });
}

const UI_CONTRIBUTION_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isValidPresentation(value: unknown): value is PluginPresentation {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    hasOnlyKeys(value, ["title", "summary"]) &&
    isBoundedText(Reflect.get(value, "title"), 80) &&
    isBoundedText(Reflect.get(value, "summary"), 240);
}

function isValidDeclarativeDocument(value: unknown): value is DeclarativePluginUiDocument {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    !hasOnlyKeys(value, ["schemaVersion", "blocks"]) ||
    Reflect.get(value, "schemaVersion") !== 1
  ) return false;
  const blocks = Reflect.get(value, "blocks");
  if (!isDenseArray(blocks) || blocks.length > 64) return false;
  return blocks.every(block => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return false;
    const kind = Reflect.get(block, "kind");
    if (kind === "text") {
      return hasOnlyKeys(block, ["kind", "text"]) &&
        isBoundedText(Reflect.get(block, "text"), 2_000);
    }
    if (kind === "notice") {
      const tone = Reflect.get(block, "tone");
      return hasOnlyKeys(block, ["kind", "tone", "text"]) &&
        (tone === "info" || tone === "warning") &&
        isBoundedText(Reflect.get(block, "text"), 2_000);
    }
    if (kind === "list") {
      const items = Reflect.get(block, "items");
      return hasOnlyKeys(block, ["kind", "items"]) && isDenseArray(items) &&
        items.length <= 32 && items.every(item => isBoundedText(item, 256));
    }
    return false;
  });
}

function isValidUiContributions(
    value: unknown): value is readonly PluginUiContributionDescriptor[] {
  if (!isDenseArray(value) || value.length > 16) return false;
  const ids = new Set<string>();
  for (const contribution of value) {
    if (
      typeof contribution !== "object" || contribution === null || Array.isArray(contribution) ||
      !hasOnlyKeys(contribution, ["contributionId", "slot", "title", "renderer"])
    ) return false;
    const id = Reflect.get(contribution, "contributionId");
    if (
      typeof id !== "string" || !UI_CONTRIBUTION_ID.test(id) || ids.has(id) ||
      !isBoundedText(Reflect.get(contribution, "title"), 80)
    ) return false;
    ids.add(id);
    const renderer = Reflect.get(contribution, "renderer");
    if (typeof renderer !== "object" || renderer === null || Array.isArray(renderer)) return false;
    const slot = Reflect.get(contribution, "slot");
    if (slot !== "user-plugin.details" && slot !== "user-plugin.navigation") return false;
    if (Reflect.get(renderer, "kind") === "host-schema-v1") {
      if (
        slot !== "user-plugin.details" ||
        !hasOnlyKeys(renderer, ["kind", "document"]) ||
        !isValidDeclarativeDocument(Reflect.get(renderer, "document"))
      ) return false;
    } else if (Reflect.get(renderer, "kind") === "worker-rendered-document-v1") {
      const height = Reflect.get(renderer, "height");
      if (
        slot !== "user-plugin.details" ||
        !hasOnlyKeys(renderer, ["kind", "codeArtifactDigest", "height"]) ||
        !/^sha256:[0-9a-f]{64}$/.test(Reflect.get(renderer, "codeArtifactDigest")) ||
        !Number.isInteger(height) || height < 120 || height > 800
      ) return false;
    } else if (Reflect.get(renderer, "kind") === "worker-interactive-document-v1") {
      if (
        slot !== "user-plugin.navigation" ||
        !hasOnlyKeys(renderer, ["kind", "codeArtifactDigest"]) ||
        !/^sha256:[0-9a-f]{64}$/.test(Reflect.get(renderer, "codeArtifactDigest"))
      ) return false;
    } else {
      return false;
    }
  }
  return true;
}

function snapshotDeclarativeDocument(
    document: DeclarativePluginUiDocument): DeclarativePluginUiDocument {
  return Object.freeze({
    schemaVersion: 1,
    blocks: Object.freeze(document.blocks.map(block => block.kind === "list"
      ? Object.freeze({kind: "list" as const, items: Object.freeze([...block.items])})
      : block.kind === "notice"
        ? Object.freeze({kind: "notice" as const, tone: block.tone, text: block.text})
        : Object.freeze({kind: "text" as const, text: block.text}))),
  });
}

/** Validates untrusted renderer output and returns an owned immutable closed document. */
export function snapshotPluginUiDocument(
    value: unknown): DeclarativePluginUiDocument | null {
  if (!isValidDeclarativeDocument(value)) return null;
  const snapshot = snapshotDeclarativeDocument(value);
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_PLUGIN_MANIFEST_BYTES) {
    return null;
  }
  return snapshot;
}

function snapshotUiContributions(
    contributions: readonly PluginUiContributionDescriptor[],
): readonly PluginUiContributionDescriptor[] {
  return Object.freeze(contributions.map(
    (contribution): PluginUiContributionDescriptor => {
      if (contribution.renderer.kind === "host-schema-v1") {
        return Object.freeze({
          contributionId: contribution.contributionId,
          slot: "user-plugin.details",
          title: contribution.title,
          renderer: Object.freeze({
        kind: "host-schema-v1" as const,
        document: snapshotDeclarativeDocument(contribution.renderer.document),
          }),
        });
      }
      if (contribution.renderer.kind === "worker-interactive-document-v1") {
        return Object.freeze({
          contributionId: contribution.contributionId,
          slot: "user-plugin.navigation" as const,
          title: contribution.title,
          renderer: Object.freeze({
            kind: "worker-interactive-document-v1" as const,
            codeArtifactDigest: contribution.renderer.codeArtifactDigest,
          }),
        });
      }
      return Object.freeze({
        contributionId: contribution.contributionId,
        slot: "user-plugin.details",
        title: contribution.title,
        renderer: Object.freeze({
          kind: "worker-rendered-document-v1" as const,
          codeArtifactDigest: contribution.renderer.codeArtifactDigest,
          height: contribution.renderer.height,
        }),
      });
    },
  ).toSorted((left, right) => left.contributionId < right.contributionId
    ? -1
    : left.contributionId > right.contributionId ? 1 : 0));
}
