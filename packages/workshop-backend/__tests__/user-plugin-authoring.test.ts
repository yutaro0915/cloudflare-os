import {describe, expect, it} from "vitest";
import {
  buildUserAuthoredPluginCandidate,
  isValidUserPluginAuthoringRequest,
  projectUserPluginCandidateReview,
} from "../src/user-plugin-authoring.js";

const request = {
  template: "focus-brief" as const,
  pluginId: "community.test-brief",
  packageVersion: "1.0.0",
  title: "Test Brief",
  summary: "A bounded test brief.",
  surfaceTitle: "Ready",
  items: ["One", "Two"],
};

describe("user plugin authoring templates", () => {
  it("builds deterministic digest-bound executable artifacts without interpolating source", async () => {
    const first = await buildUserAuthoredPluginCandidate(request);
    const second = await buildUserAuthoredPluginCandidate(request);
    expect(first).toEqual(second);
    expect(first?.manifest).toMatchObject({
      schemaVersion: 4,
      pluginId: request.pluginId,
      packageVersion: request.packageVersion,
      requestedCapabilities: [],
      presentation: {title: request.title, summary: request.summary},
    });
    expect(first?.artifacts).toHaveLength(2);
    expect(first?.artifacts[1]?.code).toContain(JSON.stringify(request.items));
    if (first === null) throw new Error("Expected generated candidate.");
    expect(projectUserPluginCandidateReview(request, first)).toEqual({
      template: "focus-brief",
      title: request.title,
      surfaceTitle: request.surfaceTitle,
      requestedCapabilities: [],
      state: "none",
      renderer: "worker-rendered-document-v1",
      artifactDigests: first.artifacts.map(artifact => artifact.codeArtifactDigest),
      verificationChecks: [
        "manifest-schema-verified",
        "artifact-digests-verified",
        "dynamic-worker-isolation-passed",
        "candidate-signature-verified",
      ],
    });
  });

  it("rejects non-community identifiers, malformed versions, and oversized input", () => {
    expect(isValidUserPluginAuthoringRequest(request)).toBe(true);
    expect(isValidUserPluginAuthoringRequest({...request, pluginId: "circle.focus-guide"}))
      .toBe(false);
    expect(isValidUserPluginAuthoringRequest({...request, packageVersion: "latest"})).toBe(false);
    expect(isValidUserPluginAuthoringRequest({...request, items: []})).toBe(false);
    expect(isValidUserPluginAuthoringRequest({...request, title: "x".repeat(81)})).toBe(false);
  });
});
