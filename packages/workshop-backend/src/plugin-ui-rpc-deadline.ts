/** Best-effort explicit disposal for native Workers RPC promises, results, and stubs. */
export function disposePluginUiRpcValue(value: unknown): void {
  if (typeof value !== "object" || value === null || !(Symbol.dispose in value)) return;
  const dispose = value[Symbol.dispose];
  if (typeof dispose === "function") dispose.call(value);
}

/**
 * Bounds one Worker RPC and tears down both its in-flight pipeline and owning entrypoint before a
 * timeout is observed by the caller. Disposal is idempotent here because native RPC disposal is
 * an explicit lifetime signal rather than an awaited cleanup operation.
 */
export async function runPluginUiRpcWithinDeadline<T, Result>(
    pending: Promise<T>,
    ownedStubs: readonly object[],
    timeoutMs: number,
    timeoutMessage: string,
    consume: (value: T) => Result): Promise<Result> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const cancel = () => {
    if (disposed) return;
    disposed = true;
    disposePluginUiRpcValue(pending);
    for (const stub of ownedStubs) disposePluginUiRpcValue(stub);
  };
  try {
    const value = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          cancel();
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
    try {
      return consume(value);
    } finally {
      disposePluginUiRpcValue(value);
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    cancel();
  }
}
