import {
  SUGGESTED_MODELS,
  type AgentDefinition,
  type AiModelProvider,
} from "@gadgets/workshop-shared/api";

/** Tool names accepted by workspace agent definitions. */
export const KNOWN_AGENT_TOOL_NAMES = [
  "readFile",
  "writeFile",
  "editFile",
  "webFetch",
  "observeUserChanges",
  "describeBinding",
  "setGadgetBinding",
  "createGadget",
  "listBlueprints",
  "executeCode",
  "listConnectableResources",
  "requestConnection",
  "giveUp",
] as const;

const knownAgentToolNames = new Set<string>(KNOWN_AGENT_TOOL_NAMES);

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
    value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  let allowedFields = new Set(allowed);
  let unknown = Object.keys(value).find(key => !allowedFields.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`${path} contains unknown field "${unknown}".`);
  }
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new TypeError(`${path} must be an array of strings.`);
  }
  return value;
}

/** Validate an untrusted workspace agent definition before it reaches Durable Object storage. */
export function validateAgentDefinition(value: unknown): asserts value is AgentDefinition {
  let definition = requireObject(value, "Agent definition");
  rejectUnknownFields(definition, ["version", "prompts", "skills", "model", "tools"],
      "Agent definition");

  if (definition.version !== 1) {
    throw new TypeError("Agent definition version must be 1.");
  }

  if (definition.prompts !== undefined) {
    let prompts = requireStringArray(definition.prompts, "Agent definition prompts");
    if (prompts.some(prompt => prompt.trim().length === 0)) {
      throw new TypeError("Agent definition prompts must not contain empty strings.");
    }
  }

  if (definition.skills !== undefined) {
    requireStringArray(definition.skills, "Agent definition skills");
  }

  if (definition.model !== undefined && definition.model !== null) {
    let model = requireObject(definition.model, "Agent definition model");
    rejectUnknownFields(model, ["provider", "model"], "Agent definition model");
    if (typeof model.provider !== "string" || !Object.hasOwn(SUGGESTED_MODELS, model.provider)) {
      throw new TypeError(`Unknown agent model provider "${String(model.provider)}".`);
    }
    if (typeof model.model !== "string" ||
        !Object.hasOwn(SUGGESTED_MODELS[model.provider as AiModelProvider], model.model)) {
      throw new TypeError(
          `Unknown agent model "${String(model.provider)}/${String(model.model)}".`);
    }
  }

  if (definition.tools !== undefined && definition.tools !== null) {
    let tools = requireObject(definition.tools, "Agent definition tools");
    rejectUnknownFields(tools, ["enabled", "disabled"], "Agent definition tools");
    for (let field of ["enabled", "disabled"] as const) {
      if (tools[field] === undefined) continue;
      let names = requireStringArray(tools[field], `Agent definition tools.${field}`);
      let unknown = names.find(name => !knownAgentToolNames.has(name));
      if (unknown !== undefined) {
        throw new TypeError(`Unknown agent tool "${unknown}".`);
      }
    }
  }
}

/** Apply an agent definition's tool rules without mutating the original tool map. */
export function filterAgentTools<T>(
    tools: Record<string, T>, rules: AgentDefinition["tools"]): Record<string, T> {
  let allowed = rules?.enabled?.length ? new Set(rules.enabled) : undefined;
  let blocked = !allowed && rules?.disabled?.length ? new Set(rules.disabled) : undefined;
  if (!allowed && !blocked) return tools;

  let result: Record<string, T> = {};
  for (let [name, tool] of Object.entries(tools)) {
    if (allowed ? allowed.has(name) : !blocked!.has(name)) result[name] = tool;
  }
  return result;
}

/** Append definition prompts to the dynamic slot for regular agents only. */
export function appendAgentDefinitionPrompts(
    dynamicPrompt: string, definition: AgentDefinition | null, spawned: boolean): string {
  if (spawned) return dynamicPrompt;
  let prompts = (definition?.prompts ?? []).filter(prompt => prompt.trim().length > 0);
  return [dynamicPrompt, ...prompts].filter(part => part.length > 0).join("\n\n");
}
