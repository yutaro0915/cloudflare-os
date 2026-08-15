import type {
  OpenUserPluginUiFrameRequest,
  OpenUserPluginUiFrameResult,
} from "@gadgets/workshop-shared/api";
import type {UserPluginUiInstallationSnapshot} from "./plugin-installation.js";
import type {
  DeclarativePluginUiDocument,
  VerifiedPluginManifest,
} from "./plugin-manifest-registry.js";
import {buildUserPluginUiFrameHtml} from "./user-plugin-ui-frame.js";

/** Trusted host ports needed to authorize and materialize one display-only plugin frame. */
export interface OpenUserPluginUiFrameHost {
  /** Reads the exact current enabled and non-revoked owner lifecycle. */
  readInstallation(
    pluginId: string,
    expectedInstallationId: string,
  ): Promise<UserPluginUiInstallationSnapshot | null>;

  /** Resolves the exact immutable manifest selected by owner desired state. */
  resolveManifest(pluginId: string, packageVersion: string): Promise<VerifiedPluginManifest | null>;

  /** Rechecks the permanent deployment policy at each security-sensitive boundary. */
  isManifestDenied(manifestDigest: string): Promise<boolean>;

  /** Executes the exact verified UI artifact in a resource-limited Dynamic Worker. */
  renderArtifact(codeArtifactDigest: string): Promise<DeclarativePluginUiDocument | null>;
}

/** Opens a frame only after both owner lifecycle and central policy survive artifact I/O. */
export async function openUserPluginUiFrame(
  request: OpenUserPluginUiFrameRequest,
  host: OpenUserPluginUiFrameHost,
): Promise<OpenUserPluginUiFrameResult> {
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
  const contribution = manifest.uiContributions?.find(candidate =>
    candidate.contributionId === request.contributionId &&
    candidate.renderer.kind === "worker-rendered-document-v1");
  if (contribution === undefined || contribution.renderer.kind !== "worker-rendered-document-v1") {
    return unavailable;
  }
  if (await host.isManifestDenied(manifest.manifestDigest)) return unavailable;
  let document: DeclarativePluginUiDocument | null;
  try {
    document = await host.renderArtifact(contribution.renderer.codeArtifactDigest);
  } catch {
    return unavailable;
  }
  if (document === null) return unavailable;
  const [current, currentlyDenied] = await Promise.all([
    host.readInstallation(request.pluginId, request.expectedInstallationId),
    host.isManifestDenied(manifest.manifestDigest),
  ]);
  if (
    current === null || current.manifestDigest !== installation.manifestDigest ||
    current.packageVersion !== installation.packageVersion || currentlyDenied
  ) return unavailable;
  return {
    ok: true,
    frame: {
      title: contribution.title,
      iframeHtml: buildUserPluginUiFrameHtml(document),
      height: contribution.renderer.height,
    },
  };
}
