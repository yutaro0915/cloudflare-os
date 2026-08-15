import { describe, expect, it } from "vitest";
import type { RuntimePluginPlan } from "../src/plugin-reconciler.js";
import {
  CordisPluginRuntimeAdapter,
  type PluginExecutionActivator,
  type PluginLocalCleanupDebtObserver,
  type PluginLocalCleanupDebtSnapshot,
} from "../src/cordis-plugin-runtime-adapter.js";

function plan(packageVersion = "1.0.0"): RuntimePluginPlan {
  return {
    installation: {
      scope: "user",
      targetId: "user-a",
      installationId: "installation-a",
      pluginId: "example.notes",
      packageVersion,
      manifestDigest: `sha256:${packageVersion.replaceAll(".", "").padEnd(64, "0")}`,
      grantedCapabilities: [],
      config: null,
    },
    dependencies: [],
    runtime: {
      kind: "dynamic-worker",
      codeArtifactDigest: `sha256:${"a".repeat(64)}`,
    },
  };
}

class RecordingDebtObserver implements PluginLocalCleanupDebtObserver {
  readonly snapshots: PluginLocalCleanupDebtSnapshot[] = [];
  fail = false;

  record(snapshot: PluginLocalCleanupDebtSnapshot): void {
    if (this.fail) throw new Error("observer failed");
    this.snapshots.push(snapshot);
  }
}

class RecordingActivator implements PluginExecutionActivator {
  readonly events: string[] = [];
  selectedVersion?: string;
  failPrepare = false;
  failCommit = false;
  failRevoke = false;
  failCleanupLabel?: string;
  receivedPrevious = false;

  async prepare(candidate: RuntimePluginPlan, _activationAttemptId: string,
      addCleanup: (label: string, step: () =>
      void | Promise<void>) => void) {
    const version = candidate.installation.packageVersion;
    for (const label of ["A", "B", "C"]) {
      addCleanup(label, () => {
        this.events.push(`cleanup:${version}:${label}`);
        if (this.failCleanupLabel === label) throw new Error(`${label} failed`);
      });
    }
    if (this.failPrepare) throw new Error("prepare failed");
    return {
      commit: previous => {
        this.events.push(`commit:${version}`);
        this.receivedPrevious = previous !== undefined;
        if (this.failCommit) throw new Error("commit failed");
        this.selectedVersion = version;
        return {
          revoke: () => {
            this.events.push(`revoke:${version}`);
            if (this.failRevoke) throw new Error("revoke failed");
            if (this.selectedVersion === version) this.selectedVersion = undefined;
          },
        };
      },
      abort: () => { this.events.push(`abort:${version}`); },
    };
  }
}

describe("Cordis plugin runtime adapter", () => {
  it("keeps the previous selection when candidate preparation fails and rolls back LIFO", async () => {
    const activator = new RecordingActivator();
    const debts = new RecordingDebtObserver();
    const adapter = new CordisPluginRuntimeAdapter(activator, debts);
    const previous = await adapter.replace(plan("1.0.0"), "attempt-v1");
    activator.events.length = 0;
    activator.failPrepare = true;

    await expect(adapter.replace(plan("2.0.0"), "attempt-v2", previous))
      .rejects.toThrow("prepare failed");

    expect(activator.selectedVersion).toBe("1.0.0");
    expect(activator.events).toEqual([
      "cleanup:2.0.0:C",
      "cleanup:2.0.0:B",
      "cleanup:2.0.0:A",
    ]);
    expect(debts.snapshots).toEqual([]);
  });

  it("retains failed candidate rollback cleanup without losing the previous selection", async () => {
    const activator = new RecordingActivator();
    const debts = new RecordingDebtObserver();
    const adapter = new CordisPluginRuntimeAdapter(activator, debts);
    const previous = await adapter.replace(plan("1.0.0"), "attempt-v1");
    activator.events.length = 0;
    activator.failPrepare = true;
    activator.failCleanupLabel = "B";

    await expect(adapter.replace(plan("2.0.0"), "attempt-v2", previous))
      .rejects.toThrow("prepare failed");

    expect(activator.selectedVersion).toBe("1.0.0");
    expect(adapter.pendingLocalCleanupDebtCount).toBe(1);
    expect(debts.snapshots).toEqual([{
      pluginId: "example.notes",
      phase: "candidate-rollback",
      failedLabels: ["B"],
    }]);
    activator.failCleanupLabel = undefined;
    await adapter.retryLocalCleanup();
    expect(adapter.pendingLocalCleanupDebtCount).toBe(0);
  });

  it("aborts and cleans a candidate when commit fails without changing previous selection", async () => {
    const activator = new RecordingActivator();
    const adapter = new CordisPluginRuntimeAdapter(activator, new RecordingDebtObserver());
    const previous = await adapter.replace(plan("1.0.0"), "attempt-v1");
    activator.events.length = 0;
    activator.failCommit = true;

    await expect(adapter.replace(plan("2.0.0"), "attempt-v2", previous))
      .rejects.toThrow("commit failed");

    expect(activator.selectedVersion).toBe("1.0.0");
    expect(activator.events).toEqual([
      "commit:2.0.0",
      "abort:2.0.0",
      "cleanup:2.0.0:C",
      "cleanup:2.0.0:B",
      "cleanup:2.0.0:A",
    ]);
  });

  it("commits the candidate and retains failed old cleanup for retry", async () => {
    const activator = new RecordingActivator();
    const debts = new RecordingDebtObserver();
    const adapter = new CordisPluginRuntimeAdapter(activator, debts);
    const previous = await adapter.replace(plan("1.0.0"), "attempt-v1");
    activator.events.length = 0;
    activator.failCleanupLabel = "B";

    const current = await adapter.replace(plan("2.0.0"), "attempt-v2", previous);
    expect(current.activationAttemptId).toBe("attempt-v2");

    expect(activator.selectedVersion).toBe("2.0.0");
    expect(activator.receivedPrevious).toBe(true);
    expect(activator.events).toEqual([
      "commit:2.0.0",
      "cleanup:1.0.0:C",
      "cleanup:1.0.0:B",
      "cleanup:1.0.0:A",
    ]);
    expect(debts.snapshots).toEqual([{
      pluginId: "example.notes",
      phase: "replacement",
      failedLabels: ["B"],
    }]);
    expect(adapter.pendingLocalCleanupDebtCount).toBe(1);
    activator.failCleanupLabel = undefined;
    await adapter.retryLocalCleanup();
    expect(adapter.pendingLocalCleanupDebtCount).toBe(0);
    expect(activator.events.at(-1)).toBe("cleanup:1.0.0:B");
    await adapter.remove(current);
  });

  it("revokes routing before cleanup when removing an active lease", async () => {
    const activator = new RecordingActivator();
    const adapter = new CordisPluginRuntimeAdapter(activator, new RecordingDebtObserver());
    const lease = await adapter.replace(plan(), "attempt-v1");
    activator.events.length = 0;

    await adapter.remove(lease);

    expect(activator.selectedVersion).toBeUndefined();
    expect(activator.events).toEqual([
      "revoke:1.0.0",
      "cleanup:1.0.0:C",
      "cleanup:1.0.0:B",
      "cleanup:1.0.0:A",
    ]);
  });

  it("leaves the lease selected and retryable when logical revocation fails", async () => {
    const activator = new RecordingActivator();
    const adapter = new CordisPluginRuntimeAdapter(activator, new RecordingDebtObserver());
    const lease = await adapter.replace(plan(), "attempt-v1");
    activator.events.length = 0;
    activator.failRevoke = true;

    await expect(adapter.remove(lease)).rejects.toThrow("revoke failed");

    expect(activator.selectedVersion).toBe("1.0.0");
    expect(activator.events).toEqual(["revoke:1.0.0"]);
    activator.failRevoke = false;
    await adapter.remove(lease);
    expect(activator.selectedVersion).toBeUndefined();
  });

  it("resolves removal after revocation while retaining cleanup despite observer failure", async () => {
    const activator = new RecordingActivator();
    const observer = new RecordingDebtObserver();
    const adapter = new CordisPluginRuntimeAdapter(activator, observer);
    const lease = await adapter.replace(plan(), "attempt-v1");
    activator.events.length = 0;
    activator.failCleanupLabel = "B";
    observer.fail = true;

    await expect(adapter.remove(lease)).resolves.toBeUndefined();

    expect(activator.selectedVersion).toBeUndefined();
    expect(adapter.pendingLocalCleanupDebtCount).toBe(1);
    expect(activator.events).toEqual([
      "revoke:1.0.0",
      "cleanup:1.0.0:C",
      "cleanup:1.0.0:B",
      "cleanup:1.0.0:A",
    ]);
    activator.failCleanupLabel = undefined;
    await adapter.retryLocalCleanup();
    expect(adapter.pendingLocalCleanupDebtCount).toBe(0);
  });
});
