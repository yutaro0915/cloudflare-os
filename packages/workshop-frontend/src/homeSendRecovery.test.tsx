// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Regression test for issue #26: Home で会話を作成 → Home に戻る → 送信すると、古い RPC
// セッションに紐づいた provisional gadget への newChat が永遠に解決せず、isSending が
// true のままコンポーザが恒久的に無効化される（リロードするまで送信不能）。
// Home の handleSend はタイムアウトで失敗を確定させて provisional を破棄し、再送信では
// 新しい gadget を作り直して成功しなければならない。

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapsuleSpecifier, SlashCommandRequest } from "@gadgets/workshop-shared/api";

type OnSend = (
  message: string | SlashCommandRequest,
  modelId: string | null,
  capsules?: CapsuleSpecifier[],
) => Promise<void>;

const testState = vi.hoisted(() => {
  const state = {
    addToast: vi.fn<(toast: unknown) => void>(),
    navigate: vi.fn<(options: unknown) => void>(),
    onSend: null as OnSend | null,
    gadgets: [] as Array<{ disposed: boolean; hang: boolean }>,
    // Overseers created by newGadget(). The first hangs forever (stale RPC session), later
    // ones resolve like a live session.
    newGadget: null as unknown as () => unknown,
  };
  state.newGadget = () => {
    const hang = state.gadgets.length === 0;
    const gadget = { disposed: false, hang };
    state.gadgets.push(gadget);
    return {
      newChat: () => (hang
        ? new Promise(() => {})
        : Promise.resolve({ chatId: 0 })),
      getMetadata: () => (hang
        ? new Promise(() => {})
        : Promise.resolve({ id: "gadget-2" })),
      newGatekeeper: () => { throw new Error("unused"); },
      [Symbol.dispose]: () => { gadget.disposed = true; },
    };
  };
  return state;
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => {
  // Stable identity: the component keys effects off `authenticatedApi`.
  const authenticatedApi = {
    listModels: async () => [],
    listAgentDefinitions: async () => [],
    newGadget: () => testState.newGadget(),
  };
  return { useAuthenticatedApi: () => ({ authenticatedApi }) };
});

vi.mock("./ChatInterface", () => ({
  ChatInput: ({ onSend }: { onSend: OnSend }) => {
    testState.onSend = onSend;
    return <textarea aria-label="Prompt" readOnly />;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Home send recovery (issue #26)", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root?.unmount());
    container?.remove();
    testState.onSend = null;
    testState.gadgets.length = 0;
    vi.clearAllMocks();
  });

  it("times out a send stuck on a dead session, then succeeds on retry with a fresh gadget", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent prompt={undefined} />));
    expect(testState.onSend).not.toBeNull();
    // Fake only setTimeout so React's own scheduling stays on real timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    // First send: the provisional gadget's RPC calls never settle (stale session). Without a
    // timeout this promise hangs forever and ChatInput's isSending never resets — the bug.
    let firstOutcome: "pending" | "rejected" | "resolved" = "pending";
    let firstSend!: Promise<void>;
    await act(async () => {
      firstSend = testState.onSend!("hello", "some-model");
      firstSend.then(() => { firstOutcome = "resolved"; }, () => { firstOutcome = "rejected"; });
    });
    expect(firstOutcome).toBe("pending");

    await vi.advanceTimersByTimeAsync(20_000);
    await act(async () => {});
    expect(firstOutcome).toBe("rejected");
    // The user sees an error instead of a composer that is disabled forever.
    expect(testState.addToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error" }),
    );
    // The stale provisional gadget is dropped so the retry starts clean.
    expect(testState.gadgets).toHaveLength(1);
    expect(testState.gadgets[0].disposed).toBe(true);
    expect(testState.navigate).not.toHaveBeenCalled();

    // Retry: a fresh gadget is created on the (now healthy) session and navigation happens.
    await act(async () => {
      await testState.onSend!("hello again", "some-model");
    });
    expect(testState.gadgets).toHaveLength(2);
    expect(testState.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/workspace/$id", params: { id: "gadget-2" } }),
    );
  });
});
