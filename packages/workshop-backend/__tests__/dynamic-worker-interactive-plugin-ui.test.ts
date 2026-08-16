import {describe, expect, it, vi} from "vitest";
import {
  DynamicWorkerInteractivePluginUi,
  type InteractivePluginUiWorkerStarter,
} from "../src/dynamic-worker-interactive-plugin-ui.js";
import type {PluginUiArtifactResolver} from "../src/dynamic-worker-plugin-ui-renderer.js";

const DIGEST = `sha256:${"d".repeat(64)}`;

describe("DynamicWorkerInteractivePluginUi", () => {
  it("runs a pure reducer with fixed isolation and returns only closed owned output", async () => {
    const artifacts: PluginUiArtifactResolver = {
      resolve: vi.fn(async () => ({
        ok: true,
        artifact: Object.freeze({
          codeArtifactDigest: DIGEST,
          code: "export default { render() {}, reduce() {} };",
          byteLength: 48,
        }),
      })),
    };
    const source = {
      state: {tasks: [{id: "one", title: "First"}]},
      document: {
        schemaVersion: 1,
        title: "Kanban",
        form: {actionId: "task.create", label: "Add", placeholder: "Task", maxLength: 200},
        columns: [{
          columnId: "todo",
          title: "To do",
          items: [{
            itemId: "one",
            title: "First",
            actions: [{actionId: "task.delete:one", label: "Delete", tone: "danger"}],
          }],
        }],
      },
    };
    const starter: InteractivePluginUiWorkerStarter = {
      interact: vi.fn(async (getCode, request) => {
        const code = await getCode();
        expect(code.env).toEqual({});
        expect(code.globalOutbound).toBeNull();
        expect(code.limits).toEqual({cpuMs: 50, subRequests: 1});
        expect(code.modules["plugin-ui.js"]).toContain("reduce()");
        expect(request).toMatchObject({kind: "action", revision: 0});
        return source;
      }),
    };

    const result = await new DynamicWorkerInteractivePluginUi(starter, artifacts).interact(
      DIGEST,
      {
        kind: "action",
        state: null,
        revision: 0,
        action: {actionId: "task.create", input: "First"},
      },
    );

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
    expect(result!.document).not.toBe(source.document);
  });

  it("collapses malformed worker output without exposing a partial document", async () => {
    const artifacts: PluginUiArtifactResolver = {
      resolve: vi.fn(async () => ({
        ok: true,
        artifact: Object.freeze({
          codeArtifactDigest: DIGEST,
          code: "export default {};",
          byteLength: 18,
        }),
      })),
    };
    const starter: InteractivePluginUiWorkerStarter = {
      interact: vi.fn(async () => ({
        state: null,
        document: {schemaVersion: 1, title: "Bad", form: null, columns: [{
          columnId: "todo",
          title: "To do",
          items: [{itemId: "x", title: "x", actions: [{
            actionId: "forged",
            label: "x",
            tone: "script",
          }]}],
        }]},
      })),
    };

    await expect(new DynamicWorkerInteractivePluginUi(starter, artifacts).interact(
      DIGEST,
      {kind: "open", state: null},
    )).resolves.toBeNull();
  });
});
