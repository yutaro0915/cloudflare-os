import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { generateWorkshopBackendArtifacts } from "./dev-server-artifacts.js";

test("generates every gitignored workshop backend module before local dev", () => {
  const backendDir = "/workspace/packages/workshop-backend";
  const calls = [];

  generateWorkshopBackendArtifacts(backendDir, (executable, args, options) => {
    calls.push({executable, args, options});
  });

  assert.deepEqual(calls, [
    {
      executable: process.execPath,
      args: [join(backendDir, "scripts", "build-format-blueprints.mjs")],
      options: {stdio: "inherit", cwd: backendDir},
    },
    {
      executable: process.execPath,
      args: [join(backendDir, "scripts", "build-plugin-manifests.mjs")],
      options: {stdio: "inherit", cwd: backendDir},
    },
  ]);
});
