import {describe, expect, it} from "vitest";
import {bundledPluginCodeArtifactResolver} from "../src/bundled-plugin-artifacts.js";
import {bundledPluginManifestResolver} from "../src/bundled-plugin-manifests.js";
import {
  DynamicWorkerPluginUiRenderer,
  type PluginUiWorkerStarter,
} from "../src/dynamic-worker-plugin-ui-renderer.js";

class ProductionArtifactStarter implements PluginUiWorkerStarter {
  async render(getCode: () => Promise<WorkerLoaderWorkerCode>): Promise<unknown> {
    const code = await getCode();
    expect(code).toMatchObject({
      mainModule: "plugin-ui-harness.js",
      env: {},
      globalOutbound: null,
      limits: {cpuMs: 50, subRequests: 1},
    });
    expect(code.modules["plugin-ui.js"]).toContain("Focus session ready");
    return {
      schemaVersion: 1,
      blocks: [
        {kind: "notice", tone: "info", text: "Focus session ready"},
        {kind: "list", items: [
          "Pick one task",
          "Work for 25 minutes",
          "Share the result",
        ]},
      ],
    };
  }
}

describe("production plugin store", () => {
  it("publishes the reviewed Focus Guide package and builds its isolated display definition", async () => {
    const catalog = await bundledPluginManifestResolver;
    const manifests = await catalog.list();

    const manifest = manifests.find(entry =>
      entry.pluginId === "circle.focus-guide" && entry.packageVersion === "1.0.0");
    expect(manifest).toMatchObject({
      schemaVersion: 4,
      pluginId: "circle.focus-guide",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies: [],
      presentation: {
        title: "Circle Focus Guide",
        summary: "A lightweight focus ritual for programming-circle sessions.",
      },
    });
    if (manifest?.schemaVersion !== 4 || manifest.runtime === undefined) {
      throw new Error("Expected the production Focus Guide manifest.");
    }

    await expect(bundledPluginCodeArtifactResolver.resolve(
      manifest.runtime.codeArtifactDigest,
    )).resolves.toMatchObject({ok: true});

    const contribution = manifest.uiContributions.find(entry =>
      entry.contributionId === "focus-session" &&
      entry.renderer.kind === "worker-rendered-document-v1");
    if (contribution?.renderer.kind !== "worker-rendered-document-v1") {
      throw new Error("Expected the Focus Guide worker-rendered contribution.");
    }
    const renderer = new DynamicWorkerPluginUiRenderer(
      new ProductionArtifactStarter(),
      bundledPluginCodeArtifactResolver,
    );
    await expect(renderer.render(contribution.renderer.codeArtifactDigest)).resolves.toEqual({
      schemaVersion: 1,
      blocks: [
        {kind: "notice", tone: "info", text: "Focus session ready"},
        {kind: "list", items: [
          "Pick one task",
          "Work for 25 minutes",
          "Share the result",
        ]},
      ],
    });
  });
});
