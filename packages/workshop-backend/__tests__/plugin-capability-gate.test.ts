import { describe, expect, it } from "vitest";
import type { RuntimePluginPlan } from "../src/plugin-reconciler.js";
import { InMemoryPluginCapabilityGateRegistry } from "../src/plugin-capability-gate.js";

function plan(packageVersion: string): RuntimePluginPlan {
  return {
    installation: {
      scope: "workspace",
      targetId: "workspace-a",
      installationId: "installation-a",
      pluginId: "example.runtime",
      packageVersion,
      manifestDigest: `sha256:${packageVersion.replaceAll(".", "").padEnd(64, "0")}`,
      grantedCapabilities: [],
      config: null,
    },
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest: `sha256:${"a".repeat(64)}`},
  };
}

describe("plugin capability gate", () => {
  it("does not retain staged authority when binding creation fails", () => {
    const gates = new InMemoryPluginCapabilityGateRegistry(() => {
      throw new Error("binding creation failed");
    });

    expect(() => gates.stage(plan("1.0.0"), "activation-leaked"))
      .toThrow("binding creation failed");
    expect(gates.isStaged("activation-leaked")).toBe(false);
    expect(gates.isActive("example.runtime", "activation-leaked")).toBe(false);
  });

  it("keeps candidates staged until commit and atomically rejects the old activation", () => {
    const gates = new InMemoryPluginCapabilityGateRegistry(key => ({PLUGIN_HOST: {key}}));
    const first = gates.stage(plan("1.0.0"), "activation-v1");
    expect(gates.isStaged("activation-v1")).toBe(true);
    expect(gates.isActive("example.runtime", "activation-v1")).toBe(false);
    const firstActive = first.commit();
    expect(gates.isActive("example.runtime", "activation-v1")).toBe(true);

    const second = gates.stage(plan("2.0.0"), "activation-v2");
    expect(gates.isActive("example.runtime", "activation-v1")).toBe(true);
    const secondActive = second.commit(firstActive);

    expect(gates.isActive("example.runtime", "activation-v1")).toBe(false);
    expect(gates.isActive("example.runtime", "activation-v2")).toBe(true);
    firstActive.revoke();
    expect(gates.isActive("example.runtime", "activation-v2")).toBe(true);
    secondActive.revoke();
    expect(gates.isActive("example.runtime", "activation-v2")).toBe(false);
  });

  it("aborts an uncommitted gate and defaults to deny after host reconstruction", () => {
    const gates = new InMemoryPluginCapabilityGateRegistry(key => ({PLUGIN_HOST: {key}}));
    const staged = gates.stage(plan("1.0.0"), "activation-v1");
    staged.abort();
    expect(gates.isStaged("activation-v1")).toBe(false);

    const active = gates.stage(plan("1.0.0"), "activation-v1").commit();
    expect(gates.isActive("example.runtime", "activation-v1")).toBe(true);
    const reconstructed = new InMemoryPluginCapabilityGateRegistry(
      key => ({PLUGIN_HOST: {key}}),
    );
    expect(reconstructed.isActive("example.runtime", "activation-v1")).toBe(false);
    active.revoke();
  });

  it("seals a released realm before an in-flight candidate can commit", () => {
    const gates = new InMemoryPluginCapabilityGateRegistry(key => ({PLUGIN_HOST: {key}}));
    const active = gates.stage(plan("1.0.0"), "activation-v1").commit();
    const inFlight = gates.stage(plan("2.0.0"), "activation-v2");

    gates.close();

    expect(gates.isActive("example.runtime", "activation-v1")).toBe(false);
    expect(gates.isStaged("activation-v2")).toBe(false);
    expect(() => inFlight.commit(active)).toThrow("Plugin capability gate realm is closed");
    expect(() => gates.stage(plan("3.0.0"), "activation-v3"))
      .toThrow("Plugin capability gate realm is closed");
  });
});
