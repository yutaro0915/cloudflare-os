import { DurableObject } from "cloudflare:workers";
import { collection, createTypedStorage } from "@gadgets/typed-storage";
import type { PluginConfigurationValue } from "./plugin-installation.js";
import { decodePluginConfigurationValue } from "./plugin-installation.js";

/** Immutable installation owner tuple stamped into one PluginState Durable Object. */
export interface PluginStateOwner {
  scope: "user";
  targetId: string;
  pluginId: string;
  installationId: string;
}

interface PluginStateValue {
  key: string;
  value: PluginConfigurationValue;
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

  /** Seeds bounded state only for trusted host tests and future host-owned migration tooling. */
  putForHost(owner: PluginStateOwner, key: string, value: unknown): void {
    if (key.length === 0 || key.length > 128) throw new RangeError("Invalid plugin state key.");
    this.#assertOwner(owner);
    if (this.#storage.purged.get()) throw new Error("Plugin state was purged.");
    this.#storage.values.put({key, value: decodePluginConfigurationValue(value)});
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
