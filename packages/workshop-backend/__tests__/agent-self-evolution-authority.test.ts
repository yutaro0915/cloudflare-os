import {createAssistantMessageEventStream, type AssistantMessage} from
  "@earendil-works/pi-ai";
import type {AiChatAuthorInfo, AiModelConfig} from "@gadgets/workshop-shared/api";
import * as Y from "yjs";
import {describe, expect, it} from "vitest";
import {runAgent, type AgentHooks} from "../src/agent.js";
import {zeroUsage} from "../src/ai-invoke.js";
import {getModel, type ModelHandle} from "../src/ai-models.js";

const AUTHOR: AiChatAuthorInfo = {type: "user", id: "human-owner", name: "Human Owner"};
const MODEL_CONFIG: AiModelConfig = {
  provider: "openai",
  model: "gpt-5.1",
  apiToken: "unused-by-capture-stream",
};

function response(
  handle: ModelHandle,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): ReturnType<typeof createAssistantMessageEventStream> {
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: handle.model.api,
    provider: handle.model.provider,
    model: handle.model.id,
    usage: zeroUsage(),
    stopReason,
    timestamp: Date.now(),
  };
  const stream = createAssistantMessageEventStream();
  stream.push({type: "start", partial: {...message, stopReason: "pending"}});
  stream.push({type: "done", reason: stopReason, message});
  stream.end(message);
  return stream;
}

function captureHooks(executeCodeEnvKeys: string[][]): AgentHooks {
  return {
    getChatAgentContext: chatId => ({chatId, bindings: {}}),
    buildYDoc: () => ({ydoc: new Y.Doc(), version: 1}),
    listGadgetInfo: () => [],
    resolveWorkpieceRoot: () => {
      throw new Error("No workpieces are exposed in this authority test.");
    },
    createGadget: () => {
      throw new Error("The capture model must not create a gadget.");
    },
    describeBinding: async () => {
      throw new Error("No bindings are exposed in this authority test.");
    },
    addGadgetBinding: () => {
      throw new Error("No bindings are exposed in this authority test.");
    },
    prepareChatBindings: async () => [],
    executeCodeMode: async (_chatId, _code, _initiator, _initiatorModelId, bindings) => {
      executeCodeEnvKeys.push(Object.keys(bindings).toSorted());
      return "captured";
    },
    activeAgentCallbackCount: () => 0,
    rejectAllAgentCallbacks: () => {},
    consumeCapturedActions: () => undefined,
    addChatMessages: () => {},
    emitChatStreamEvent: () => {},
    getChatModelData: () => undefined,
    recordAgentObservation: async () => {},
    getChatAttachmentData: async () => new Uint8Array(),
    getWebFetchEnv: () => {
      throw new Error("The capture model must not fetch the web.");
    },
    getFirecrawlSearchEnv: () => {
      throw new Error("The capture model must not search the web.");
    },
    getInstanceInstructions: async () => "",
    listConnectableVendors: async () => [],
    listConnectableResources: async () => "",
    requestConnection: async () => ({requested: false, message: "unavailable"}),
    consumeCapturedConnectionRequests: () => [],
    listAvailableBlueprints: async () => "",
    describeStandardFormats: async () => "",
    fetchBlueprint: async () => {
      throw new Error("The capture model must not fetch a blueprint.");
    },
  };
}

describe("agent self-evolution authority boundary", () => {
  it("withholds plugin tools, context, and executeCode bindings at the model invocation seam", async () => {
    const contexts: {systemPrompt: string | undefined; toolNames: string[]}[] = [];
    const executeCodeEnvKeys: string[][] = [];
    let calls = 0;
    const base = getModel({} as Cloudflare.Env, MODEL_CONFIG, AUTHOR);
    const handle: ModelHandle = {
      ...base,
      stream: (_model, context) => {
        contexts.push({
          systemPrompt: context.systemPrompt,
          toolNames: context.tools?.map(tool => tool.name) ?? [],
        });
        calls += 1;
        if (calls === 1) {
          return response(handle, [{
            type: "toolCall",
            id: "capture-env",
            name: "executeCode",
            arguments: {
              code: "export default async function(_self, env) { return Object.keys(env); }",
            },
          }], "toolUse");
        }
        return response(handle, [{type: "text", text: "done"}], "stop");
      },
    };

    await runAgent(
      captureHooks(executeCodeEnvKeys),
      handle,
      1,
      AUTHOR,
      [{
        chatId: 1,
        sequence: 0,
        timestamp: new Date(0),
        author: AUTHOR,
        type: "message",
        message: "Inspect your available authority.",
      }],
      new AbortController().signal,
      AUTHOR,
      false,
      {modelConfig: MODEL_CONFIG, measuredTokens: 0},
    );

    const forbiddenToolNames = [
      "generatePlugin",
      "publishPlugin",
      "installUserPlugin",
      "openPluginStore",
    ];
    expect(contexts.length).toBe(2);
    for (const context of contexts) {
      expect(context.toolNames).not.toEqual(expect.arrayContaining(forbiddenToolNames));
      expect(context.toolNames).not.toContain("readSkill");
      expect(context.systemPrompt).not.toMatch(
        /Plugin Store|plugin-manifests|circle\.focus-guide|publishPlugin|installUserPlugin/,
      );
    }
    expect(executeCodeEnvKeys).toEqual([[]]);
  });
});
