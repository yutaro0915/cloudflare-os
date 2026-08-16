import {env} from "cloudflare:test";
import type {WorkerEntrypoint} from "cloudflare:workers";
import {describe, expect, it} from "vitest";
import focusGuideManifest from "../plugin-manifests/circle.focus-guide.json";
import focusGuideRuntimeSource from "../plugin-manifests/circle.focus-guide.runtime.js?raw";
import focusGuideUiSource from "../plugin-manifests/circle.focus-guide.ui.js?raw";
import {
  DynamicWorkerPluginUiRenderer,
  WorkerLoaderPluginUiWorkerStarter,
} from "../src/dynamic-worker-plugin-ui-renderer.js";
import {VerifyingPluginCodeArtifactResolver} from "../src/plugin-code-artifact.js";

const RUNTIME_HARNESS = `
import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  async verify() {
    const plugin = await import("plugin.js");
    if (typeof plugin.default?.handshake !== "function" ||
        typeof plugin.default?.invoke !== "function") {
      throw new TypeError("Plugin runtime must export default.handshake() and default.invoke().");
    }
    await plugin.default.handshake();
    await plugin.default.invoke();
  }
}
`;

interface RuntimeContractEntrypoint extends WorkerEntrypoint {
  verify(): Promise<void>;
}

function disposeRpcValue(value: object): void {
  if (!(Symbol.dispose in value)) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === "function") dispose.call(value);
}

describe("production plugin Store artifact", () => {
  it("executes the exact reviewed Focus Guide UI in a real Dynamic Worker", async () => {
    const contribution = focusGuideManifest.uiContributions.find(entry =>
      entry.contributionId === "focus-session" &&
      entry.renderer.kind === "worker-rendered-document-v1");
    if (contribution?.renderer.kind !== "worker-rendered-document-v1") {
      throw new Error("Expected the production Focus Guide worker-rendered contribution.");
    }
    const expectedDigest = contribution.renderer.codeArtifactDigest;
    const artifacts = new VerifyingPluginCodeArtifactResolver({
      read: async digest => digest === expectedDigest ? focusGuideUiSource : null,
    });
    const renderer = new DynamicWorkerPluginUiRenderer(
      new WorkerLoaderPluginUiWorkerStarter(env.LOADER),
      artifacts,
    );

    await expect(renderer.render(expectedDigest)).resolves.toEqual({
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

  it("executes the exact reviewed Focus Guide runtime ABI in a real Dynamic Worker", async () => {
    const expectedDigest = focusGuideManifest.runtime.codeArtifactDigest;
    const artifacts = new VerifyingPluginCodeArtifactResolver({
      read: async digest => digest === expectedDigest ? focusGuideRuntimeSource : null,
    });
    const resolved = await artifacts.resolve(expectedDigest);
    if (!resolved.ok) throw new Error("Expected the production Focus Guide runtime artifact.");

    const entrypoint = env.LOADER.load({
      compatibilityDate: "2026-02-01",
      compatibilityFlags: ["disallow_importable_env"],
      mainModule: "runtime-contract.js",
      modules: {
        "runtime-contract.js": RUNTIME_HARNESS,
        "plugin.js": resolved.artifact.code,
      },
      env: {},
      globalOutbound: null,
      limits: {cpuMs: 50, subRequests: 1},
    }).getEntrypoint<RuntimeContractEntrypoint>();
    const pending = entrypoint.verify();
    try {
      await expect(pending).resolves.toBeUndefined();
    } finally {
      disposeRpcValue(pending);
      disposeRpcValue(entrypoint);
    }
  });
});
