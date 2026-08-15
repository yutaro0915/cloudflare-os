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
  it("defaults to deny before and after an owning Overseer reconstructs", async () => {
    const overseerId = exports.OverseerDurableObject.newUniqueId().toString();
    const props = {
      overseerId,
      userId: exports.UserDurableObject.newUniqueId().toString(),
      role: "build" as const,
      generation: crypto.randomUUID(),
      pluginId: "test.runtime",
      activationKey: `plugin-worker:v1:${"a".repeat(64)}`,
      manifestDigest: `sha256:${"b".repeat(64)}`,
    };

    await expect(exports.PluginRuntimeLoopback({props}).verifyStaged())
      .rejects.toThrow("Plugin runtime realm is unavailable");
    await abortAllDurableObjects();
    await expect(exports.PluginRuntimeLoopback({props}).assertActive())
      .rejects.toThrow("Plugin runtime realm is unavailable");
  });

  it("keeps public workspace open while a verified v3 runtime reconciles", async () => {
    using publicApi = await connect();
    const name = username("pluginruntime");
    const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
    if (token === null) throw new Error("Failed to create runtime test account.");
    using authenticated = await publicApi.authenticate(token);
    let workspaceId = "";
    {
      using workspace = await authenticated.newGadget();
      workspaceId = (await workspace.getMetadata()).id;
    }
    await expect(authenticated.installUserPlugin({
      pluginId: "test.runtime",
      packageVersion: "1.0.0",
      approvedCapabilities: [],
    })).resolves.toMatchObject({ok: true});

    const userId = exports.UserDurableObject.idFromName(name).toString();
    const workspaceHost = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    const reopened = authenticated.openGadget(workspaceId);
    await expect(reopened.getMetadata()).resolves.toMatchObject({
      id: workspaceId,
      role: "build",
    });
    await expect(workspaceHost.assertPluginRuntimeLoopbackActiveForHost(
      userId, "build", "test.runtime",
    )).resolves.toBeUndefined();

    reopened[Symbol.dispose]();
    await expect(workspaceHost.assertPluginRuntimeActiveForHost(
      userId, "build", "test.runtime",
    )).rejects.toThrow("Plugin runtime realm is unavailable");

    const beforeRestart = authenticated.openGadget(workspaceId);
    await beforeRestart.getMetadata();
    await expect(workspaceHost.assertPluginRuntimeLoopbackActiveForHost(
      userId, "build", "test.runtime",
    )).resolves.toBeUndefined();
    await abortAllDurableObjects();
    const reconstructed = exports.OverseerDurableObject.get(
      exports.OverseerDurableObject.idFromString(workspaceId),
    );
    await expect(reconstructed.assertPluginRuntimeActiveForHost(
      userId, "build", "test.runtime",
    )).rejects.toThrow("Plugin runtime realm is unavailable");
    beforeRestart[Symbol.dispose]();
  });
});
