import { describe, expect, it } from "vitest";
import type { EffectivePluginInstallation } from "../src/plugin-effective-configuration.js";
import {
  PluginReconciler,
  type PluginRuntimeAdapter,
  type RuntimePluginPlan,
} from "../src/plugin-reconciler.js";

interface FakeLease {
  id: string;
  pluginId: string;
  packageVersion: string;
}

class FakeRuntimeAdapter implements PluginRuntimeAdapter<FakeLease> {
  readonly events: string[] = [];
  readonly active = new Map<string, FakeLease>();
  readonly failReplace = new Set<string>();
  readonly failRemove = new Set<string>();

  async replace(candidate: RuntimePluginPlan, previous?: FakeLease): Promise<FakeLease> {
    const {pluginId, packageVersion} = candidate.installation;
    this.events.push(`replace:${pluginId}@${packageVersion}:${previous?.id ?? "none"}`);
    if (this.failReplace.has(`${pluginId}@${packageVersion}`)) {
      throw new Error("activation failed");
    }
    const lease = {id: crypto.randomUUID(), pluginId, packageVersion};
    this.active.set(pluginId, lease);
    return lease;
  }

  async remove(active: FakeLease): Promise<void> {
    this.events.push(`remove:${active.id}`);
    if (this.failRemove.has(active.pluginId)) throw new Error("deactivation failed");
    this.active.delete(active.pluginId);
  }
}

class BlockingRuntimeAdapter implements PluginRuntimeAdapter<FakeLease> {
  readonly events: string[] = [];
  readonly firstEntered: Promise<void>;
  #resolveFirstEntered!: () => void;
  #releaseFirst!: () => void;
  #firstRelease: Promise<void>;
  #leaseSequence = 0;

  constructor() {
    this.firstEntered = new Promise(resolve => { this.#resolveFirstEntered = resolve; });
    this.#firstRelease = new Promise(resolve => { this.#releaseFirst = resolve; });
  }

  releaseFirst(): void {
    this.#releaseFirst();
  }

  async replace(candidate: RuntimePluginPlan, previous?: FakeLease): Promise<FakeLease> {
    const {pluginId, packageVersion} = candidate.installation;
    this.events.push(`replace:${packageVersion}:${previous?.id ?? "none"}`);
    if (this.#leaseSequence === 0) {
      this.#resolveFirstEntered();
      await this.#firstRelease;
    }
    this.#leaseSequence += 1;
    return {id: `lease-${this.#leaseSequence}`, pluginId, packageVersion};
  }

  async remove(active: FakeLease): Promise<void> {
    this.events.push(`remove:${active.id}`);
  }
}

function installation(
    pluginId: string, packageVersion = "1.0.0"): EffectivePluginInstallation {
  return {
    scope: "user",
    targetId: "user-target",
    installationId: `installation-${pluginId}`,
    pluginId,
    packageVersion,
    manifestDigest: `sha256:${packageVersion.replaceAll(".", "").padEnd(64, "0")}`,
    grantedCapabilities: ["ui.panel"],
    config: null,
  };
}

function plan(pluginId: string, packageVersion = "1.0.0",
    dependencies: readonly string[] = []): RuntimePluginPlan {
  return {installation: installation(pluginId, packageVersion), dependencies};
}

function runtimeIdentity(pluginId: string, packageVersion = "1.0.0") {
  return {
    installationId: `installation-${pluginId}`,
    pluginId,
    packageVersion,
    manifestDigest: `sha256:${packageVersion.replaceAll(".", "").padEnd(64, "0")}`,
  };
}

describe("plugin reconciler", () => {
  it("activates an initial desired plugin through the runtime port", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);

    await expect(reconciler.reconcile({ok: true, plans: [plan("notes.plugin")]})).resolves.toEqual({
      ok: true,
      states: [{
        pluginId: "notes.plugin",
        status: "active",
        active: {
          installationId: "installation-notes.plugin",
          pluginId: "notes.plugin",
          packageVersion: "1.0.0",
          manifestDigest: `sha256:${"100".padEnd(64, "0")}`,
        },
      }],
    });
    expect(runtime.events).toEqual(["replace:notes.plugin@1.0.0:none"]);
  });

  it("does not touch the adapter when the complete desired plan is unchanged", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    const desired = {ok: true, plans: [plan("notes.plugin")]} as const;

    const first = await reconciler.reconcile(desired);
    const eventsAfterFirst = [...runtime.events];
    await expect(reconciler.reconcile(desired)).resolves.toEqual(first);
    expect(runtime.events).toEqual(eventsAfterFirst);
  });

  it("rebuilds runtime state from desired state in a new reconciler", async () => {
    const desired = {ok: true, plans: [plan("notes.plugin")]} as const;
    const firstRuntime = new FakeRuntimeAdapter();
    await new PluginReconciler(firstRuntime).reconcile(desired);
    const rebuiltRuntime = new FakeRuntimeAdapter();

    await new PluginReconciler(rebuiltRuntime).reconcile(desired);

    expect(rebuiltRuntime.events).toEqual(["replace:notes.plugin@1.0.0:none"]);
  });

  it("retains the old version when its candidate fails and activates unrelated plugins", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({ok: true, plans: [plan("a.plugin", "1.0.0")]});
    const oldLease = runtime.active.get("a.plugin");
    if (oldLease === undefined) throw new Error("Expected the initial runtime lease.");
    runtime.failReplace.add("a.plugin@2.0.0");

    await expect(reconciler.reconcile({
      ok: true,
      plans: [plan("b.plugin"), plan("a.plugin", "2.0.0")],
    })).resolves.toEqual({
      ok: true,
      states: [
        {
          pluginId: "a.plugin",
          status: "failed",
          candidate: runtimeIdentity("a.plugin", "2.0.0"),
          reason: "ACTIVATION_FAILED",
          retainedActive: runtimeIdentity("a.plugin", "1.0.0"),
        },
        {
          pluginId: "b.plugin",
          status: "active",
          active: runtimeIdentity("b.plugin"),
        },
      ],
    });
    expect(runtime.active.get("a.plugin")).toBe(oldLease);
    expect(runtime.active.get("b.plugin")).toMatchObject({packageVersion: "1.0.0"});
    expect(runtime.events.slice(1)).toEqual([
      `replace:a.plugin@2.0.0:${oldLease.id}`,
      "replace:b.plugin@1.0.0:none",
    ]);
  });

  it("commits a successful replacement through the previous runtime lease", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({ok: true, plans: [plan("notes.plugin", "1.0.0")]});
    const previous = runtime.active.get("notes.plugin");
    if (previous === undefined) throw new Error("Expected the initial runtime lease.");

    await expect(reconciler.reconcile({
      ok: true,
      plans: [plan("notes.plugin", "2.0.0")],
    })).resolves.toEqual({
      ok: true,
      states: [{
        pluginId: "notes.plugin",
        status: "active",
        active: runtimeIdentity("notes.plugin", "2.0.0"),
      }],
    });
    expect(runtime.events.at(-1)).toBe(`replace:notes.plugin@2.0.0:${previous.id}`);
    expect(runtime.active.get("notes.plugin")).toMatchObject({packageVersion: "2.0.0"});
  });

  it("removes only runtimes absent from desired state", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({
      ok: true,
      plans: [plan("a.plugin"), plan("b.plugin")],
    });
    const removed = runtime.active.get("a.plugin");
    if (removed === undefined) throw new Error("Expected the runtime selected for removal.");

    await expect(reconciler.reconcile({
      ok: true,
      plans: [plan("b.plugin")],
    })).resolves.toEqual({
      ok: true,
      states: [{
        pluginId: "b.plugin",
        status: "active",
        active: runtimeIdentity("b.plugin"),
      }],
    });
    expect(runtime.events.at(-1)).toBe(`remove:${removed.id}`);
    expect(runtime.active.has("a.plugin")).toBe(false);
    expect(runtime.active.has("b.plugin")).toBe(true);
  });

  it("retains a runtime whose removal failed so the next pass can retry", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({ok: true, plans: [plan("notes.plugin")]});
    const retained = runtime.active.get("notes.plugin");
    if (retained === undefined) throw new Error("Expected the runtime selected for removal.");
    runtime.failRemove.add("notes.plugin");

    await expect(reconciler.reconcile({ok: true, plans: []})).resolves.toEqual({
      ok: true,
      states: [{
        pluginId: "notes.plugin",
        status: "failed",
        reason: "DEACTIVATION_FAILED",
        retainedActive: runtimeIdentity("notes.plugin"),
      }],
    });
    expect(runtime.active.get("notes.plugin")).toBe(retained);

    runtime.failRemove.delete("notes.plugin");
    await expect(reconciler.reconcile({ok: true, plans: []})).resolves.toEqual({
      ok: true,
      states: [],
    });
    expect(runtime.active.has("notes.plugin")).toBe(false);
  });

  it("suspends missing dependencies, rejects cycles, and activates unrelated plugins", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);

    await expect(reconciler.reconcile({
      ok: true,
      plans: [
        plan("downstream.plugin", "1.0.0", ["cycle.one"]),
        plan("cycle.two", "1.0.0", ["cycle.one"]),
        plan("independent.plugin"),
        plan("missing.plugin.consumer", "1.0.0", ["not.installed"]),
        plan("cycle.one", "1.0.0", ["cycle.two"]),
      ],
    })).resolves.toEqual({
      ok: true,
      states: [
        {
          pluginId: "cycle.one",
          status: "failed",
          candidate: runtimeIdentity("cycle.one"),
          reason: "CYCLIC_DEPENDENCY",
        },
        {
          pluginId: "cycle.two",
          status: "failed",
          candidate: runtimeIdentity("cycle.two"),
          reason: "CYCLIC_DEPENDENCY",
        },
        {
          pluginId: "downstream.plugin",
          status: "suspended",
          candidate: runtimeIdentity("downstream.plugin"),
          reason: "DEPENDENCY_UNAVAILABLE",
        },
        {
          pluginId: "independent.plugin",
          status: "active",
          active: runtimeIdentity("independent.plugin"),
        },
        {
          pluginId: "missing.plugin.consumer",
          status: "suspended",
          candidate: runtimeIdentity("missing.plugin.consumer"),
          reason: "MISSING_DEPENDENCY",
        },
      ],
    });
    expect(runtime.events).toEqual(["replace:independent.plugin@1.0.0:none"]);
  });

  it("stops an active consumer before reporting a newly missing dependency", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({
      ok: true,
      plans: [plan("dependency.plugin"), plan("consumer.plugin", "1.0.0", ["dependency.plugin"])],
    });
    const consumerLease = runtime.active.get("consumer.plugin");
    if (consumerLease === undefined) throw new Error("Expected the active consumer lease.");

    await expect(reconciler.reconcile({
      ok: true,
      plans: [plan("consumer.plugin", "1.0.0", ["dependency.plugin"])],
    })).resolves.toEqual({
      ok: true,
      states: [{
        pluginId: "consumer.plugin",
        status: "suspended",
        candidate: runtimeIdentity("consumer.plugin"),
        reason: "MISSING_DEPENDENCY",
      }],
    });
    expect(runtime.events).toContain(`remove:${consumerLease.id}`);
    const consumerRemovalIndex = runtime.events.indexOf(`remove:${consumerLease.id}`);
    const dependencyRemoval = runtime.events.findIndex(event =>
      event.startsWith("remove:") && event !== `remove:${consumerLease.id}`);
    expect(consumerRemovalIndex).toBeLessThan(dependencyRemoval);
    expect(runtime.active.has("consumer.plugin")).toBe(false);
    expect(runtime.active.has("dependency.plugin")).toBe(false);
  });

  it("reports teardown failure instead of claiming an active consumer is suspended", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({
      ok: true,
      plans: [
        plan("dependency.plugin"),
        plan("consumer.plugin", "1.0.0", ["dependency.plugin"]),
        plan("independent.plugin"),
      ],
    });
    runtime.failRemove.add("consumer.plugin");

    await expect(reconciler.reconcile({
      ok: true,
      plans: [plan("consumer.plugin", "1.0.0", ["dependency.plugin"])],
    })).resolves.toEqual({
      ok: true,
      states: [
        {
          pluginId: "consumer.plugin",
          status: "failed",
          candidate: runtimeIdentity("consumer.plugin"),
          reason: "DEACTIVATION_FAILED",
          retainedActive: runtimeIdentity("consumer.plugin"),
        },
        {
          pluginId: "dependency.plugin",
          status: "failed",
          reason: "DEACTIVATION_BLOCKED",
          retainedActive: runtimeIdentity("dependency.plugin"),
        },
      ],
    });
    expect(runtime.active.has("consumer.plugin")).toBe(true);
    expect(runtime.active.has("dependency.plugin")).toBe(true);
    expect(runtime.active.has("independent.plugin")).toBe(false);
  });

  it("keeps an old dependency when a failed update retains its consumer", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({
      ok: true,
      plans: [
        plan("dependency.plugin"),
        plan("consumer.plugin", "1.0.0", ["dependency.plugin"]),
      ],
    });
    runtime.failReplace.add("consumer.plugin@2.0.0");

    await expect(reconciler.reconcile({
      ok: true,
      plans: [plan("consumer.plugin", "2.0.0")],
    })).resolves.toEqual({
      ok: true,
      states: [
        {
          pluginId: "consumer.plugin",
          status: "failed",
          candidate: runtimeIdentity("consumer.plugin", "2.0.0"),
          reason: "ACTIVATION_FAILED",
          retainedActive: runtimeIdentity("consumer.plugin", "1.0.0"),
        },
        {
          pluginId: "dependency.plugin",
          status: "failed",
          reason: "DEACTIVATION_BLOCKED",
          retainedActive: runtimeIdentity("dependency.plugin"),
        },
      ],
    });
    expect(runtime.active.has("consumer.plugin")).toBe(true);
    expect(runtime.active.has("dependency.plugin")).toBe(true);
  });

  it("revalidates a retained dependency chain before stopping providers", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({
      ok: true,
      plans: [
        plan("c.base"),
        plan("b.provider", "1.0.0", ["c.base"]),
        plan("a.consumer", "1.0.0", ["b.provider"]),
      ],
    });
    const consumer = runtime.active.get("a.consumer");
    const provider = runtime.active.get("b.provider");
    const base = runtime.active.get("c.base");
    if (!consumer || !provider || !base) throw new Error("Expected the active dependency chain.");

    await expect(reconciler.reconcile({
      ok: true,
      plans: [
        plan("a.consumer", "2.0.0", ["missing.a"]),
        plan("b.provider", "2.0.0", ["missing.b"]),
      ],
    })).resolves.toEqual({
      ok: true,
      states: [
        {
          pluginId: "a.consumer",
          status: "suspended",
          candidate: runtimeIdentity("a.consumer", "2.0.0"),
          reason: "MISSING_DEPENDENCY",
        },
        {
          pluginId: "b.provider",
          status: "suspended",
          candidate: runtimeIdentity("b.provider", "2.0.0"),
          reason: "MISSING_DEPENDENCY",
        },
      ],
    });
    const removalEvents = runtime.events.filter(event => event.startsWith("remove:"));
    expect(removalEvents).toEqual([
      `remove:${consumer.id}`,
      `remove:${provider.id}`,
      `remove:${base.id}`,
    ]);
    expect(runtime.active.size).toBe(0);
  });

  it("keeps a transitive provider closure when the consumer cannot stop", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({
      ok: true,
      plans: [
        plan("c.base"),
        plan("b.provider", "1.0.0", ["c.base"]),
        plan("a.consumer", "1.0.0", ["b.provider"]),
        plan("independent.plugin"),
      ],
    });
    runtime.failRemove.add("a.consumer");

    await expect(reconciler.reconcile({
      ok: true,
      plans: [
        plan("a.consumer", "2.0.0", ["missing.a"]),
        plan("b.provider", "2.0.0", ["missing.b"]),
      ],
    })).resolves.toEqual({
      ok: true,
      states: [
        {
          pluginId: "a.consumer",
          status: "failed",
          candidate: runtimeIdentity("a.consumer", "2.0.0"),
          reason: "DEACTIVATION_FAILED",
          retainedActive: runtimeIdentity("a.consumer", "1.0.0"),
        },
        {
          pluginId: "b.provider",
          status: "failed",
          candidate: runtimeIdentity("b.provider", "2.0.0"),
          reason: "DEACTIVATION_BLOCKED",
          retainedActive: runtimeIdentity("b.provider", "1.0.0"),
        },
        {
          pluginId: "c.base",
          status: "failed",
          reason: "DEACTIVATION_BLOCKED",
          retainedActive: runtimeIdentity("c.base"),
        },
      ],
    });
    expect([...runtime.active.keys()].toSorted()).toEqual([
      "a.consumer", "b.provider", "c.base",
    ]);
  });

  it("does not activate a candidate through a provider scheduled to stop", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    await reconciler.reconcile({
      ok: true,
      plans: [
        plan("c.base"),
        plan("b.provider", "1.0.0", ["c.base"]),
        plan("a.consumer", "1.0.0", ["b.provider"]),
      ],
    });
    const eventsBefore = runtime.events.length;

    await expect(reconciler.reconcile({
      ok: true,
      plans: [
        plan("a.consumer", "2.0.0", ["b.provider"]),
        plan("b.provider", "2.0.0", ["missing.provider"]),
      ],
    })).resolves.toEqual({
      ok: true,
      states: [
        {
          pluginId: "a.consumer",
          status: "suspended",
          candidate: runtimeIdentity("a.consumer", "2.0.0"),
          reason: "DEPENDENCY_UNAVAILABLE",
        },
        {
          pluginId: "b.provider",
          status: "suspended",
          candidate: runtimeIdentity("b.provider", "2.0.0"),
          reason: "MISSING_DEPENDENCY",
        },
      ],
    });
    const transitionEvents = runtime.events.slice(eventsBefore);
    expect(transitionEvents.some(event => event.startsWith("replace:"))).toBe(false);
    expect(runtime.active.size).toBe(0);
  });

  it("leaves adapter calls and active state unchanged for an ambiguous configuration", async () => {
    const runtime = new FakeRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    const desired = {ok: true, plans: [plan("notes.plugin")]} as const;
    await reconciler.reconcile(desired);
    const eventsBeforeConflict = [...runtime.events];

    await expect(reconciler.reconcile({
      ok: false,
      error: "DUPLICATE_ENABLED_PLUGIN_ID",
      conflicts: [{
        pluginId: "notes.plugin",
        sources: [
          {scope: "deployment", targetId: "deployment-target", installationId: "deployment"},
          {scope: "user", targetId: "user-target", installationId: "user"},
        ],
      }],
    })).resolves.toEqual({
      ok: false,
      error: "DUPLICATE_ENABLED_PLUGIN_ID",
      conflicts: [{
        pluginId: "notes.plugin",
        sources: [
          {scope: "deployment", targetId: "deployment-target", installationId: "deployment"},
          {scope: "user", targetId: "user-target", installationId: "user"},
        ],
      }],
      active: [runtimeIdentity("notes.plugin")],
    });
    expect(runtime.events).toEqual(eventsBeforeConflict);
    await reconciler.reconcile(desired);
    expect(runtime.events).toEqual(eventsBeforeConflict);
  });

  it("serializes overlapping reconciliations before reading or changing runtime state", async () => {
    const runtime = new BlockingRuntimeAdapter();
    const reconciler = new PluginReconciler(runtime);
    const first = reconciler.reconcile({
      ok: true,
      plans: [plan("notes.plugin", "1.0.0")],
    });
    await runtime.firstEntered;

    const queuedPlan = plan("notes.plugin", "2.0.0");
    const second = reconciler.reconcile({
      ok: true,
      plans: [queuedPlan],
    });
    queuedPlan.installation.packageVersion = "forged-after-enqueue";
    await Promise.resolve();
    expect(runtime.events).toEqual(["replace:1.0.0:none"]);

    runtime.releaseFirst();
    await first;
    await expect(second).resolves.toEqual({
      ok: true,
      states: [{
        pluginId: "notes.plugin",
        status: "active",
        active: runtimeIdentity("notes.plugin", "2.0.0"),
      }],
    });
    expect(runtime.events).toEqual([
      "replace:1.0.0:none",
      "replace:2.0.0:lease-1",
    ]);
  });
});
