import { execFileSync } from "node:child_process";
import { join } from "node:path";

const WORKSHOP_BACKEND_GENERATORS = [
  "build-format-blueprints.mjs",
  "build-plugin-manifests.mjs",
];

/** Generates gitignored backend modules required before Wrangler can bundle local development. */
export function generateWorkshopBackendArtifacts(
    backendDir, execute = execFileSync) {
  for (const generator of WORKSHOP_BACKEND_GENERATORS) {
    execute(
      process.execPath,
      [join(backendDir, "scripts", generator)],
      {stdio: "inherit", cwd: backendDir},
    );
  }
}
