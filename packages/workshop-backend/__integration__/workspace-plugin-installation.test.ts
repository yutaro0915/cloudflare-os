import { exports } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const V1_MANIFEST_DIGEST =
  "sha256:c5ba5566a2a255b6a106f7d64fac442589da19e32fa0212b12e2f67e278fc75f";

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

describe("workspace plugin installations", () => {
  it("revokes, detaches, and owner-purges workspace installation state across reconstruction", async () => {
    using publicApi = await connect();
    const ownerAccount = await createAccount(publicApi, "workspacepluginstateowner");
    using owner = await publicApi.authenticate(ownerAccount.token);
    using workspace = await owner.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    const host = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );

    const installed = await workspace.installWorkspacePlugin({
      pluginId: "test.state-only",
      packageVersion: "1.0.0",
      approvedCapabilities: [],
    });
    expect(installed).toMatchObject({ok: true, installationId: expect.any(String)});
    if (!installed.ok) throw new Error("Expected stateful workspace installation.");
    const [record] = await host.listWorkspacePluginInstallationsForHost();
    if (record?.stateRef === undefined) throw new Error("Expected workspace stateRef.");
    const stateOwner = {
      scope: "workspace" as const,
      targetId: host.id.toString(),
      pluginId: record.pluginId,
      installationId: record.installationId,
    };
    const state = exports.PluginStateDurableObject.get(
      exports.PluginStateDurableObject.idFromString(record.stateRef),
    );
    await state.putForHost(stateOwner, "marker", {workspace: true});

    await expect(workspace.uninstallWorkspacePlugin({
      pluginId: record.pluginId,
      expectedInstallationId: record.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: record.installationId,
      retainedState: true,
    });
    await expect(host.readWorkspacePluginInstallationsSnapshotForRuntimeHost())
      .resolves.toEqual([]);
    await abortAllDurableObjects();

    const reconstructed = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await expect(reconstructed.listWorkspacePluginInstallationsForHost()).resolves.toEqual([]);
    await expect(reconstructed.listDetachedWorkspacePluginStatesForHost()).resolves.toMatchObject([{
      installationId: record.installationId,
      pluginId: record.pluginId,
      stateRef: record.stateRef,
    }]);
    const reconstructedState = exports.PluginStateDurableObject.get(
      exports.PluginStateDurableObject.idFromString(record.stateRef),
    );
    await expect(reconstructedState.read(stateOwner, "marker"))
      .resolves.toEqual({workspace: true});
    using reconstructedPublicApi = await connect();
    using reconstructedOwner = await reconstructedPublicApi.authenticate(ownerAccount.token);
    using reconstructedWorkspace = await reconstructedOwner.openGadget(workspaceId);
    await expect(reconstructedWorkspace.purgeWorkspacePluginState({
      installationId: record.installationId,
    })).resolves.toEqual({ok: true, installationId: record.installationId});
    await expect(reconstructedState.read(stateOwner, "marker"))
      .rejects.toThrow("Plugin state was purged");
    expect((await reconstructed.listWorkspacePluginAuditEventsForHost())
      .map(event => event.action)).toEqual([
        "PLUGIN_DESIRED_STATE_PUT",
        "PLUGIN_UNINSTALLED",
        "PLUGIN_STATE_PURGED",
      ]);
  });

  it("rejects a user-navigation plugin before workspace desired state changes", async () => {
    using publicApi = await connect();
    const owner = await createAccount(publicApi, "workspacekanbanscope");
    using authenticated = await publicApi.authenticate(owner.token);
    using workspace = await authenticated.newGadget();

    await expect(workspace.installWorkspacePlugin({
      pluginId: "test.kanban",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.ui.state.mutate"],
    })).resolves.toEqual({ok: false, error: "PLUGIN_SCOPE_NOT_SUPPORTED"});
    const workspaceId = (await workspace.getMetadata()).id;
    const host = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await expect(host.listWorkspacePluginInstallationsForHost()).resolves.toEqual([]);
    await expect(host.listWorkspacePluginAuditEventsForHost()).resolves.toEqual([]);
  });

  it("persists owner-approved desired state and audit in only the owning workspace", async () => {
    let ownerUsername = "";
    let workspaceId = "";
    let otherWorkspaceId = "";
    let installationId = "";

    {
      using publicApi = await connect();
      const owner = await createAccount(publicApi, "workspacepluginowner");
      ownerUsername = owner.username;
      using authenticated = await publicApi.authenticate(owner.token);
      using workspace = await authenticated.newGadget();
      using otherWorkspace = await authenticated.newGadget();
      workspaceId = (await workspace.getMetadata()).id;
      otherWorkspaceId = (await otherWorkspace.getMetadata()).id;

      const result = await workspace.installWorkspacePlugin({
        pluginId: "test.notes",
        packageVersion: "1.2.3",
        approvedCapabilities: ["agent.catalog.read", "ui.panel"],
      });
      expect(result).toMatchObject({ok: true, installationId: expect.any(String)});
      if (!result.ok) throw new Error("Expected workspace plugin installation to succeed.");
      installationId = result.installationId;
    }

    await abortAllDurableObjects();

    const workspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    const otherWorkspace = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(otherWorkspaceId),
    );
    const workspaceTarget = exports.OverseerDurableObject.idFromString(workspaceId).toString();
    const ownerUserId = exports.UserDurableObject.idFromName(ownerUsername).toString();

    await expect(workspace.listWorkspacePluginInstallationsForHost()).resolves.toEqual([{
      schemaVersion: 1,
      installationId,
      scope: "workspace",
      targetId: workspaceTarget,
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      manifestDigest: V1_MANIFEST_DIGEST,
      enabled: true,
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
      grantedCapabilities: ["ui.panel", "agent.catalog.read"],
      config: null,
    }]);
    await expect(otherWorkspace.listWorkspacePluginInstallationsForHost()).resolves.toEqual([]);
    await expect(workspace.listWorkspacePluginAuditEventsForHost()).resolves.toMatchObject([{
      schemaVersion: 1,
      sequence: 0,
      action: "PLUGIN_DESIRED_STATE_PUT",
      actorUserId: ownerUserId,
      actorProfileId: ownerUsername,
      authority: "owner",
      scope: "workspace",
      targetId: workspaceTarget,
      installationId,
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      manifestDigest: V1_MANIFEST_DIGEST,
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
      grantedCapabilities: ["ui.panel", "agent.catalog.read"],
      recordedAt: expect.any(Number),
    }]);
  });

  it("lets a build collaborator update within the owner-approved capability ceiling", async () => {
    using publicApi = await connect();
    const ownerAccount = await createAccount(publicApi, "workspacepluginownerbuild");
    const builderAccount = await createAccount(publicApi, "workspacepluginbuilder");
    using owner = await publicApi.authenticate(ownerAccount.token);
    using workspace = await owner.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    const installed = await workspace.installWorkspacePlugin({
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
    });
    if (!installed.ok) throw new Error("Expected owner installation to succeed.");
    await expect(workspace.addCollaborator(builderAccount.username, "build")).resolves.toMatchObject({
      role: "build",
    });

    using builder = await publicApi.authenticate(builderAccount.token);
    using builderWorkspace = await builder.openGadget(workspaceId);
    await expect(builderWorkspace.installWorkspacePlugin({
      pluginId: "test.notes",
      packageVersion: "1.3.0",
      approvedCapabilities: ["ui.panel"],
    })).resolves.toEqual({ok: true, installationId: installed.installationId});

    const workspaceHost = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await expect(workspaceHost.listWorkspacePluginInstallationsForHost()).resolves.toMatchObject([{
      installationId: installed.installationId,
      packageVersion: "1.3.0",
      manifestDigest:
        "sha256:00504a35886ec267d7b82fe5dbe961c0619fdfe7c15f72991d30ee53379f5796",
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
      grantedCapabilities: ["ui.panel"],
    }]);
    await expect(workspaceHost.listWorkspacePluginAuditEventsForHost()).resolves.toMatchObject([
      {sequence: 0, authority: "owner", actorProfileId: ownerAccount.username},
      {
        sequence: 1,
        authority: "build",
        actorUserId: exports.UserDurableObject.idFromName(builderAccount.username).toString(),
        actorProfileId: builderAccount.username,
        approvedCapabilities: ["ui.panel", "agent.catalog.read"],
        grantedCapabilities: ["ui.panel"],
      },
    ]);
  });

  it("rejects a build collaborator capability expansion without changing state or audit", async () => {
    using publicApi = await connect();
    const ownerAccount = await createAccount(publicApi, "workspacepluginownerexpand");
    const builderAccount = await createAccount(publicApi, "workspacepluginbuilderexpand");
    using owner = await publicApi.authenticate(ownerAccount.token);
    using workspace = await owner.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    const installed = await workspace.installWorkspacePlugin({
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
    });
    if (!installed.ok) throw new Error("Expected owner installation to succeed.");
    const workspaceHost = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    const before = await workspaceHost.listWorkspacePluginInstallationsForHost();
    await expect(workspace.addCollaborator(builderAccount.username, "build")).resolves.not.toBeNull();

    using builder = await publicApi.authenticate(builderAccount.token);
    using builderWorkspace = await builder.openGadget(workspaceId);
    await expect(builderWorkspace.installWorkspacePlugin({
      pluginId: "test.notes",
      packageVersion: "2.0.0",
      approvedCapabilities: ["ui.panel", "agent.catalog.read", "workspace.write"],
    })).resolves.toEqual({
      ok: false,
      error: "CAPABILITY_OWNER_APPROVAL_REQUIRED",
    });
    await expect(workspaceHost.listWorkspacePluginInstallationsForHost()).resolves.toEqual(before);
    await expect(workspaceHost.listWorkspacePluginAuditEventsForHost()).resolves.toHaveLength(1);
  });

  it("denies workspace plugin mutation to a use collaborator", async () => {
    using publicApi = await connect();
    const ownerAccount = await createAccount(publicApi, "workspacepluginowneruse");
    const userAccount = await createAccount(publicApi, "workspacepluginuser");
    using owner = await publicApi.authenticate(ownerAccount.token);
    using workspace = await owner.newGadget();
    const workspaceId = (await workspace.getMetadata()).id;
    await expect(workspace.addCollaborator(userAccount.username, "use")).resolves.toMatchObject({
      role: "use",
    });

    using user = await publicApi.authenticate(userAccount.token);
    using userWorkspace = await user.openGadget(workspaceId);
    await expect(userWorkspace.installWorkspacePlugin({
      pluginId: "test.notes",
      packageVersion: "1.2.3",
      approvedCapabilities: ["ui.panel", "agent.catalog.read"],
    })).rejects.toThrow(/Unauthorized/);
  });
});
