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
      dependencies: [],
      manifestDigest:
        "sha256:1f277c6e9735b5b5c75aec6498a48156638186317f5140e4c533d16569c743e7",
    });
    await expect(resolver.resolve("example.notes", "2.0.0")).resolves.toEqual({
      ...versionTwo,
      dependencies: [],
      manifestDigest:
        "sha256:91115bef6acbd770195c0439904129b62d5b085344e085e6a1b7530d83dbeb1e",
    });
    await expect(resolver.resolve("example.notes", "3.0.0")).resolves.toBeNull();
  });

  it("verifies schema v2 dependencies as an immutable canonical set", async () => {
    const dependencies = ["example.storage", "example.auth"];
    const source: PluginManifest = {
      schemaVersion: 2,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      requestedCapabilities: ["ui.panel"],
      dependencies,
    };

    const resolver = await BundledPluginManifestResolver.create([source]);
    dependencies[0] = "forged.dependency";
    const resolved = await resolver.resolve("example.notes", "2.0.0");

    expect(resolved).toMatchObject({
      schemaVersion: 2,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      dependencies: ["example.auth", "example.storage"],
      manifestDigest:
        "sha256:1fc5b02a59ff45bf212f71072798e1049ee0690f8d9cdc9bf4781c9c7fade6b2",
    });
    expect(Reflect.set(resolved!.dependencies, 0, "forged.result")).toBe(false);

    const reordered = await BundledPluginManifestResolver.create([{
      ...source,
      dependencies: ["example.auth", "example.storage"],
    }]);
    await expect(reordered.resolve("example.notes", "2.0.0")).resolves.toMatchObject({
      manifestDigest: resolved!.manifestDigest,
    });

    const changed = await BundledPluginManifestResolver.create([{
      ...source,
      dependencies: ["example.auth", "example.search"],
    }]);
    const changedManifest = await changed.resolve("example.notes", "2.0.0");
    expect(changedManifest!.manifestDigest).not.toBe(resolved!.manifestDigest);
  });

  it("rejects invalid dependency sets before calling them verified", async () => {
    const base = {
      schemaVersion: 2,
      pluginId: "example.notes",
      packageVersion: "2.0.0",
      requestedCapabilities: [],
    } as const;

    for (const dependencies of [["example.auth", "example.auth"], ["example.auth", " "]]) {
      await expect(BundledPluginManifestResolver.create([{...base, dependencies}]))
        .rejects.toThrow("Invalid dependencies in example.notes@2.0.0");
    }
  });

  it("binds a schema v3 Dynamic Worker artifact descriptor into the manifest digest", async () => {
    const source: PluginManifest = {
      schemaVersion: 3,
      pluginId: "example.runtime",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies: ["example.storage", "example.auth"],
      runtime: {
        kind: "dynamic-worker",
        codeArtifactDigest:
          "sha256:5b056b8472e4c36854cb9fdaa5c173b5dada6ddf49e86006c5851eff8091e8c8",
      },
    };
    const resolver = await BundledPluginManifestResolver.create([source]);
    const resolved = await resolver.resolve("example.runtime", "1.0.0");

    expect(resolved).toMatchObject({
      schemaVersion: 3,
      runtime: source.runtime,
      manifestDigest:
        "sha256:2e1cf7b634246008fc83d5c0300411dc00f9235529ac576a86723860b21fcfb5",
    });
    expect(Reflect.set(resolved!.runtime!, "codeArtifactDigest", `sha256:${"0".repeat(64)}`))
      .toBe(false);

    const reordered = await BundledPluginManifestResolver.create([{
      ...source,
      dependencies: ["example.auth", "example.storage"],
    }]);
    await expect(reordered.resolve("example.runtime", "1.0.0")).resolves.toMatchObject({
      manifestDigest: resolved!.manifestDigest,
    });

    const changed = await BundledPluginManifestResolver.create([{
      ...source,
      runtime: {
        ...source.runtime,
        codeArtifactDigest: `sha256:${"f".repeat(64)}`,
      },
    }]);
    const changedManifest = await changed.resolve("example.runtime", "1.0.0");
    expect(changedManifest!.manifestDigest).not.toBe(resolved!.manifestDigest);
  });

  it("hashes and returns the same v3 runtime snapshot when the source changes during hashing",
    async () => {
      const runtime = {
        kind: "dynamic-worker" as const,
        codeArtifactDigest: `sha256:${"a".repeat(64)}`,
      };
      const source: PluginManifest = {
        schemaVersion: 3,
        pluginId: "example.runtime",
        packageVersion: "1.0.0",
        requestedCapabilities: [],
        dependencies: [],
        runtime,
      };

      const pending = BundledPluginManifestResolver.create([source]);
      expect(Reflect.set(runtime, "codeArtifactDigest", `sha256:${"f".repeat(64)}`)).toBe(true);
      const resolver = await pending;

      await expect(resolver.resolve("example.runtime", "1.0.0")).resolves.toMatchObject({
        runtime: {codeArtifactDigest: `sha256:${"a".repeat(64)}`},
      });
    });

  it("rejects runtime descriptor fields that the generator would reject", async () => {
    const runtime = {
      kind: "dynamic-worker" as const,
      codeArtifactDigest: `sha256:${"a".repeat(64)}`,
      env: {FORGED: true},
    };
    const source: PluginManifest = {
      schemaVersion: 3,
      pluginId: "example.runtime",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies: [],
      runtime,
    };

    await expect(BundledPluginManifestResolver.create([source]))
      .rejects.toThrow("Invalid runtime descriptor in example.runtime@1.0.0");
  });

  it("binds owned schema v4 UI contributions into a deterministic manifest digest", async () => {
    const source: PluginManifest = {
      schemaVersion: 4,
      pluginId: "example.ui",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies: [],
      runtime: {
        kind: "dynamic-worker",
        codeArtifactDigest: `sha256:${"a".repeat(64)}`,
      },
      presentation: {
        title: "Example UI",
        summary: "Safe host and sandbox views.",
      },
      uiContributions: [{
        contributionId: "details",
        slot: "user-plugin.details",
        title: "Details",
        renderer: {
          kind: "host-schema-v1",
          document: {schemaVersion: 1, blocks: [{kind: "text", text: "Hello"}]},
        },
      }, {
        contributionId: "sandbox",
        slot: "user-plugin.details",
        title: "Sandbox",
        renderer: {
          kind: "worker-rendered-document-v1",
          codeArtifactDigest: `sha256:${"b".repeat(64)}`,
          height: 240,
        },
      }],
    };
    const resolver = await BundledPluginManifestResolver.create([source]);
    const resolved = await resolver.resolve("example.ui", "1.0.0");

    expect(resolved).toMatchObject({
      schemaVersion: 4,
      presentation: source.presentation,
      uiContributions: source.uiContributions,
      manifestDigest:
        "sha256:53d915e61f21371238168e8b2402865c8d9c187bb7b40b0517c8a7f50243bf0f",
    });
    expect(Object.isFrozen(resolved!.presentation)).toBe(true);
    expect(Object.isFrozen(resolved!.uiContributions)).toBe(true);
    expect(Object.isFrozen(resolved!.uiContributions![0].renderer)).toBe(true);

    const reordered = await BundledPluginManifestResolver.create([{
      ...source,
      uiContributions: source.uiContributions.toReversed(),
    }]);
    await expect(reordered.resolve("example.ui", "1.0.0")).resolves.toMatchObject({
      manifestDigest: resolved!.manifestDigest,
    });

    const changed = await BundledPluginManifestResolver.create([{
      ...source,
      uiContributions: [{
        ...source.uiContributions[0],
        renderer: {
          kind: "host-schema-v1" as const,
          document: {schemaVersion: 1 as const, blocks: [{kind: "text" as const, text: "Changed"}]},
        },
      }, source.uiContributions[1]],
    }]);
    const changedManifest = await changed.resolve("example.ui", "1.0.0");
    expect(changedManifest!.manifestDigest).not.toBe(resolved!.manifestDigest);
  });

  it("rejects malformed schema v4 presentation and UI contribution declarations", async () => {
    const base: PluginManifest = {
      schemaVersion: 4,
      pluginId: "example.ui",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies: [],
      runtime: {
        kind: "dynamic-worker",
        codeArtifactDigest: `sha256:${"a".repeat(64)}`,
      },
      presentation: {title: "Example", summary: "Summary"},
      uiContributions: [],
    };
    const duplicate = {
      contributionId: "details",
      slot: "user-plugin.details" as const,
      title: "Details",
      renderer: {
        kind: "host-schema-v1" as const,
        document: {schemaVersion: 1 as const, blocks: []},
      },
    };

    await expect(BundledPluginManifestResolver.create([{
      ...base,
      uiContributions: [duplicate, duplicate],
    }])).rejects.toThrow("Invalid UI contributions in example.ui@1.0.0");
    await expect(BundledPluginManifestResolver.create([{
      ...base,
      presentation: {title: "", summary: "Summary"},
    }])).rejects.toThrow("Invalid presentation in example.ui@1.0.0");
    await expect(BundledPluginManifestResolver.create([{
      ...base,
      uiContributions: [{
        ...duplicate,
        renderer: {
          kind: "worker-rendered-document-v1" as const,
          codeArtifactDigest: "not-a-digest",
          height: 240,
        },
      }],
    }])).rejects.toThrow("Invalid UI contributions in example.ui@1.0.0");
    await expect(BundledPluginManifestResolver.create([{
      ...base,
      uiContributions: [{
        ...duplicate,
        renderer: {
          kind: "host-schema-v1" as const,
          document: {
            schemaVersion: 1 as const,
            blocks: Array.from({length: 64}, () => ({
              kind: "text" as const,
              text: "雪".repeat(2_000),
            })),
          },
        },
      }],
    }])).rejects.toThrow("Plugin manifest exceeds size limit: example.ui@1.0.0");
  });

  it("owns nested schema v4 declarative documents before asynchronous hashing", async () => {
    const items = ["first", "second"];
    const blocks = [{kind: "list" as const, items}];
    const source: PluginManifest = {
      schemaVersion: 4,
      pluginId: "example.snapshot-ui",
      packageVersion: "1.0.0",
      requestedCapabilities: [],
      dependencies: [],
      runtime: {
        kind: "dynamic-worker",
        codeArtifactDigest: `sha256:${"a".repeat(64)}`,
      },
      presentation: {title: "Snapshot UI", summary: "Owned nested document."},
      uiContributions: [{
        contributionId: "details",
        slot: "user-plugin.details",
        title: "Details",
        renderer: {
          kind: "host-schema-v1",
          document: {schemaVersion: 1, blocks},
        },
      }],
    };

    const pending = BundledPluginManifestResolver.create([source]);
    items[0] = "forged item";
    blocks[0] = {kind: "list", items: ["forged block"]};
    const resolver = await pending;
    const resolved = await resolver.resolve("example.snapshot-ui", "1.0.0");
    const contribution = resolved!.uiContributions![0];
    if (contribution.renderer.kind !== "host-schema-v1") {
      throw new Error("Expected declarative contribution.");
    }
    expect(contribution.renderer.document.blocks).toEqual([{
      kind: "list",
      items: ["first", "second"],
    }]);
    expect(Object.isFrozen(contribution.renderer.document)).toBe(true);
    expect(Object.isFrozen(contribution.renderer.document.blocks)).toBe(true);
    expect(Object.isFrozen(contribution.renderer.document.blocks[0])).toBe(true);
    const block = contribution.renderer.document.blocks[0];
    if (block.kind !== "list") throw new Error("Expected list block.");
    expect(Object.isFrozen(block.items)).toBe(true);
    expect(Reflect.set(block.items, 0, "forged result")).toBe(false);
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
      dependencies: [],
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
      dependencies: [],
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
