import { describe, expect, it } from "vitest";
import {
  BundledPluginManifestResolver,
  type PluginManifest,
  type VerifiedPluginManifest,
} from "../src/plugin-manifest-registry.js";

describe("bundled plugin manifest resolver", () => {
  it("resolves exact versions without collapsing an older manifest", async () => {
    const versionOne: PluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      requestedCapabilities: ["ui.panel"],
    };
    const versionTwo: PluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      requestedCapabilities: ["ui.panel", "agent.catalog.read"],
    };
    const resolver = await BundledPluginManifestResolver.create([versionOne, versionTwo]);

    await expect(resolver.resolve("example.notes", "1.0.0")).resolves.toEqual({
      ...versionOne,
      manifestDigest:
        "sha256:1f277c6e9735b5b5c75aec6498a48156638186317f5140e4c533d16569c743e7",
    });
    await expect(resolver.resolve("example.notes", "2.0.0")).resolves.toEqual({
      ...versionTwo,
      manifestDigest:
        "sha256:91115bef6acbd770195c0439904129b62d5b085344e085e6a1b7530d83dbeb1e",
    });
    await expect(resolver.resolve("example.notes", "3.0.0")).resolves.toBeNull();
  });

  it("creates a verified snapshot that source and callers cannot mutate", async () => {
    const requestedCapabilities = ["ui.panel"];
    const source: PluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      requestedCapabilities,
    };
    const resolver = await BundledPluginManifestResolver.create([source]);
    const expected: VerifiedPluginManifest = {
      ...source,
      manifestDigest:
        "sha256:1f277c6e9735b5b5c75aec6498a48156638186317f5140e4c533d16569c743e7",
      requestedCapabilities: ["ui.panel"],
    };

    requestedCapabilities[0] = "forged.source.capability";
    const resolved = await resolver.resolve("example.notes", "1.0.0");

    expect(resolved).toEqual(expected);
    expect(Reflect.set(resolved!, "pluginId", "forged.plugin")).toBe(false);
    expect(Reflect.set(resolved!.requestedCapabilities, 0, "forged.result.capability")).toBe(false);
    await expect(resolver.resolve("example.notes", "1.0.0")).resolves.toEqual(expected);
  });

  it("hashes and stores the same snapshot when source fields change during verification", async () => {
    const source: PluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      requestedCapabilities: ["ui.panel"],
    };

    const pendingResolver = BundledPluginManifestResolver.create([source]);
    expect(Reflect.set(source, "pluginId", "forged.during-hash")).toBe(true);
    const resolver = await pendingResolver;

    await expect(resolver.resolve("example.notes", "1.0.0")).resolves.toMatchObject({
      pluginId: "example.notes",
      manifestDigest:
        "sha256:1f277c6e9735b5b5c75aec6498a48156638186317f5140e4c533d16569c743e7",
    });
    await expect(resolver.resolve("forged.during-hash", "1.0.0")).resolves.toBeNull();
  });

  it("rejects two manifests for the same exact package version", async () => {
    const first: PluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      requestedCapabilities: ["ui.panel"],
    };
    const conflicting: PluginManifest = {
      ...first,
      requestedCapabilities: ["ui.panel", "agent.catalog.read"],
    };

    await expect(BundledPluginManifestResolver.create([first, conflicting]))
      .rejects.toThrow("Duplicate bundled plugin manifest: example.notes@1.0.0");
  });
});
