import { describe, expect, it } from "vitest";
import {
  decodeDeploymentPluginInstallationSnapshot,
  decodePluginRuntimePolicySnapshot,
  decodeUserPluginInstallationSnapshot,
} from "../src/plugin-installation.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function record() {
  return {
    schemaVersion: 1,
    scope: "user",
    targetId: "user-a",
    installationId: "installation-a",
    pluginId: "example.runtime",
    packageVersion: "1.0.0",
    manifestDigest: DIGEST,
    enabled: true,
    grantedCapabilities: ["ui.panel"],
    config: {mode: "safe"},
  };
}

describe("plugin installation runtime snapshots", () => {
  it("owns a validated user snapshot and rejects forged owner targets", () => {
    const source = record();
    const decoded = decodeUserPluginInstallationSnapshot([source], "user-a");

    source.grantedCapabilities.push("forged.capability");
    source.config.mode = "forged";
    expect(decoded).toEqual([record()]);
    expect(() => decodeUserPluginInstallationSnapshot(
      [{...record(), targetId: "user-b"}],
      "user-a",
    )).toThrow("Invalid user plugin installation record");
  });

  it("validates deployment scope and target without inferring ownership", () => {
    const deployment = {
      ...record(),
      scope: "deployment",
      targetId: "admin-settings",
    };

    expect(decodeDeploymentPluginInstallationSnapshot(
      [deployment],
      "admin-settings",
    )).toMatchObject([{scope: "deployment", targetId: "admin-settings"}]);
    expect(() => decodeDeploymentPluginInstallationSnapshot(
      [{...deployment, scope: "user"}],
      "admin-settings",
    )).toThrow("Invalid deployment plugin installation record");
  });

  it("validates an atomic deployment policy snapshot and canonical permanent denylist", () => {
    const deployment = {
      ...record(),
      scope: "deployment",
      targetId: "admin-settings",
    };
    expect(decodePluginRuntimePolicySnapshot({
      installations: [deployment],
      deniedManifestDigests: [DIGEST],
    }, "admin-settings")).toMatchObject({
      deployment: [{scope: "deployment"}],
      deniedManifestDigests: [DIGEST],
    });
    for (const deniedManifestDigests of [[DIGEST, DIGEST], ["bad-digest"]]) {
      expect(() => decodePluginRuntimePolicySnapshot({
        installations: [deployment],
        deniedManifestDigests,
      }, "admin-settings")).toThrow("Invalid plugin runtime policy snapshot");
    }
  });

  it("rejects non-JSON-safe, cyclic, and oversized configuration", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const oversized = Array.from({length: 10_001}, () => null);

    for (const config of [NaN, -0, cyclic, oversized]) {
      expect(() => decodeUserPluginInstallationSnapshot(
        [{...record(), config}],
        "user-a",
      )).toThrow("Invalid user plugin installation record");
    }
  });

  it("rejects sparse arrays and arrays with non-index properties at every boundary", () => {
    const sparseSnapshot: unknown[] = [];
    sparseSnapshot.length = 1;
    const sparseGrants: unknown[] = [];
    sparseGrants.length = 1;
    const sparseConfig: unknown[] = [];
    sparseConfig.length = 1;
    const decoratedConfig: unknown[] = [null];
    Reflect.set(decoratedConfig, "extra", true);

    expect(() => decodeUserPluginInstallationSnapshot(sparseSnapshot, "user-a"))
      .toThrow("User plugin snapshot must be a dense array");
    for (const value of [
      {...record(), grantedCapabilities: sparseGrants},
      {...record(), config: sparseConfig},
      {...record(), config: decoratedConfig},
    ]) {
      expect(() => decodeUserPluginInstallationSnapshot([value], "user-a"))
        .toThrow("Invalid user plugin installation record");
    }
  });
});
