import { describe, expect, it } from "vitest";
import {
  isPluginRuntimeCapabilityAuthorized,
  isPluginRuntimeCandidateCurrent,
  type UserPluginInstallation,
} from "../src/plugin-installation.js";

const CURRENT: UserPluginInstallation = {
  schemaVersion: 1,
  scope: "user",
  targetId: "user-a",
  installationId: "installation-a",
  pluginId: "example.runtime",
  packageVersion: "2.0.0",
  manifestDigest: `sha256:${"b".repeat(64)}`,
  enabled: true,
  grantedCapabilities: ["workspace.metadata.read"],
  config: null,
};

describe("plugin runtime owner authorization", () => {
  it("keeps a retained active version authorized while its current lifecycle keeps the grant", () => {
    expect(isPluginRuntimeCapabilityAuthorized(CURRENT, {
      scope: "user",
      targetId: "user-a",
      installationId: "installation-a",
      pluginId: "example.runtime",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      capability: "workspace.metadata.read",
      phase: "active",
    })).toBe(true);
  });

  it("requires an exact digest while staged and the current grant in every phase", () => {
    const base = {
      scope: "user" as const,
      targetId: "user-a",
      installationId: "installation-a",
      pluginId: "example.runtime",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      capability: "workspace.metadata.read",
    };
    expect(isPluginRuntimeCapabilityAuthorized(CURRENT, {...base, phase: "staged"}))
      .toBe(false);
    expect(isPluginRuntimeCapabilityAuthorized(
      {...CURRENT, grantedCapabilities: []},
      {...base, phase: "active"},
    )).toBe(false);
  });

  it("requires the staged candidate to equal the owner's complete current definition", () => {
    const candidate = {
      scope: CURRENT.scope,
      targetId: CURRENT.targetId,
      installationId: CURRENT.installationId,
      pluginId: CURRENT.pluginId,
      packageVersion: CURRENT.packageVersion,
      manifestDigest: CURRENT.manifestDigest,
      grantedCapabilities: CURRENT.grantedCapabilities,
      config: CURRENT.config,
    };

    expect(isPluginRuntimeCandidateCurrent(CURRENT, candidate)).toBe(true);
    expect(isPluginRuntimeCandidateCurrent(CURRENT, {
      ...candidate,
      packageVersion: "1.0.0",
    })).toBe(false);
    expect(isPluginRuntimeCandidateCurrent(CURRENT, {
      ...candidate,
      config: {mode: "forged"},
    })).toBe(false);
  });
});
