// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, ChatSummary } from "../../types";

const mocks = vi.hoisted(() => {
  const state = {
    chats: [] as unknown[],
    messages: [] as unknown[],
    participants: [] as string[],
  };
  return {
    state,
    appendMessage: vi.fn(),
    listChatParticipants: vi.fn(),
    listChats: vi.fn(),
    resolveContextEntries: vi.fn(),
    resolveMemorySnippetsBatch: vi.fn(),
    prepareResponseRequest: vi.fn(),
    finalizeResponseOutput: vi.fn(),
    parseLlamaSseStream: vi.fn(),
    runtimeFetch: vi.fn(),
    setNotice: vi.fn(),
    setReplyState: vi.fn(),
    setStreaming: vi.fn(),
    setMessagesByChat: vi.fn(),
    setParticipantsByChat: vi.fn(),
    setComposerInput: vi.fn(),
  };
});

vi.mock("../../api/tauri", () => ({
  appendMessage: mocks.appendMessage,
  branchChat: vi.fn(),
  createChat: vi.fn(),
  createGroupChat: vi.fn(),
  listChatParticipants: mocks.listChatParticipants,
  listChats: mocks.listChats,
  resolveContextEntries: mocks.resolveContextEntries,
  resolveMemorySnippets: vi.fn(),
  resolveMemorySnippetsBatch: mocks.resolveMemorySnippetsBatch,
  upsertChatRelationshipState: vi.fn(),
  updateGroupChat: vi.fn(),
  updateMessage: vi.fn(),
  editMessageAndTruncate: vi.fn(),
}));

vi.mock("../../extensions-runtime", () => ({
  extensionRegistry: {
    beforeSend: async (draft: { chatId: string; text: string }) => ({ draft }),
    transformPromptNotes: async (notes: string[]) => ({ notes, added: [] }),
    afterReply: async () => undefined,
  },
}));

vi.mock("./auto-summary", () => ({
  maybeUpdateAutoSummary: vi.fn(),
}));

vi.mock("../memory/memory-extraction", () => ({
  maybeExtractMemories: vi.fn(),
}));

vi.mock("../../lib/sse", () => ({
  parseLlamaSseStream: mocks.parseLlamaSseStream,
}));

vi.mock("../../lib/runtime-fetch", () => ({
  runtimeFetch: mocks.runtimeFetch,
}));

vi.mock("./response-system", () => ({
  buildResponseRetrievalHints: vi.fn(() => ""),
  buildStreamingPreview: vi.fn(() => ""),
  finalizeResponseOutput: mocks.finalizeResponseOutput,
  prepareResponseRequest: mocks.prepareResponseRequest,
}));

vi.mock("./response-system/diagnostics", () => {
  const recorder = new Proxy(
    { entry: { runtime: {} } },
    {
      get: (target, key) =>
        key in target ? target[key as keyof typeof target] : () => ({ finish: () => undefined }),
    },
  );
  return {
    buildResponseDiagnosticsInspection: vi.fn(() => ({})),
    createResponseDiagnostics: vi.fn(() => recorder),
    formatResponseDiagnosticError: vi.fn((error: unknown) => String(error)),
  };
});

vi.mock("../../stores", () => {
  const characters = ["a", "b", "c", "d"].map((id) => ({
    id,
    name: `Char ${id.toUpperCase()}`,
  }));
  const chatState = () => ({
    chats: mocks.state.chats,
    participantsByChat: { "chat-1": mocks.state.participants },
    memoryByChat: {},
    messagesByChat: { "chat-1": mocks.state.messages },
    activeChatId: "chat-1",
    setParticipantsByChat: mocks.setParticipantsByChat,
    setMessagesByChat: mocks.setMessagesByChat,
  });
  return {
    useAppStore: () => ({ setDetailTab: vi.fn(), setNotice: mocks.setNotice }),
    useModelStore: () => ({
      runtime: { status: "running", endpoint: "http://127.0.0.1:8080" },
      models: [],
    }),
    useCharacterStore: () => ({
      characters,
      activeCharacterId: "a",
      setActiveCharacterId: vi.fn(),
    }),
    useChatStore: () => ({
      ...chatState(),
      composerInput: "",
      replyStateByChat: {},
      editingMessageDraft: "",
      setChats: vi.fn(),
      setActiveChatId: vi.fn(),
      setComposerInput: mocks.setComposerInput,
      setReplyState: mocks.setReplyState,
      setStreaming: mocks.setStreaming,
      setMemoryByChat: vi.fn(),
      setMessageActionBusyId: vi.fn(),
      setGroupBuilderOpen: vi.fn(),
      setGroupTitle: vi.fn(),
      setCreatingGroup: vi.fn(),
      startEditMessage: vi.fn(),
      cancelEditMessage: vi.fn(),
    }),
    useContextStore: () => ({
      setActiveContextHits: vi.fn(),
      setActiveMemoryHits: vi.fn(),
    }),
    useProfileStore: () => ({ userProfile: null, relationshipStateByChat: {} }),
    usePresetStore: () => ({ activeGenerationPresetId: null, generationPresets: [] }),
    characterStore: { getState: () => ({ characters }) },
    chatStore: { getState: chatState },
    modelStore: {
      getState: () => ({
        runtime: { status: "running", endpoint: "http://127.0.0.1:8080" },
        models: [],
      }),
    },
    profileStore: {
      getState: () => ({ userProfile: null, relationshipStateByChat: {} }),
    },
    presetStore: {
      getState: () => ({ generationPresets: [], activeGenerationPresetId: null }),
    },
  };
});

import { maybeUpdateAutoSummary } from "./auto-summary";
import { maybeExtractMemories } from "../memory/memory-extraction";
import { useChatOrchestration } from "./use-chat-orchestration";

function chatSummary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: "chat-1",
    title: "Group",
    chatMode: "group",
    participantIds: ["a", "b", "c", "d"],
    historyEpoch: 2,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  speakerCharacterId?: string,
): ChatMessage {
  return { id, chatId: "chat-1", role, content, speakerCharacterId, createdAt: "" };
}

function streamOf(content: string, finishReason: string | null = "stop") {
  mocks.parseLlamaSseStream.mockImplementation(async function* parse() {
    yield { content };
    yield { content: "", finishReason };
  });
}

async function flushQueue() {
  await act(async () => {
    for (let turn = 0; turn < 40; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function renderOrchestration() {
  return renderHook(() =>
    useChatOrchestration({ current: null }, vi.fn().mockResolvedValue(undefined)),
  );
}

function spokenOrder(): Array<string | undefined> {
  return mocks.prepareResponseRequest.mock.calls.map(
    (call) => (call[0] as { speaker?: { id: string } }).speaker?.id,
  );
}

describe("reply queue speaker selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    mocks.state.chats = [chatSummary()];
    mocks.state.participants = ["a", "b", "c", "d"];
    mocks.state.messages = [
      message("m1", "user", "what does everyone want for dinner"),
      message("m2", "assistant", "Pizza for me.", "a"),
    ];
    mocks.listChatParticipants.mockResolvedValue(["a", "b", "c", "d"]);
    mocks.listChats.mockResolvedValue([]);
    mocks.resolveContextEntries.mockResolvedValue([]);
    mocks.resolveMemorySnippetsBatch.mockImplementation(
      async (inputs: unknown[]) => inputs.map(() => []),
    );
    mocks.appendMessage.mockImplementation(async (payload: Record<string, unknown>) => ({
      id: `saved-${String(payload.role)}`,
      createdAt: "",
      ...payload,
    }));
    mocks.prepareResponseRequest.mockImplementation(() => ({
      context: { latestUserMessage: "hi" },
      runtimeRequest: { model: "m", messages: [], stream: true, max_tokens: 300 },
    }));
    mocks.finalizeResponseOutput.mockResolvedValue({
      accepted: true,
      repaired: false,
      retryRequested: false,
      qualityScore: 1,
      reasons: [],
      rawReply: "Fine.",
      finalReply: "Sounds fine to me.",
    });
    mocks.runtimeFetch.mockResolvedValue({ ok: true, body: {} });
    streamOf("Sounds fine to me.");
  });

  it("lets only a couple of members answer an unaddressed message, rotating from the last speaker", async () => {
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.sendMessage("so what shall we do tonight");
    });
    await flushQueue();

    expect(spokenOrder()).toEqual(["b", "c"]);
  });

  it("answers only the addressed member", async () => {
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.sendMessage("Char D, what do you think?");
    });
    await flushQueue();

    expect(spokenOrder()).toEqual(["d"]);
  });

  it("asks for a background summary once the replies are done", async () => {
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.sendMessage("Char D, what do you think?");
    });
    await flushQueue();

    expect(maybeUpdateAutoSummary).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1" }),
    );
  });

  it("extracts long-term memories in the background after the summary", async () => {
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.sendMessage("Char D, what do you think?");
    });
    await flushQueue();

    expect(maybeExtractMemories).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-1" }),
    );
  });

  it("uses explicit responder ids, in order, instead of automatic selection", async () => {
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.sendMessage("so what shall we do tonight", {
        responderIds: ["d", "b", "d", "missing"],
      });
    });
    await flushQueue();

    expect(mocks.appendMessage.mock.calls[0]?.[0]).toMatchObject({
      role: "user",
      content: "so what shall we do tonight",
    });
    expect(spokenOrder()).toEqual(["d", "b"]);
  });

  it("requests one extra reply from a character without adding a user message", async () => {
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.requestCharacterReply("c");
    });
    await flushQueue();

    expect(spokenOrder()).toEqual(["c"]);
    const appended = mocks.appendMessage.mock.calls.map(
      (call) => call[0] as { role: string; speakerCharacterId?: string },
    );
    expect(appended.map((payload) => payload.role)).toEqual(["assistant"]);
    expect(appended[0]?.speakerCharacterId).toBe("c");
    const retrieval = mocks.resolveMemorySnippetsBatch.mock.calls[0]?.[0] as Array<{
      query: string;
      speakerCharacterId?: string;
    }>;
    expect(retrieval).toEqual([
      expect.objectContaining({
        query: "what does everyone want for dinner",
        speakerCharacterId: "c",
      }),
    ]);
  });

  it("refuses an extra reply from a character who is not in the chat", async () => {
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.requestCharacterReply("stranger");
    });
    await flushQueue();

    expect(mocks.prepareResponseRequest).not.toHaveBeenCalled();
    expect(mocks.appendMessage).not.toHaveBeenCalled();
    expect(mocks.setNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("does nothing when the chat has no user message to answer", async () => {
    mocks.state.messages = [message("m0", "assistant", "Hello.", "a")];
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.requestCharacterReply("a");
    });
    await flushQueue();

    expect(mocks.prepareResponseRequest).not.toHaveBeenCalled();
    expect(mocks.setNotice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "info" }),
    );
  });
});

describe("truncated replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    mocks.state.chats = [chatSummary({ chatMode: "single", participantIds: ["a"] })];
    mocks.state.participants = ["a"];
    mocks.state.messages = [message("m1", "user", "tell me a story")];
    mocks.listChatParticipants.mockResolvedValue(["a"]);
    mocks.listChats.mockResolvedValue([]);
    mocks.resolveContextEntries.mockResolvedValue([]);
    mocks.resolveMemorySnippetsBatch.mockResolvedValue([[]]);
    mocks.appendMessage.mockImplementation(async (payload: Record<string, unknown>) => ({
      id: "saved",
      createdAt: "",
      ...payload,
    }));
    mocks.prepareResponseRequest.mockImplementation(() => ({
      context: { latestUserMessage: "tell me a story" },
      runtimeRequest: { model: "m", messages: [], stream: true, max_tokens: 300 },
    }));
    mocks.finalizeResponseOutput.mockResolvedValue({
      accepted: true,
      repaired: false,
      retryRequested: false,
      qualityScore: 1,
      reasons: [],
      rawReply: "",
      finalReply: "Once upon a time.",
    });
    mocks.runtimeFetch.mockResolvedValue({ ok: true, body: {} });
  });

  it("marks the reply truncated when the stream finished at the token limit", async () => {
    streamOf("Once upon a time there was a", "length");
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.requestCharacterReply("a");
    });
    await flushQueue();

    expect(mocks.finalizeResponseOutput).toHaveBeenCalledOnce();
    expect(mocks.finalizeResponseOutput.mock.calls[0]?.[0]).toMatchObject({
      rawOutput: "Once upon a time there was a",
      truncated: true,
    });
  });

  it("does not mark a naturally finished reply truncated", async () => {
    streamOf("Once upon a time.", "stop");
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.requestCharacterReply("a");
    });
    await flushQueue();

    expect(mocks.finalizeResponseOutput.mock.calls[0]?.[0]).toMatchObject({
      truncated: false,
    });
  });

  it("reads the finish reason from the non-streaming fallback too", async () => {
    mocks.parseLlamaSseStream.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("stream broke");
        },
      }),
    }));
    mocks.runtimeFetch
      .mockResolvedValueOnce({ ok: true, body: {} })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [
              { message: { content: "Once upon a time there was a" }, finish_reason: "length" },
            ],
          }),
      });
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.requestCharacterReply("a");
    });
    await flushQueue();

    expect(mocks.finalizeResponseOutput.mock.calls[0]?.[0]).toMatchObject({
      rawOutput: "Once upon a time there was a",
      truncated: true,
    });
  });

  it("passes the truncation state of a repair through to finalization", async () => {
    streamOf("Put your hands up. Do not move.", "stop");
    mocks.finalizeResponseOutput.mockImplementation(
      async (input: { repair?: (instruction: string) => Promise<unknown> }) => {
        const repaired = await input.repair?.("Rewrite it.");
        mocks.state.messages = [message("repair-seen", "user", JSON.stringify(repaired))];
        return {
          accepted: true,
          repaired: true,
          retryRequested: true,
          qualityScore: 1,
          reasons: [],
          rawReply: "",
          finalReply: "Easy now.",
        };
      },
    );
    mocks.runtimeFetch
      .mockResolvedValueOnce({ ok: true, body: {} })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: "Easy now, and" }, finish_reason: "length" }],
          }),
      });
    const { result } = renderOrchestration();

    await act(async () => {
      await result.current.requestCharacterReply("a");
    });
    await flushQueue();

    const repairBody = JSON.parse(
      String((mocks.runtimeFetch.mock.calls[1]?.[1] as RequestInit).body),
    ) as { max_tokens: number; stream: boolean };
    expect(repairBody.stream).toBe(false);
    expect(repairBody.max_tokens).toBe(300);
    expect(JSON.parse(mocks.state.messages[0] ? (mocks.state.messages[0] as ChatMessage).content : "null")).toEqual({
      content: "Easy now, and",
      truncated: true,
    });
  });
});
