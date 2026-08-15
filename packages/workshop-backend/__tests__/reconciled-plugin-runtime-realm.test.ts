import { describe, expect, it } from "vitest";
import type { EffectivePluginConfigurationInput } from "../src/plugin-effective-configuration.js";
import type {
  DeploymentPluginInstallationRecord,
  UserPluginInstallation,
} from "../src/plugin-installation.js";
import {
  BundledPluginManifestResolver,
  type PluginManifestV3,
} from "../src/plugin-manifest-registry.js";
import {
  VerifyingPluginCodeArtifactResolver,
  type PluginCodeArtifactStore,
} from "../src/plugin-code-artifact.js";
import type {
  PluginRuntimeRealmIdentity,
  PluginWorkerControl,
  PluginWorkerStarter,
} from "../src/dynamic-worker-plugin-activator.js";
import { ReconciledPluginRuntimeRealm } from "../src/reconciled-plugin-runtime-realm.js";

const REALM: PluginRuntimeRealmIdentity = {
  overseerId: "workspace-a",
  userId: "user-a",
  role: "build",
  generation: "generation-a",
};
const CODE = `export default { handshake() {} };\n`;

class ArtifactStore implements PluginCodeArtifactStore {
  constructor(private code: string) {}
  async read(): Promise<string> {
    return this.code;
  }
}

class RecordingStarter implements PluginWorkerStarter {
  ids: string[] = [];
  definitions: WorkerLoaderWorkerCode[] = [];

  async start(
      id: string,
      getCode: () => Promise<WorkerLoaderWorkerCode>): Promise<PluginWorkerControl> {
    this.ids.push(id);
    this.definitions.push(await getCode());
    return {verify: async () => {}};
  }
}

async function fixture(): Promise<{
  source: {
    value: EffectivePluginConfigurationInput;
    error?: Error;
    pending: boolean;
    finishPending?: () => void;
  };
  realm: ReconciledPluginRuntimeRealm;
  starter: RecordingStarter;
}> {
  const codeHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CODE));
  const codeArtifactDigest = `sha256:${new Uint8Array(codeHash).toHex()}`;
  const manifest: PluginManifestV3 = {
    schemaVersion: 3,
    pluginId: "example.runtime",
    packageVersion: "1.0.0",
    requestedCapabilities: [],
    dependencies: [],
    runtime: {kind: "dynamic-worker", codeArtifactDigest},
  };
  const manifests = await BundledPluginManifestResolver.create([manifest]);
  const verified = await manifests.resolve(manifest.pluginId, manifest.packageVersion);
  if (verified === null) throw new Error("Expected verified manifest.");
  const user: UserPluginInstallation = {
    schemaVersion: 1,
    scope: "user",
    targetId: REALM.userId,
    installationId: "installation-a",
    pluginId: manifest.pluginId,
    packageVersion: manifest.packageVersion,
    manifestDigest: verified.manifestDigest,
    enabled: true,
    grantedCapabilities: [],
    config: null,
  };
  const source = {
    value: {deployment: [], workspace: [], user: [user]},
    error: undefined as Error | undefined,
    pending: false,
  };
  const starter = new RecordingStarter();
  const realm = new ReconciledPluginRuntimeRealm({
    identity: REALM,
    readDesiredState: async () => {
      if (source.pending) {
        await new Promise<void>(resolve => {
          source.finishPending = resolve;
        });
      }
      if (source.error) throw source.error;
      return structuredClone(source.value);
    },
    manifests,
    artifacts: new VerifyingPluginCodeArtifactResolver(new ArtifactStore(CODE)),
    starter,
    makeCapabilityEnv: () => ({}),
    refreshTimeoutMs: 100,
  });
  return {source, realm, starter};
}

describe("reconciled plugin runtime realm", () => {
  it("runs the full desired-state pipeline and preserves active gates on snapshot failure", async () => {
    const {source, realm, starter} = await fixture();

    await realm.refresh();
    expect(starter.ids).toHaveLength(1);
    realm.assertGate("example.runtime", starter.ids[0]!, "active");

    source.error = new Error("UserDO read failed");
    await expect(realm.refresh()).rejects.toThrow("UserDO read failed");
    expect(starter.ids).toHaveLength(1);
    realm.assertGate("example.runtime", starter.ids[0]!, "active");

    realm.revokeAll();
    expect(() => realm.assertGate("example.runtime", starter.ids[0]!, "active"))
      .toThrow("Plugin runtime gate denied");
    await realm.close();
  });

  it("bounds a desired-state refresh without treating it as empty state", async () => {
    const {source, realm, starter} = await fixture();
    await realm.refresh();
    const activeKey = starter.ids[0]!;
    source.pending = true;

    await expect(realm.refresh()).rejects.toThrow("Plugin runtime refresh timed out");
    expect(starter.ids).toEqual([activeKey]);
    realm.assertGate("example.runtime", activeKey, "active");
    realm.revokeAll();
    await expect(Promise.race([
      realm.close().then(() => "closed"),
      new Promise<string>(resolve => setTimeout(() => resolve("stuck"), 20)),
    ])).resolves.toBe("closed");
    source.finishPending?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(starter.ids).toEqual([activeKey]);
    expect(() => realm.assertGate("example.runtime", activeKey, "active"))
      .toThrow("Plugin runtime gate denied");
  });

  it("keeps the complete old runtime when scopes conflict", async () => {
    const {source, realm, starter} = await fixture();
    await realm.refresh();
    const activeKey = starter.ids[0]!;
    const user = source.value.user[0]!;
    const deployment: DeploymentPluginInstallationRecord = {
      schemaVersion: 1,
      scope: "deployment",
      targetId: "admin-settings",
      installationId: "deployment-installation",
      pluginId: user.pluginId,
      packageVersion: user.packageVersion,
      manifestDigest: user.manifestDigest,
      enabled: true,
      grantedCapabilities: [...user.grantedCapabilities],
      config: null,
    };
    source.value = {...source.value, deployment: [deployment]};

    await realm.refresh();

    expect(starter.ids).toEqual([activeKey]);
    realm.assertGate("example.runtime", activeKey, "active");
    realm.revokeAll();
    await realm.close();
  });
});
