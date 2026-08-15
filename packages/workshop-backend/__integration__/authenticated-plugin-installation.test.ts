import { exports } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const MANIFEST_DIGEST =
  "sha256:c5ba5566a2a255b6a106f7d64fac442589da19e32fa0212b12e2f67e278fc75f";
const UPDATED_MANIFEST_DIGEST =
  "sha256:00504a35886ec267d7b82fe5dbe961c0619fdfe7c15f72991d30ee53379f5796";

function username(prefix: string): string {
  return prefix + crypto.randomUUID().replaceAll("-", "");
}

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function createAccount(
    publicApi: RpcStub<PublicApi>, prefix: string): Promise<{username: string; token: string}> {
  const name = username(prefix);
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return {username: name, token};
}

describe("authenticated user plugin installation", () => {
  it("resolves an exact manifest and persists host-derived desired state with audit", async () => {
    using publicApi = await connect();
    const ownerAccount = await createAccount(publicApi, "pluginowner");
    const otherAccount = await createAccount(publicApi, "pluginother");
    using authenticated = await publicApi.authenticate(ownerAccount.token);

    const result = await authenticated.installUserPlugin({
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      approvedCapabilities: ["agent.catalog.read", "ui.panel"],
    });

    expect(result).toMatchObject({ok: true, installationId: expect.any(String)});
    if (!result.ok) throw new Error("Expected plugin installation to succeed.");

    await abortAllDurableObjects();
    const owner = exports.UserDurableObject.getByName(ownerAccount.username);
    const other = exports.UserDurableObject.getByName(otherAccount.username);
    const expected = {
      schemaVersion: 1,
      installationId: result.installationId,
      scope: "user",
      targetId: owner.id.toString(),
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      manifestDigest: MANIFEST_DIGEST,
      enabled: true,
      grantedCapabilities: ["ui.panel", "agent.catalog.read"],
      config: null,
    };
    await expect(owner.listUserPluginInstallations()).resolves.toEqual([expected]);
    await expect(other.listUserPluginInstallations()).resolves.toEqual([]);
    await expect(owner.listUserPluginAuditEvents()).resolves.toMatchObject([
      {
        installationId: result.installationId,
        pluginId: "test.notes",
        packageVersion: "1.2.3",
        manifestDigest: MANIFEST_DIGEST,
        grantedCapabilities: ["ui.panel", "agent.catalog.read"],
      },
    ]);
  });

  it("rejects an unknown exact plugin version without persistence", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "pluginmissing");
    using authenticated = await publicApi.authenticate(account.token);

    await expect(authenticated.installUserPlugin({
      pluginId: "test.notes",
      packageVersion: "9.9.9",
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
    })).resolves.toEqual({ok: false, error: "PLUGIN_VERSION_NOT_FOUND"});

    const owner = exports.UserDurableObject.getByName(account.username);
    await expect(owner.listUserPluginInstallations()).resolves.toEqual([]);
    await expect(owner.listUserPluginAuditEvents()).resolves.toEqual([]);
  });

  it("retains the installation lifecycle identity across an explicit version update", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "pluginupdate");
    using authenticated = await publicApi.authenticate(account.token);
    const first = await authenticated.installUserPlugin({
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
    });
    if (!first.ok) throw new Error("Expected initial plugin installation to succeed.");

    await expect(authenticated.installUserPlugin({
      pluginId: "test.notes",
      packageVersion: "1.3.0",
      approvedCapabilities: ["ui.panel"],
    })).resolves.toEqual({ok: true, installationId: first.installationId});

    const owner = exports.UserDurableObject.getByName(account.username);
    await expect(owner.listUserPluginInstallations()).resolves.toMatchObject([{
      installationId: first.installationId,
      packageVersion: "1.3.0",
      manifestDigest: UPDATED_MANIFEST_DIGEST,
    }]);
  });

  it("rejects missing, extra, or duplicate capability approvals without persistence", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "plugincapabilities");
    using authenticated = await publicApi.authenticate(account.token);

    for (const approvedCapabilities of [
      ["ui.panel"],
      ["ui.panel", "agent.catalog.read", "workspace.write"],
      ["ui.panel", "agent.catalog.read", "ui.panel"],
    ]) {
      await expect(authenticated.installUserPlugin({
        pluginId: "test.notes",
        packageVersion: "1.2.3",
        approvedCapabilities,
      })).resolves.toEqual({ok: false, error: "CAPABILITY_APPROVAL_MISMATCH"});
    }

    const owner = exports.UserDurableObject.getByName(account.username);
    await expect(owner.listUserPluginInstallations()).resolves.toEqual([]);
    await expect(owner.listUserPluginAuditEvents()).resolves.toEqual([]);
  });

  it("uninstalls through the authenticated self-user boundary without exposing state refs", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "pluginuninstall");
    using authenticated = await publicApi.authenticate(account.token);
    const installed = await authenticated.installUserPlugin({
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
    });
    if (!installed.ok) throw new Error("Expected plugin installation to succeed.");

    const ownerBeforeRestart = exports.UserDurableObject.getByName(account.username);
    await expect(ownerBeforeRestart.beginUserPluginUninstall(
      "test.notes",
      installed.installationId,
    )).resolves.toEqual({
      ok: true,
      installationId: installed.installationId,
    });
    await abortAllDurableObjects();
    using recoveredAuthenticated = await publicApi.authenticate(account.token);

    await expect(recoveredAuthenticated.uninstallUserPlugin({
      pluginId: "test.notes",
      expectedInstallationId: installed.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: installed.installationId,
      retainedState: false,
    });
    await expect(recoveredAuthenticated.uninstallUserPlugin({
      pluginId: "test.notes",
      expectedInstallationId: installed.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: installed.installationId,
      retainedState: false,
    });
    await expect(recoveredAuthenticated.listDetachedUserPluginStates()).resolves.toEqual([]);

    const reinstalled = await recoveredAuthenticated.installUserPlugin({
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
    });
    if (!reinstalled.ok) throw new Error("Expected replacement installation to succeed.");
    expect(reinstalled.installationId).not.toBe(installed.installationId);
    await expect(recoveredAuthenticated.uninstallUserPlugin({
      pluginId: "test.notes",
      expectedInstallationId: "unrelated-stale-installation",
    })).resolves.toEqual({ok: false, error: "INSTALLATION_CHANGED"});
    await expect(recoveredAuthenticated.uninstallUserPlugin({
      pluginId: "test.notes",
      expectedInstallationId: installed.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: installed.installationId,
      retainedState: false,
    });
    const currentOwner = exports.UserDurableObject.getByName(account.username);
    await expect(currentOwner.listUserPluginInstallations()).resolves.toMatchObject([{
      installationId: reinstalled.installationId,
    }]);

    await abortAllDurableObjects();
    const owner = exports.UserDurableObject.getByName(account.username);
    await expect(owner.readUserPluginInstallationsSnapshotForRuntimeHost()).resolves.toMatchObject([{
      installationId: reinstalled.installationId,
    }]);
    expect((await owner.listUserPluginAuditEvents())
      .filter(event => event.action === "PLUGIN_UNINSTALLED")).toHaveLength(1);
  });
});
