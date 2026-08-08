// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentDefinition,
  AuthenticatedApi,
  Overseer,
} from "@gadgets/workshop-shared/api";
import { AgentPreview } from "./AgentPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const definition: AgentDefinition = {
  version: 3,
  id: "draft-agent",
  name: "Draft Agent",
  modelId: "model-1",
  agentsMd: "Answer briefly.",
  skillIds: ["skill-1"],
  tools: null,
};

describe("AgentPreview", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  it("starts a preview chat from the unsaved definition", async () => {
    const accidentallyInvokedAsUpdater = vi.fn<() => void>();
    const overseer = Object.assign(accidentallyInvokedAsUpdater, {
      getChatHistory: vi.fn<(chatId: number) => Promise<{messages: never[]}>>(
        async () => ({messages: []}),
      ),
      listChats: vi.fn<() => Promise<never[]>>(async () => []),
    }) as unknown as RpcStub<Overseer>;
    const startAgentPreviewChat = vi.fn<
      (...args: Parameters<AuthenticatedApi['startAgentPreviewChat']>) => Promise<number>
    >(async () => 7);
    const authenticatedApi = {
      openAgentPreview: vi.fn<() => Promise<RpcStub<Overseer>>>(async () => overseer),
      startAgentPreviewChat,
    } as unknown as RpcStub<AuthenticatedApi>;

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <AgentPreview authenticatedApi={authenticatedApi} definition={definition} />,
    ));

    const input = container.querySelector<HTMLTextAreaElement>('[aria-label="Preview message"]')!;
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
        .call(input, "Hello preview");
      input.dispatchEvent(new Event("input", {bubbles: true}));
    });
    await act(async () => {
      button.click();
    });

    expect(authenticatedApi.openAgentPreview).toHaveBeenCalledOnce();
    expect(accidentallyInvokedAsUpdater).not.toHaveBeenCalled();
    expect(startAgentPreviewChat).toHaveBeenCalledWith("Hello preview", definition);
  });
});
