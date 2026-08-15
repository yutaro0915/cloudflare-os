import {describe, expect, it, vi} from "vitest";
import type {OpenUserPluginUiFrameHost} from "../src/open-user-plugin-ui-frame.js";
import {openUserPluginUiFrame} from "../src/open-user-plugin-ui-frame.js";
import type {VerifiedPluginManifest} from "../src/plugin-manifest-registry.js";

const MANIFEST_DIGEST = `sha256:${"a".repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}`;
const installation = {
  installationId: "installation-1",
  pluginId: "example.ui",
  packageVersion: "1.0.0",
  manifestDigest: MANIFEST_DIGEST,
};
const manifest: VerifiedPluginManifest = {
  schemaVersion: 4,
  pluginId: installation.pluginId,
  packageVersion: installation.packageVersion,
  requestedCapabilities: [],
  dependencies: [],
  runtime: {kind: "dynamic-worker", codeArtifactDigest: ARTIFACT_DIGEST},
  presentation: {title: "Example", summary: "Example UI"},
  uiContributions: [{
    contributionId: "sandbox",
    slot: "user-plugin.details",
    title: "Sandbox",
    renderer: {kind: "worker-rendered-document-v1", codeArtifactDigest: ARTIFACT_DIGEST, height: 240},
  }],
  manifestDigest: MANIFEST_DIGEST,
};

describe("openUserPluginUiFrame", () => {
  it("rejects a manifest denied while artifact I/O is pending", async () => {
    let denied = false;
    let releaseArtifact: (() => void) | undefined;
    const artifactReady = new Promise<void>(resolve => { releaseArtifact = resolve; });
    const host: OpenUserPluginUiFrameHost = {
      readInstallation: vi.fn(async () => installation),
      resolveManifest: vi.fn(async () => manifest),
      isManifestDenied: vi.fn(async () => denied),
      renderArtifact: vi.fn(async () => {
        await artifactReady;
        return Object.freeze({
          schemaVersion: 1 as const,
          blocks: Object.freeze([{kind: "text" as const, text: "Rendered"}]),
        });
      }),
    };

    const pending = openUserPluginUiFrame({
      pluginId: installation.pluginId,
      expectedInstallationId: installation.installationId,
      contributionId: "sandbox",
    }, host);
    await vi.waitFor(() => expect(host.renderArtifact).toHaveBeenCalledOnce());
    denied = true;
    releaseArtifact!();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: "PLUGIN_UI_NOT_AVAILABLE",
    });
    expect(host.isManifestDenied).toHaveBeenCalledTimes(2);
  });
});
