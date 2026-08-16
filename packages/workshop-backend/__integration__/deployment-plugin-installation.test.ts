import { exports } from "cloudflare:workers";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { beforeEach, describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const ADMIN_USERNAME = "deploymentpluginadmin";
const REJECT_ADMIN_USERNAME = "deploymentpluginrejectadmin";
const DENYLIST_ADMIN_USERNAME = "deploymentplugindenylistadmin";
const DENY_RUNTIME_ADMIN_USERNAME = "deploymentplugindenyruntimeadmin";
const V1_MANIFEST_DIGEST =
  "sha256:c5ba5566a2a255b6a106f7d64fac442589da19e32fa0212b12e2f67e278fc75f";
const V2_MANIFEST_DIGEST =
  "sha256:00504a35886ec267d7b82fe5dbe961c0619fdfe7c15f72991d30ee53379f5796";
const RUNTIME_MANIFEST_DIGEST =
  "sha256:0f1b7e5e7ebb0f571257dfa312ddec6c57ee6a32c3f0da81c31c0c6648a0203b";

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
    publicApi: RpcStub<PublicApi>, name: string): Promise<{username: string; token: string}> {
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return {username: name, token};
}

beforeEach(async () => {
  await reset();
});

describe("deployment plugin installations", () => {
  it("rejects a user-navigation plugin before deployment desired state changes", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, REJECT_ADMIN_USERNAME);
    using authenticated = await publicApi.authenticate(account.token);
    using admin = await authenticated.getAdminApi();
    if (admin === null) throw new Error("Expected the configured admin capability.");

    await expect(admin.installDeploymentPlugin({
      pluginId: "test.kanban",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.ui.state.mutate"],
    })).resolves.toEqual({ok: false, error: "PLUGIN_SCOPE_NOT_SUPPORTED"});
    await expect(admin.installDeploymentPlugin({
      pluginId: "test.state-only",
      packageVersion: "1.0.0",
      approvedCapabilities: [],
    })).resolves.toEqual({ok: false, error: "PLUGIN_SCOPE_NOT_SUPPORTED"});
    const host = exports.AdminSettings.getByName("");
    await expect(host.listDeploymentPluginInstallationsForHost()).resolves.toEqual([]);
    await expect(host.listDeploymentPluginAuditEventsForHost()).resolves.toEqual([]);
  });

  it("permanently denies a canonical manifest with one append-only admin audit event", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, DENYLIST_ADMIN_USERNAME);
    using authenticated = await publicApi.authenticate(account.token);
    using admin = await authenticated.getAdminApi();
    if (admin === null) throw new Error("Expected the configured admin capability.");

    await expect(admin.denyPluginManifest("not-a-digest")).resolves.toEqual({
      ok: false,
      error: "INVALID_MANIFEST_DIGEST",
    });
    await expect(admin.denyPluginManifest(RUNTIME_MANIFEST_DIGEST)).resolves.toEqual({ok: true});
    await expect(admin.denyPluginManifest(RUNTIME_MANIFEST_DIGEST)).resolves.toEqual({ok: true});
    await abortAllDurableObjects();

    const adminSettings = exports.AdminSettings.getByName("");
    await expect(adminSettings.isPluginManifestDeniedForRuntimeHost(
      RUNTIME_MANIFEST_DIGEST,
    )).resolves.toBe(true);
    await expect(adminSettings.listPluginManifestDenylistAuditEventsForHost())
      .resolves.toEqual([{
        sequence: 0,
        action: "PLUGIN_MANIFEST_DENIED",
        manifestDigest: RUNTIME_MANIFEST_DIGEST,
        actorUserId: exports.UserDurableObject.idFromName(DENYLIST_ADMIN_USERNAME).toString(),
        actorProfileId: DENYLIST_ADMIN_USERNAME,
        deniedAt: expect.any(Number),
      }]);
  });

  it("revokes an active denied runtime on the next realm refresh", async () => {
    using publicApi = await connect();
    const adminAccount = await createAccount(publicApi, DENY_RUNTIME_ADMIN_USERNAME);
    const memberName = username("deploymentplugindenymember");
    const memberAccount = await createAccount(publicApi, memberName);
    using adminAuthenticated = await publicApi.authenticate(adminAccount.token);
    using admin = await adminAuthenticated.getAdminApi();
    if (admin === null) throw new Error("Expected the configured admin capability.");
    using memberAuthenticated = await publicApi.authenticate(memberAccount.token);
    let workspaceId = "";
    {
      using workspace = await memberAuthenticated.newGadget();
      workspaceId = (await workspace.getMetadata()).id;
    }
    await expect(memberAuthenticated.installUserPlugin({
      pluginId: "test.runtime",
      packageVersion: "1.0.0",
      approvedCapabilities: [],
    })).resolves.toMatchObject({ok: true});

    const memberUserId = exports.UserDurableObject.idFromName(memberName).toString();
    const workspaceHost = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    const firstSession = memberAuthenticated.openGadget(workspaceId);
    await firstSession.getMetadata();
    await expect(workspaceHost.assertPluginRuntimeLoopbackActiveForHost(
      memberUserId, "build", "test.runtime",
    )).resolves.toBeUndefined();

    await expect(admin.denyPluginManifest(RUNTIME_MANIFEST_DIGEST)).resolves.toEqual({ok: true});
    await expect(workspaceHost.assertPluginRuntimeLoopbackActiveForHost(
      memberUserId, "build", "test.runtime",
    )).rejects.toThrow("Plugin manifest is denied");
    await expect(workspaceHost.assertPluginRuntimeActiveForHost(
      memberUserId, "build", "test.runtime",
    )).rejects.toThrow("Plugin runtime plugin is inactive");
    firstSession[Symbol.dispose]();
  });

  it("persists admin-approved desired state and audit across reconstruction", async () => {
    let installationId = "";

    {
      using publicApi = await connect();
      const account = await createAccount(publicApi, ADMIN_USERNAME);
      using authenticated = await publicApi.authenticate(account.token);
      using admin = await authenticated.getAdminApi();
      expect(admin).not.toBeNull();
      if (admin === null) throw new Error("Expected the configured admin capability.");

      const result = await admin.installDeploymentPlugin({
        pluginId: "test.notes",
        packageVersion: "1.2.3",
        approvedCapabilities: ["agent.catalog.read", "ui.panel"],
      });
      expect(result).toMatchObject({ok: true, installationId: expect.any(String)});
      if (!result.ok) throw new Error("Expected deployment plugin installation to succeed.");
      installationId = result.installationId;

      await expect(admin.installDeploymentPlugin({
        pluginId: "test.notes",
        packageVersion: "1.3.0",
        approvedCapabilities: ["ui.panel"],
      })).resolves.toEqual({ok: true, installationId});
    }

    await abortAllDurableObjects();

    const adminSettings = exports.AdminSettings.getByName("");
    const targetId = adminSettings.id.toString();
    const actorUserId = exports.UserDurableObject.idFromName(ADMIN_USERNAME).toString();
    await expect(adminSettings.listDeploymentPluginInstallationsForHost()).resolves.toEqual([{
      schemaVersion: 1,
      installationId,
      scope: "deployment",
      targetId,
      pluginId: "test.notes",
      packageVersion: "1.3.0",
      manifestDigest: V2_MANIFEST_DIGEST,
      enabled: true,
      grantedCapabilities: ["ui.panel"],
      config: null,
    }]);
    await expect(adminSettings.listDeploymentPluginAuditEventsForHost()).resolves.toMatchObject([
      {
        schemaVersion: 1,
        sequence: 0,
        action: "PLUGIN_DESIRED_STATE_PUT",
        actorUserId,
        actorProfileId: ADMIN_USERNAME,
        authority: "admin",
        scope: "deployment",
        targetId,
        installationId,
        pluginId: "test.notes",
        packageVersion: "1.2.3",
        manifestDigest: V1_MANIFEST_DIGEST,
        grantedCapabilities: ["ui.panel", "agent.catalog.read"],
        recordedAt: expect.any(Number),
      },
      {
        schemaVersion: 1,
        sequence: 1,
        action: "PLUGIN_DESIRED_STATE_PUT",
        actorUserId,
        actorProfileId: ADMIN_USERNAME,
        authority: "admin",
        scope: "deployment",
        targetId,
        installationId,
        pluginId: "test.notes",
        packageVersion: "1.3.0",
        manifestDigest: V2_MANIFEST_DIGEST,
        grantedCapabilities: ["ui.panel"],
        recordedAt: expect.any(Number),
      },
    ]);
  });

  it("does not mint the deployment mutation capability for a non-admin", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, username("deploymentpluginnonadmin"));
    using authenticated = await publicApi.authenticate(account.token);

    await expect(authenticated.getAdminApi()).resolves.toBeNull();
    const adminSettings = exports.AdminSettings.getByName("");
    await expect(adminSettings.listDeploymentPluginInstallationsForHost()).resolves.toEqual([]);
    await expect(adminSettings.listDeploymentPluginAuditEventsForHost()).resolves.toEqual([]);
  });

  it("rejects an unapproved manifest without changing desired state or audit", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, REJECT_ADMIN_USERNAME);
    using authenticated = await publicApi.authenticate(account.token);
    using admin = await authenticated.getAdminApi();
    if (admin === null) throw new Error("Expected the configured admin capability.");

    await expect(admin.installDeploymentPlugin({
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      approvedCapabilities: ["ui.panel"],
    })).resolves.toEqual({ok: false, error: "CAPABILITY_APPROVAL_MISMATCH"});

    const adminSettings = exports.AdminSettings.getByName("");
    await expect(adminSettings.listDeploymentPluginInstallationsForHost()).resolves.toEqual([]);
    await expect(adminSettings.listDeploymentPluginAuditEventsForHost()).resolves.toEqual([]);
  });
});
