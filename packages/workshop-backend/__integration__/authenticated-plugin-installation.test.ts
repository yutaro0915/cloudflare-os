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
  it("installs a navigation plugin and persists create, move, and delete through its reducer", async () => {
    using publicApi = await connect();
    const ownerAccount = await createAccount(publicApi, "pluginkanbanowner");
    const otherAccount = await createAccount(publicApi, "pluginkanbanother");
    using authenticated = await publicApi.authenticate(ownerAccount.token);
    using other = await publicApi.authenticate(otherAccount.token);

    const installed = await authenticated.installUserPlugin({
      pluginId: "test.kanban",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.ui.state.mutate"],
    });
    if (!installed.ok) throw new Error("Expected Kanban installation.");

    const navigation = await authenticated.listUserPluginNavigation();
    expect(navigation).toEqual([{
      pluginId: "test.kanban",
      installationId: installed.installationId,
      packageVersion: "1.0.0",
      contributionId: "board",
      title: "Kanban",
    }]);
    await expect(other.listUserPluginNavigation()).resolves.toEqual([]);
    await expect(other.interactUserPluginSurface({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {
        kind: "action",
        expectedRevision: 0,
        mutationId: "forged-other-user",
        actionId: "task.create",
        input: "Forged",
      },
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});
    expect(JSON.stringify(navigation)).not.toMatch(/stateRef|manifestDigest|codeArtifactDigest|sha256:/);

    const opened = await authenticated.interactUserPluginSurface({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {kind: "open"},
    });
    expect(opened).toMatchObject({
      ok: true,
      revision: 0,
      document: {
        title: "Test Kanban",
        columns: [
          {columnId: "todo", items: []},
          {columnId: "doing", items: []},
          {columnId: "done", items: []},
        ],
      },
    });

    const createRequest = {
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {
        kind: "action" as const,
        expectedRevision: 0,
        mutationId: "create-first",
        actionId: "task.create",
        input: "Ship the Kanban demo",
      },
    };
    const created = await authenticated.interactUserPluginSurface(createRequest);
    expect(created).toMatchObject({ok: true, revision: 1});
    if (!created.ok) throw new Error("Expected task creation.");
    expect(created.document.columns[0]?.items).toMatchObject([{
      itemId: "task-1",
      title: "Ship the Kanban demo",
    }]);
    const replayed = await authenticated.interactUserPluginSurface(createRequest);
    expect(replayed).toMatchObject({ok: true, revision: 1});
    if (!replayed.ok) throw new Error("Expected idempotent create replay.");
    expect(replayed.document.columns[0]?.items).toMatchObject([{itemId: "task-1"}]);

    const moved = await authenticated.interactUserPluginSurface({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {
        kind: "action",
        expectedRevision: 1,
        mutationId: "move-first",
        actionId: "task.move:task-1:doing",
        input: null,
      },
    });
    expect(moved).toMatchObject({
      ok: true,
      revision: 2,
      document: {columns: [{items: []}, {items: [{itemId: "task-1"}]}, {items: []}]},
    });
    await expect(authenticated.interactUserPluginSurface({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {
        kind: "action",
        expectedRevision: 0,
        mutationId: "stale-delete",
        actionId: "task.delete:task-1",
        input: null,
      },
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_CONFLICT"});

    await abortAllDurableObjects();
    using reconstructed = await publicApi.authenticate(ownerAccount.token);
    await expect(reconstructed.interactUserPluginSurface({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {kind: "open"},
    })).resolves.toMatchObject({
      ok: true,
      revision: 2,
      document: {columns: [{items: []}, {items: [{itemId: "task-1"}]}, {items: []}]},
    });

    await expect(reconstructed.interactUserPluginSurface({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {
        kind: "action",
        expectedRevision: 2,
        mutationId: "delete-first",
        actionId: "task.delete:task-1",
        input: null,
      },
    })).resolves.toMatchObject({
      ok: true,
      revision: 3,
      document: {columns: [{items: []}, {items: []}, {items: []}]},
    });

    const owner = exports.UserDurableObject.getByName(ownerAccount.username);
    const [persisted] = await owner.listUserPluginInstallations();
    if (persisted?.stateRef === undefined) throw new Error("Expected Kanban stateRef.");
    await owner.putUserPluginInstallation({
      installationId: persisted.installationId,
      pluginId: persisted.pluginId,
      packageVersion: persisted.packageVersion,
      manifestDigest: persisted.manifestDigest,
      enabled: true,
      grantedCapabilities: [],
      config: persisted.config,
      stateRequirement: "installation",
    });
    await expect(reconstructed.listUserPluginNavigation()).resolves.toEqual([]);
    await expect(reconstructed.interactUserPluginSurface({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {
        kind: "action",
        expectedRevision: 3,
        mutationId: "grant-revoked",
        actionId: "task.create",
        input: "Must not persist",
      },
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});
    const restored = await reconstructed.installUserPlugin({
      pluginId: "test.kanban",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.ui.state.mutate"],
    });
    expect(restored).toEqual({ok: true, installationId: installed.installationId});
    await expect(reconstructed.listUserPluginNavigation()).resolves.toHaveLength(1);

    await expect(reconstructed.uninstallUserPlugin({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: installed.installationId,
      retainedState: true,
    });
    await expect(reconstructed.listUserPluginNavigation()).resolves.toEqual([]);
    await expect(reconstructed.interactUserPluginSurface({
      pluginId: "test.kanban",
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {
        kind: "action",
        expectedRevision: 3,
        mutationId: "stale-after-uninstall",
        actionId: "task.create",
        input: "Must stay detached",
      },
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});
    await expect(reconstructed.listDetachedUserPluginStates()).resolves.toMatchObject([{
      installationId: installed.installationId,
      pluginId: "test.kanban",
    }]);
    const [detached] = await owner.listDetachedUserPluginStatesForHost();
    if (detached === undefined) throw new Error("Expected detached Kanban state.");
    const state = exports.PluginStateDurableObject.get(
      exports.PluginStateDurableObject.idFromString(detached.stateRef),
    );
    await expect(state.readVersioned({
      scope: "user",
      targetId: owner.id.toString(),
      pluginId: detached.pluginId,
      installationId: detached.installationId,
    }, "ui:board")).resolves.toMatchObject({revision: 3});
  });

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

  it("resumes detached state purge across both crash windows without exposing state refs", async () => {
    using publicApi = await connect();
    const account = await createAccount(publicApi, "pluginpurge");
    using authenticated = await publicApi.authenticate(account.token);
    const installed = await authenticated.installUserPlugin({
      pluginId: "test.runtime-metadata",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.state.read", "workspace.metadata.read"],
    });
    if (!installed.ok) throw new Error("Expected stateful plugin installation to succeed.");
    await authenticated.uninstallUserPlugin({
      pluginId: "test.runtime-metadata",
      expectedInstallationId: installed.installationId,
    });

    let owner = exports.UserDurableObject.getByName(account.username);
    const [detached] = await owner.listDetachedUserPluginStatesForHost();
    if (detached === undefined) throw new Error("Expected detached plugin state.");
    const firstBegin = await owner.beginUserPluginStatePurge(detached.installationId);
    if (!firstBegin.ok || firstBegin.phase !== "PURGE_REQUIRED") {
      throw new Error("Expected pending purge marker.");
    }
    await abortAllDurableObjects();

    using resumedAfterBegin = await publicApi.authenticate(account.token);
    await expect(resumedAfterBegin.purgeUserPluginState({
      installationId: detached.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: detached.installationId,
    });
    await expect(resumedAfterBegin.listDetachedUserPluginStates()).resolves.toEqual([]);

    const reinstalled = await resumedAfterBegin.installUserPlugin({
      pluginId: "test.runtime-metadata",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.state.read", "workspace.metadata.read"],
    });
    if (!reinstalled.ok) throw new Error("Expected replacement stateful installation.");
    await resumedAfterBegin.uninstallUserPlugin({
      pluginId: "test.runtime-metadata",
      expectedInstallationId: reinstalled.installationId,
    });
    owner = exports.UserDurableObject.getByName(account.username);
    const secondBegin = await owner.beginUserPluginStatePurge(reinstalled.installationId);
    if (!secondBegin.ok || secondBegin.phase !== "PURGE_REQUIRED") {
      throw new Error("Expected second purge marker.");
    }
    const state = exports.PluginStateDurableObject.get(
      exports.PluginStateDurableObject.idFromString(secondBegin.stateRef),
    );
    await state.purge(secondBegin.owner);
    await abortAllDurableObjects();

    using resumedAfterChild = await publicApi.authenticate(account.token);
    await expect(resumedAfterChild.purgeUserPluginState({
      installationId: reinstalled.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: reinstalled.installationId,
    });
    await expect(resumedAfterChild.purgeUserPluginState({
      installationId: reinstalled.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: reinstalled.installationId,
    });
    const latest = await resumedAfterChild.installUserPlugin({
      pluginId: "test.runtime-metadata",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.state.read", "workspace.metadata.read"],
    });
    if (!latest.ok) throw new Error("Expected latest stateful installation.");
    const latestOwner = exports.UserDurableObject.getByName(account.username);
    const [latestInstallation] = await latestOwner.listUserPluginInstallations();
    if (latestInstallation?.stateRef === undefined) {
      throw new Error("Expected latest host-managed stateRef.");
    }
    const latestStateOwner = {
      scope: "user" as const,
      targetId: latestOwner.id.toString(),
      pluginId: latestInstallation.pluginId,
      installationId: latest.installationId,
    };
    const latestState = exports.PluginStateDurableObject.get(
      exports.PluginStateDurableObject.idFromString(latestInstallation.stateRef),
    );
    await latestState.putForHost(latestStateOwner, "latest", {preserved: true});
    await expect(resumedAfterChild.purgeUserPluginState({
      installationId: reinstalled.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: reinstalled.installationId,
    });
    await expect(exports.UserDurableObject.getByName(account.username)
      .listUserPluginInstallations()).resolves.toMatchObject([{
      installationId: latest.installationId,
      stateRef: expect.any(String),
    }]);
    await expect(latestState.read(latestStateOwner, "latest"))
      .resolves.toEqual({preserved: true});
    await resumedAfterChild.uninstallUserPlugin({
      pluginId: "test.runtime-metadata",
      expectedInstallationId: latest.installationId,
    });
    await expect(resumedAfterChild.purgeUserPluginState({
      installationId: latest.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: latest.installationId,
    });
    await expect(resumedAfterChild.listDetachedUserPluginStates()).resolves.toEqual([]);
    await expect(resumedAfterChild.purgeUserPluginState({
      installationId: "unrelated-stale-installation",
    })).resolves.toEqual({ok: false, error: "DETACHED_PLUGIN_STATE_NOT_FOUND"});
    expect((await exports.UserDurableObject.getByName(account.username)
      .listUserPluginAuditEvents()).filter(event => event.action === "PLUGIN_STATE_PURGED"))
      .toHaveLength(3);
  });

  it("projects an isolated deterministic Plugin Center without authority fields", async () => {
    using publicApi = await connect();
    const firstAccount = await createAccount(publicApi, "plugincenterfirst");
    const secondAccount = await createAccount(publicApi, "plugincentersecond");
    using first = await publicApi.authenticate(firstAccount.token);
    using second = await publicApi.authenticate(secondAccount.token);
    const installed = await first.installUserPlugin({
      pluginId: "test.ui-center",
      packageVersion: "1.0.0",
      approvedCapabilities: [],
    });
    if (!installed.ok) throw new Error("Expected UI plugin installation.");

    const firstView = await first.getUserPluginCenter();
    const secondView = await second.getUserPluginCenter();
    const firstCard = firstView.plugins.find(plugin => plugin.pluginId === "test.ui-center");
    const secondCard = secondView.plugins.find(plugin => plugin.pluginId === "test.ui-center");
    expect(firstCard).toMatchObject({
      title: "UI Center Test",
      offers: [{
        packageVersion: "1.0.0",
        contributions: [
          {kind: "declarative"},
          {kind: "worker-rendered", height: 180},
          {kind: "worker-rendered", height: 180},
          {kind: "worker-rendered", height: 240},
        ],
      }],
      installation: {
        installationId: installed.installationId,
        lifecycle: "installed",
        contributions: [
          {kind: "declarative"},
          {kind: "worker-rendered"},
          {kind: "worker-rendered"},
          {kind: "worker-rendered"},
        ],
      },
    });
    expect(secondCard).toMatchObject({installation: null});

    const opened = await first.openUserPluginUiFrame({
      pluginId: "test.ui-center",
      expectedInstallationId: installed.installationId,
      contributionId: "sandbox",
    });
    expect(opened).toMatchObject({
      ok: true,
      frame: {
        title: "Worker-rendered surface",
        height: 240,
        iframeHtml: expect.stringContaining("connect-src 'none'"),
      },
    });
    if (!opened.ok) throw new Error("Expected isolated UI frame.");
    expect(opened.frame.iframeHtml).toContain("Rendered in an isolated Dynamic Worker.");
    expect(opened.frame.iframeHtml).toContain("script-src 'none'");
    expect(opened.frame.iframeHtml).not.toContain("<script");
    await expect(first.openUserPluginUiFrame({
      pluginId: "test.ui-center",
      expectedInstallationId: installed.installationId,
      contributionId: "hung-render",
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});
    await expect(first.openUserPluginUiFrame({
      pluginId: "test.ui-center",
      expectedInstallationId: installed.installationId,
      contributionId: "prototype-poison",
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});
    await expect(first.getUserPluginCenter()).resolves.toMatchObject({
      plugins: expect.arrayContaining([expect.objectContaining({pluginId: "test.ui-center"})]),
    });
    expect(JSON.stringify(opened)).not.toContain("sha256:");

    const owner = exports.UserDurableObject.getByName(firstAccount.username);
    const [persisted] = await owner.listUserPluginInstallations();
    if (persisted === undefined) throw new Error("Expected persisted UI plugin installation.");
    await owner.putUserPluginInstallation({
      installationId: persisted.installationId,
      pluginId: persisted.pluginId,
      packageVersion: persisted.packageVersion,
      manifestDigest: persisted.manifestDigest,
      enabled: false,
      grantedCapabilities: persisted.grantedCapabilities,
      config: persisted.config,
    });
    await expect(first.openUserPluginUiFrame({
      pluginId: "test.ui-center",
      expectedInstallationId: installed.installationId,
      contributionId: "sandbox",
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});
    await expect(first.openUserPluginUiFrame({
      pluginId: "test.ui-center",
      expectedInstallationId: installed.installationId,
      contributionId: "details",
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});
    await expect(second.openUserPluginUiFrame({
      pluginId: "test.ui-center",
      expectedInstallationId: installed.installationId,
      contributionId: "sandbox",
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});

    const serialized = JSON.stringify(firstView);
    for (const forbidden of [
      "stateRef", "manifestDigest", "codeArtifactDigest", "targetId", "scope", "config",
      "sha256:",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    await owner.beginUserPluginUninstall("test.ui-center", installed.installationId);
    await expect(first.openUserPluginUiFrame({
      pluginId: "test.ui-center",
      expectedInstallationId: installed.installationId,
      contributionId: "sandbox",
    })).resolves.toEqual({ok: false, error: "PLUGIN_UI_NOT_AVAILABLE"});
    await expect(first.getUserPluginCenter()).resolves.toMatchObject({
      plugins: expect.arrayContaining([expect.objectContaining({
        pluginId: "test.ui-center",
        installation: expect.objectContaining({lifecycle: "uninstalling"}),
      })]),
    });
  });
});
