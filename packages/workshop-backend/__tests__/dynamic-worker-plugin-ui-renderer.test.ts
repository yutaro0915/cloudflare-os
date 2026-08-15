import {describe, expect, it, vi} from "vitest";
import {
  DynamicWorkerPluginUiRenderer,
  type PluginUiArtifactResolver,
  type PluginUiWorkerStarter,
} from "../src/dynamic-worker-plugin-ui-renderer.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("DynamicWorkerPluginUiRenderer", () => {
  it("runs verified code only behind fixed limits and returns an owned closed document", async () => {
    const artifacts: PluginUiArtifactResolver = {
      resolve: vi.fn<PluginUiArtifactResolver["resolve"]>(async () => ({
        ok: true,
        artifact: Object.freeze({
          codeArtifactDigest: DIGEST,
          code: "export default { render() { return {}; } };",
          byteLength: 44,
        }),
      })),
    };
    const source = {schemaVersion: 1, blocks: [{kind: "text", text: "Isolated"}]};
    const starter: PluginUiWorkerStarter = {
      render: vi.fn<PluginUiWorkerStarter["render"]>(async getCode => {
        const code = await getCode();
        expect(code.globalOutbound).toBeNull();
        expect(code.env).toEqual({});
        expect(code.limits).toEqual({cpuMs: 50, subRequests: 1});
        expect(code.mainModule).toBe("plugin-ui-harness.js");
        expect(code.modules["plugin-ui.js"]).toContain("render()");
        return source;
      }),
    };

    const renderer = new DynamicWorkerPluginUiRenderer(starter, artifacts);
    const rendered = await renderer.render(DIGEST);
    expect(rendered).toEqual(source);
    expect(rendered).not.toBe(source);
    expect(Object.isFrozen(rendered)).toBe(true);
    expect(Object.isFrozen(rendered!.blocks)).toBe(true);
  });

  it("rejects malformed worker output without returning partial UI", async () => {
    const artifacts: PluginUiArtifactResolver = {
      resolve: vi.fn<PluginUiArtifactResolver["resolve"]>(async () => ({
        ok: true,
        artifact: Object.freeze({
          codeArtifactDigest: DIGEST,
          code: "export default {};",
          byteLength: 18,
        }),
      })),
    };
    const starter: PluginUiWorkerStarter = {
      render: vi.fn<PluginUiWorkerStarter["render"]>(async () => ({
        schemaVersion: 1,
        blocks: [{kind: "text", text: "x".repeat(2_001)}],
      })),
    };

    await expect(new DynamicWorkerPluginUiRenderer(starter, artifacts).render(DIGEST))
      .resolves.toBeNull();
  });
});
