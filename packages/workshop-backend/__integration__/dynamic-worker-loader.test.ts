import { env } from "cloudflare:test";
import type { WorkerEntrypoint } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface LoaderContractEntrypoint extends WorkerEntrypoint {
  inspect(): Promise<{
    envKeys: string[];
    fetchDenied: boolean;
    connectDenied: boolean;
  }>;
}

const CONTRACT_WORKER = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

export default class extends WorkerEntrypoint {
  async inspect() {
    let fetchDenied = false;
    try {
      await fetch("https://example.com/");
    } catch {
      fetchDenied = true;
    }
    let connectDenied = false;
    try {
      const socket = connect({hostname: "example.com", port: 443});
      await socket.opened;
      socket.close();
    } catch {
      connectDenied = true;
    }
    return {
      envKeys: Object.keys(this.env).toSorted(),
      fetchDenied,
      connectDenied,
    };
  }
}
`;

function workerCode(source: string): WorkerLoaderWorkerCode {
  return {
    compatibilityDate: "2026-02-01",
    compatibilityFlags: ["disallow_importable_env"],
    mainModule: "main.js",
    modules: {"main.js": source},
    env: {VISIBLE: "explicit-only"},
    globalOutbound: null,
    limits: {cpuMs: 50, subRequests: 16},
  };
}

describe("Dynamic Worker Loader isolation contract", () => {
  it("resolves an exact ID consistently and exposes only explicit default-deny env", async () => {
    const id = `plugin-loader-contract-${crypto.randomUUID()}`;
    let callbacks = 0;
    const getCode = async () => {
      callbacks += 1;
      return workerCode(CONTRACT_WORKER);
    };

    const first = env.LOADER.get(id, getCode).getEntrypoint<LoaderContractEntrypoint>();
    await expect(first.inspect()).resolves.toEqual({
      envKeys: ["VISIBLE"],
      fetchDenied: true,
      connectDenied: true,
    });
    const second = env.LOADER.get(id, getCode).getEntrypoint<LoaderContractEntrypoint>();
    await expect(second.inspect()).resolves.toEqual({
      envKeys: ["VISIBLE"],
      fetchDenied: true,
      connectDenied: true,
    });
    // The platform may invoke the callback again after isolate eviction; correctness depends only
    // on returning the same verified definition every time, never on exactly-once construction.
    expect(callbacks).toBeGreaterThanOrEqual(1);
  });

  it("rejects code that tries to import the ambient env binding", async () => {
    const source = `
import { WorkerEntrypoint, env } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  inspect() { return Object.keys(env); }
}
`;
    const entrypoint = env.LOADER
      .get(`plugin-loader-importable-env-${crypto.randomUUID()}`, async () => workerCode(source))
      .getEntrypoint<LoaderContractEntrypoint>();

    await expect(entrypoint.inspect()).rejects.toThrow();
  });
});
