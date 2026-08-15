import { describe, expect, it } from "vitest";
import type { EffectivePluginInstallation } from "../src/plugin-effective-configuration.js";
import {
  BundledPluginManifestResolver,
  type PluginManifest,
} from "../src/plugin-manifest-registry.js";
import { PluginReconciler } from "../src/plugin-reconciler.js";
import { buildRuntimePluginPlans } from "../src/plugin-runtime-plan.js";

function installation(overrides: Partial<EffectivePluginInstallation> = {}):
    EffectivePluginInstallation {
  return {
    scope: "user",
    targetId: "user-a",
    installationId: "installation-a",
    pluginId: "example.notes",
    packageVersion: "2.0.0",
    manifestDigest: "replaced-by-test",
    grantedCapabilities: ["ui.panel"],
    config: null,
    ...overrides,
  };
}

describe("runtime plugin plan builder", () => {
  it("adds only dependencies from the digest-matched verified manifest", async () => {
    const manifest: PluginManifest = {
      schemaVersion: 3,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      requestedCapabilities: ["ui.panel"],
      dependencies: ["example.storage", "example.auth"],
      runtime: {
        kind: "dynamic-worker",
        codeArtifactDigest: `sha256:${"a".repeat(64)}`,
      },
    };
    const resolver = await BundledPluginManifestResolver.create([manifest]);
    const verified = await resolver.resolve(manifest.pluginId, manifest.packageVersion);

    const result = await buildRuntimePluginPlans([
      installation({manifestDigest: verified!.manifestDigest}),
    ], resolver);

    expect(result).toEqual({
      plans: [{
        installation: installation({manifestDigest: verified!.manifestDigest}),
        dependencies: ["example.auth", "example.storage"],
        runtime: manifest.runtime,
      }],
      preflightFailures: [],
    });
  });

  it("keeps a metadata-only legacy manifest as a local preflight failure", async () => {
    const manifest: PluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      requestedCapabilities: ["ui.panel"],
    };
    const resolver = await BundledPluginManifestResolver.create([manifest]);
    const verified = await resolver.resolve("example.notes", "2.0.0");

    await expect(buildRuntimePluginPlans([
      installation({manifestDigest: verified!.manifestDigest}),
    ], resolver)).resolves.toEqual({
      plans: [],
      preflightFailures: [{
        installation: installation({manifestDigest: verified!.manifestDigest}),
        reason: "RUNTIME_ARTIFACT_NOT_DECLARED",
      }],
    });
  });

  it("keeps manifest failures beside valid plans so unrelated plugins can continue", async () => {
    const validManifest: PluginManifest = {
      schemaVersion: 3,
      pluginId: "example.valid",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies: [],
      runtime: {
        kind: "dynamic-worker",
        codeArtifactDigest: `sha256:${"b".repeat(64)}`,
      },
    };
    const resolver = await BundledPluginManifestResolver.create([validManifest]);
    const verified = await resolver.resolve("example.valid", "1.0.0");

    await expect(buildRuntimePluginPlans([
      installation(),
      installation({
        installationId: "installation-valid",
        pluginId: "example.valid",
        packageVersion: "1.0.0",
        manifestDigest: verified!.manifestDigest,
        grantedCapabilities: [],
      }),
    ], resolver)).resolves.toEqual({
      plans: [{
        installation: installation({
          installationId: "installation-valid",
          pluginId: "example.valid",
          packageVersion: "1.0.0",
          manifestDigest: verified!.manifestDigest,
          grantedCapabilities: [],
        }),
        dependencies: [],
        runtime: validManifest.runtime,
      }],
      preflightFailures: [{
        installation: installation(),
        reason: "MANIFEST_NOT_FOUND",
      }],
    });
  });

  it("reports digest or grant drift as manifest integrity failures", async () => {
    const manifest: PluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      requestedCapabilities: ["ui.panel"],
    };
    const resolver = await BundledPluginManifestResolver.create([manifest]);

    const verified = await resolver.resolve("example.notes", "2.0.0");
    await expect(buildRuntimePluginPlans([
      installation(),
      installation({
        installationId: "installation-grant-drift",
        manifestDigest: verified!.manifestDigest,
        grantedCapabilities: ["ui.panel", "forged.capability"],
      }),
    ], resolver)).resolves.toEqual({
      plans: [],
      preflightFailures: [
        {installation: installation(), reason: "MANIFEST_INTEGRITY_MISMATCH"},
        {
          installation: installation({
            installationId: "installation-grant-drift",
            manifestDigest: verified!.manifestDigest,
            grantedCapabilities: ["ui.panel", "forged.capability"],
          }),
          reason: "MANIFEST_INTEGRITY_MISMATCH",
        },
      ],
    });
  });

  it("passes builder failures directly to the reconciler without dropping desired identity", async () => {
    const resolver = await BundledPluginManifestResolver.create([]);
    const input = await buildRuntimePluginPlans([installation()], resolver);
    const runtimeCalls: string[] = [];
    const reconciler = new PluginReconciler({
      async replace() {
        runtimeCalls.push("replace");
        return "lease";
      },
      async remove() {
        runtimeCalls.push("remove");
      },
    });

    await expect(reconciler.reconcile({ok: true, ...input})).resolves.toEqual({
      ok: true,
      states: [{
        pluginId: "example.notes",
        status: "failed",
        candidate: {
          installationId: "installation-a",
          pluginId: "example.notes",
          packageVersion: "2.0.0",
          manifestDigest: "replaced-by-test",
        },
        reason: "MANIFEST_NOT_FOUND",
      }],
    });
    expect(runtimeCalls).toEqual([]);
  });
});
