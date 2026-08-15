import { exports } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  UserPluginInstallation,
  UserPluginInstallationInput,
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
    const input: UserPluginInstallationInput = callerValue;
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

    await expect(owner.putUserPluginInstallation(input)).resolves.toEqual({ok: true});

    await abortAllDurableObjects();
    owner = exports.UserDurableObject.getByName("plugin-installation-owner");
    otherUser = exports.UserDurableObject.getByName("plugin-installation-other-user");

    await expect(owner.listUserPluginInstallations()).resolves.toEqual([expected]);
    await expect(otherUser.listUserPluginInstallations()).resolves.toEqual([]);
  });

  it("rejects a desired-state record without a content-addressed manifest digest", async () => {
    const owner = exports.UserDurableObject.getByName("plugin-installation-invalid-digest");
    const input: UserPluginInstallationInput = {
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
});
