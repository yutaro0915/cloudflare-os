import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimePluginPlan } from "../src/plugin-reconciler.js";
import {
  DynamicWorkerPluginExecutionActivator,
  WorkerLoaderPluginWorkerStarter,
  pluginActivationKey,
  type PluginCapabilityGatePreparation,
  type PluginCapabilityGateRegistry,
  type PluginRuntimeRealmIdentity,
  type PluginWorkerControl,
  type PluginWorkerStarter,
} from "../src/dynamic-worker-plugin-activator.js";
import {
  VerifyingPluginCodeArtifactResolver,
  type PluginCodeArtifactStore,
} from "../src/plugin-code-artifact.js";

const CODE = `export default { handshake() { return "ok"; } };\n`;
const DIGEST = "sha256:5b056b8472e4c36854cb9fdaa5c173b5dada6ddf49e86006c5851eff8091e8c8";
const REALM: PluginRuntimeRealmIdentity = {
  overseerId: "workspace-a",
  userId: "user-a",
  role: "build",
  generation: "generation-a",
};

function plan(overrides: Partial<RuntimePluginPlan["installation"]> = {}): RuntimePluginPlan {
  return {
    installation: {
      scope: "user",
      targetId: "user-a",
      installationId: "installation-a",
      pluginId: "example.runtime",
      packageVersion: "1.0.0",
      manifestDigest: `sha256:${"b".repeat(64)}`,
      grantedCapabilities: [],
      config: {mode: "safe"},
      ...overrides,
    },
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest: DIGEST},
  };
}

class MutableStore implements PluginCodeArtifactStore {
  values = [CODE];
  reads = 0;

  async read(): Promise<string | null> {
    const value = this.values[Math.min(this.reads, this.values.length - 1)] ?? null;
    this.reads += 1;
    return value;
  }
}

class FakeStarter implements PluginWorkerStarter {
  ids: string[] = [];
  definitions: WorkerLoaderWorkerCode[] = [];
  verifyError?: Error;
  verifyNeverSettles = false;
  invokeCodeTwice = false;

  async start(
      id: string,
      getCode: () => Promise<WorkerLoaderWorkerCode>): Promise<PluginWorkerControl> {
    this.ids.push(id);
    this.definitions.push(await getCode());
    if (this.invokeCodeTwice) this.definitions.push(await getCode());
    return {
      verify: async () => {
        if (this.verifyError) throw this.verifyError;
        if (this.verifyNeverSettles) await new Promise<never>(() => {});
      },
    };
  }
}

class FakeGateRegistry implements PluginCapabilityGateRegistry {
  stagedKeys: string[] = [];
  abortedKeys: string[] = [];
  selectedKey?: string;

  stage(_plan: RuntimePluginPlan, activationKey: string): PluginCapabilityGatePreparation {
    this.stagedKeys.push(activationKey);
    let committed = false;
    return {
      env: {PLUGIN_HOST: {activationKey}},
      commit: () => {
        committed = true;
        this.selectedKey = activationKey;
        return {
          revoke: () => {
            if (this.selectedKey === activationKey) this.selectedKey = undefined;
          },
        };
      },
      abort: () => {
        if (committed) return;
        this.abortedKeys.push(activationKey);
      },
    };
  }
}

describe("Dynamic Worker plugin activator", () => {
  afterEach(() => vi.useRealTimers());

  it("builds only a host-authored default-deny Worker after re-verifying artifact bytes", async () => {
    const store = new MutableStore();
    const starter = new FakeStarter();
    starter.invokeCodeTwice = true;
    const gates = new FakeGateRegistry();
    const activator = new DynamicWorkerPluginExecutionActivator(
      REALM,
      starter,
      new VerifyingPluginCodeArtifactResolver(store),
      gates,
    );

    const prepared = await activator.prepare(plan(), () => {});

    expect(store.reads).toBe(2);
    expect(starter.definitions[1]).toEqual(starter.definitions[0]);
    expect(starter.definitions[0]).toMatchObject({
      compatibilityDate: "2026-02-01",
      compatibilityFlags: ["disallow_importable_env"],
      mainModule: "plugin-harness.js",
      modules: {"plugin.js": CODE},
      env: {PLUGIN_HOST: {activationKey: starter.ids[0]}},
      globalOutbound: null,
      limits: {cpuMs: 50, subRequests: 16},
    });
    expect(gates.selectedKey).toBeUndefined();
    const active = prepared.commit();
    expect(gates.selectedKey).toBe(starter.ids[0]);
    active.revoke();
    expect(gates.selectedKey).toBeUndefined();
  });

  it("aborts staging when a repeated loader callback sees tampered bytes", async () => {
    const store = new MutableStore();
    store.values = [CODE, `${CODE}// forged`];
    const starter = new FakeStarter();
    starter.invokeCodeTwice = true;
    const gates = new FakeGateRegistry();
    const activator = new DynamicWorkerPluginExecutionActivator(
      REALM,
      starter,
      new VerifyingPluginCodeArtifactResolver(store),
      gates,
    );

    await expect(activator.prepare(plan(), () => {}))
      .rejects.toThrow("ARTIFACT_DIGEST_MISMATCH");
    expect(gates.selectedKey).toBeUndefined();
    expect(gates.abortedKeys).toEqual(gates.stagedKeys);
  });

  it("fails closed before staging when capability bindings are not implemented", async () => {
    const store = new MutableStore();
    const starter = new FakeStarter();
    const gates = new FakeGateRegistry();
    const activator = new DynamicWorkerPluginExecutionActivator(
      REALM,
      starter,
      new VerifyingPluginCodeArtifactResolver(store),
      gates,
    );

    await expect(activator.prepare(plan({grantedCapabilities: ["ui.panel"]}), () => {}))
      .rejects.toThrow("Plugin capability bindings are not implemented");
    expect(store.reads).toBe(0);
    expect(starter.ids).toEqual([]);
    expect(gates.stagedKeys).toEqual([]);
  });

  it("aborts staging when the fixed entrypoint handshake fails", async () => {
    const starter = new FakeStarter();
    starter.verifyError = new Error("handshake failed");
    const gates = new FakeGateRegistry();
    const activator = new DynamicWorkerPluginExecutionActivator(
      REALM,
      starter,
      new VerifyingPluginCodeArtifactResolver(new MutableStore()),
      gates,
    );

    await expect(activator.prepare(plan(), () => {})).rejects.toThrow("handshake failed");
    expect(gates.selectedKey).toBeUndefined();
    expect(gates.abortedKeys).toEqual(gates.stagedKeys);
  });

  it("times out a handshake that never settles and aborts staging", async () => {
    vi.useFakeTimers();
    const starter = new FakeStarter();
    starter.verifyNeverSettles = true;
    const gates = new FakeGateRegistry();
    const activator = new DynamicWorkerPluginExecutionActivator(
      REALM,
      starter,
      new VerifyingPluginCodeArtifactResolver(new MutableStore()),
      gates,
    );

    const preparing = activator.prepare(plan(), () => {});
    const rejection = expect(preparing).rejects.toThrow("Plugin handshake timed out");
    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(gates.selectedKey).toBeUndefined();
    expect(gates.abortedKeys).toEqual(gates.stagedKeys);
  });

  it("keys warm workers by the complete authority and runtime policy definition", async () => {
    const base = plan();
    const expected = await pluginActivationKey(REALM, base);
    expect(expected).toBe(
      "plugin-worker:v1:aec392f38111805aa92435a4aa74c28ff92cfce2b98d506d4235d029606582ef",
    );
    await expect(pluginActivationKey(structuredClone(REALM), structuredClone(base)))
      .resolves.toBe(expected);

    const variants: RuntimePluginPlan[] = [
      plan({targetId: "user-b"}),
      plan({installationId: "installation-b"}),
      plan({manifestDigest: `sha256:${"c".repeat(64)}`}),
      plan({grantedCapabilities: ["ui.panel"]}),
      plan({config: {mode: "other"}}),
      {...plan(), runtime: {kind: "dynamic-worker", codeArtifactDigest: `sha256:${"d".repeat(64)}`}},
    ];
    for (const variant of variants) {
      await expect(pluginActivationKey(REALM, variant)).resolves.not.toBe(expected);
    }

    const realmVariants: PluginRuntimeRealmIdentity[] = [
      {...REALM, overseerId: "workspace-b"},
      {...REALM, userId: "user-b"},
      {...REALM, role: "use"},
      {...REALM, generation: "generation-b"},
    ];
    for (const realm of realmVariants) {
      await expect(pluginActivationKey(realm, base)).resolves.not.toBe(expected);
    }
  });

  it.each([NaN, Infinity, -Infinity, -0])(
    "rejects non-JSON-safe numeric configuration %s",
    async invalidNumber => {
      await expect(pluginActivationKey(REALM, plan({config: invalidNumber})))
        .rejects.toThrow("finite JSON number");
    },
  );

  it("rejects cyclic and non-plain configuration objects", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicPlan = plan();
    Reflect.set(cyclicPlan.installation, "config", cyclic);
    const datedPlan = plan();
    Reflect.set(datedPlan.installation, "config", new Date(0));

    await expect(pluginActivationKey(REALM, cyclicPlan)).rejects.toThrow("cyclic");
    await expect(pluginActivationKey(REALM, datedPlan)).rejects.toThrow("plain JSON objects");
  });

  it("uses the real Worker Loader type without exposing it to the domain activator", () => {
    expect(WorkerLoaderPluginWorkerStarter).toBeTypeOf("function");
  });
});
