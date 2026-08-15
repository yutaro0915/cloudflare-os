/** One physical resource cleanup operation owned by the trusted runtime host. */
export type PluginCleanupStep = () => void | Promise<void>;

/** One cleanup failure retained for a later retry. */
export interface PluginCleanupFailure {
  /** Bounded host-defined step label for diagnostics. */
  label: string;

  /** Original caught value; callers must normalize it before external reporting. */
  error: unknown;
}

/** Result of one best-effort cleanup pass. */
export interface PluginCleanupResult {
  /** Number of failed steps still owned by this controller. */
  pendingCount: number;

  /** Failures from this pass in attempted LIFO order. */
  failures: PluginCleanupFailure[];
}

interface CleanupEntry {
  label: string;
  step: PluginCleanupStep;
}

/** Serial, LIFO cleanup ledger that removes a step only after it succeeds. */
export class RetryableCleanupController {
  readonly #pending: CleanupEntry[] = [];
  #tail = Promise.resolve();
  #runCount = 0;
  #lastResult?: PluginCleanupResult;

  /** Whether at least one cleanup pass has completed. */
  get hasRun(): boolean {
    return this.#runCount > 0;
  }

  /** Number of steps still awaiting a successful cleanup. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /** Result of the most recently completed pass, retained for local diagnostics. */
  get lastResult(): PluginCleanupResult | undefined {
    return this.#lastResult;
  }

  /** Registers one resource immediately after acquisition. */
  add(label: string, step: PluginCleanupStep): void {
    this.#pending.push({label, step});
  }

  /** Attempts every pending step in LIFO order and retains only failures for retry. */
  run(): Promise<PluginCleanupResult> {
    const execute = this.#tail.then(async () => {
      const completed = new Set<CleanupEntry>();
      const failures: PluginCleanupFailure[] = [];
      for (const entry of this.#pending.toReversed()) {
        try {
          await entry.step();
          completed.add(entry);
        } catch (error) {
          failures.push({label: entry.label, error});
        }
      }
      if (completed.size > 0) {
        const remaining = this.#pending.filter(entry => !completed.has(entry));
        this.#pending.splice(0, this.#pending.length, ...remaining);
      }
      this.#runCount += 1;
      const result = {pendingCount: this.#pending.length, failures};
      this.#lastResult = result;
      return result;
    });
    this.#tail = execute.then(() => undefined, () => undefined);
    return execute;
  }
}
