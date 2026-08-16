import type {
  InteractUserPluginSurfaceRequest,
  InteractUserPluginSurfaceResult,
  UserPluginInteractiveDocument,
  UserPluginNavigationEntry,
} from "@gadgets/workshop-shared/api";
import type {
  PluginConfigurationValue,
  UserPluginCenterOwnerSnapshot,
  UserPluginInteractiveInstallationSnapshot,
} from "./plugin-installation.js";
import type {
  PluginUiContributionDescriptor,
  VerifiedPluginManifest,
} from "./plugin-manifest-registry.js";
import type {InteractivePluginUiRequest} from "./dynamic-worker-interactive-plugin-ui.js";
import {isValidPluginUiAction} from "./plugin-interactive-ui.js";
import {PLUGIN_UI_STATE_MUTATE_CAPABILITY} from "./plugin-runtime-capabilities.js";

interface VersionedPluginState {
  revision: number;
  value: PluginConfigurationValue | null;
}

type InteractiveContribution = Extract<
  PluginUiContributionDescriptor,
  {slot: "user-plugin.navigation"}
>;

/** Trusted ports used by the user-scoped interactive UI deep module. */
export interface UserPluginInteractiveSurfaceHost {
  /** Authenticated UserDO ID; no caller-supplied target is accepted. */
  readonly userId: string;

  /** Reads one exact current non-revoked stateful lifecycle. */
  readInstallation(
    pluginId: string,
    installationId: string,
  ): Promise<UserPluginInteractiveInstallationSnapshot | null>;

  /** Resolves one exact immutable manifest. */
  resolveManifest(pluginId: string, packageVersion: string): Promise<VerifiedPluginManifest | null>;

  /** Rechecks permanent central policy at every security-sensitive boundary. */
  isManifestDenied(manifestDigest: string): Promise<boolean>;

  /** Reads one host-selected versioned state cell. */
  readState(
    installation: UserPluginInteractiveInstallationSnapshot,
    key: string,
  ): Promise<VersionedPluginState | null>;

  /** Runs a pure interactive artifact without state or host authority. */
  runArtifact(
    codeArtifactDigest: string,
    request: InteractivePluginUiRequest,
  ): Promise<{
    state: PluginConfigurationValue;
    document: UserPluginInteractiveDocument;
  } | null>;

  /** Commits one isolated reducer result atomically. */
  compareAndSetState(
    installation: UserPluginInteractiveInstallationSnapshot,
    key: string,
    expectedRevision: number,
    nextValue: PluginConfigurationValue,
    mutationId: string,
  ): Promise<
    {ok: true; revision: number; replayed: boolean} |
    {ok: false; currentRevision: number} |
    null
  >;
}

function exactInteractiveContribution(
    manifest: VerifiedPluginManifest,
    contributionId: string): InteractiveContribution | null {
  if (manifest.schemaVersion !== 5 || manifest.state?.kind !== "installation") return null;
  const contribution = manifest.uiContributions?.find(candidate =>
    candidate.contributionId === contributionId &&
    candidate.slot === "user-plugin.navigation" &&
    candidate.renderer.kind === "worker-interactive-document-v1");
  return contribution?.slot === "user-plugin.navigation" ? contribution : null;
}

async function remainsCurrent(
    host: UserPluginInteractiveSurfaceHost,
    original: UserPluginInteractiveInstallationSnapshot): Promise<boolean> {
  const [current, denied] = await Promise.all([
    host.readInstallation(original.pluginId, original.installationId),
    host.isManifestDenied(original.manifestDigest),
  ]);
  return current !== null && !denied &&
    current.packageVersion === original.packageVersion &&
    current.manifestDigest === original.manifestDigest &&
    current.stateRef === original.stateRef;
}

/** Projects current navigation contributions from the owner SSOT and verified catalog. */
export async function buildUserPluginNavigation(
    owner: UserPluginCenterOwnerSnapshot,
    manifests: readonly VerifiedPluginManifest[],
    isManifestDenied: (manifestDigest: string) => Promise<boolean>,
): Promise<UserPluginNavigationEntry[]> {
  const uninstalling = new Set(owner.uninstallingInstallationIds);
  const manifestsByKey = new Map(manifests.map(manifest => [
    `${manifest.pluginId}\0${manifest.packageVersion}`,
    manifest,
  ]));
  const entries: UserPluginNavigationEntry[] = [];
  for (const installation of owner.installations) {
    if (
      !installation.enabled || uninstalling.has(installation.installationId) ||
      !installation.grantedCapabilities.includes(PLUGIN_UI_STATE_MUTATE_CAPABILITY)
    ) continue;
    const manifest = manifestsByKey.get(
      `${installation.pluginId}\0${installation.packageVersion}`,
    );
    if (
      manifest === undefined || manifest.manifestDigest !== installation.manifestDigest ||
      manifest.schemaVersion !== 5 || manifest.state?.kind !== "installation" ||
      await isManifestDenied(manifest.manifestDigest)
    ) continue;
    for (const contribution of manifest.uiContributions ?? []) {
      if (
        contribution.slot !== "user-plugin.navigation" ||
        contribution.renderer.kind !== "worker-interactive-document-v1"
      ) continue;
      entries.push({
        pluginId: installation.pluginId,
        installationId: installation.installationId,
        contributionId: contribution.contributionId,
        title: contribution.title,
      });
    }
  }
  return entries.toSorted((left, right) =>
    left.title < right.title ? -1 : left.title > right.title ? 1 :
      left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 :
        left.contributionId < right.contributionId ? -1 :
          left.contributionId > right.contributionId ? 1 : 0);
}

/** Opens or mutates one exact installed navigation contribution through an isolated CAS path. */
export async function interactUserPluginSurface(
    request: InteractUserPluginSurfaceRequest,
    host: UserPluginInteractiveSurfaceHost): Promise<InteractUserPluginSurfaceResult> {
  const unavailable = {ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"} as const;
  const installation = await host.readInstallation(
    request.pluginId,
    request.expectedInstallationId,
  );
  if (installation === null) return unavailable;
  const manifest = await host.resolveManifest(
    installation.pluginId,
    installation.packageVersion,
  );
  if (manifest === null || manifest.manifestDigest !== installation.manifestDigest) {
    return unavailable;
  }
  const contribution = exactInteractiveContribution(manifest, request.contributionId);
  if (contribution === null || await host.isManifestDenied(manifest.manifestDigest)) {
    return unavailable;
  }
  const stateKey = `ui:${contribution.contributionId}`;
  const current = await host.readState(installation, stateKey);
  if (current === null) return unavailable;
  const artifactDigest = contribution.renderer.codeArtifactDigest;
  if (request.interaction.kind === "open") {
    const rendered = await host.runArtifact(artifactDigest, {
      kind: "open",
      state: current.value,
    });
    if (rendered === null || !await remainsCurrent(host, installation)) return unavailable;
    return {
      ok: true,
      revision: current.revision,
      document: rendered.document,
    };
  }
  if (
    !Number.isSafeInteger(request.interaction.expectedRevision) ||
    request.interaction.expectedRevision < 0 ||
    request.interaction.mutationId.length === 0 || request.interaction.mutationId.length > 128 ||
    !isValidPluginUiAction(request.interaction.actionId, request.interaction.input)
  ) return unavailable;
  const reduced = await host.runArtifact(artifactDigest, {
    kind: "action",
    state: current.value,
    revision: current.revision,
    action: {
      actionId: request.interaction.actionId,
      input: request.interaction.input,
    },
  });
  if (reduced === null || !await remainsCurrent(host, installation)) return unavailable;
  const committed = await host.compareAndSetState(
    installation,
    stateKey,
    request.interaction.expectedRevision,
    reduced.state,
    request.interaction.mutationId,
  );
  if (committed === null) return unavailable;
  if (!committed.ok) return {ok: false, error: "PLUGIN_UI_CONFLICT"};
  if (!await remainsCurrent(host, installation)) return unavailable;
  if (!committed.replayed) {
    return {
      ok: true,
      revision: committed.revision,
      document: reduced.document,
    };
  }
  const replayed = await host.readState(installation, stateKey);
  if (replayed === null) return unavailable;
  const rendered = await host.runArtifact(artifactDigest, {kind: "open", state: replayed.value});
  if (rendered === null || !await remainsCurrent(host, installation)) return unavailable;
  return {
    ok: true,
    revision: replayed.revision,
    document: rendered.document,
  };
}
