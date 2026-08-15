import { Context, type Fiber } from "cordis";
import type { PluginRuntimeAdapter, RuntimePluginPlan } from "./plugin-reconciler.js";
import {
  RetryableCleanupController,
  type PluginCleanupStep,
} from "./plugin-runtime-cleanup.js";

/** Logically selected isolated execution that can synchronously revoke its capability gate. */
export interface ActivePluginExecution {
  /** Revokes routing and capabilities, or throws while leaving this execution selected. */
  revoke(): void;
}

/** Prepared isolated execution that has not yet changed the selected runtime. */
export interface PreparedPluginExecution {
  /**
   * Atomically selects this candidate and deselects `previous`, returning its active gate handle.
   * On throw, the candidate remains unselected and `previous` remains selected.
   */
  commit(previous?: ActivePluginExecution): ActivePluginExecution;

  /** Discards logical staging after a failed commit; this operation must not throw. */
  abort(): void;
}

/** Trusted bridge that stages execution outside the Cordis host's security boundary. */
export interface PluginExecutionActivator {
  /**
   * Stages one data-only plan and registers every isolate-local resource immediately. Cleanup steps
   * must be idempotent and independently safe because every step is attempted after a failure.
   * External compensation must use a separate serializable command, never a closure registered here.
   * Rejection must not select the candidate; registered cleanup remains owned by the adapter.
   */
  prepare(
    candidate: RuntimePluginPlan,
    activationAttemptId: string,
    addCleanup: (label: string, step: PluginCleanupStep) => void,
  ): Promise<PreparedPluginExecution>;
}

interface PluginLocalCleanupDebt {
  /** Package whose revoked resources remain pending. */
  pluginId: string;

  /** Lifecycle point that transferred this obligation. */
  phase: PluginLocalCleanupDebtSnapshot["phase"];

  /** Retryable host-owned cleanup ledger. */
  cleanup: RetryableCleanupController;
}

/** Diagnostic snapshot of isolate-local cleanup that remains pending after logical revocation. */
export interface PluginLocalCleanupDebtSnapshot {
  /** Package whose revoked isolate-local resources remain pending. */
  pluginId: string;

  /** Lifecycle point that created the pending cleanup. */
  phase: "candidate-rollback" | "replacement" | "removal";

  /** Labels of failed cleanup steps in attempted LIFO order. */
  failedLabels: string[];
}

/** Best-effort observer for isolate-local cleanup diagnostics; it never owns the obligation. */
export interface PluginLocalCleanupDebtObserver {
  /** Records a bounded snapshot; observer exceptions are isolated from runtime state changes. */
  record(snapshot: PluginLocalCleanupDebtSnapshot): void;
}

/** Cordis-backed lease retained only inside the runtime reconciler. */
export interface CordisPluginRuntimeLease {
  /** Data-only plan represented by this lease. */
  plan: RuntimePluginPlan;

  /** Opaque activation token shared with the gate and reconciler active entry. */
  activationAttemptId: string;

  /** Cordis lifecycle for the trusted bridge plugin. */
  fiber: Fiber;

  /** Currently selected isolated execution gate. */
  execution: ActivePluginExecution;

  /** Physical cleanup ledger for resources acquired while staging this lease. */
  cleanup: RetryableCleanupController;
}

/** Cordis lifecycle adapter that never evaluates or imports untrusted plugin code. */
export class CordisPluginRuntimeAdapter
implements PluginRuntimeAdapter<CordisPluginRuntimeLease> {
  readonly #context = new Context();
  readonly #cleanupDebts = new Set<PluginLocalCleanupDebt>();

  /** Creates one trusted Cordis host around an isolated execution activator. */
  constructor(
    private activator: PluginExecutionActivator,
    private cleanupDebtObserver?: PluginLocalCleanupDebtObserver,
  ) {}

  /** Number of closure-based cleanup ledgers retained for this isolate's lifetime. */
  get pendingLocalCleanupDebtCount(): number {
    return this.#cleanupDebts.size;
  }

  /** Retries isolate-local cleanup; external resource compensation is intentionally out of scope. */
  async retryLocalCleanup(): Promise<void> {
    for (const debt of this.#cleanupDebts) {
      const result = await debt.cleanup.run();
      if (result.pendingCount === 0) {
        this.#cleanupDebts.delete(debt);
      } else {
        this.#recordCleanupDebt(debt, result.failures.map(failure => failure.label));
      }
    }
  }

  async replace(
      candidate: RuntimePluginPlan,
      activationAttemptId: string,
      previous?: CordisPluginRuntimeLease): Promise<CordisPluginRuntimeLease> {
    const cleanup = new RetryableCleanupController();
    let prepared: PreparedPluginExecution | undefined;
    const fiber = this.#context.plugin(async () => {
      prepared = await this.activator.prepare(
        candidate,
        activationAttemptId,
        (label, step) => cleanup.add(label, step),
      );
      return () => cleanup.run().then(() => undefined);
    });

    try {
      await fiber;
    } catch (error) {
      await this.#retire(candidate.installation.pluginId, "candidate-rollback", fiber, cleanup);
      throw error;
    }
    if (prepared === undefined) {
      await this.#retire(candidate.installation.pluginId, "candidate-rollback", fiber, cleanup);
      throw new Error("Cordis plugin activation completed without a prepared execution.");
    }

    let execution: ActivePluginExecution;
    try {
      execution = prepared.commit(previous?.execution);
    } catch (error) {
      prepared.abort();
      await this.#retire(candidate.installation.pluginId, "candidate-rollback", fiber, cleanup);
      throw error;
    }

    if (previous !== undefined) {
      await this.#retire(
        previous.plan.installation.pluginId,
        "replacement",
        previous.fiber,
        previous.cleanup,
      );
    }
    return {
      plan: structuredClone(candidate),
      activationAttemptId,
      fiber,
      execution,
      cleanup,
    };
  }

  async remove(active: CordisPluginRuntimeLease): Promise<void> {
    active.execution.revoke();
    await this.#retire(
      active.plan.installation.pluginId,
      "removal",
      active.fiber,
      active.cleanup,
    );
  }

  async #retire(
      pluginId: string,
      phase: PluginLocalCleanupDebt["phase"],
      fiber: Fiber,
      cleanup: RetryableCleanupController): Promise<void> {
    await fiber.dispose();
    if (!cleanup.hasRun) await cleanup.run();
    if (cleanup.pendingCount > 0) {
      const debt = {pluginId, phase, cleanup};
      this.#cleanupDebts.add(debt);
      this.#recordCleanupDebt(
        debt,
        cleanup.lastResult?.failures.map(failure => failure.label) ?? [],
      );
    }
  }

  #recordCleanupDebt(debt: PluginLocalCleanupDebt, failedLabels: string[]): void {
    try {
      this.cleanupDebtObserver?.record({
        pluginId: debt.pluginId,
        phase: debt.phase,
        failedLabels,
      });
    } catch {
      // Diagnostics cannot invalidate an already-committed routing decision.
    }
  }
}
