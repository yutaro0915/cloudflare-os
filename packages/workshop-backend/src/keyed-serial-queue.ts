/**
 * Serializes asynchronous operations per key while allowing unrelated keys to proceed independently.
 */
export class KeyedSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  /** Runs one operation after every previously enqueued operation for the same key. */
  async run<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.catch(() => {}).then(() => gate);
    this.#tails.set(key, queued);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === queued) this.#tails.delete(key);
    }
  }
}
