import { describe, expect, it, vi } from "vitest";
import type { PluginRuntimeRealmIdentity } from "../src/dynamic-worker-plugin-activator.js";
import { makePluginRuntimeCapabilityEnv } from "../src/plugin-runtime-capability-env.js";
import type { RuntimePluginPlan } from "../src/plugin-reconciler.js";

const REALM: PluginRuntimeRealmIdentity = {
  overseerId: "workspace-a",
  userId: "user-a",
  role: "build",
  generation: "generation-a",
};

function plan(grantedCapabilities: string[]): RuntimePluginPlan {
  return {
    installation: {
      scope: "user",
      targetId: "user-a",
      installationId: "installation-a",
      pluginId: "example.runtime",
      packageVersion: "1.0.0",
      manifestDigest: `sha256:${"a".repeat(64)}`,
      grantedCapabilities,
      config: null,
    },
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest: `sha256:${"b".repeat(64)}`},
  };
}

describe("plugin runtime capability env", () => {
  it("injects a metadata binding only for the exact granted capability", () => {
    const pluginHost = vi.fn(() => "plugin-host-stub");
    const workspaceMetadata = vi.fn(() => "metadata-stub");
    const pluginState = vi.fn(() => "state-stub");

    const granted = makePluginRuntimeCapabilityEnv(
      REALM,
      plan(["workspace.metadata.read"]),
      "activation-a",
      {pluginHost, workspaceMetadata, pluginState},
    );
    const ungranted = makePluginRuntimeCapabilityEnv(
      REALM,
      plan([]),
      "activation-b",
      {pluginHost, workspaceMetadata, pluginState},
    );

    expect(granted).toEqual({
      PLUGIN_HOST: "plugin-host-stub",
      WORKSPACE_METADATA: "metadata-stub",
    });
    expect(ungranted).toEqual({PLUGIN_HOST: "plugin-host-stub"});
    expect(workspaceMetadata).toHaveBeenCalledTimes(1);
    expect(pluginState).not.toHaveBeenCalled();
    expect(workspaceMetadata.mock.calls[0]?.[0]).toMatchObject({
      overseerId: REALM.overseerId,
      userId: REALM.userId,
      role: REALM.role,
      generation: REALM.generation,
      pluginId: "example.runtime",
      activationKey: "activation-a",
    });
  });

  it("injects installation state only for the exact state-read grant", () => {
    const bindings = {
      pluginHost: vi.fn(() => "plugin-host-stub"),
      workspaceMetadata: vi.fn(() => "metadata-stub"),
      pluginState: vi.fn(() => "state-stub"),
    };

    const granted = makePluginRuntimeCapabilityEnv(
      REALM,
      plan(["plugin.state.read"]),
      "activation-state",
      bindings,
    );

    expect(granted).toEqual({
      PLUGIN_HOST: "plugin-host-stub",
      PLUGIN_STATE: "state-stub",
    });
    expect(bindings.pluginState).toHaveBeenCalledTimes(1);
    expect(bindings.workspaceMetadata).not.toHaveBeenCalled();
  });

});
