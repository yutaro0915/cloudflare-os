import { exports } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  UserPluginInstallation,
  PluginInstallationInput,
} from "../src/plugin-installation.js";

describe("user plugin installations", () => {
  it("persists per UserDO across reconstruction without cross-DO storage leakage", async () => {
    let owner = exports.UserDurableObject.getByName("plugin-installation-owner");
    let otherUser = exports.UserDurableObject.getByName("plugin-installation-other-user");
    const callerValue = {
      installationId: "installation-notes-v1",
      pluginId: "example.notes",
      packageVersion: "1.2.3",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      enabled: true,
      grantedCapabilities: ["ui.panel"],
      config: { panel: "right" },
      scope: "workspace",
      targetId: otherUser.id.toString(),
      stateRef: "forged-state-ref",
    };
    const input: PluginInstallationInput = callerValue;
    const expected: UserPluginInstallation = {
      schemaVersion: 1,
      installationId: "installation-notes-v1",
      scope: "user",
      targetId: owner.id.toString(),
      pluginId: "example.notes",
      packageVersion: "1.2.3",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      enabled: true,
      grantedCapabilities: ["ui.panel"],
      config: { panel: "right" },
    };

    await expect(owner.putUserPluginInstallation(input)).resolves.toEqual({
      ok: true,
      installationId: input.installationId,
    });

    await abortAllDurableObjects();
    owner = exports.UserDurableObject.getByName("plugin-installation-owner");
    otherUser = exports.UserDurableObject.getByName("plugin-installation-other-user");

    await expect(owner.listUserPluginInstallations()).resolves.toEqual([expected]);
    await expect(otherUser.listUserPluginInstallations()).resolves.toEqual([]);
  });

  it("rejects a desired-state record without a content-addressed manifest digest", async () => {
    const owner = exports.UserDurableObject.getByName("plugin-installation-invalid-digest");
    const input: PluginInstallationInput = {
      installationId: "installation-invalid-digest",
      pluginId: "example.invalid-digest",
      packageVersion: "1.0.0",
      manifestDigest: "latest",
      enabled: true,
      grantedCapabilities: [],
      config: null,
    };

    await expect(owner.putUserPluginInstallation(input)).resolves.toEqual({
      ok: false,
      error: "INVALID_MANIFEST_DIGEST",
    });
    await expect(owner.listUserPluginInstallations()).resolves.toEqual([]);
  });

  it("appends a host-owned audit event for every desired-state upsert", async () => {
    let owner = exports.UserDurableObject.getByName("plugin-installation-audit-owner");
    const first: PluginInstallationInput = {
      installationId: "installation-notes-v1",
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      enabled: true,
      grantedCapabilities: ["ui.panel"],
      config: null,
    };
    const second: PluginInstallationInput = {
      ...first,
      installationId: "installation-notes-v2",
      packageVersion: "2.0.0",
      manifestDigest: `sha256:${"b".repeat(64)}`,
      grantedCapabilities: ["ui.panel", "agent.catalog.read"],
    };

    await expect(owner.putUserPluginInstallation(first)).resolves.toEqual({
      ok: true,
      installationId: first.installationId,
    });
    await expect(owner.putUserPluginInstallation(second)).resolves.toEqual({
      ok: true,
      installationId: first.installationId,
    });

    await abortAllDurableObjects();
    owner = exports.UserDurableObject.getByName("plugin-installation-audit-owner");

    const events = await owner.listUserPluginAuditEvents();
    expect(events).toMatchObject([
      {
        schemaVersion: 1,
        sequence: 0,
        action: "PLUGIN_DESIRED_STATE_PUT",
        actorUserId: owner.id.toString(),
        scope: "user",
        targetId: owner.id.toString(),
        installationId: first.installationId,
        pluginId: first.pluginId,
        packageVersion: first.packageVersion,
        manifestDigest: first.manifestDigest,
        enabled: true,
        grantedCapabilities: first.grantedCapabilities,
        recordedAt: expect.any(Number),
      },
      {
        schemaVersion: 1,
        sequence: 1,
        action: "PLUGIN_DESIRED_STATE_PUT",
        actorUserId: owner.id.toString(),
        scope: "user",
        targetId: owner.id.toString(),
        installationId: first.installationId,
        pluginId: second.pluginId,
        packageVersion: second.packageVersion,
        manifestDigest: second.manifestDigest,
        enabled: true,
        grantedCapabilities: second.grantedCapabilities,
        recordedAt: expect.any(Number),
      },
    ]);
    expect(events[0]).not.toHaveProperty("config");
    await expect(owner.listUserPluginInstallations()).resolves.toMatchObject([
      {installationId: first.installationId, packageVersion: second.packageVersion},
    ]);
  });

  it("revokes before detach and preserves installation state across reconstruction", async () => {
    let owner = exports.UserDurableObject.getByName("plugin-uninstall-owner");
    const input: PluginInstallationInput = {
      installationId: "installation-stateful-v1",
      pluginId: "example.stateful",
      packageVersion: "1.0.0",
      manifestDigest: `sha256:${"c".repeat(64)}`,
      enabled: true,
      grantedCapabilities: ["plugin.state.read"],
      config: null,
    };
    await expect(owner.putUserPluginInstallation(input)).resolves.toEqual({
      ok: true,
      installationId: input.installationId,
    });
    const [installed] = await owner.listUserPluginInstallations();
    if (installed?.stateRef === undefined) throw new Error("Expected host-managed stateRef.");
    const state = exports.PluginStateDurableObject.get(
      exports.PluginStateDurableObject.idFromString(installed.stateRef),
    );
    const stateOwner = {
      scope: "user" as const,
      targetId: owner.id.toString(),
      pluginId: input.pluginId,
      installationId: input.installationId,
    };
    await state.putForHost(stateOwner, "marker", {present: true});
    await expect(state.read({...stateOwner, targetId: "forged-user"}, "marker"))
      .rejects.toThrow("Plugin state owner mismatch");

    await expect(owner.beginUserPluginUninstall(
      input.pluginId,
      input.installationId,
    )).resolves.toEqual({
      ok: true,
      installationId: input.installationId,
    });
    await expect(owner.readUserPluginInstallationsSnapshotForRuntimeHost()).resolves.toEqual([]);
    await expect(owner.authorizePluginCapabilityForRuntimeHost({
      scope: "user",
      targetId: owner.id.toString(),
      installationId: input.installationId,
      pluginId: input.pluginId,
      manifestDigest: input.manifestDigest,
      capability: "plugin.state.read",
      phase: "active",
    })).resolves.toBe(false);
    await expect(owner.finalizeUserPluginUninstall(input.installationId)).resolves.toEqual({
      ok: true,
      installationId: input.installationId,
      retainedState: true,
    });

    await abortAllDurableObjects();
    owner = exports.UserDurableObject.getByName("plugin-uninstall-owner");
    await expect(owner.listUserPluginInstallations()).resolves.toEqual([]);
    await expect(owner.listDetachedUserPluginStatesForHost()).resolves.toMatchObject([{
      installationId: input.installationId,
      pluginId: input.pluginId,
      stateRef: installed.stateRef,
    }]);
    const reconstructedState = exports.PluginStateDurableObject.get(
      exports.PluginStateDurableObject.idFromString(installed.stateRef),
    );
    await expect(reconstructedState.read(stateOwner, "marker"))
      .resolves.toEqual({present: true});
    const uninstallEvents = (await owner.listUserPluginAuditEvents())
      .filter(event => event.action === "PLUGIN_UNINSTALLED");
    expect(uninstallEvents).toHaveLength(1);
    await expect(owner.finalizeUserPluginUninstall(input.installationId)).resolves.toEqual({
      ok: true,
      installationId: input.installationId,
      retainedState: true,
    });
    expect((await owner.listUserPluginAuditEvents())
      .filter(event => event.action === "PLUGIN_UNINSTALLED")).toHaveLength(1);

    const replacement: PluginInstallationInput = {
      ...input,
      installationId: "installation-stateful-v2",
    };
    await expect(owner.putUserPluginInstallation(replacement)).resolves.toEqual({
      ok: true,
      installationId: replacement.installationId,
    });
    const [reinstalled] = await owner.listUserPluginInstallations();
    expect(reinstalled?.installationId).toBe(replacement.installationId);
    expect(reinstalled?.stateRef).not.toBe(installed.stateRef);
    await expect(owner.finalizeUserPluginUninstall(input.installationId)).resolves.toEqual({
      ok: true,
      installationId: input.installationId,
      retainedState: true,
    });
    await expect(owner.listUserPluginInstallations()).resolves.toMatchObject([{
      installationId: replacement.installationId,
    }]);
  });
});
