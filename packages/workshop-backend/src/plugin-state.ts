import { DurableObject } from "cloudflare:workers";
import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type { PluginConfigurationValue, PluginStateOwner } from "./plugin-installation.js";
import { decodePluginConfigurationValue } from "./plugin-installation.js";

interface PluginStateValue {
  key: string;
  revision?: number;
  value: PluginConfigurationValue;
  recentMutationIds?: string[];
}

const MAX_PLUGIN_STATE_VALUE_BYTES = 64 * 1024;

function decodePluginStateValue(value: unknown): PluginConfigurationValue {
  const decoded = decodePluginConfigurationValue(value);
  if (new TextEncoder().encode(JSON.stringify(decoded)).byteLength > MAX_PLUGIN_STATE_VALUE_BYTES) {
    throw new RangeError("Plugin state value exceeds the size limit.");
  }
  return decoded;
}

function makePluginStateStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      values: collection<PluginStateValue>()({primaryKey: "key"}),
    },
    singletons: {
      owner: <PluginStateOwner | null>null,
      purged: false,
    },
  });
}

function ownersEqual(left: PluginStateOwner, right: PluginStateOwner): boolean {
  return left.scope === right.scope && left.targetId === right.targetId &&
    left.pluginId === right.pluginId && left.installationId === right.installationId;
}

/** Generic state instance for one plugin installation; it never receives browser authority. */
export class PluginStateDurableObject extends DurableObject<Cloudflare.Env> {
  readonly #storage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#storage = makePluginStateStorage(ctx.storage);
  }

  /** Reads one bounded JSON value after permanently binding this instance to its owner tuple. */
  read(owner: PluginStateOwner, key: string): unknown {
    if (key.length === 0 || key.length > 128) throw new RangeError("Invalid plugin state key.");
    this.#assertOwner(owner);
    if (this.#storage.purged.get()) throw new Error("Plugin state was purged.");
    const value = this.#storage.values.get(key);
    return value === undefined ? null : structuredClone(value.value);
  }

  /** Reads one owned state cell and its monotonically increasing compare-and-set revision. */
  readVersioned(owner: PluginStateOwner, key: string): unknown {
    if (key.length === 0 || key.length > 128) throw new RangeError("Invalid plugin state key.");
    this.#assertOwner(owner);
    if (this.#storage.purged.get()) throw new Error("Plugin state was purged.");
    const current = this.#storage.values.get(key);
    return current === undefined
      ? {revision: 0, value: null}
      : {revision: current.revision ?? 0, value: structuredClone(current.value)};
  }

  /** Atomically replaces one host-selected state cell only when the caller observed its revision. */
  compareAndSetForHost(
      owner: PluginStateOwner,
      key: string,
      expectedRevision: number,
      nextValue: unknown,
      mutationId?: string,
  ): {ok: true; revision: number; replayed: boolean} |
    {ok: false; currentRevision: number} {
    if (key.length === 0 || key.length > 128) throw new RangeError("Invalid plugin state key.");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new RangeError("Invalid plugin state revision.");
    }
    if (
      mutationId !== undefined &&
      (mutationId.length === 0 || mutationId.length > 128)
    ) throw new RangeError("Invalid plugin state mutation ID.");
    const decoded = decodePluginStateValue(nextValue);
    let result: {ok: true; revision: number; replayed: boolean} |
      {ok: false; currentRevision: number} = {
      ok: false,
      currentRevision: 0,
    };
    this.ctx.storage.transactionSync(() => {
      this.#assertOwner(owner);
      if (this.#storage.purged.get()) throw new Error("Plugin state was purged.");
      const current = this.#storage.values.get(key);
      const currentRevision = current?.revision ?? 0;
      if (mutationId !== undefined && current?.recentMutationIds?.includes(mutationId)) {
        result = {ok: true, revision: currentRevision, replayed: true};
        return;
      }
      if (currentRevision !== expectedRevision) {
        result = {ok: false, currentRevision};
        return;
      }
      const revision = currentRevision + 1;
      const recentMutationIds = mutationId === undefined
        ? current?.recentMutationIds ?? []
        : [...(current?.recentMutationIds ?? []), mutationId].slice(-32);
      this.#storage.values.put({key, revision, value: decoded, recentMutationIds});
      result = {ok: true, revision, replayed: false};
    });
    return result;
  }

  /** Seeds bounded state only for trusted host tests and future host-owned migration tooling. */
  putForHost(owner: PluginStateOwner, key: string, value: unknown): void {
    if (key.length === 0 || key.length > 128) throw new RangeError("Invalid plugin state key.");
    this.#assertOwner(owner);
    if (this.#storage.purged.get()) throw new Error("Plugin state was purged.");
    const current = this.#storage.values.get(key);
    this.#storage.values.put({
      key,
      revision: (current?.revision ?? 0) + 1,
      value: decodePluginStateValue(value),
      recentMutationIds: current?.recentMutationIds ?? [],
    });
  }

  /** Permanently erases values while retaining immutable owner and purged tombstones. */
  purge(owner: PluginStateOwner): {
    ok: true;
    alreadyPurged: boolean;
    deletedValueCount: number;
  } {
    let alreadyPurged = false;
    let deletedValueCount = 0;
    this.ctx.storage.transactionSync(() => {
      this.#assertOwner(owner);
      alreadyPurged = this.#storage.purged.get();
      if (alreadyPurged) return;
      const values = Array.from(this.#storage.values.list());
      for (const value of values) {
        if (!this.#storage.values.delete(value.key)) {
          throw new Error("Plugin state purge lost a value before deletion.");
        }
        deletedValueCount += 1;
      }
      if (Array.from(this.#storage.values.list(), value => value.key).length !== 0) {
        throw new Error("Plugin state purge left residual values.");
      }
      this.#storage.purged.put(true);
    });
    return {ok: true, alreadyPurged, deletedValueCount};
  }

  #assertOwner(owner: PluginStateOwner): void {
    const current = this.#storage.owner.get();
    if (current === null) {
      this.#storage.owner.put(structuredClone(owner));
    } else if (!ownersEqual(current, owner)) {
      throw new Error("Plugin state owner mismatch.");
    }
  }
}
