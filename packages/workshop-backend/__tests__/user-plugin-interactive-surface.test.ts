import { describe, expect, it, vi } from "vitest";
import type {InteractUserPluginSurfaceRequest} from "@gadgets/workshop-shared/api";
import {
  interactUserPluginSurface,
  type UserPluginInteractiveSurfaceHost,
} from "../src/user-plugin-interactive-surface.js";

async function unexpectedPluginInteraction(): Promise<never> {
  throw new Error("A stale request must not reach plugin state or code.");
}

describe("user plugin interactive surface", () => {
  it("rejects a pending request when the installation version changed", async () => {
    const resolveManifest = vi.fn(async () => {
      throw new Error("A stale request must not reach the replacement manifest.");
    });
    const host: UserPluginInteractiveSurfaceHost = {
      userId: "user-1",
      readInstallation: async () => ({
        installationId: "installation-1",
        pluginId: "test.kanban",
        packageVersion: "2.0.0",
        manifestDigest: `sha256:${"b".repeat(64)}`,
        stateRef: "state-1",
      }),
      resolveManifest,
      isManifestDenied: unexpectedPluginInteraction,
      readState: unexpectedPluginInteraction,
      runArtifact: unexpectedPluginInteraction,
      compareAndSetState: unexpectedPluginInteraction,
    };
    const request = {
      pluginId: "test.kanban",
      expectedInstallationId: "installation-1",
      expectedPackageVersion: "1.0.0",
      contributionId: "board",
      interaction: {
        kind: "action",
        expectedRevision: 0,
        mutationId: "pending-v1-action",
        actionId: "task.create",
        input: "Only v1 understands this action",
      },
    } as InteractUserPluginSurfaceRequest;

    await expect(interactUserPluginSurface(request, host)).resolves.toEqual({
      ok: false,
      error: "PLUGIN_UI_NOT_AVAILABLE",
    });
    expect(resolveManifest).not.toHaveBeenCalled();
  });
});
