import { describe, expect, it } from "vitest";
import { RetryableCleanupController } from "../src/plugin-runtime-cleanup.js";

describe("retryable plugin cleanup", () => {
  it("attempts every step in LIFO order and retries only failures", async () => {
    const events: string[] = [];
    let failMiddle = true;
    const cleanup = new RetryableCleanupController();
    cleanup.add("A", () => { events.push("A"); });
    cleanup.add("B", () => {
      events.push("B");
      if (failMiddle) throw new Error("B failed");
    });
    cleanup.add("C", async () => {
      await Promise.resolve();
      events.push("C");
    });

    await expect(cleanup.run()).resolves.toEqual({
      pendingCount: 1,
      failures: [{label: "B", error: expect.any(Error)}],
    });
    expect(events).toEqual(["C", "B", "A"]);

    failMiddle = false;
    await expect(cleanup.run()).resolves.toEqual({pendingCount: 0, failures: []});
    expect(events).toEqual(["C", "B", "A", "B"]);
    await expect(cleanup.run()).resolves.toEqual({pendingCount: 0, failures: []});
  });
});
