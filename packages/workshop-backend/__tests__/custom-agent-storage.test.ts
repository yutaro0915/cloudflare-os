import { describe, expect, it } from "vitest";
import type { AgentDefinition, SkillDefinition } from "@gadgets/workshop-shared/api";
import { UserDurableObject, type UserAiModelRecord } from "../src/user.js";

function makeUser(models: UserAiModelRecord[]) {
  let definitions = new Map<string, AgentDefinition>();
  let skills = new Map<string, SkillDefinition>();
  let gadgets = new Map<string, any>();
  let modelMap = new Map(models.map(model => [model.profile.id, model]));
  let user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env: {},
    storage: {
      profile: {get: () => ({type: "user", id: "user", name: "User"})},
      aiModels: {get: (id: string) => modelMap.get(id)},
      agentDefinitions: {
        get: (id: string) => definitions.get(id),
        list: () => definitions.values(),
        put: (definition: AgentDefinition) => definitions.set(definition.id, definition),
        delete: (id: string) => definitions.delete(id),
      },
      skillDefinitions: {
        get: (id: string) => skills.get(id),
        list: () => skills.values(),
        put: (skill: SkillDefinition) => skills.set(skill.id, skill),
        delete: (id: string) => skills.delete(id),
        byName: {get: (name: string) => [...skills.values()].find(skill => skill.name === name)},
      },
      gadgets: {
        get: (id: string) => gadgets.get(id),
        list: () => gadgets.values(),
        put: (gadget: any) => gadgets.set(gadget.id, gadget),
      },
      quickModel: {get: () => null},
    },
  });
  return {user, definitions, skills, gadgets};
}

const model: UserAiModelRecord = {
  profile: {type: "agent", id: "model-1", name: "Model One"},
  config: {provider: "openai", model: "gpt-5.6-sol", apiToken: "test-token"},
};

const definition: AgentDefinition = {
  version: 2,
  id: "reviewer",
  name: "Reviewer",
  modelId: model.profile.id,
  agentsMd: "# Reviewer\n\nReview changes carefully.",
  skillIds: ["review-code"],
  tools: {enabled: ["readFile"]},
};

const skill: SkillDefinition = {
  version: 1,
  id: "review-code",
  name: "review-code",
  description: "Review code changes carefully.",
  markdown: `---
name: review-code
description: Review code changes carefully.
---

# Review code

Read the changed files before reporting findings.`,
};

describe("custom agent storage", () => {
  it("stores definitions and resolves their configured model for chat creation", async () => {
    let {user} = makeUser([model]);

    await user.saveSkillDefinition(skill.id, skill.markdown);
    await user.saveAgentDefinition(definition);

    await expect(user.listAgentDefinitions()).resolves.toEqual([definition]);
    await expect(user.getChatContext("ignored-model", definition.id)).resolves.toMatchObject({
      aiModel: model,
      agentDefinition: {...definition, skills: [skill]},
    });
  });

  it("resolves an unsaved definition for preview without storing it", async () => {
    let {user, definitions} = makeUser([model]);
    await user.saveSkillDefinition(skill.id, skill.markdown);

    await expect(user.getPreviewChatContext(definition)).resolves.toMatchObject({
      aiModel: model,
      agentDefinition: {...definition, skills: [skill]},
    });
    expect(definitions.size).toBe(0);
  });

  it("rejects an unsaved preview definition with an unknown skill", async () => {
    let {user} = makeUser([model]);

    await expect(user.getPreviewChatContext(definition))
      .rejects.toThrow("No such skill: review-code");
  });

  it("keeps the dedicated Agent preview workspace out of the workspace list", async () => {
    let {user} = makeUser([model]);

    await user.ensureAgentPreviewGadget("preview-id");
    await user.setGadgetLastActive("preview-id", new Date(), 0);

    await expect(user.listGadgets()).resolves.toEqual([]);
    await expect(user.getGadget("preview-id")).resolves.toMatchObject({agentPreview: true});
  });

  it("stores, lists, and deletes independent skills", async () => {
    let {user} = makeUser([model]);

    await user.saveSkillDefinition(skill.id, skill.markdown);
    await expect(user.listSkillDefinitions()).resolves.toEqual([skill]);

    await user.deleteSkillDefinition(skill.id);
    await expect(user.listSkillDefinitions()).resolves.toEqual([]);
  });

  it("rejects an agent that references an unknown skill", async () => {
    let {user, definitions} = makeUser([model]);

    await expect(user.saveAgentDefinition(definition)).rejects.toThrow("No such skill: review-code");
    expect(definitions.size).toBe(0);
  });

  it("rejects a definition whose configured model does not exist", async () => {
    let {user, definitions} = makeUser([]);

    await user.saveSkillDefinition(skill.id, skill.markdown);
    await expect(user.saveAgentDefinition(definition)).rejects.toThrow("No such model: model-1");
    expect(definitions.size).toBe(0);
  });

  it("deletes a stored definition", async () => {
    let {user} = makeUser([model]);
    await user.saveSkillDefinition(skill.id, skill.markdown);
    await user.saveAgentDefinition(definition);

    await user.deleteAgentDefinition(definition.id);

    await expect(user.listAgentDefinitions()).resolves.toEqual([]);
  });
});
