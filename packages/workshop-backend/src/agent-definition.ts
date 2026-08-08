import {
  CUSTOM_AGENT_TOOL_NAMES,
  validateBindingName,
  type AgentDefinition,
  type SkillDefinition,
} from "@gadgets/workshop-shared/api";
import { parse } from "yaml";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Agent definition with immutable Skill documents resolved for one chat. */
export type AgentDefinitionSnapshot = AgentDefinition & {skills: SkillDefinition[]};

const knownAgentToolNames = new Set<string>(CUSTOM_AGENT_TOOL_NAMES);

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

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string.`);
  }
  return value;
}

function parseAgentSkillMarkdown(value: unknown, path = "Agent skill"):
    Pick<SkillDefinition, "name" | "description"> {
  let markdown = requireNonEmptyString(value, path);
  let match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) {
    throw new TypeError(`${path} must contain YAML frontmatter delimited by --- lines.`);
  }

  let metadata: unknown;
  try {
    metadata = parse(match[1]);
  } catch {
    throw new TypeError(`${path} frontmatter must be valid YAML.`);
  }
  let frontmatter = requireObject(metadata, `${path} frontmatter`);
  let name = requireNonEmptyString(frontmatter.name, `${path} frontmatter name`);
  let description = requireNonEmptyString(
      frontmatter.description, `${path} frontmatter description`).trim();
  if (!/^[a-z0-9-]{1,64}$/.test(name)) {
    throw new TypeError(
        `${path} frontmatter name must use lowercase letters, digits, and hyphens only.`);
  }
  if (match[2].trim().length === 0) {
    throw new TypeError(`${path} must contain Markdown instructions after its frontmatter.`);
  }
  return {name, description};
}

/** Build a canonical reusable Skill definition from a stable ID and complete SKILL.md. */
export function createSkillDefinition(id: string, markdown: string): SkillDefinition {
  requireNonEmptyString(id, "Skill definition id");
  let metadata = parseAgentSkillMarkdown(markdown, "Skill definition markdown");
  return {version: 1, id, ...metadata, markdown};
}

/** Validate a complete reusable Skill definition and its SKILL.md metadata. */
export function validateSkillDefinition(value: unknown): SkillDefinition {
  let definition = requireObject(value, "Skill definition");
  rejectUnknownFields(definition,
      ["version", "id", "name", "description", "markdown"], "Skill definition");
  if (definition.version !== 1) {
    throw new TypeError("Skill definition version must be 1.");
  }
  requireNonEmptyString(definition.id, "Skill definition id");
  let name = requireNonEmptyString(definition.name, "Skill definition name");
  let description = requireNonEmptyString(
      definition.description, "Skill definition description").trim();
  let markdown = requireNonEmptyString(definition.markdown, "Skill definition markdown");
  let manifest = parseAgentSkillMarkdown(markdown, "Skill definition markdown");
  if (name !== manifest.name) {
    throw new TypeError("Skill definition name must match SKILL.md frontmatter name.");
  }
  if (description !== manifest.description) {
    throw new TypeError(
        "Skill definition description must match SKILL.md frontmatter description.");
  }
  return value as SkillDefinition;
}

/** Validate an untrusted custom agent definition before it reaches Durable Object storage. */
export function validateAgentDefinition(value: unknown): asserts value is AgentDefinition {
  let definition = requireObject(value, "Agent definition");
  rejectUnknownFields(definition,
      ["version", "id", "name", "modelId", "agentsMd", "skillIds", "tools", "bindings"],
      "Agent definition");

  if (definition.version !== 3) {
    throw new TypeError("Agent definition version must be 3.");
  }

  requireNonEmptyString(definition.id, "Agent definition id");
  requireNonEmptyString(definition.name, "Agent definition name");
  requireNonEmptyString(definition.modelId, "Agent definition modelId");

  requireString(definition.agentsMd, "Agent definition agentsMd");

  requireStringArray(definition.skillIds, "Agent definition skillIds");

  if (definition.tools !== null) {
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

  if (definition.bindings !== undefined) {
    if (!Array.isArray(definition.bindings)) {
      throw new TypeError("Agent definition bindings must be an array.");
    }
    let seenNames = new Set<string>();
    definition.bindings.forEach((binding, index) => {
      let path = `Agent definition bindings[${index}]`;
      let ref = requireObject(binding, path);
      rejectUnknownFields(ref, ["name", "vendorId", "resourceUrl"], path);
      let name = requireNonEmptyString(ref.name, `${path} name`);
      try {
        validateBindingName(name);
      } catch (error) {
        throw new TypeError(`${path} name: ${(error as Error).message}`, {cause: error});
      }
      if (seenNames.has(name)) {
        throw new TypeError(`${path} name "${name}" is used by another binding.`);
      }
      seenNames.add(name);
      requireNonEmptyString(ref.vendorId, `${path} vendorId`);
      let resourceUrl = requireNonEmptyString(ref.resourceUrl, `${path} resourceUrl`);
      if (!URL.canParse(resourceUrl)) {
        throw new TypeError(`${path} resourceUrl must be a valid URL.`);
      }
    });
  }
}

function escapeXml(value: string): string {
  return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
}

/** Format selected Skill metadata for pi-style progressive disclosure. */
export function formatAgentSkillsPrompt(skills: SkillDefinition[]): string {
  if (skills.length === 0) return "";
  let lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the readSkill tool to load a skill when the task matches its description.",
    "If the user writes /skill:<name>, load that named skill before answering.",
    "",
    "<available_skills>",
  ];
  for (let skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>agent-skill://${escapeXml(skill.id)}/SKILL.md</location>`);
    lines.push(`    <invocation>/skill:${escapeXml(skill.name)}</invocation>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** Create the harness tool that reveals selected SKILL.md documents on demand. */
export function createReadSkillTool(skills: SkillDefinition[]) {
  let byId = new Map(skills.map(skill => [skill.id, skill]));
  let byName = new Map(skills.map(skill => [skill.name, skill]));
  let parameters = Type.Object({
    id: Type.String({
      description: "Skill ID or name from the available_skills catalog in the system prompt.",
    }),
  });
  return {
    name: "readSkill",
    label: "Read skill",
    description: "Load the complete SKILL.md for an available agent skill.",
    parameters,
    execute: async (_toolCallId, {id}) => {
      let skill = byId.get(id) ?? byName.get(id);
      if (!skill) throw new Error(`Skill is not available: ${id}`);
      return {
        content: [{type: "text" as const, text: skill.markdown}],
        // Persist the exact document so later turns replay this chat's immutable Skill snapshot.
        details: {output: skill.markdown},
      };
    },
  } satisfies AgentTool<typeof parameters>;
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

/** Append an agent's AGENTS.md to the dynamic slot for regular agents only. */
export function appendAgentDefinitionInstructions(
    dynamicPrompt: string, definition: AgentDefinitionSnapshot | AgentDefinition | null,
    spawned: boolean): string {
  if (spawned) return dynamicPrompt;
  let agentsMd = definition?.agentsMd.trim() ?? "";
  let skills = definition && "skills" in definition ? definition.skills : [];
  let skillCatalog = formatAgentSkillsPrompt(skills);
  return [dynamicPrompt, agentsMd, skillCatalog]
      .filter(part => part.length > 0).join("\n\n");
}
