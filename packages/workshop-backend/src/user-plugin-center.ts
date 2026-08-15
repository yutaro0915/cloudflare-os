import type {
  UserPluginCenterView,
  UserPluginUiContribution,
  UserPluginVersionOffer,
} from "@gadgets/workshop-shared/api";
import type {
  UserPluginCenterOwnerSnapshot,
} from "./plugin-installation.js";
import type {
  PluginUiContributionDescriptor,
  VerifiedPluginManifest,
} from "./plugin-manifest-registry.js";

/** Complete trusted inputs for one safe user Plugin Center projection. */
export interface BuildUserPluginCenterViewInput extends UserPluginCenterOwnerSnapshot {
  manifests: readonly VerifiedPluginManifest[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestKey(pluginId: string, packageVersion: string): string {
  return `${pluginId}\0${packageVersion}`;
}

function projectContribution(
    contribution: PluginUiContributionDescriptor): UserPluginUiContribution {
  if (contribution.renderer.kind === "host-schema-v1") {
    return {
      contributionId: contribution.contributionId,
      slot: contribution.slot,
      title: contribution.title,
      kind: "declarative",
      document: {
        schemaVersion: 1,
        blocks: contribution.renderer.document.blocks.map(block => block.kind === "list"
          ? {kind: "list", items: [...block.items]}
          : block.kind === "notice"
            ? {kind: "notice", tone: block.tone, text: block.text}
            : {kind: "text", text: block.text}),
      },
    };
  }
  return {
    contributionId: contribution.contributionId,
    slot: contribution.slot,
    title: contribution.title,
    kind: "worker-rendered",
    height: contribution.renderer.height,
  };
}

function versionOffer(manifest: VerifiedPluginManifest): UserPluginVersionOffer {
  return {
    packageVersion: manifest.packageVersion,
    title: manifest.presentation?.title ?? manifest.pluginId,
    summary: manifest.presentation?.summary ?? "No description provided.",
    requestedCapabilities: [...manifest.requestedCapabilities].toSorted(compareText),
    dependencies: [...manifest.dependencies].toSorted(compareText),
    contributions: [...(manifest.uiContributions ?? [])]
      .toSorted((left, right) => compareText(left.contributionId, right.contributionId))
      .map(projectContribution),
  };
}

function matchingManifest(
    installation: UserPluginCenterOwnerSnapshot["installations"][number],
    manifestsByVersion: ReadonlyMap<string, VerifiedPluginManifest>,
): {manifest: VerifiedPluginManifest | null; availability:
  "available" | "manifest-missing" | "manifest-mismatch"} {
  const manifest = manifestsByVersion.get(
    manifestKey(installation.pluginId, installation.packageVersion),
  );
  if (manifest === undefined) return {manifest: null, availability: "manifest-missing"};
  if (manifest.manifestDigest !== installation.manifestDigest) {
    return {manifest: null, availability: "manifest-mismatch"};
  }
  return {manifest, availability: "available"};
}

/** Joins immutable catalog and owner SSOT into a deterministic authority-free browser view. */
export function buildUserPluginCenterView(
    input: BuildUserPluginCenterViewInput): UserPluginCenterView {
  const manifests = [...input.manifests].toSorted((left, right) =>
    compareText(left.pluginId, right.pluginId) ||
    compareText(left.packageVersion, right.packageVersion));
  const manifestsByVersion = new Map(manifests.map(manifest => [
    manifestKey(manifest.pluginId, manifest.packageVersion),
    manifest,
  ]));
  const offersByPlugin = new Map<string, UserPluginVersionOffer[]>();
  for (const manifest of manifests) {
    const offers = offersByPlugin.get(manifest.pluginId) ?? [];
    offers.push(versionOffer(manifest));
    offersByPlugin.set(manifest.pluginId, offers);
  }
  const installationsByPlugin = new Map(
    input.installations.map(installation => [installation.pluginId, installation]),
  );
  const pluginIds = new Set([...offersByPlugin.keys(), ...installationsByPlugin.keys()]);
  const plugins = [...pluginIds].toSorted(compareText).map(pluginId => {
    const offers = offersByPlugin.get(pluginId) ?? [];
    const installation = installationsByPlugin.get(pluginId);
    const matched = installation === undefined
      ? null
      : matchingManifest(installation, manifestsByVersion);
    const presentation = matched?.manifest?.presentation ??
      (offers.length === 0 ? null : {
        title: offers.at(-1)!.title,
        summary: offers.at(-1)!.summary,
      });
    return {
      pluginId,
      title: presentation?.title ?? pluginId,
      summary: presentation?.summary ?? "Catalog metadata is unavailable.",
      offers,
      installation: installation === undefined ? null : {
        installationId: installation.installationId,
        packageVersion: installation.packageVersion,
        enabled: installation.enabled,
        grantedCapabilities: [...installation.grantedCapabilities].toSorted(compareText),
        hasState: installation.hasState,
        lifecycle: input.uninstallingInstallationIds.includes(installation.installationId)
          ? "uninstalling" as const
          : "installed" as const,
        catalogAvailability: matched!.availability,
        contributions: [...(matched!.manifest?.uiContributions ?? [])]
          .toSorted((left, right) => compareText(left.contributionId, right.contributionId))
          .map(projectContribution),
      },
    };
  });
  const detachedStates = [...input.detachedStates].toSorted((left, right) =>
    right.detachedAt - left.detachedAt || compareText(left.installationId, right.installationId))
    .map(detached => {
      const manifest = manifestsByVersion.get(
        manifestKey(detached.pluginId, detached.packageVersion),
      );
      return {
        installationId: detached.installationId,
        pluginId: detached.pluginId,
        packageVersion: detached.packageVersion,
        detachedAt: detached.detachedAt,
        title: manifest?.manifestDigest === detached.manifestDigest
          ? manifest.presentation?.title ?? detached.pluginId
          : detached.pluginId,
        lifecycle: input.purgingInstallationIds.includes(detached.installationId)
          ? "purging" as const
          : "detached" as const,
      };
    });
  return {plugins, detachedStates};
}
