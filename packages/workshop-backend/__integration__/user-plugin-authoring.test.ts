import {exports} from "cloudflare:workers";
import {newWebSocketRpcSession, type RpcStub} from "capnweb";
import type {PublicApi} from "@gadgets/workshop-shared/api";
import {describe, expect, it} from "vitest";

const PASSWORD_HASH = new Uint8Array([8, 2, 4]);

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
    headers: {Upgrade: "websocket"},
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Expected WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

describe("authenticated user plugin authoring", () => {
  it("keeps the candidate hidden, publishes through admin review, and lets another user import it", async () => {
    using publicApi = await connect();
    const adminToken = await publicApi.createAccount(
      "deploymentpluginadmin",
      "Plugin Author",
      PASSWORD_HASH,
    );
    if (adminToken === null) throw new Error("Expected admin account.");
    using author = await publicApi.authenticate(adminToken);
    const request = {
      template: "personal-board" as const,
      pluginId: "community.integration-board",
      packageVersion: "1.0.0",
      title: "Integration Board",
      summary: "A persistent integration-test board.",
      surfaceTitle: "Shared Release Board",
      items: ["Smoke test", "Confirm rollback"],
    };
    const staged = await author.stageUserPluginCandidate(request);
    expect(staged).toMatchObject({
      ok: true,
      candidateId: expect.stringMatching(/^sha256:/),
      manifestDigest: expect.stringMatching(/^sha256:/),
      review: {
        template: "personal-board",
        title: request.title,
        surfaceTitle: request.surfaceTitle,
        requestedCapabilities: ["plugin.ui.state.mutate"],
        state: "installation",
        renderer: "worker-interactive-document-v1",
        artifactDigests: [
          expect.stringMatching(/^sha256:/),
          expect.stringMatching(/^sha256:/),
        ],
        verificationChecks: [
          "manifest-schema-verified",
          "artifact-digests-verified",
          "dynamic-worker-isolation-passed",
          "candidate-signature-verified",
        ],
      },
    });
    if (!staged.ok) throw new Error("Expected staged candidate.");
    expect((await author.getUserPluginCenter()).plugins)
      .not.toContainEqual(expect.objectContaining({pluginId: request.pluginId}));

    using admin = await author.getAdminApi();
    if (admin === null) throw new Error("Expected admin capability.");
    await expect(admin.approvePluginStoreCandidate(staged.candidateId))
      .resolves.toEqual({ok: true, candidateId: staged.candidateId});

    const importerToken = await publicApi.createAccount(
      "pluginimporter",
      "Plugin Importer",
      PASSWORD_HASH,
    );
    if (importerToken === null) throw new Error("Expected importer account.");
    using importer = await publicApi.authenticate(importerToken);
    const offer = (await importer.getUserPluginCenter()).plugins.find(
      plugin => plugin.pluginId === request.pluginId,
    )?.offers[0];
    expect(offer).toMatchObject({
      packageVersion: "1.0.0",
      requestedCapabilities: ["plugin.ui.state.mutate"],
    });
    const installed = await importer.installUserPlugin({
      pluginId: request.pluginId,
      packageVersion: "1.0.0",
      approvedCapabilities: ["plugin.ui.state.mutate"],
    });
    expect(installed).toMatchObject({ok: true, installationId: expect.any(String)});
    if (!installed.ok) throw new Error("Expected imported installation.");
    const navigation = await importer.listUserPluginNavigation();
    expect(navigation).toContainEqual(expect.objectContaining({
      pluginId: request.pluginId,
      title: request.surfaceTitle,
    }));
    const opened = await importer.interactUserPluginSurface({
      pluginId: request.pluginId,
      expectedInstallationId: installed.installationId,
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {kind: "open"},
    });
    expect(opened).toMatchObject({
      ok: true,
      document: {title: request.surfaceTitle},
    });
    await expect(importer.uninstallUserPlugin({
      pluginId: request.pluginId,
      expectedInstallationId: installed.installationId,
    })).resolves.toMatchObject({ok: true, retainedState: true});
    await expect(importer.listDetachedUserPluginStates()).resolves.toContainEqual(
      expect.objectContaining({pluginId: request.pluginId}),
    );
  });

  it("does not grant authoring authority to a normal authenticated user", async () => {
    using publicApi = await connect();
    const token = await publicApi.createAccount("ordinaryauthor", "Ordinary", PASSWORD_HASH);
    if (token === null) throw new Error("Expected ordinary account.");
    using authenticated = await publicApi.authenticate(token);
    await expect(authenticated.stageUserPluginCandidate({
      template: "focus-brief",
      pluginId: "community.denied",
      packageVersion: "1.0.0",
      title: "Denied",
      summary: "Must remain denied.",
      surfaceTitle: "Denied",
      items: ["No authority"],
    })).resolves.toEqual({ok: false, error: "ADMIN_REQUIRED"});
  });
});
