import { exports } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);

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

describe("production plugin runtime loopback", () => {
  it("reconciles, revokes, restores, and reconstructs one isolated capability", async () => {
    using publicApi = await connect();
    const name = username("pluginruntimegrantrevoke");
    const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
    if (token === null) throw new Error("Failed to create grant revocation account.");
    using authenticated = await publicApi.authenticate(token);
    let workspaceId = "";
    {
      using workspace = await authenticated.newGadget();
      await workspace.setTitle("Capability Workspace");
      workspaceId = (await workspace.getMetadata()).id;
    }
    const first = await authenticated.installUserPlugin({
      pluginId: "test.runtime-metadata",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.state.read", "workspace.metadata.read"],
    });
    if (!first.ok) throw new Error("Expected initial capability installation to succeed.");

    const userId = exports.UserDurableObject.idFromName(name).toString();
    const workspaceHost = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    const firstSession = authenticated.openGadget(workspaceId);
    await firstSession.getMetadata();
    await expect(workspaceHost.assertPluginWorkspaceMetadataCapabilityForHost(
      userId, "build", "test.runtime-metadata",
    )).resolves.toBeUndefined();

    await expect(authenticated.installUserPlugin({
      pluginId: "test.runtime-metadata",
      packageVersion: "2.0.0",
      approvedCapabilities: [],
    })).resolves.toEqual({ok: true, installationId: first.installationId});
    using refreshSession = authenticated.openGadget(workspaceId);
    await refreshSession.getMetadata();
    await expect(refreshSession.getPluginRuntimeStatus()).resolves.toMatchObject({
      outcome: "ready",
      states: [{
        pluginId: "test.runtime-metadata",
        status: "failed",
        reason: "ACTIVATION_FAILED",
        candidate: {packageVersion: "2.0.0"},
        retainedActive: {packageVersion: "1.0.0"},
      }],
      observedAt: expect.any(Number),
    });
    expect((await workspaceHost.listPluginRuntimeAuditEventsForHost()).some(event =>
      event.action === "PLUGIN_RUNTIME_RECONCILED" &&
      event.realmUserId === userId &&
      event.status.states.some(state =>
        state.pluginId === "test.runtime-metadata" &&
        state.status === "failed" && state.reason === "ACTIVATION_FAILED")))
      .toBe(true);

    await expect(workspaceHost.assertPluginWorkspaceMetadataCapabilityForHost(
      userId, "build", "test.runtime-metadata",
    )).rejects.toThrow("Plugin runtime capability is no longer authorized");
    await expect(workspaceHost.assertPluginRuntimeActiveForHost(
      userId, "build", "test.runtime-metadata",
    )).rejects.toThrow("Plugin runtime plugin is inactive");

    await expect(authenticated.installUserPlugin({
      pluginId: "test.runtime-metadata",
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.state.read", "workspace.metadata.read"],
    })).resolves.toEqual({ok: true, installationId: first.installationId});
    using recoveredSession = authenticated.openGadget(workspaceId);
    await recoveredSession.getMetadata();
    await expect(recoveredSession.getPluginRuntimeStatus()).resolves.toMatchObject({
      outcome: "ready",
      states: [{
        pluginId: "test.runtime-metadata",
        status: "active",
        active: {packageVersion: "1.0.0"},
      }],
    });
    await expect(workspaceHost.assertPluginWorkspaceMetadataCapabilityForHost(
      userId, "build", "test.runtime-metadata",
    )).resolves.toBeUndefined();

    await expect(authenticated.uninstallUserPlugin({
      pluginId: "test.runtime-metadata",
      expectedInstallationId: first.installationId,
    })).resolves.toEqual({
      ok: true,
      installationId: first.installationId,
      retainedState: true,
    });
    await expect(workspaceHost.assertPluginWorkspaceMetadataCapabilityForHost(
      userId, "build", "test.runtime-metadata",
    )).rejects.toThrow("Plugin runtime lifecycle is no longer authorized");
    await expect(workspaceHost.assertPluginRuntimeActiveForHost(
      userId, "build", "test.runtime-metadata",
    )).rejects.toThrow("Plugin runtime plugin is inactive");
    await expect(authenticated.listDetachedUserPluginStates()).resolves.toMatchObject([{
      installationId: first.installationId,
      pluginId: "test.runtime-metadata",
      packageVersion: "1.0.0",
      detachedAt: expect.any(Number),
    }]);

    recoveredSession[Symbol.dispose]();
    refreshSession[Symbol.dispose]();
    firstSession[Symbol.dispose]();
    await expect(workspaceHost.assertPluginWorkspaceMetadataCapabilityForHost(
      userId, "build", "test.runtime-metadata",
    )).rejects.toThrow("Plugin runtime realm is unavailable");

    const beforeRestart = authenticated.openGadget(workspaceId);
    await beforeRestart.getMetadata();
    await expect(workspaceHost.assertPluginRuntimeActiveForHost(
      userId, "build", "test.runtime-metadata",
    )).rejects.toThrow("Plugin runtime plugin is inactive");
    await abortAllDurableObjects();
    const reconstructed = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await expect(reconstructed.assertPluginWorkspaceMetadataCapabilityForHost(
      userId, "build", "test.runtime-metadata",
    )).rejects.toThrow("Plugin runtime realm is unavailable");
    beforeRestart[Symbol.dispose]();
  });
});
