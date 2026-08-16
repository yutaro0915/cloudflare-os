import { describe, expect, it } from "vitest";
import type { AgentDefinition, SkillDefinition } from "@gadgets/workshop-shared/api";
import {CUSTOM_AGENT_TOOL_NAMES} from "@gadgets/workshop-shared/api";
import {
  appendAgentDefinitionInstructions,
  createReadSkillTool,
  filterAgentTools,
  formatAgentSkillsPrompt,
  validateSkillDefinition,
  validateAgentDefinition,
} from "../src/agent-definition";

const skillMarkdown = `---
name: review-code
description: Review code changes for correctness and clarity.
---

# Review code

Read the changed files before reporting findings.`;

const skill: SkillDefinition = {
  version: 1,
  id: "review-code",
  name: "review-code",
  description: "Review code changes for correctness and clarity.",
  markdown: skillMarkdown,
};

describe("validateAgentDefinition", () => {
  it("rejects plugin authority that is not part of the saved-agent catalog", () => {
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toEqual(expect.arrayContaining([
      "generatePlugin",
      "publishPlugin",
      "installUserPlugin",
      "openPluginStore",
    ]));
    expect(() => validateAgentDefinition({
      version: 3,
      id: "self-evolver",
      name: "Self evolver",
      modelId: "gpt-5.6-sol",
      agentsMd: "",
      skillIds: [],
      tools: {enabled: ["publishPlugin"]},
    })).toThrow(/Unknown agent tool "publishPlugin"/);
  });

  it("accepts a complete version 3 definition", () => {
    let definition = {
      version: 3,
      id: "reviewer",
      name: "Reviewer",
      modelId: "gpt-5.6-sol",
      agentsMd: "# Instructions\n\nAnswer in Japanese.",
      skillIds: [skill.id],
      tools: {enabled: ["readFile"], disabled: ["webFetch"]},
    };

    expect(() => validateAgentDefinition(definition)).not.toThrow();
  });

  it("rejects unknown fields at every defined object level", () => {
    let base = {
      version: 3,
      id: "reviewer",
      name: "Reviewer",
      modelId: "gpt-5.6-sol",
      agentsMd: "",
      skillIds: [],
      tools: null,
    };
    expect(() => validateAgentDefinition({...base, extra: true}))
        .toThrow(/unknown field "extra"/);
    expect(() => validateAgentDefinition({...base, tools: {extra: []}}))
        .toThrow(/unknown field "extra"/);
  });

  it("validates bindings: names, duplicates, and resource URLs", () => {
    let base = {
      version: 3,
      id: "mascot",
      name: "Mascot",
      modelId: "gpt-5.6-sol",
      agentsMd: "",
      skillIds: [],
      tools: null,
    };
    let binding = {name: "MEMORY", vendorId: "memory", resourceUrl: "memory://bank/mascot"};

    expect(() => validateAgentDefinition({...base, bindings: []})).not.toThrow();
    expect(() => validateAgentDefinition({...base, bindings: [binding]})).not.toThrow();
    expect(() => validateAgentDefinition({...base, bindings: [binding, {...binding, resourceUrl: "memory://bank/other"}]}))
        .toThrow(/used by another binding/);
    expect(() => validateAgentDefinition({...base, bindings: [{...binding, name: "1BAD"}]}))
        .toThrow(/binding names must be JavaScript identifiers/);
    expect(() => validateAgentDefinition({...base, bindings: [{...binding, resourceUrl: "not a url"}]}))
        .toThrow(/must be a valid URL/);
    expect(() => validateAgentDefinition({...base, bindings: [{...binding, vendorId: ""}]}))
        .toThrow(/vendorId/);
    expect(() => validateAgentDefinition({...base, bindings: [{...binding, extra: 1}]}))
        .toThrow(/unknown field "extra"/);
    expect(() => validateAgentDefinition({...base, bindings: {}})).toThrow(/must be an array/);
  });

  it("rejects unknown tool names", () => {
    expect(() => validateAgentDefinition({
      version: 3,
      id: "reviewer",
      name: "Reviewer",
      modelId: "gpt-5.6-sol",
      agentsMd: "",
      skillIds: [],
      tools: {disabled: ["searchWeb"]},
    }))
        .toThrow(/Unknown agent tool "searchWeb"/);
  });

  it("requires AGENTS.md to be a string", () => {
    expect(() => validateAgentDefinition({
      version: 3,
      id: "reviewer",
      name: "Reviewer",
      modelId: "gpt-5.6-sol",
      agentsMd: [],
      skillIds: [],
      tools: null,
    }))
        .toThrow(/agentsMd must be a string/);
  });

  it("requires identity, model, and collection fields", () => {
    expect(() => validateAgentDefinition({
      version: 3,
      id: "",
      name: "Reviewer",
      modelId: "gpt-5.6-sol",
      agentsMd: "",
      skillIds: [],
      tools: null,
    })).toThrow(/id must be a non-empty string/);
    expect(() => validateAgentDefinition({
      version: 3,
      id: "reviewer",
      name: "Reviewer",
      modelId: "gpt-5.6-sol",
      agentsMd: "",
      tools: null,
    })).toThrow(/skillIds must be an array of strings/);
  });
});

describe("validateSkillDefinition", () => {
  it("accepts a complete SKILL.md and returns frontmatter metadata", () => {
    expect(validateSkillDefinition(skill)).toEqual(skill);
  });

  it("rejects metadata that disagrees with SKILL.md", () => {
    expect(() => validateSkillDefinition({...skill, name: "wrong-name"}))
        .toThrow(/name must match SKILL.md frontmatter/);
    expect(() => validateSkillDefinition({...skill, description: "Wrong description."}))
        .toThrow(/description must match SKILL.md frontmatter/);
  });

  it("rejects missing frontmatter and instructions", () => {
    expect(() => validateSkillDefinition({...skill, markdown: "# No frontmatter"}))
        .toThrow(/must contain YAML frontmatter/);
    expect(() => validateSkillDefinition({...skill, markdown: `---
name: missing-description
---

Instructions.`})).toThrow(/description must be a non-empty string/);
    expect(() => validateSkillDefinition({...skill, markdown: `---
name: empty-body
description: Has no instructions.
---`})).toThrow(/must contain Markdown instructions/);
  });
});

describe("formatAgentSkillsPrompt", () => {
  it("exposes only skill metadata and a virtual location", () => {
    let prompt = formatAgentSkillsPrompt([skill]);

    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>review-code</name>");
    expect(prompt).toContain("<description>Review code changes for correctness and clarity.</description>");
    expect(prompt).toContain("<location>agent-skill://review-code/SKILL.md</location>");
    expect(prompt).toContain("/skill:review-code");
    expect(prompt).not.toContain("Read the changed files before reporting findings.");
  });

  it("escapes metadata before placing it in XML", () => {
    expect(formatAgentSkillsPrompt([{...skill, description: "Use <code> & report."}]))
        .toContain("Use &lt;code&gt; &amp; report.");
  });
});

describe("readSkill tool", () => {
  it("returns the complete selected SKILL.md on demand", async () => {
    let tool = createReadSkillTool([skill]);

    await expect(tool.execute("call-1", {id: skill.id}, undefined)).resolves.toMatchObject({
      content: [{type: "text", text: skillMarkdown}],
      details: {output: skillMarkdown},
    });
  });

  it("accepts the catalog name used by normal skill invocations", async () => {
    let namedSkill = {...skill, id: "skill-record-id"};
    let tool = createReadSkillTool([namedSkill]);

    await expect(tool.execute("call-1", {id: namedSkill.name}, undefined)).resolves.toMatchObject({
      content: [{type: "text", text: skillMarkdown}],
      details: {output: skillMarkdown},
    });
  });

  it("cannot read a skill outside the selected snapshot", async () => {
    let tool = createReadSkillTool([skill]);

    await expect(tool.execute("call-1", {id: "unselected"}, undefined))
        .rejects.toThrow("Skill is not available: unselected");
  });
});

describe("filterAgentTools", () => {
  let tools = {readFile: 1, writeFile: 2, webFetch: 3};

  it("uses a non-empty enabled list as a whitelist even when disabled is also present", () => {
    expect(filterAgentTools(tools, {
      enabled: ["readFile", "webFetch"], disabled: ["webFetch"],
    })).toEqual({readFile: 1, webFetch: 3});
  });

  it("removes disabled tools when enabled is absent", () => {
    expect(filterAgentTools(tools, {disabled: ["webFetch"]}))
        .toEqual({readFile: 1, writeFile: 2});
  });

  it("leaves all tools available for empty lists", () => {
    expect(filterAgentTools(tools, {enabled: [], disabled: []})).toBe(tools);
  });
});

describe("appendAgentDefinitionInstructions", () => {
  let definition: AgentDefinition = {
    version: 3,
    id: "reviewer",
    name: "Reviewer",
    modelId: "gpt-5.6-sol",
    agentsMd: "# Agent instructions\n\nFirst custom instruction.\n\nSecond custom instruction.",
    skillIds: [skill.id],
    tools: null,
  };

  it("appends fragments to the regular agent's dynamic prompt in order", () => {
    expect(appendAgentDefinitionInstructions("Workspace context.", definition, false)).toBe(
        "Workspace context.\n\n# Agent instructions\n\nFirst custom instruction.\n\nSecond custom instruction.");
  });

  it("does not inject AGENTS.md into spawned agents", () => {
    expect(appendAgentDefinitionInstructions("Spawner context.", definition, true))
        .toBe("Spawner context.");
  });
});
