import { describe, expect, it } from "vitest";
import {
  BundledPluginManifestResolver,
  type VerifiedPluginManifest,
} from "../src/plugin-manifest-registry.js";

describe("bundled plugin manifest resolver", () => {
  it("resolves exact versions without collapsing an older manifest", async () => {
    const versionOne: VerifiedPluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "1.0.0",
      manifestDigest: `sha256:${"1".repeat(64)}`,
      requestedCapabilities: ["ui.panel"],
    };
    const versionTwo: VerifiedPluginManifest = {
      schemaVersion: 1,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      manifestDigest: `sha256:${"2".repeat(64)}`,
      requestedCapabilities: ["ui.panel", "agent.catalog.read"],
    };
    const resolver = new BundledPluginManifestResolver([versionOne, versionTwo]);

    await expect(resolver.resolve("example.notes", "1.0.0")).resolves.toEqual(versionOne);
    await expect(resolver.resolve("example.notes", "2.0.0")).resolves.toEqual(versionTwo);
    await expect(resolver.resolve("example.notes", "3.0.0")).resolves.toBeNull();
  });
});
