import {afterEach, describe, expect, it, vi} from "vitest";
import {runPluginUiRpcWithinDeadline} from "../src/plugin-ui-rpc-deadline.js";

afterEach(() => vi.useRealTimers());

describe("plugin UI RPC deadline", () => {
  it("disposes the in-flight RPC promise and entrypoint before surfacing timeout", async () => {
    vi.useFakeTimers();
    const disposed: string[] = [];
    const pending = new Promise<unknown>(() => {});
    Object.defineProperty(pending, Symbol.dispose, {
      value: () => disposed.push("pending"),
    });
    const entrypoint = {
      [Symbol.dispose]: () => disposed.push("entrypoint"),
    };
    const rejection = expect(runPluginUiRpcWithinDeadline(
      pending,
      [entrypoint],
      100,
      "timed out",
      value => value,
    )).rejects.toThrow("timed out");

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(disposed).toEqual(["pending", "entrypoint"]);
  });

  it("copies a successful result before disposing all RPC-owned values", async () => {
    const disposed: string[] = [];
    const value = {ok: true};
    Object.defineProperty(value, Symbol.dispose, {
      value: () => disposed.push("result"),
      enumerable: false,
    });
    const pending = Promise.resolve(value);
    Object.defineProperty(pending, Symbol.dispose, {
      value: () => disposed.push("pending"),
    });
    const entrypoint = {
      [Symbol.dispose]: () => disposed.push("entrypoint"),
    };

    await expect(runPluginUiRpcWithinDeadline(
      pending,
      [entrypoint],
      100,
      "timed out",
      result => {
        expect(disposed).toEqual([]);
        return structuredClone(result);
      },
    )).resolves.toEqual({ok: true});
    expect(disposed).toEqual(["result", "pending", "entrypoint"]);
  });
});
