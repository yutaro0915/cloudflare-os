import { describe, expect, it } from "vitest";
import { BundledPluginManifestResolver } from "../src/plugin-manifest-registry.js";
import { buildUserPluginCenterView } from "../src/user-plugin-center.js";

describe("user plugin center projector", () => {
  it("joins catalog and owner state deterministically without internal authority fields", async () => {
    const manifests = await BundledPluginManifestResolver.create([{
      schemaVersion: 4,
      pluginId: "a.ui",
      packageVersion: "1.0.0",
      requestedCapabilities: ["plugin.state.read"],
      dependencies: [],
      runtime: {
        kind: "dynamic-worker",
        codeArtifactDigest: `sha256:${"a".repeat(64)}`,
      },
      presentation: {title: "A UI", summary: "UI package"},
      uiContributions: [{
        contributionId: "details",
        slot: "user-plugin.details",
        title: "Details",
        renderer: {
          kind: "host-schema-v1",
          document: {schemaVersion: 1, blocks: [{kind: "text", text: "Safe text"}]},
        },
      }, {
        contributionId: "sandbox",
        slot: "user-plugin.details",
        title: "Sandbox",
        renderer: {
          kind: "worker-rendered-document-v1",
          codeArtifactDigest: `sha256:${"b".repeat(64)}`,
          height: 240,
        },
      }],
    }, {
      schemaVersion: 1,
      pluginId: "Z.metadata",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
    }]);
    const aManifest = await manifests.resolve("a.ui", "1.0.0");
    if (aManifest === null) throw new Error("Expected verified manifest.");
    const installations = [{
      installationId: "installed-a",
      pluginId: "a.ui",
      packageVersion: "1.0.0",
      manifestDigest: aManifest.manifestDigest,
      enabled: true,
      grantedCapabilities: ["plugin.state.read"],
      hasState: true,
    }, {
      installationId: "installed-orphan",
      pluginId: "m.orphan",
      packageVersion: "9.0.0",
      manifestDigest: `sha256:${"f".repeat(64)}`,
      enabled: true,
      grantedCapabilities: [],
      hasState: false,
    }];
    const detachedStates = [{
      installationId: "detached-new",
      pluginId: "a.ui",
      packageVersion: "1.0.0",
      manifestDigest: aManifest.manifestDigest,
      detachedAt: 20,
    }, {
      installationId: "detached-old",
      pluginId: "m.orphan",
      packageVersion: "8.0.0",
      manifestDigest: `sha256:${"e".repeat(64)}`,
      detachedAt: 10,
    }];

    const view = buildUserPluginCenterView({
      manifests: await manifests.list(),
      installations,
      uninstallingInstallationIds: ["installed-orphan"],
      detachedStates,
      purgingInstallationIds: ["detached-new"],
    });

    expect(view.plugins.map(plugin => plugin.pluginId)).toEqual([
      "Z.metadata",
      "a.ui",
      "m.orphan",
    ]);
    expect(view.plugins[1]).toMatchObject({
      title: "A UI",
      offers: [{
        contributions: [{kind: "declarative"}, {kind: "worker-rendered", height: 240}],
      }],
      installation: {
        installationId: "installed-a",
        lifecycle: "installed",
        catalogAvailability: "available",
        hasState: true,
        contributions: [{kind: "declarative"}, {kind: "worker-rendered"}],
      },
    });
    expect(view.plugins[2]).toMatchObject({
      title: "m.orphan",
      offers: [],
      installation: {
        lifecycle: "uninstalling",
        catalogAvailability: "manifest-missing",
        contributions: [],
      },
    });
    expect(view.detachedStates).toEqual([{
      installationId: "detached-new",
      pluginId: "a.ui",
      packageVersion: "1.0.0",
      detachedAt: 20,
      title: "A UI",
      lifecycle: "purging",
    }, {
      installationId: "detached-old",
      pluginId: "m.orphan",
      packageVersion: "8.0.0",
      detachedAt: 10,
      title: "m.orphan",
      lifecycle: "detached",
    }]);

    const serialized = JSON.stringify(view);
    for (const forbidden of [
      "stateRef", "manifestDigest", "codeArtifactDigest", "targetId", "scope", "config",
      "sha256:",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const mismatchView = buildUserPluginCenterView({
      manifests: await manifests.list(),
      installations: installations.map(installation => installation.pluginId === "a.ui"
        ? {...installation, manifestDigest: `sha256:${"c".repeat(64)}`}
        : installation),
      uninstallingInstallationIds: ["installed-orphan"],
      detachedStates,
      purgingInstallationIds: ["detached-new"],
    });
    expect(mismatchView.plugins.find(plugin => plugin.pluginId === "a.ui")?.installation)
      .toMatchObject({catalogAvailability: "manifest-mismatch", contributions: []});
  });
});
