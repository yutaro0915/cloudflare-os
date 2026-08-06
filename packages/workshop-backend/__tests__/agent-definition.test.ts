import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "@gadgets/workshop-shared/api";
import {
  appendAgentDefinitionPrompts,
  filterAgentTools,
  validateAgentDefinition,
} from "../src/agent-definition";

describe("validateAgentDefinition", () => {
  it("accepts a complete version 1 definition", () => {
    let definition = {
      version: 1,
      prompts: ["Answer in Japanese."],
      skills: ["context-collection-1"],
      model: {provider: "openai", model: "gpt-5.6-sol"},
      tools: {enabled: ["readFile"], disabled: ["webFetch"]},
    };

    expect(() => validateAgentDefinition(definition)).not.toThrow();
  });

  it("rejects unknown fields at every defined object level", () => {
    expect(() => validateAgentDefinition({version: 1, extra: true}))
        .toThrow(/unknown field "extra"/);
    expect(() => validateAgentDefinition({
      version: 1, model: {provider: "openai", model: "gpt-5.6-sol", extra: true},
    })).toThrow(/unknown field "extra"/);
    expect(() => validateAgentDefinition({version: 1, tools: {extra: []}}))
        .toThrow(/unknown field "extra"/);
  });

  it("rejects unknown tool names", () => {
    expect(() => validateAgentDefinition({version: 1, tools: {disabled: ["searchWeb"]}}))
        .toThrow(/Unknown agent tool "searchWeb"/);
  });

  it("rejects empty prompt fragments", () => {
    expect(() => validateAgentDefinition({version: 1, prompts: ["valid", "  "]}))
        .toThrow(/must not contain empty strings/);
  });

  it("rejects models outside the suggested model catalog", () => {
    expect(() => validateAgentDefinition({
      version: 1, model: {provider: "openai", model: "unknown"},
    })).toThrow(/Unknown agent model/);
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

describe("appendAgentDefinitionPrompts", () => {
  let definition: AgentDefinition = {
    version: 1,
    prompts: ["First workspace instruction.", "Second workspace instruction."],
  };

  it("appends fragments to the regular agent's dynamic prompt in order", () => {
    expect(appendAgentDefinitionPrompts("Workspace context.", definition, false)).toBe(
        "Workspace context.\n\nFirst workspace instruction.\n\nSecond workspace instruction.");
  });

  it("does not inject workspace prompts into spawned agents", () => {
    expect(appendAgentDefinitionPrompts("Spawner context.", definition, true))
        .toBe("Spawner context.");
  });
});
