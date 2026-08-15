import type {
  PluginRuntimeRealmIdentity,
  PluginRuntimeRealmLocator,
} from "./dynamic-worker-plugin-activator.js";
import type { PluginRuntimeGateClaim } from "./plugin-capability-gate.js";

/** Runtime operations owned by exactly one authenticated workspace-user-role realm. */
export interface PluginRuntimeRealm {
  /** Refreshes desired state without replacing it with empty state when an upstream read fails. */
  refresh(): Promise<void>;

  /** Synchronously denies staged and active authority before asynchronous teardown. */
  revokeAll(): void;

  /** Stops the realm's runtime resources after authority has already been revoked. */
  close(): Promise<void>;

  /** Throws unless this exact staged or active gate currently belongs to the realm. */
  assertGate(
    pluginId: string,
    activationKey: string,
    manifestDigest: string,
    phase: "staged" | "active",
  ): void;

  /** Throws unless the host selected some current-generation activation for this package. */
  assertPluginActive(pluginId: string): void;

  /** Returns one owned active claim for a trusted host loopback diagnostic. */
  activeClaim(pluginId: string): PluginRuntimeGateClaim | undefined;

  /** Immediately denies one exact claim and queues forced denylist reconciliation. */
  denyPlugin(
    pluginId: string,
    activationKey: string,
    manifestDigest: string,
  ): boolean;
}

/** Reference-counted session ownership returned without exposing the underlying realm. */
export interface PluginRuntimeRealmSession {
  /** Releases this session once; the final release synchronously revokes the realm. */
  release(): void;
}

interface RealmEntry {
  identity: PluginRuntimeRealmIdentity;
  realm: PluginRuntimeRealm;
  references: number;
  refreshTail: Promise<void>;
}

/** Creates one isolated runtime realm per authenticated user and effective role inside a workspace. */
export class PluginRuntimeRealms {
  readonly #entries = new Map<string, RealmEntry>();

  /** Creates a workspace-local realm owner around trusted runtime construction and cleanup hooks. */
  constructor(
    private overseerId: string,
    private createRealm: (identity: PluginRuntimeRealmIdentity) => PluginRuntimeRealm,
    private trackCleanup: (cleanup: Promise<void>) => void,
    private reportFailure: (error: unknown) => void = () => {},
  ) {}

  /** Acquires and refreshes one authenticated realm without propagating runtime failures to open. */
  async acquire(locator: PluginRuntimeRealmLocator): Promise<PluginRuntimeRealmSession> {
    this.#assertWorkspace(locator);
    const key = this.#key(locator);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      const snapshot = Object.freeze({...locator, generation: crypto.randomUUID()});
      let realm: PluginRuntimeRealm;
      try {
        realm = this.createRealm(snapshot);
      } catch (error) {
        this.#report(error);
        return {release: () => {}};
      }
      entry = {
        identity: snapshot,
        realm,
        references: 0,
        refreshTail: Promise.resolve(),
      };
      this.#entries.set(key, entry);
    }
    entry.references += 1;
    entry.refreshTail = entry.refreshTail.then(async () => {
      try {
        await entry.realm.refresh();
      } catch (error) {
        this.#report(error);
      }
    });
    await entry.refreshTail;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release(key, entry);
      },
    };
  }

  /** Verifies a host-minted loopback claim against the current in-memory realm generation. */
  assertGate(
      identity: PluginRuntimeRealmIdentity,
      pluginId: string,
      activationKey: string,
      manifestDigest: string,
      phase: "staged" | "active"): void {
    this.#assertWorkspace(identity);
    const entry = this.#entries.get(this.#key(identity));
    if (entry === undefined || entry.identity.generation !== identity.generation) {
      throw new Error("Plugin runtime realm is unavailable.");
    }
    entry.realm.assertGate(pluginId, activationKey, manifestDigest, phase);
  }

  /** Verifies host operational health without disclosing activation keys or generation nonces. */
  assertPluginActive(identity: PluginRuntimeRealmLocator, pluginId: string): void {
    this.#assertWorkspace(identity);
    const entry = this.#entries.get(this.#key(identity));
    if (entry === undefined) throw new Error("Plugin runtime realm is unavailable.");
    entry.realm.assertPluginActive(pluginId);
  }

  /** Returns one current-generation active claim without widening browser RPC capabilities. */
  activeClaim(
      identity: PluginRuntimeRealmLocator,
      pluginId: string): (PluginRuntimeRealmIdentity & PluginRuntimeGateClaim) | undefined {
    this.#assertWorkspace(identity);
    const entry = this.#entries.get(this.#key(identity));
    if (entry === undefined) return undefined;
    const claim = entry.realm.activeClaim(pluginId);
    return claim === undefined ? undefined : {...entry.identity, ...claim};
  }

  /** Denies an exact current-generation claim and queues physical retirement in the background. */
  denyPlugin(
      identity: PluginRuntimeRealmIdentity,
      pluginId: string,
      activationKey: string,
      manifestDigest: string): void {
    this.#assertWorkspace(identity);
    const key = this.#key(identity);
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.identity.generation !== identity.generation) return;
    if (!entry.realm.denyPlugin(pluginId, activationKey, manifestDigest)) return;
    entry.refreshTail = entry.refreshTail.then(async () => {
      if (this.#entries.get(key) !== entry) return;
      try {
        await entry.realm.refresh();
      } catch (error) {
        this.#report(error);
      }
    });
    try {
      this.trackCleanup(entry.refreshTail);
    } catch (error) {
      this.#report(error);
    }
  }

  #release(key: string, entry: RealmEntry): void {
    if (this.#entries.get(key) !== entry || entry.references === 0) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    this.#entries.delete(key);
    try {
      entry.realm.revokeAll();
    } catch (error) {
      this.#report(error);
    }
    const cleanup = entry.refreshTail
      .then(() => entry.realm.close())
      .catch(error => this.#report(error));
    try {
      this.trackCleanup(cleanup);
    } catch (error) {
      this.#report(error);
    }
  }

  #assertWorkspace(identity: PluginRuntimeRealmLocator): void {
    if (identity.overseerId !== this.overseerId) {
      throw new Error("Plugin runtime realm does not belong to this workspace.");
    }
  }

  #key(identity: PluginRuntimeRealmLocator): string {
    return `${identity.userId}\0${identity.role}`;
  }

  #report(error: unknown): void {
    try {
      this.reportFailure(error);
    } catch {
      // Diagnostics cannot extend or restore a runtime realm's authority lifetime.
    }
  }
}
