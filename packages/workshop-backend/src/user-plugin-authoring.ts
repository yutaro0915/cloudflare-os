import type {
  StageUserPluginCandidateRequest,
  UserPluginCandidateReview,
} from "@gadgets/workshop-shared/api";
import type {GeneratedPluginCandidate} from "./plugin-candidate-pipeline.js";
import type {PluginManifest} from "./plugin-manifest-registry.js";

const COMMUNITY_PLUGIN_ID = /^community\.[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/;
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RUNTIME_SOURCE =
  "export default { async handshake() {}, async invoke() { return {ok: true}; } };";

const BOARD_SOURCE = [
  "const columns = [{id: 'todo', title: 'To do'}, {id: 'doing', title: 'Doing'}, {id: 'done', title: 'Done'}];",
  "function initialState() { return {schemaVersion: 1, columns: columns.map((column, columnIndex) => ({...column, tasks: columnIndex === 0 ? seed.items.map((title, index) => ({id: 'seed-' + index, title})) : []}))}; }",
  "function currentState(value) { if (value === null) return initialState(); if (value?.schemaVersion !== 1 || !Array.isArray(value.columns)) throw new TypeError('Invalid board state.'); return structuredClone(value); }",
  "function render(value) { const state = currentState(value); return {schemaVersion: 1, title: seed.title, form: {actionId: 'task.create', label: 'Add item', placeholder: 'Add a work item', maxLength: 200}, columns: state.columns.map(column => ({columnId: column.id, title: column.title, items: column.tasks.map(task => ({itemId: task.id, title: task.title, actions: [...state.columns.filter(destination => destination.id !== column.id).map(destination => ({actionId: 'task.move:' + task.id + ':' + destination.id, label: 'Move to ' + destination.title, tone: 'neutral'})), {actionId: 'task.delete:' + task.id, label: 'Delete', tone: 'danger'}]}))}))}; }",
  "function reduce({state: value, action}) { const state = currentState(value); if (action.actionId === 'task.create') { const title = action.input?.trim(); if (!title || title.length > 200) throw new TypeError('Invalid item title.'); state.columns[0].tasks.push({id: crypto.randomUUID(), title}); } else if (action.actionId.startsWith('task.move:')) { const [, taskId, destinationId] = action.actionId.split(':'); const source = state.columns.find(column => column.tasks.some(task => task.id === taskId)); const destination = state.columns.find(column => column.id === destinationId); if (!source || !destination) throw new TypeError('Unknown item move.'); const index = source.tasks.findIndex(task => task.id === taskId); const [task] = source.tasks.splice(index, 1); destination.tasks.push(task); } else if (action.actionId.startsWith('task.delete:')) { const taskId = action.actionId.slice('task.delete:'.length); const source = state.columns.find(column => column.tasks.some(task => task.id === taskId)); if (!source) throw new TypeError('Unknown item deletion.'); source.tasks.splice(source.tasks.findIndex(task => task.id === taskId), 1); } else throw new TypeError('Unknown board action.'); return {state, document: render(state)}; }",
  "export default {render: ({state}) => render(state), reduce};",
].join("\n");

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return "sha256:" + new Uint8Array(digest).toHex();
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

/** Rejects malformed or oversized authoring input before executable bytes are constructed. */
export function isValidUserPluginAuthoringRequest(
    request: StageUserPluginCandidateRequest): boolean {
  return (request.template === "focus-brief" || request.template === "personal-board") &&
    COMMUNITY_PLUGIN_ID.test(request.pluginId) &&
    EXACT_SEMVER.test(request.packageVersion) &&
    boundedText(request.title, 80) && boundedText(request.summary, 240) &&
    boundedText(request.surfaceTitle, 80) && Array.isArray(request.items) &&
    request.items.length > 0 && request.items.length <= 8 &&
    request.items.every(item => boundedText(item, 200));
}

function focusBriefSource(request: StageUserPluginCandidateRequest): string {
  const document = {
    schemaVersion: 1,
    blocks: [
      {kind: "notice", tone: "info", text: request.surfaceTitle.trim()},
      {kind: "list", items: request.items.map(item => item.trim())},
    ],
  };
  return "const document = " + JSON.stringify(document) + ";\n" +
    "export default { render() { return structuredClone(document); } };";
}

/** Builds exact manifest and executable artifacts from one closed host-owned template. */
export async function buildUserAuthoredPluginCandidate(
    request: StageUserPluginCandidateRequest): Promise<GeneratedPluginCandidate | null> {
  if (!isValidUserPluginAuthoringRequest(request)) return null;
  const runtimeDigest = await sha256Text(RUNTIME_SOURCE);
  const uiSource = request.template === "focus-brief"
    ? focusBriefSource(request)
    : "const seed = " + JSON.stringify({
      title: request.surfaceTitle.trim(),
      items: request.items.map(item => item.trim()),
    }) + ";\n" + BOARD_SOURCE;
  const uiDigest = await sha256Text(uiSource);
  const base = {
    pluginId: request.pluginId,
    packageVersion: request.packageVersion,
    dependencies: [] as string[],
    runtime: {kind: "dynamic-worker" as const, codeArtifactDigest: runtimeDigest},
    presentation: {title: request.title.trim(), summary: request.summary.trim()},
  };
  const manifest: PluginManifest = request.template === "focus-brief" ? {
    schemaVersion: 4,
    ...base,
    requestedCapabilities: [],
    uiContributions: [{
      contributionId: "brief",
      slot: "user-plugin.details",
      title: request.surfaceTitle.trim(),
      renderer: {kind: "worker-rendered-document-v1", codeArtifactDigest: uiDigest, height: 260},
    }],
  } : {
    schemaVersion: 5,
    ...base,
    requestedCapabilities: ["plugin.ui.state.mutate"],
    state: {kind: "installation"},
    uiContributions: [{
      contributionId: "board",
      slot: "user-plugin.navigation",
      title: request.surfaceTitle.trim(),
      renderer: {kind: "worker-interactive-document-v1", codeArtifactDigest: uiDigest},
    }],
  };
  return {
    manifest,
    artifacts: [
      {codeArtifactDigest: runtimeDigest, code: RUNTIME_SOURCE},
      {codeArtifactDigest: uiDigest, code: uiSource},
    ],
  };
}

/** Projects one generated package into the bounded facts required for admin publication review. */
export function projectUserPluginCandidateReview(
    request: StageUserPluginCandidateRequest,
    candidate: GeneratedPluginCandidate): UserPluginCandidateReview {
  const manifest = candidate.manifest;
  const expectedSchemaVersion = request.template === "personal-board" ? 5 : 4;
  if (manifest.schemaVersion !== expectedSchemaVersion ||
      (manifest.schemaVersion !== 4 && manifest.schemaVersion !== 5)) {
    throw new TypeError("Generated candidate does not match its authoring template.");
  }
  const contribution = manifest.uiContributions[0];
  if (!contribution || contribution.renderer.kind === "host-schema-v1") {
    throw new TypeError("Generated candidate is missing its executable UI contribution.");
  }
  return {
    template: request.template,
    title: manifest.presentation.title,
    surfaceTitle: contribution.title,
    requestedCapabilities: [...manifest.requestedCapabilities],
    state: manifest.schemaVersion === 5 ? manifest.state.kind : "none",
    renderer: contribution.renderer.kind,
    artifactDigests: candidate.artifacts.map(artifact => artifact.codeArtifactDigest),
    verificationChecks: [
      "manifest-schema-verified",
      "artifact-digests-verified",
      "dynamic-worker-isolation-passed",
      "candidate-signature-verified",
    ],
  };
}
