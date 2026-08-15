import { describe, expect, it } from "vitest";
import {
  resolveEffectivePluginConfiguration,
  type EffectivePluginConfigurationInput,
} from "../src/plugin-effective-configuration.js";
import type {
  DeploymentPluginInstallationRecord,
  UserPluginInstallation,
  WorkspacePluginInstallationRecord,
} from "../src/plugin-installation.js";

function user(pluginId: string, enabled = true): UserPluginInstallation {
  return {
    schemaVersion: 1,
    installationId: `user-${pluginId}`,
    scope: "user",
    targetId: "user-target",
    pluginId,
    packageVersion: "1.0.0",
    manifestDigest: `sha256:${"1".repeat(64)}`,
    enabled,
    grantedCapabilities: ["ui.panel"],
    config: {placement: "sidebar"},
    stateRef: `state-${pluginId}`,
  };
}

function workspace(pluginId: string, enabled = true): WorkspacePluginInstallationRecord {
  return {
    schemaVersion: 1,
    installationId: `workspace-${pluginId}`,
    scope: "workspace",
    targetId: "workspace-target",
    pluginId,
    packageVersion: "2.0.0",
    manifestDigest: `sha256:${"2".repeat(64)}`,
    enabled,
    approvedCapabilities: ["workspace.read"],
    grantedCapabilities: ["workspace.read"],
    config: null,
  };
}

function deployment(pluginId: string, enabled = true): DeploymentPluginInstallationRecord {
  return {
    schemaVersion: 1,
    installationId: `deployment-${pluginId}`,
    scope: "deployment",
    targetId: "deployment-target",
    pluginId,
    packageVersion: "3.0.0",
    manifestDigest: `sha256:${"3".repeat(64)}`,
    enabled,
    grantedCapabilities: ["policy.read"],
    config: null,
  };
}

function input(
    partial: Partial<EffectivePluginConfigurationInput>): EffectivePluginConfigurationInput {
  return {
    deployment: [],
    workspace: [],
    user: [],
    ...partial,
  };
}

describe("effective plugin configuration", () => {
  it("normalizes distinct enabled scopes into deterministic reconciler input", () => {
    expect(resolveEffectivePluginConfiguration(input({
      deployment: [deployment("z.security")],
      workspace: [workspace("a.review")],
      user: [user("m.theme")],
    }))).toEqual({
      ok: true,
      installations: [
        {
          scope: "workspace",
          targetId: "workspace-target",
          installationId: "workspace-a.review",
          pluginId: "a.review",
          packageVersion: "2.0.0",
          manifestDigest: `sha256:${"2".repeat(64)}`,
          grantedCapabilities: ["workspace.read"],
          config: null,
        },
        {
          scope: "user",
          targetId: "user-target",
          installationId: "user-m.theme",
          pluginId: "m.theme",
          packageVersion: "1.0.0",
          manifestDigest: `sha256:${"1".repeat(64)}`,
          grantedCapabilities: ["ui.panel"],
          config: {placement: "sidebar"},
          stateRef: "state-m.theme",
        },
        {
          scope: "deployment",
          targetId: "deployment-target",
          installationId: "deployment-z.security",
          pluginId: "z.security",
          packageVersion: "3.0.0",
          manifestDigest: `sha256:${"3".repeat(64)}`,
          grantedCapabilities: ["policy.read"],
          config: null,
        },
      ],
    });
  });

  for (const [name, conflict] of [
    ["deployment/workspace", input({
      deployment: [deployment("duplicate.plugin")],
      workspace: [workspace("duplicate.plugin")],
    })],
    ["deployment/user", input({
      deployment: [deployment("duplicate.plugin")],
      user: [user("duplicate.plugin")],
    })],
    ["workspace/user", input({
      workspace: [workspace("duplicate.plugin")],
      user: [user("duplicate.plugin")],
    })],
  ] as const) {
    it(`rejects an enabled ${name} duplicate without choosing a version`, () => {
      expect(resolveEffectivePluginConfiguration(conflict)).toEqual({
        ok: false,
        error: "DUPLICATE_ENABLED_PLUGIN_ID",
        conflicts: [{
          pluginId: "duplicate.plugin",
          sources: [
            ...(conflict.deployment.length === 0 ? [] : [{
              scope: "deployment",
              targetId: "deployment-target",
              installationId: "deployment-duplicate.plugin",
            }]),
            ...(conflict.workspace.length === 0 ? [] : [{
              scope: "workspace",
              targetId: "workspace-target",
              installationId: "workspace-duplicate.plugin",
            }]),
            ...(conflict.user.length === 0 ? [] : [{
              scope: "user",
              targetId: "user-target",
              installationId: "user-duplicate.plugin",
            }]),
          ],
        }],
      });
    });
  }

  it("ignores disabled records before duplicate detection", () => {
    expect(resolveEffectivePluginConfiguration(input({
      deployment: [deployment("same.plugin", false)],
      user: [user("same.plugin")],
    }))).toEqual({
      ok: true,
      installations: [{
        scope: "user",
        targetId: "user-target",
        installationId: "user-same.plugin",
        pluginId: "same.plugin",
        packageVersion: "1.0.0",
        manifestDigest: `sha256:${"1".repeat(64)}`,
        grantedCapabilities: ["ui.panel"],
        config: {placement: "sidebar"},
        stateRef: "state-same.plugin",
      }],
    });
  });

  it("uses locale-independent code-unit order for deterministic runtime input", () => {
    const result = resolveEffectivePluginConfiguration(input({
      deployment: [deployment("Z.plugin")],
      user: [user("a.plugin")],
    }));

    expect(result.ok && result.installations.map(installation => installation.pluginId)).toEqual([
      "Z.plugin",
      "a.plugin",
    ]);
  });

  it("reports every conflict deterministically without mutating typed snapshots", () => {
    const snapshots = input({
      deployment: [deployment("z.conflict"), deployment("a.conflict")],
      workspace: [workspace("a.conflict"), workspace("z.conflict")],
      user: [user("z.conflict")],
    });
    const before = structuredClone(snapshots);

    expect(resolveEffectivePluginConfiguration(snapshots)).toEqual({
      ok: false,
      error: "DUPLICATE_ENABLED_PLUGIN_ID",
      conflicts: [
        {
          pluginId: "a.conflict",
          sources: [
            {
              scope: "deployment",
              targetId: "deployment-target",
              installationId: "deployment-a.conflict",
            },
            {
              scope: "workspace",
              targetId: "workspace-target",
              installationId: "workspace-a.conflict",
            },
          ],
        },
        {
          pluginId: "z.conflict",
          sources: [
            {
              scope: "deployment",
              targetId: "deployment-target",
              installationId: "deployment-z.conflict",
            },
            {
              scope: "workspace",
              targetId: "workspace-target",
              installationId: "workspace-z.conflict",
            },
            {
              scope: "user",
              targetId: "user-target",
              installationId: "user-z.conflict",
            },
          ],
        },
      ],
    });
    expect(snapshots).toEqual(before);
  });
});
