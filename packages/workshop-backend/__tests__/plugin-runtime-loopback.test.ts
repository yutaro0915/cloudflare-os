import { describe, expect, it, vi } from "vitest";
import {
  assertPluginRuntimeLoopbackClaim,
  type PluginRuntimeLoopbackAuthorityHost,
  type PluginRuntimeLoopbackProps,
} from "../src/plugin-runtime-loopback.js";

const PROPS: PluginRuntimeLoopbackProps = {
  overseerId: "workspace-a",
  userId: "user-a",
  role: "build",
  generation: "generation-a",
  pluginId: "example.runtime",
  activationKey: `plugin-worker:v1:${"a".repeat(64)}`,
  manifestDigest: `sha256:${"b".repeat(64)}`,
};

function host(overrides: Partial<PluginRuntimeLoopbackAuthorityHost> = {}):
    PluginRuntimeLoopbackAuthorityHost {
  return {
    isManifestDenied: async () => false,
    revokeDeniedClaim: () => {},
    assertGate: () => {},
    ...overrides,
  };
}

describe("plugin runtime loopback policy", () => {
  it.each(["staged", "active"] as const)(
    "fails a centrally denied %s claim before local authorization",
    async phase => {
      const assertGate = vi.fn();
      const revokeDeniedClaim = vi.fn();

      await expect(assertPluginRuntimeLoopbackClaim(PROPS, phase, host({
        isManifestDenied: async () => true,
        revokeDeniedClaim,
        assertGate,
      }))).rejects.toThrow("Plugin manifest is denied");

      expect(revokeDeniedClaim).toHaveBeenCalledWith(PROPS);
      expect(assertGate).not.toHaveBeenCalled();
    },
  );

  it("stays fail-closed when background local retirement cannot be queued", async () => {
    await expect(assertPluginRuntimeLoopbackClaim(PROPS, "active", host({
      isManifestDenied: async () => true,
      revokeDeniedClaim: () => {
        throw new Error("cleanup tracker failed");
      },
    }))).rejects.toThrow("Plugin manifest is denied");
  });

  it("passes the exact non-denied claim and phase to the local gate", async () => {
    const assertGate = vi.fn();

    await assertPluginRuntimeLoopbackClaim(PROPS, "active", host({assertGate}));

    expect(assertGate).toHaveBeenCalledWith(PROPS, "active");
  });
});
