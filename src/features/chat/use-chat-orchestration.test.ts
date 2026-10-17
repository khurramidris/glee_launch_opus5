import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../../api/tauri", () => ({
  appendMessage: vi.fn(),
  branchChat: vi.fn(),
  createChat: vi.fn(),
  createGroupChat: vi.fn(),
  listChatParticipants: vi.fn(),
  listChats: vi.fn(),
  resolveContextEntries: vi.fn(),
  resolveMemorySnippets: vi.fn(),
  upsertChatRelationshipState: vi.fn(),
  updateGroupChat: vi.fn(),
  updateMessage: vi.fn(),
  editMessageAndTruncate: vi.fn(),
}));

vi.mock("../../lib/chat-domain", () => ({
  chatParticipantIds: vi.fn(),
  dedupeIds: vi.fn((ids: string[]) => ids),
  isGroupChatMode: vi.fn(() => false),
}));

vi.mock("../../lib/sse", () => ({
  parseLlamaSseStream: vi.fn(async function* parse() {}),
}));

vi.mock("./response-system", () => ({
  buildResponseRetrievalHints: vi.fn(),
  buildStreamingPreview: vi.fn(),
  finalizeResponseOutput: vi.fn(),
  prepareResponseRequest: vi.fn(),
}));

vi.mock("./response-system/evaluation/evaluate-reply", () => ({
  evaluateCharacterReply: vi.fn(() => ({
    retryRequested: false,
    suppressPreview: false,
    fatal: false,
    qualityScore: 1,
    reasons: [],
  })),
}));

vi.mock("./group-turn-history", () => ({
  historyForQueuedSpeakerTurn: vi.fn(),
}));

vi.mock("./response-system/runtime-field-gating", () => ({
  shouldInjectGreetingAsFirstMessage: vi.fn(() => false),
}));

vi.mock("./response-sanitizer", () => ({
  sanitizeAssistantReply: vi.fn((value?: string) => value ?? ""),
}));

vi.mock("./response-system/compile/prompt-budget", () => ({
  clipText: vi.fn((value: string, maxLength: number) => value.slice(0, maxLength)),
}));

vi.mock("../../stores", () => ({
  useAppStore: vi.fn(() => ({})),
  useCharacterStore: vi.fn(() => ({})),
  useChatStore: vi.fn(() => ({})),
  useContextStore: vi.fn(() => ({})),
  useModelStore: vi.fn(() => ({})),
  useProfileStore: vi.fn(() => ({})),
  usePresetStore: vi.fn(() => ({})),
  characterStore: { getState: vi.fn(() => ({})) },
  chatStore: { getState: vi.fn(() => ({})) },
  modelStore: { getState: vi.fn(() => ({})) },
  profileStore: { getState: vi.fn(() => ({})) },
  presetStore: { getState: vi.fn(() => ({})) },
}));

vi.mock("../app/app-domain", () => ({
  GENERATION_CANCELLED_MESSAGE: "cancelled",
  buildExportSlug: vi.fn(),
  exportChatTranscript: vi.fn(),
  emptyMemory: vi.fn(),
  isGenerationCancelledError: vi.fn(() => false),
  normalizeError: vi.fn((error: unknown) => String(error)),
  resolveChatCompletionsUrl: vi.fn(),
  sortChatsByRecent: vi.fn(),
  textOr: vi.fn(),
}));

import { __test__ } from "./use-chat-orchestration";
import {
  createResponseDiagnostics,
  getResponseDiagnosticsStore,
  resetResponseDiagnosticsStoreForTest,
} from "./response-system/diagnostics";

function makePreparedResponse(input?: {
  latestUserMessage?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens?: number;
  currentScene?: string;
  currentSpeakerRole?: string | null;
}) {
  return {
    context: {
      latestUserMessage: input?.latestUserMessage ?? "What do you want, Pooja?",
      relationshipState: input?.currentScene
        ? { currentScene: input.currentScene }
        : undefined,
      groupRoundState: input?.currentSpeakerRole
        ? { currentSpeakerRole: input.currentSpeakerRole }
        : undefined,
    },
    sceneState: input?.currentScene
      ? { currentScene: input.currentScene }
      : undefined,
    runtimeRequest: {
      model: "test-model",
      messages: input?.messages ?? [
        { role: "system", content: "Core contract: Stay in character." },
        { role: "user", content: "What do you want, Pooja?" },
      ],
      stream: true,
      temperature: 0.8,
      top_p: 0.92,
      max_tokens: input?.maxTokens ?? 384,
      repeat_penalty: 1.05,
      stop: ["\nUser:"],
    },
  } as any;
}

describe("history epoch queue guards", () => {
  it("removes only queued work for the mutated chat", () => {
    const tasks = [
      { chatId: "chat-a", text: "one", historyEpoch: 0 },
      { chatId: "chat-b", text: "two", historyEpoch: 3 },
      { chatId: "chat-a", text: "three", historyEpoch: 0 },
    ];
    expect(__test__.removeQueuedReplyTasksForChat(tasks, "chat-a")).toEqual([
      { chatId: "chat-b", text: "two", historyEpoch: 3 },
    ]);
  });

  it("classifies stale backend writes as cancellation conflicts", () => {
    expect(
      __test__.isHistoryEpochConflictError(
        new Error("conflict: stale history epoch for chat c: expected 0, current 1"),
      ),
    ).toBe(true);
    expect(__test__.isHistoryEpochConflictError(new Error("runtime failed"))).toBe(false);
  });
});

describe("use-chat-orchestration repair requests", () => {
  afterEach(() => {
    resetResponseDiagnosticsStoreForTest();
  });

  it("keeps repair on the canonical runtime request and appends the failed draft only when turn order allows it", () => {
    const preparedResponse = makePreparedResponse();
    const request = __test__.buildCanonicalRepairRequestBody({
      preparedResponse,
      repairInstruction: "Rewrite the reply as Pooja and answer directly.",
      invalidDraft: "I can answer that.",
    });

    expect(request.stream).toBe(false);
    expect(request.max_tokens).toBe(384);
    expect(request.messages.slice(0, 2)).toEqual(preparedResponse.runtimeRequest.messages);
    expect(request.messages[2]).toEqual({
      role: "assistant",
      content: "I can answer that.",
    });
    expect(request.messages[3]).toMatchObject({
      role: "user",
    });
    expect(request.messages[3]?.content).toContain(
      "Repair requirements: Rewrite the reply as Pooja and answer directly.",
    );
    expect(request.messages[3]?.content).toContain(
      "Latest user move still in force: What do you want, Pooja?",
    );
  });

  it("gives the repair request the same token budget as the original request", () => {
    const request = __test__.buildCanonicalRepairRequestBody({
      preparedResponse: makePreparedResponse({ maxTokens: 700 }),
      repairInstruction: "Rewrite the reply as Pooja and answer directly.",
      invalidDraft: "I can answer that.",
    });

    expect(request.max_tokens).toBe(700);
  });

  it("keeps prompt-echo drafts out of the repair history and asks for a fresh reply", () => {
    const preparedResponse = makePreparedResponse({
      messages: [
        { role: "system", content: "Core contract: Stay in character." },
        { role: "user", content: "Everyone, look at Pooja." },
        { role: "assistant", content: "I'm listening." },
      ],
    });
    const request = __test__.buildCanonicalRepairRequestBody({
      preparedResponse,
      repairInstruction: "Rewrite the reply as Pooja and react in character.",
      invalidDraft: "System is asking: write only the character's next reply",
    });

    expect(request.messages).toHaveLength(4);
    expect(request.messages.slice(0, 3)).toEqual(preparedResponse.runtimeRequest.messages);
    expect(request.messages[3]).toMatchObject({
      role: "user",
    });
    expect(request.messages[3]?.content).toContain(
      "The previous draft echoed prompt text or metadata. Ignore that malformed draft and answer fresh.",
    );
    expect(request.messages[3]?.content).not.toContain("System is asking");
  });

  it("keeps internal group scaffold drafts out of repair history", () => {
    const preparedResponse = makePreparedResponse();
    const request = __test__.buildCanonicalRepairRequestBody({
      preparedResponse,
      repairInstruction: "Rewrite the reply as Yulian and react to the room.",
      invalidDraft:
        'Previous group reply from Lara: "I am listening."',
    });

    expect(request.messages).toHaveLength(3);
    expect(request.messages.slice(0, 2)).toEqual(preparedResponse.runtimeRequest.messages);
    expect(JSON.stringify(request.messages)).not.toContain("Previous group reply");
    expect(request.messages[2]).toMatchObject({
      role: "user",
    });
    expect(request.messages[2]?.content).toContain(
      "The previous draft broke role, scene, or user-agency boundaries. Do not reuse it.",
    );
  });

  it("does not replay user-scripting drafts into repair history", () => {
    const preparedResponse = makePreparedResponse({
      currentScene: "We are sitting in a cafe.",
    });
    const request = __test__.buildCanonicalRepairRequestBody({
      preparedResponse,
      repairInstruction: "Rewrite the reply in character and stay grounded in the cafe scene.",
      invalidDraft:
        "You turn your head slightly, catching a glimpse of John's outstretched hand. Your eyes widen with surprise.",
    });

    expect(request.messages).toHaveLength(3);
    expect(request.messages[2]).toMatchObject({
      role: "user",
    });
    expect(request.messages[2]?.content).toContain(
      "The previous draft broke role, scene, or user-agency boundaries. Do not reuse it. Answer fresh from the original context.",
    );
    expect(request.messages[2]?.content).not.toContain("You turn your head slightly");
  });

  it("does not replay scene-replacement drafts into repair history", () => {
    const preparedResponse = makePreparedResponse({
      currentScene: "We are sitting in a cafe.",
    });
    const request = __test__.buildCanonicalRepairRequestBody({
      preparedResponse,
      repairInstruction: "Rewrite the reply in character and stay in the live scene.",
      invalidDraft:
        "Oh, John... You've been here the whole time? What are you doing in my room?",
    });

    expect(request.messages).toHaveLength(3);
    expect(request.messages[2]?.content).toContain(
      "The previous draft broke role, scene, or user-agency boundaries. Do not reuse it. Answer fresh from the original context.",
    );
    expect(request.messages[2]?.content).not.toContain("What are you doing in my room");
  });

  it("does not replay observer role-inversion drafts into repair history", () => {
    const preparedResponse = makePreparedResponse({
      latestUserMessage: "Can you please change the music Lara?",
      currentSpeakerRole: "observer_to_other_address",
    });
    const request = __test__.buildCanonicalRepairRequestBody({
      preparedResponse,
      repairInstruction: "Reply as an observer and do not take over Lara's task.",
      invalidDraft:
        "Sure thing boss man! What kind of music do you want this time? Consider this request granted.",
    });

    expect(request.messages).toHaveLength(3);
    expect(request.messages[2]?.content).toContain(
      "The previous draft broke role, scene, or user-agency boundaries. Do not reuse it. Answer fresh from the original context.",
    );
    expect(request.messages[2]?.content).not.toContain("Sure thing boss man");
  });

  it("prioritizes directly addressed participants ahead of roster order in group turns", () => {
    const turnOrder = __test__.prioritizeTurnOrderByAddress({
      responderIds: ["char-yulian", "char-lara"],
      participantDirectory: {
        "char-yulian": "Yulian",
        "char-lara": "Lara Lightland",
      },
      latestUserMessage:
        "Can you please change the music Lara, I say loudly to Lara who is driving",
    });

    expect(turnOrder).toEqual(["char-lara", "char-yulian"]);
  });

  it("prioritizes addressees in mid-clause vocatives ahead of roster order", () => {
    const turnOrder = __test__.prioritizeTurnOrderByAddress({
      responderIds: ["char-yulian", "char-pooja"],
      participantDirectory: {
        "char-yulian": "Yulian",
        "char-pooja": "Pooja",
      },
      latestUserMessage:
        "I am going to get some popcorns, do you want anything Pooja darlin? I say as I get up from my seat",
    });

    expect(turnOrder).toEqual(["char-pooja", "char-yulian"]);
  });

  it("prioritizes addressees before trailing roleplay asides", () => {
    const turnOrder = __test__.prioritizeTurnOrderByAddress({
      responderIds: ["char-yulian", "char-pooja", "char-lara"],
      participantDirectory: {
        "char-yulian": "Yulian",
        "char-pooja": "Pooja",
        "char-lara": "Lara",
      },
      latestUserMessage: "I wanna eat you Pooja *I say naughtily*",
    });

    expect(turnOrder).toEqual(["char-pooja", "char-yulian", "char-lara"]);
  });

  it("selects only a directly addressed group participant to respond", () => {
    const selected = __test__.selectGroupResponderIds({
      responderIds: ["char-yulian", "char-pooja", "char-lara"],
      participantDirectory: {
        "char-yulian": "Yulian",
        "char-pooja": "Pooja",
        "char-lara": "Lara",
      },
      latestUserMessage: "Pooja, can you answer this one?",
    });

    expect(selected).toEqual(["char-pooja"]);
  });

  it("selects at most two group participants when no one is directly addressed", () => {
    const selected = __test__.selectGroupResponderIds({
      responderIds: ["char-yulian", "char-pooja", "char-lara"],
      participantDirectory: {
        "char-yulian": "Yulian",
        "char-pooja": "Pooja",
        "char-lara": "Lara",
      },
      latestUserMessage: "What does everyone think?",
    });

    expect(selected).toEqual(["char-yulian", "char-pooja"]);
  });

  it("rotates unaddressed group turns onward from the last speaker", () => {
    const selected = __test__.selectGroupResponderIds({
      responderIds: ["char-yulian", "char-pooja", "char-lara"],
      participantDirectory: {
        "char-yulian": "Yulian",
        "char-pooja": "Pooja",
        "char-lara": "Lara",
      },
      latestUserMessage: "What does everyone think?",
      lastSpeakerId: "char-pooja",
    });

    expect(selected).toEqual(["char-lara", "char-yulian"]);
  });

  it("finds the last speaking character in a history", () => {
    const history = [
      { id: "1", chatId: "c", role: "user", content: "hi", createdAt: "" },
      { id: "2", chatId: "c", role: "assistant", content: "yo", speakerCharacterId: "a", createdAt: "" },
      { id: "3", chatId: "c", role: "assistant", content: "hey", speakerCharacterId: "b", createdAt: "" },
      { id: "4", chatId: "c", role: "user", content: "so?", createdAt: "" },
    ] as any;

    expect(__test__.lastAssistantSpeakerId(history)).toBe("b");
    expect(__test__.lastAssistantSpeakerId(history.slice(0, 1))).toBeUndefined();
  });

  it("keeps explicit responders in the caller's order and drops strangers and duplicates", () => {
    expect(
      __test__.resolveExplicitResponderIds(["c", "a", "c", "z"], ["a", "b", "c"]),
    ).toEqual(["c", "a"]);
    expect(__test__.resolveExplicitResponderIds(["z"], ["a", "b"])).toEqual([]);
    expect(__test__.resolveExplicitResponderIds([], ["a", "b"])).toBeNull();
    expect(__test__.resolveExplicitResponderIds(undefined, ["a", "b"])).toBeNull();
  });

  it("selects multiple explicitly addressed participants in roster order", () => {
    const selected = __test__.selectGroupResponderIds({
      responderIds: ["char-yulian", "char-pooja", "char-lara"],
      participantDirectory: {
        "char-yulian": "Yulian",
        "char-pooja": "Pooja",
        "char-lara": "Lara",
      },
      latestUserMessage: "Pooja, Lara, can you both stay behind?",
    });

    expect(selected).toEqual(["char-pooja", "char-lara"]);
  });

  it("appends a normal assistant reply through the lifecycle append boundary", async () => {
    const appendMessage = vi.fn(async (payload) => ({
      id: "assistant-1",
      createdAt: "2000-05-01T00:00:00.000Z",
      ...payload,
    }));

    const message = await __test__.appendAssistantReplyWithFallback({
      context: {
        chatId: "chat-1",
        speaker: { id: "pooja", name: "Pooja" },
      } as any,
      generateReplyText: vi.fn().mockResolvedValue("I am here."),
      appendMessageFn: appendMessage,
    });

    expect(appendMessage).toHaveBeenCalledWith({
      chatId: "chat-1",
      role: "assistant",
      content: "I am here.",
      speakerCharacterId: "pooja",
    });
    expect(message.content).toBe("I am here.");
  });

  it("records append success before flushing generation diagnostics", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const diagnostics = createResponseDiagnostics({
      chatId: "chat-1",
      speakerCharacterId: "pooja",
      speakerName: "Pooja",
      mode: "group",
      groupTurn: {
        turnIndex: 2,
        turnCount: 3,
        speakerIdOrder: ["yulian", "pooja", "lara"],
        speakerNameOrder: ["Yulian", "Pooja", "Lara"],
      },
    });
    const appendMessage = vi.fn(async (payload) => ({
      id: "assistant-1",
      createdAt: "2000-05-01T00:00:00.000Z",
      ...payload,
    }));

    await __test__.appendAssistantReplyWithFallback({
      context: {
        chatId: "chat-1",
        speaker: { id: "pooja", name: "Pooja" },
      } as any,
      generateReplyText: vi.fn().mockResolvedValue({
        content: "I am here.",
        diagnostics,
      }),
      appendMessageFn: appendMessage,
    });

    const latest = getResponseDiagnosticsStore().latest;
    expect(latest?.groupTurn).toMatchObject({
      turnIndex: 2,
      turnCount: 3,
      speakerNameOrder: ["Yulian", "Pooja", "Lara"],
    });
    expect(latest?.lifecycle.append).toMatchObject({
      attempted: true,
      succeeded: true,
      messageId: "assistant-1",
      savedSpeakerCharacterId: "pooja",
    });
    expect(latest?.lifecycle.latestStage).toBe("persisted");
    expect(latest?.lifecycle.events.map((event) => event.stage)).toEqual([
      "append_started",
      "persisted",
    ]);
  });

  it("records append failure instead of making a missing speaker invisible", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const diagnostics = createResponseDiagnostics({
      chatId: "chat-1",
      speakerCharacterId: "yulian",
      speakerName: "Yulian",
      mode: "group",
      groupTurn: {
        turnIndex: 1,
        turnCount: 3,
        speakerIdOrder: ["yulian", "pooja", "lara"],
        speakerNameOrder: ["Yulian", "Pooja", "Lara"],
      },
    });
    const appendMessage = vi.fn(async () => {
      throw new Error("speaker is not a member of this chat");
    });

    const generateReplyText = vi.fn().mockResolvedValue({
      content: "I am reacting to that.",
      diagnostics,
    });

    await expect(
      __test__.appendAssistantReplyWithFallback({
        context: {
          chatId: "chat-1",
          speaker: { id: "yulian", name: "Yulian" },
        } as any,
        generateReplyText,
        appendMessageFn: appendMessage,
      }),
    ).rejects.toThrow("speaker is not a member of this chat");

    expect(generateReplyText).toHaveBeenCalledTimes(1);
    const latest = getResponseDiagnosticsStore().latest;
    expect(latest?.speakerName).toBe("Yulian");
    expect(latest?.lifecycle.append).toMatchObject({
      attempted: true,
      succeeded: false,
      error: "speaker is not a member of this chat",
    });
    expect(latest?.lifecycle.latestStage).toBe("failed");
    expect(latest?.lifecycle.events.map((event) => event.stage)).toEqual([
      "append_started",
      "failed",
    ]);
  });

  it("retries a failed direct generation once and appends the recovered reply", async () => {
    const appendMessage = vi.fn(async (payload) => ({
      id: "assistant-1",
      createdAt: "2000-05-01T00:00:00.000Z",
      ...payload,
    }));
    const generateReplyText = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime failed"))
      .mockResolvedValueOnce("I am here now.");

    const message = await __test__.appendAssistantReplyWithFallback({
      context: {
        chatId: "chat-1",
        mode: "single",
        speaker: { id: "pooja", name: "Pooja" },
      } as any,
      generateReplyText,
      appendMessageFn: appendMessage,
    });

    expect(generateReplyText).toHaveBeenCalledTimes(2);
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(message.content).toBe("I am here now.");
  });

  it("persists a recoverable failure message after both direct attempts fail", async () => {
    const appendMessage = vi.fn(async (payload) => ({
      id: "assistant-1",
      createdAt: "2000-05-01T00:00:00.000Z",
      ...payload,
    }));
    const generateReplyText = vi
      .fn()
      .mockRejectedValue(new Error("runtime failed"));

    const message = await __test__.appendAssistantReplyWithFallback({
      context: {
        chatId: "chat-1",
        mode: "single",
        speaker: { id: "pooja", name: "Pooja" },
      } as any,
      generateReplyText,
      appendMessageFn: appendMessage,
    });

    expect(generateReplyText).toHaveBeenCalledTimes(2);
    expect(appendMessage).toHaveBeenCalledWith({
      chatId: "chat-1",
      role: "assistant",
      content:
        "[Glee reply failed] Pooja could not complete this reply after an automatic retry. Select Regenerate to try again.",
      speakerCharacterId: "pooja",
    });
    expect(message.content).toContain("Select Regenerate to try again");
  });

  it("retries group generation and persists an explicit recovery event on failure", async () => {
    const appendMessage = vi.fn(async (payload) => ({
      id: "assistant-1",
      createdAt: "2000-05-01T00:00:00.000Z",
      ...payload,
    }));

    const message = await __test__.appendAssistantReplyWithFallback({
      context: {
        chatId: "chat-1",
        mode: "group",
        groupTurnIndex: 2,
        history: [
          {
            role: "user",
            content: "what shall we do after pizza?",
          },
        ],
        speaker: { id: "priyanka", name: "Priyanka" },
      } as any,
      generateReplyText: vi.fn().mockRejectedValue(new Error("runtime failed")),
      appendMessageFn: appendMessage,
    });

    expect(appendMessage).toHaveBeenCalledWith({
      chatId: "chat-1",
      role: "assistant",
      content:
        "[Glee reply failed] Priyanka could not complete this reply after an automatic retry. Select Regenerate to try again.",
      speakerCharacterId: "priyanka",
    });
    expect(message.content).toContain("[Glee reply failed]");
  });

  it("retries empty direct replies before persisting a recoverable failure message", async () => {
    const appendMessage = vi.fn(async (payload) => ({
      id: "assistant-1",
      createdAt: "2000-05-01T00:00:00.000Z",
      ...payload,
    }));
    const generateReplyText = vi.fn().mockResolvedValue("   ");

    const message = await __test__.appendAssistantReplyWithFallback({
      context: {
        chatId: "chat-1",
        mode: "single",
        speaker: { id: "pooja", name: "Pooja" },
      } as any,
      generateReplyText,
      appendMessageFn: appendMessage,
    });

    expect(generateReplyText).toHaveBeenCalledTimes(2);
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(message.content).toContain("Select Regenerate to try again");
  });

  it("retries an empty group reply and persists an explicit recovery event", async () => {
    const appendMessage = vi.fn(async (payload) => ({
      id: "assistant-1",
      createdAt: "2000-05-01T00:00:00.000Z",
      ...payload,
    }));

    const message = await __test__.appendAssistantReplyWithFallback({
      context: {
        chatId: "chat-1",
        mode: "group",
        groupTurnIndex: 4,
        history: [
          {
            role: "user",
            content: "Umm i wanna eat Pizza",
          },
        ],
        speaker: { id: "lara", name: "Lara Lightland" },
      } as any,
      generateReplyText: vi.fn().mockResolvedValue("   "),
      appendMessageFn: appendMessage,
    });

    expect(appendMessage).toHaveBeenCalledWith({
      chatId: "chat-1",
      role: "assistant",
      content:
        "[Glee reply failed] Lara Lightland could not complete this reply after an automatic retry. Select Regenerate to try again.",
      speakerCharacterId: "lara",
    });
    expect(message.speakerCharacterId).toBe("lara");
    expect(message.content).toContain("[Glee reply failed]");
  });
});
