import { describe, expect, it } from "vitest";
import type {
  PluginRuntimeRealmIdentity,
  PluginRuntimeRealmLocator,
} from "../src/dynamic-worker-plugin-activator.js";
import {
  PluginRuntimeRealms,
  type PluginRuntimeRealm,
} from "../src/plugin-runtime-realms.js";

const LOCATOR: PluginRuntimeRealmLocator = {
  overseerId: "workspace-a",
  userId: "user-a",
  role: "build",
};

class FakeRealm implements PluginRuntimeRealm {
  refreshes = 0;
  closed = false;
  closeResolved = false;
  active = true;
  refreshError?: Error;
  revokeError?: Error;
  closePromise = Promise.resolve();

  async refresh(): Promise<void> {
    this.refreshes += 1;
    if (this.refreshError) throw this.refreshError;
  }

  revokeAll(): void {
    if (this.revokeError) throw this.revokeError;
    this.active = false;
    this.closed = true;
  }

  async close(): Promise<void> {
    await this.closePromise;
    this.closeResolved = true;
  }

  assertGate(_pluginId: string, _activationKey: string, _phase: "staged" | "active"): void {
    if (!this.active) throw new Error("Plugin runtime gate denied.");
  }
}

describe("plugin runtime realms", () => {
  it("shares one realm across sessions and synchronously revokes it on the final release", async () => {
    const created: FakeRealm[] = [];
    const identities: PluginRuntimeRealmIdentity[] = [];
    const tracked: Promise<void>[] = [];
    const realms = new PluginRuntimeRealms(
      "workspace-a",
      identity => {
        const realm = new FakeRealm();
        identities.push(identity);
        created.push(realm);
        return realm;
      },
      promise => tracked.push(promise),
    );

    const first = await realms.acquire(LOCATOR);
    const second = await realms.acquire(LOCATOR);
    expect(created).toHaveLength(1);
    expect(created[0]?.refreshes).toBe(2);

    first.release();
    expect(created[0]?.active).toBe(true);
    realms.assertGate(identities[0]!, "example.runtime", "activation-v1", "active");

    second.release();
    expect(created[0]?.active).toBe(false);
    expect(() => realms.assertGate(
      identities[0]!, "example.runtime", "activation-v1", "active",
    )).toThrow("Plugin runtime realm is unavailable");
    expect(tracked).toHaveLength(1);
    await tracked[0];
    expect(created[0]?.closeResolved).toBe(true);
  });

  it("isolates a reopened generation from cleanup of the released realm", async () => {
    let finishOldClose: (() => void) | undefined;
    const created: FakeRealm[] = [];
    const identities: PluginRuntimeRealmIdentity[] = [];
    const realms = new PluginRuntimeRealms(
      "workspace-a",
      identity => {
        const realm = new FakeRealm();
        identities.push(identity);
        if (created.length === 0) {
          realm.closePromise = new Promise(resolve => {
            finishOldClose = resolve;
          });
        }
        created.push(realm);
        return realm;
      },
      () => {},
    );

    const oldSession = await realms.acquire(LOCATOR);
    oldSession.release();
    const newSession = await realms.acquire(LOCATOR);

    expect(created).toHaveLength(2);
    expect(created[0]?.active).toBe(false);
    expect(created[1]?.active).toBe(true);
    expect(identities[1]?.generation).not.toBe(identities[0]?.generation);
    expect(() => realms.assertGate(
      identities[0]!, "example.runtime", "activation-v1", "active",
    )).toThrow("Plugin runtime realm is unavailable");
    finishOldClose?.();
    await Promise.resolve();
    realms.assertGate(identities[1]!, "example.runtime", "activation-v1", "active");
    newSession.release();
  });

  it("keeps the current runtime unchanged when refresh fails", async () => {
    const failures: unknown[] = [];
    const realm = new FakeRealm();
    let identity: PluginRuntimeRealmIdentity | undefined;
    const realms = new PluginRuntimeRealms(
      "workspace-a",
      createdIdentity => {
        identity = createdIdentity;
        return realm;
      },
      () => {},
      error => failures.push(error),
    );

    const first = await realms.acquire(LOCATOR);
    realm.refreshError = new Error("UserDO read failed");
    const second = await realms.acquire(LOCATOR);

    expect(realm.active).toBe(true);
    expect(failures).toEqual([realm.refreshError]);
    realms.assertGate(identity!, "example.runtime", "activation-v1", "active");
    first.release();
    second.release();
  });

  it("isolates a throwing failure reporter without leaking a session reference", async () => {
    const realm = new FakeRealm();
    const realms = new PluginRuntimeRealms(
      "workspace-a",
      () => realm,
      () => {},
      () => {
        throw new Error("diagnostic sink failed");
      },
    );

    const first = await realms.acquire(LOCATOR);
    realm.refreshError = new Error("UserDO read failed");
    const second = await realms.acquire(LOCATOR);
    first.release();
    expect(realm.active).toBe(true);
    second.release();

    expect(realm.active).toBe(false);
  });

  it("returns a no-op session and retries after realm construction fails", async () => {
    let attempts = 0;
    const realm = new FakeRealm();
    const failures: unknown[] = [];
    let identity: PluginRuntimeRealmIdentity | undefined;
    const realms = new PluginRuntimeRealms(
      "workspace-a",
      createdIdentity => {
        attempts += 1;
        if (attempts === 1) throw new Error("runtime construction failed");
        identity = createdIdentity;
        return realm;
      },
      () => {},
      error => failures.push(error),
    );

    const failed = await realms.acquire(LOCATOR);
    failed.release();
    const recovered = await realms.acquire(LOCATOR);

    expect(attempts).toBe(2);
    expect(failures).toHaveLength(1);
    realms.assertGate(identity!, "example.runtime", "activation-v1", "active");
    recovered.release();
  });

  it("rejects cross-workspace and cross-role gate assertions", async () => {
    let identity: PluginRuntimeRealmIdentity | undefined;
    const realms = new PluginRuntimeRealms(
      "workspace-a",
      createdIdentity => {
        identity = createdIdentity;
        return new FakeRealm();
      },
      () => {},
    );
    const session = await realms.acquire(LOCATOR);

    expect(() => realms.assertGate(
      {...identity!, overseerId: "workspace-b"},
      "example.runtime", "activation-v1", "active",
    )).toThrow("Plugin runtime realm does not belong to this workspace");
    expect(() => realms.assertGate(
      {...identity!, role: "use"},
      "example.runtime", "activation-v1", "active",
    )).toThrow("Plugin runtime realm is unavailable");
    session.release();
  });

  it("tracks async cleanup even when synchronous revocation and the tracker fail", async () => {
    const failures: unknown[] = [];
    const realm = new FakeRealm();
    realm.revokeError = new Error("sync revoke failed");
    const realms = new PluginRuntimeRealms(
      "workspace-a",
      () => realm,
      () => {
        throw new Error("cleanup tracker failed");
      },
      error => failures.push(error),
    );
    const session = await realms.acquire(LOCATOR);

    expect(() => session.release()).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(realm.closeResolved).toBe(true);
    expect(failures.map(error => error instanceof Error ? error.message : error)).toEqual([
      "sync revoke failed",
      "cleanup tracker failed",
    ]);
  });
});
