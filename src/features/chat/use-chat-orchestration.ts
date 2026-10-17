import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  appendMessage,
  branchChat,
  createChat,
  createGroupChat,
  listChatParticipants,
  listChats,
  resolveContextEntries,
  resolveMemorySnippets,
  resolveMemorySnippetsBatch,
  upsertChatRelationshipState,
  updateGroupChat,
  updateMessage,
  editMessageAndTruncate,
} from "../../api/tauri";
import {
  chatParticipantIds,
  dedupeIds,
  isGroupChatMode,
} from "../../lib/chat-domain";
import { parseLlamaSseStream } from "../../lib/sse";
import { runtimeFetch } from "../../lib/runtime-fetch";
import {
  buildResponseRetrievalHints,
  buildStreamingPreview,
  finalizeResponseOutput,
  prepareResponseRequest,
} from "./response-system";
import {
  prioritizeTurnOrderByAddress,
  selectGroupResponderIds,
} from "./response-system/group-addressing";
import { historyForQueuedSpeakerTurn } from "./group-turn-history";
import { shouldInjectGreetingAsFirstMessage } from "./response-system/runtime-field-gating";
import { renderCardTemplate } from "./card-template";
import { sanitizeAssistantReply } from "./response-sanitizer";
import { clipText } from "./response-system/compile/prompt-budget";
import { retainVisibleStreamingPreview } from "./streaming-presentation";
import {
  useAppStore,
  useCharacterStore,
  useChatStore,
  useContextStore,
  useModelStore,
  useProfileStore,
  usePresetStore,
  characterStore,
  chatStore,
  modelStore,
  profileStore,
  presetStore,
} from "../../stores";
import type {
  AppendMessagePayload,
  Character,
  ChatMemory,
  ChatMessage,
  ChatRelationshipState,
  ContextEntry,
  LlamaChatCompletionResponse,
  LlamaChatRequest,
  LlamaTokenUsage,
  MemorySnippet,
  UserProfile,
} from "../../types";
import {
  buildGenerationFailureMessage,
  filterGenerationFailureMessages,
} from "./generation-failure";
import {
  buildResponseDiagnosticsInspection,
  createResponseDiagnostics,
  formatResponseDiagnosticError,
} from "./response-system/diagnostics";
import type { ResponseDiagnosticsRecorder } from "./response-system/diagnostics";
import {
  GENERATION_CANCELLED_MESSAGE,
  buildExportSlug,
  downloadTextFile,
  emptyMemory,
  isGenerationCancelledError,
  normalizeError,
  resolveChatCompletionsUrl,
  sortChatsByRecent,
  textOr,
} from "../app/app-domain";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateChatMessagesTokens,
} from "./runtime-adapters/token-budget";

const FALLBACK_RUNTIME_ENDPOINT = "http://127.0.0.1:8080";
const REPAIR_REQUEST_TIMEOUT_MS = 180000;
const STREAM_CONNECT_TIMEOUT_MS = 30_000;
const STREAM_FIRST_TOKEN_TIMEOUT_MS = 45_000;
const STREAM_INACTIVITY_TIMEOUT_MS = 30_000;
const STREAM_TOTAL_TIMEOUT_MS = 240_000;
const STREAM_PREVIEW_INTERVAL_MS = 50;
const REPAIR_MAX_TOKENS = 256;
const REPLY_GENERATION_ATTEMPTS = 2;

type ReplyTask = {
  chatId: string;
  text: string;
  historyEpoch: number;
};

type ReplyExecutionContext = {
  chatId: string;
  expectedHistoryEpoch?: number;
  speaker: Character | undefined;
  mode: "single" | "group";
  isRegeneration?: boolean;
  previousAssistantReply?: string;
  streamTargetMessageId?: string;
  participantNames: string[];
  participantDirectory?: Record<string, string>;
  history: ChatMessage[];
  memory: ChatMemory | undefined;
  contextHits: ContextEntry[];
  memoryHits: MemorySnippet[];
  relationshipState: ChatRelationshipState | undefined;
  userProfile: UserProfile | undefined;
  runtimeEndpoint: string;
  activeModelName: string;
  samplingTemperature: number | undefined;
  samplingTopP: number | undefined;
  samplingMaxTokens: number | undefined;
  samplingRepeatPenalty: number | undefined;
  groupTurnIndex?: number;
  groupTurnCount?: number;
  groupTurnSpeakerIds?: string[];
  groupTurnSpeakerNames?: string[];
};

type ReplyGenerationResult =
  | string
  | {
      content: string;
      diagnostics?: ResponseDiagnosticsRecorder;
    };

function normalizeReplyGenerationResult(result: ReplyGenerationResult): {
  content: string;
  diagnostics?: ResponseDiagnosticsRecorder;
} {
  if (typeof result === "string") {
    return { content: result };
  }
  return result;
}

function compactRuntimeText(value?: string, maxLength = 180): string {
  return clipText(
    (value ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/[*_`]/g, "")
      .replace(/^\s*[-•]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim(),
    maxLength,
  );
}

function normalizeRetrievedReplyText(value?: string): string {
  return (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function filterRegenerationMemoryHits(
  hits: MemorySnippet[],
  targetMessage: ChatMessage,
): MemorySnippet[] {
  const targetText = normalizeRetrievedReplyText(targetMessage.content);
  if (!targetText) {
    return hits.filter((hit) => hit.messageId !== targetMessage.id);
  }

  return hits.filter((hit) => {
    if (hit.messageId === targetMessage.id) {
      return false;
    }
    if (hit.role !== "assistant") {
      return true;
    }
    if (
      targetMessage.speakerCharacterId &&
      hit.speakerCharacterId &&
      hit.speakerCharacterId !== targetMessage.speakerCharacterId
    ) {
      return true;
    }
    return normalizeRetrievedReplyText(hit.content) !== targetText;
  });
}

function normalizeCompactPromptText(value?: string): string {
  return (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[*_`"'“”]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function looksLikePromptEcho(value?: string): boolean {
  const normalized = normalizeCompactPromptText(value);
  if (!normalized) {
    return false;
  }

  return (
    normalized.startsWith("system is asking") ||
    normalized.startsWith("core contract") ||
    normalized.includes("roleplay conversation with the user below this line") ||
    normalized.includes("write only the character's next reply") ||
    normalized.includes("write only the character s next reply") ||
    normalized.includes("write one short in-character reply in plain text") ||
    normalized.includes("write one short in character reply in plain text") ||
    normalized.includes("prompt metadata") ||
      normalized.includes("transcript scaffolding")
  );
}

function tokenizeBoundaryText(value?: string): string[] {
  return (value ?? "")
    .toLowerCase()
    .match(/[a-z]+/g) ?? [];
}

function containsUserScripting(value?: string): boolean {
  const normalized = normalizeCompactPromptText(value);
  if (!normalized) {
    return false;
  }

  return (
    /\byou\s+(turn|turned|look|looked|glance|glanced|glances|widen|widened|walk|walked|stand|stood|sit|sat|raise|raised|reach|reached|take|takes|took|smile|smiled|lean|leaned|feel|felt|notice|noticed|watch|watched|catch|caught|see|saw|hear|heard|ask|asked|say|said|stare|stared|gesture|gestured|nod|nodded|pause|paused)\b/.test(
      normalized,
    ) ||
    /\byour\s+(eyes|hand|hands|body|chest|hips|mouth|lips|face|fingers|hair|heart|breath)\b/.test(
      normalized,
    )
  );
}

function containsSceneReplacementDraft(
  preparedResponse: ReturnType<typeof prepareResponseRequest>,
  invalidDraft: string,
): boolean {
  const sceneText =
    preparedResponse.sceneState?.currentScene ??
    preparedResponse.context.relationshipState?.currentScene ??
    "";
  const sceneTokens = new Set(tokenizeBoundaryText(sceneText));
  const draftTokens = new Set(tokenizeBoundaryText(invalidDraft));

  if (sceneTokens.size === 0 || draftTokens.size === 0) {
    return false;
  }

  const venueTerms = [
    "cafe",
    "coffee",
    "restaurant",
    "pizzeria",
    "diner",
    "bar",
    "mall",
    "market",
    "supermarket",
    "shop",
    "showroom",
    "stadium",
    "airport",
    "station",
    "theater",
    "cinema",
    "beach",
    "park",
    "car",
    "room",
    "bedroom",
    "house",
    "tavern",
    "palace",
    "castle",
    "forest",
    "battlefield",
    "classroom",
    "office",
  ];

  const sceneVenueTerms = venueTerms.filter((term) => sceneTokens.has(term));
  if (sceneVenueTerms.length === 0) {
    return false;
  }

  return venueTerms.some(
    (term) =>
      draftTokens.has(term) &&
      !sceneTokens.has(term) &&
      !sceneVenueTerms.includes(term),
  );
}

function containsRoleInversionDraft(
  preparedResponse: ReturnType<typeof prepareResponseRequest>,
  invalidDraft: string,
): boolean {
  const normalized = normalizeCompactPromptText(invalidDraft);
  if (!normalized) {
    return false;
  }

  const currentSpeakerRole =
    preparedResponse.context.groupRoundState?.currentSpeakerRole ?? null;
  if (currentSpeakerRole !== "observer_to_other_address") {
    return false;
  }

  return (
    /\b(sure thing|leave it to me|i ll handle it|i can handle that|consider it done|coming right up|i can assist|i ll take care of it)\b/.test(
      normalized,
    ) ||
    /\bwhat kind of .* do you want\b/.test(normalized)
  );
}

function looksLikeInternalScaffoldDraft(invalidDraft: string): boolean {
  const firstLine = invalidDraft.trim().split("\n", 1)[0] ?? "";
  return /^\s*(?:previous|prior|earlier|last)\s+(?:group\s+)?(?:assistant\s+)?reply\s+from\s+[^:\n]{1,80}\s*:/i.test(
    firstLine,
  );
}

function containsBoundaryFailureDraft(
  preparedResponse: ReturnType<typeof prepareResponseRequest>,
  invalidDraft: string,
): boolean {
  return (
    looksLikePromptEcho(invalidDraft) ||
    looksLikeInternalScaffoldDraft(invalidDraft) ||
    containsUserScripting(invalidDraft) ||
    containsSceneReplacementDraft(preparedResponse, invalidDraft) ||
    containsRoleInversionDraft(preparedResponse, invalidDraft)
  );
}

function buildCanonicalRepairRequestBody(input: {
  preparedResponse: ReturnType<typeof prepareResponseRequest>;
  repairInstruction: string;
  invalidDraft: string;
}): LlamaChatRequest {
  const baseRequest = input.preparedResponse.runtimeRequest;
  // Keep repair on the canonical compiled request and append only the
  // validation-driven repair turn instead of rebuilding a parallel prompt.
  const repairMessages = [...baseRequest.messages];
  const invalidDraft = compactRuntimeText(input.invalidDraft, 260);
  const invalidDraftIsPromptEcho =
    invalidDraft.length > 0 && looksLikePromptEcho(input.invalidDraft);
  const invalidDraftHasBoundaryFailure =
    invalidDraft.length > 0 &&
    containsBoundaryFailureDraft(input.preparedResponse, input.invalidDraft);
  const appendInvalidDraftAsAssistantTurn =
    Boolean(invalidDraft) &&
    !invalidDraftHasBoundaryFailure &&
    repairMessages[repairMessages.length - 1]?.role === "user";

  if (appendInvalidDraftAsAssistantTurn) {
    repairMessages.push({
      role: "assistant",
      content: invalidDraft,
    });
  }

  const repairLines = [
    "The previous assistant draft failed validation. Rewrite the character's reply so it follows the original instructions and stays in character.",
    `Repair requirements: ${compactRuntimeText(input.repairInstruction, 900) || "Return a valid in-character reply."}`,
    input.preparedResponse.context.latestUserMessage?.trim()
      ? `Latest user move still in force: ${compactRuntimeText(input.preparedResponse.context.latestUserMessage, 180)}`
      : "",
    invalidDraft && !invalidDraftHasBoundaryFailure && !appendInvalidDraftAsAssistantTurn
      ? `Draft that failed validation: ${invalidDraft}`
      : "",
    invalidDraftIsPromptEcho
      ? "The previous draft echoed prompt text or metadata. Ignore that malformed draft and answer fresh."
      : invalidDraftHasBoundaryFailure
      ? "The previous draft broke role, scene, or user-agency boundaries. Do not reuse it. Answer fresh from the original context."
      : "",
    "Return only the corrected in-character reply.",
  ].filter(Boolean);

  repairMessages.push({
    role: "user",
    content: repairLines.join("\n"),
  });

  return {
    ...baseRequest,
    stream: false,
    max_tokens: Math.min(
      Number(baseRequest.max_tokens ?? REPAIR_MAX_TOKENS),
      REPAIR_MAX_TOKENS,
    ),
    messages: repairMessages,
  };
}

export const __test__ = {
  appendAssistantReplyWithFallback,
  buildCanonicalRepairRequestBody,
  prioritizeTurnOrderByAddress,
  selectGroupResponderIds,
  isHistoryEpochConflictError,
  removeQueuedReplyTasksForChat,
};

function isHistoryEpochConflictError(error: unknown): boolean {
  return /conflict:\s+stale history epoch/i.test(normalizeError(error));
}

function removeQueuedReplyTasksForChat(tasks: ReplyTask[], chatId: string): ReplyTask[] {
  return tasks.filter((task) => task.chatId !== chatId);
}

type AppendMessageFn = (payload: AppendMessagePayload) => Promise<ChatMessage>;

async function appendAssistantReplyWithFallback(input: {
  context: ReplyExecutionContext;
  generateReplyText: (context: ReplyExecutionContext) => Promise<ReplyGenerationResult>;
  appendMessageFn: AppendMessageFn;
}): Promise<ChatMessage> {
  const generationAttempts = REPLY_GENERATION_ATTEMPTS;
  let generated: ReturnType<typeof normalizeReplyGenerationResult> | null = null;

  for (let attempt = 0; attempt < generationAttempts; attempt += 1) {
    try {
      const candidate = normalizeReplyGenerationResult(
        await input.generateReplyText(input.context),
      );
      if (!candidate.content.trim()) {
        throw new Error(
          `${input.context.speaker?.name ?? "Assistant"} returned an empty reply after validation.`,
        );
      }
      generated = candidate;
      break;
    } catch (error) {
      if (isGenerationCancelledError(error)) {
        throw error;
      }
    }
  }

  if (!generated) {
    return input.appendMessageFn({
      chatId: input.context.chatId,
      role: "assistant",
      content: buildGenerationFailureMessage(input.context.speaker?.name),
      speakerCharacterId: input.context.speaker?.id,
      ...(input.context.expectedHistoryEpoch === undefined
        ? {}
        : { expectedHistoryEpoch: input.context.expectedHistoryEpoch }),
    });
  }

  const replyText = generated.content.trim();
  generated.diagnostics?.recordLifecycle("append_started");
  try {
    const appended = await input.appendMessageFn({
      chatId: input.context.chatId,
      role: "assistant",
      content: replyText,
      speakerCharacterId: input.context.speaker?.id,
      ...(input.context.expectedHistoryEpoch === undefined
        ? {}
        : { expectedHistoryEpoch: input.context.expectedHistoryEpoch }),
    });
    generated.diagnostics?.recordAppendResult({
      attempted: true,
      succeeded: true,
      messageId: appended.id,
      savedSpeakerCharacterId: appended.speakerCharacterId,
    });
    return appended;
  } catch (appendError) {
    generated.diagnostics?.recordAppendResult({
      attempted: true,
      succeeded: false,
      error: formatResponseDiagnosticError(appendError),
    });
    throw appendError;
  } finally {
    generated.diagnostics?.flush();
  }
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  upstreamSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const abortFromUpstream = () => controller.abort();
  let timedOut = false;

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, {
        once: true,
      });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await runtimeFetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut && !upstreamSignal?.aborted) {
      throw new Error("The local model did not accept the request in time.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (upstreamSignal) {
      upstreamSignal.removeEventListener("abort", abortFromUpstream);
    }
  }
}

async function fetchTextWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  upstreamSignal?: AbortSignal,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const abortFromUpstream = () => controller.abort();
  let timedOut = false;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
    }
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await runtimeFetch(input, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (timedOut && !upstreamSignal?.aborted) {
      throw new Error("The local model response exceeded the time limit.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

function normalizeTokenUsage(
  usage: LlamaChatCompletionResponse["usage"],
): LlamaTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const normalized: LlamaTokenUsage = {
    promptTokens:
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    completionTokens:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined,
    totalTokens:
      typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
  };
  return Object.values(normalized).some((value) => value !== undefined)
    ? normalized
    : undefined;
}

export function useChatOrchestration(
  composerRef: RefObject<HTMLTextAreaElement | null>,
  persistMemory: (
    chatId: string,
    history: ChatMessage[],
    expectedHistoryEpoch?: number,
  ) => Promise<void>,
) {
  const { setDetailTab, setNotice } = useAppStore();
  const { runtime, models } = useModelStore();
  const { characters, activeCharacterId, setActiveCharacterId } = useCharacterStore();
  const {
    chats,
    activeChatId,
    messagesByChat,
    participantsByChat,
    memoryByChat,
    composerInput,
    replyStateByChat,
    editingMessageDraft,
    setChats,
    setActiveChatId,
    setComposerInput,
    setReplyState,
    setStreaming,
    setMessagesByChat,
    setParticipantsByChat,
    setMemoryByChat,
    setMessageActionBusyId,
    setGroupBuilderOpen,
    setGroupTitle,
    setCreatingGroup,
    startEditMessage,
    cancelEditMessage,
  } = useChatStore();
  const { setActiveContextHits, setActiveMemoryHits } = useContextStore();
  const { userProfile, relationshipStateByChat } = useProfileStore();
  const {
    activeGenerationPresetId,
    generationPresets,
  } = usePresetStore();

  const generationAbortByChatRef = useRef<Record<string, AbortController | null>>({});
  const replyQueueRef = useRef<ReplyTask[]>([]);
  const processingQueueRef = useRef(false);

  const cancelChatWork = useCallback(
    (chatId: string) => {
      replyQueueRef.current = removeQueuedReplyTasksForChat(replyQueueRef.current, chatId);
      generationAbortByChatRef.current[chatId]?.abort();
      delete generationAbortByChatRef.current[chatId];
      setStreaming(chatId, null);
      setReplyState(chatId, null);
    },
    [setReplyState, setStreaming],
  );

  const charMap = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters],
  );
  const activeModel = useMemo(
    () => models.find((model) => model.isActive) ?? null,
    [models],
  );
  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) ?? null,
    [activeChatId, chats],
  );
  const activeCharacter = useMemo(
    () =>
      characters.find((character) => character.id === activeCharacterId) ??
      (activeChat?.characterId
        ? characters.find((character) => character.id === activeChat.characterId)
        : undefined),
    [activeCharacterId, activeChat?.characterId, characters],
  );
  const activeParticipants = useMemo(() => {
    const ids = activeChat ? chatParticipantIds(activeChat, participantsByChat[activeChat.id]) : [];
    return ids
      .map((id) => charMap.get(id))
      .filter((character): character is Character => Boolean(character));
  }, [activeChat, charMap, participantsByChat]);
  const activeMemory = useMemo(
    () => (activeChatId ? memoryByChat[activeChatId] : undefined),
    [activeChatId, memoryByChat],
  );
  const activeGenerationPreset = useMemo(
    () => generationPresets.find((preset) => preset.id === activeGenerationPresetId),
    [activeGenerationPresetId, generationPresets],
  );
  const activeRelationshipState = useMemo(
    () => (activeChatId ? relationshipStateByChat[activeChatId] : undefined),
    [activeChatId, relationshipStateByChat],
  );
  const samplingTemperature = activeGenerationPreset?.temperature;
  const samplingTopP = activeGenerationPreset?.topP;
  const samplingMaxTokens = activeGenerationPreset?.maxTokens;
  const samplingRepeatPenalty = activeGenerationPreset?.repeatPenalty;

  useEffect(() => {
    return () => {
      for (const controller of Object.values(generationAbortByChatRef.current)) {
        controller?.abort();
      }
      generationAbortByChatRef.current = {};
    };
  }, []);

  const refreshChats = useCallback(
    async (preferredChatId?: string) => {
      const latest = sortChatsByRecent(await listChats());
      setChats(latest);
      setParticipantsByChat((prev) => {
        const next = { ...prev };
        for (const chat of latest) {
          const authoritative = dedupeIds(chat.participantIds ?? []);
          if (authoritative.length === 0) {
            continue;
          }
          const cached = prev[chat.id] ?? [];
          next[chat.id] =
            cached.length > authoritative.length
              ? dedupeIds([...authoritative, ...cached])
              : authoritative;
        }
        return next;
      });
      if (preferredChatId) {
        setActiveChatId(preferredChatId);
        return;
      }
      setActiveChatId((prev) => {
        if (prev && latest.some((chat) => chat.id === prev)) {
          return prev;
        }
        return latest[0]?.id ?? null;
      });
    },
    [setActiveChatId, setChats, setParticipantsByChat],
  );

  const streamAssistantReplyText = useCallback(
    async (context: ReplyExecutionContext): Promise<ReplyGenerationResult> => {
      const {
        chatId,
        speaker,
        mode,
        isRegeneration,
        previousAssistantReply,
        streamTargetMessageId,
        groupTurnIndex,
        groupTurnCount,
        groupTurnSpeakerIds,
        groupTurnSpeakerNames,
        participantNames,
        participantDirectory,
        history,
        memory,
        contextHits,
        memoryHits,
        relationshipState,
        userProfile,
        runtimeEndpoint,
        activeModelName,
        samplingTemperature,
        samplingTopP,
        samplingMaxTokens,
        samplingRepeatPenalty,
      } = context;
      const endpoint = resolveChatCompletionsUrl(
        runtimeEndpoint,
        FALLBACK_RUNTIME_ENDPOINT,
      );
      const diagnostics = createResponseDiagnostics({
        chatId,
        speakerCharacterId: speaker?.id,
        speakerName: speaker?.name,
        mode,
        groupTurn:
          mode === "group"
            ? {
                turnIndex: groupTurnIndex,
                turnCount: groupTurnCount,
                speakerIdOrder: groupTurnSpeakerIds,
                speakerNameOrder: groupTurnSpeakerNames,
              }
            : undefined,
        runtime: {
          endpoint,
          model: activeModelName,
          stream: true,
          maxTokens: samplingMaxTokens,
          temperature: samplingTemperature,
          topP: samplingTopP,
          repeatPenalty: samplingRepeatPenalty,
        },
      });
      const controller = new AbortController();
      generationAbortByChatRef.current[chatId] = controller;
      let rawContent = "";
      let flushAfterAppend = false;
      try {
        const prepareStartedAt = Date.now();
        let preparedResponse: ReturnType<typeof prepareResponseRequest>;
        try {
          preparedResponse = prepareResponseRequest({
            speaker,
            userProfile,
            relationshipState,
            sceneStateInput: relationshipState
              ? {
                  currentScene: relationshipState.currentScene,
                  interactionTone: relationshipState.interactionTone,
                  characterState: relationshipState.characterState,
                  userState: relationshipState.userState,
                }
              : undefined,
            memory,
            contextEntries: contextHits,
            semanticMemorySnippets: memoryHits,
            history: filterGenerationFailureMessages(history),
            sampling: {
              temperature: samplingTemperature,
              topP: samplingTopP,
              maxTokens: samplingMaxTokens,
              repeatPenalty: samplingRepeatPenalty,
            },
            mode,
            isRegeneration,
            previousAssistantReply,
            participantNames,
            participantDirectory,
            runtime: {
              model: activeModelName,
              stream: true,
            },
          });
        } catch (error) {
          diagnostics.recordTiming("prepare", Date.now() - prepareStartedAt);
          throw new Error(
            `Failed to prepare response request: ${normalizeError(error)}`,
          );
        }
        diagnostics.recordTiming("prepare", Date.now() - prepareStartedAt);
        diagnostics.recordLifecycle("prepared");
        const requestBody = preparedResponse.runtimeRequest;
        diagnostics.recordInspection(
          buildResponseDiagnosticsInspection(preparedResponse),
        );
        diagnostics.recordRuntimeRequest({
          stream: Boolean(requestBody.stream),
          messageCount: requestBody.messages.length,
          contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
          estimatedInputTokens: estimateChatMessagesTokens(requestBody.messages),
          maxTokens:
            typeof requestBody.max_tokens === "number"
              ? requestBody.max_tokens
              : undefined,
          temperature:
            typeof requestBody.temperature === "number"
              ? requestBody.temperature
              : undefined,
          topP:
            typeof requestBody.top_p === "number"
              ? requestBody.top_p
              : undefined,
          repeatPenalty:
            typeof requestBody.repeat_penalty === "number"
              ? requestBody.repeat_penalty
              : undefined,
        });

        async function fetchNonStreamingCompletion(body: unknown): Promise<{
          content: string;
          finishReason?: string;
          usage?: LlamaTokenUsage;
        }> {
          const normalizedBody =
            body && typeof body === "object"
              ? ({ ...(body as Record<string, unknown>), stream: false })
              : { stream: false };
          const { response: fallbackResponse, text } = await fetchTextWithTimeout(
            endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(normalizedBody),
            },
            REPAIR_REQUEST_TIMEOUT_MS,
            controller.signal,
          );
          if (!fallbackResponse.ok) {
            throw new Error(
              `fallback failed (${fallbackResponse.status}): ${text.slice(0, 200)}`,
            );
          }
          let payload: LlamaChatCompletionResponse;
          try {
            payload = JSON.parse(text) as LlamaChatCompletionResponse;
          } catch {
            throw new Error("The local model returned a malformed completion response.");
          }
          if (payload.error?.message) {
            throw new Error(payload.error.message);
          }
          const finishReason = payload.choices?.[0]?.finish_reason;
          return {
            content: payload.choices?.[0]?.message?.content ?? "",
            ...(typeof finishReason === "string" ? { finishReason } : {}),
            ...(payload.usage ? { usage: normalizeTokenUsage(payload.usage) } : {}),
          };
        }

        let latestPreview = "";
        setStreaming(chatId, {
          speakerCharacterId: speaker?.id,
          targetMessageId: streamTargetMessageId,
          content: "",
        });
        const streamStartedAt = Date.now();
        let firstTokenRecorded = false;
        let lastPreviewAt = 0;
        let finishReason: string | undefined;
        let tokenUsage: LlamaTokenUsage | undefined;
        let streamFallbackUsed = false;
        const updateStreamingPreview = (force = false) => {
          const now = Date.now();
          if (!force && now - lastPreviewAt < STREAM_PREVIEW_INTERVAL_MS) {
            return;
          }
          lastPreviewAt = now;
          const nextPreview = retainVisibleStreamingPreview(
            latestPreview,
            buildStreamingPreview(rawContent, preparedResponse),
          );
          if (nextPreview === latestPreview) {
            return;
          }
          latestPreview = nextPreview;
          setStreaming(chatId, {
            speakerCharacterId: speaker?.id,
            targetMessageId: streamTargetMessageId,
            content: latestPreview,
          });
        };
        diagnostics.recordLifecycle("runtime_started");
        let streamTimingRecorded = false;
        const recordStreamTiming = () => {
          if (streamTimingRecorded) {
            return;
          }
          streamTimingRecorded = true;
          diagnostics.recordTiming(
            "runtime_stream",
            Date.now() - streamStartedAt,
          );
        };
        try {
          const streamResponse = await fetchWithTimeout(
            endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestBody),
            },
            STREAM_CONNECT_TIMEOUT_MS,
            controller.signal,
          );
          if (!streamResponse.ok) {
            const text = await streamResponse.text();
            throw new Error(
              `inference failed (${streamResponse.status}): ${text.slice(0, 200)}`,
            );
          }
          if (!streamResponse.body) {
            throw new Error("Inference stream unavailable");
          }
          for await (const delta of parseLlamaSseStream(streamResponse.body, {
            signal: controller.signal,
            firstTokenTimeoutMs: STREAM_FIRST_TOKEN_TIMEOUT_MS,
            inactivityTimeoutMs: STREAM_INACTIVITY_TIMEOUT_MS,
            totalTimeoutMs: STREAM_TOTAL_TIMEOUT_MS,
          })) {
            if (delta.content) {
              if (!firstTokenRecorded) {
                firstTokenRecorded = true;
                diagnostics.recordTiming(
                  "time_to_first_token",
                  Date.now() - streamStartedAt,
                );
              }
              rawContent += delta.content;
              updateStreamingPreview();
            }
            if (typeof delta.finishReason === "string") {
              finishReason = delta.finishReason;
            }
            if (delta.usage) {
              tokenUsage = delta.usage;
            }
          }
          updateStreamingPreview(true);
        } catch (streamError) {
          recordStreamTiming();
          if (isGenerationCancelledError(streamError)) {
            throw new Error(GENERATION_CANCELLED_MESSAGE);
          }
          const fallbackStartedAt = Date.now();
          try {
            const fallback = await fetchNonStreamingCompletion(requestBody);
            rawContent = fallback.content;
            finishReason = fallback.finishReason;
            tokenUsage = fallback.usage;
            streamFallbackUsed = true;
            latestPreview = buildStreamingPreview(rawContent, preparedResponse);
            setStreaming(chatId, {
              speakerCharacterId: speaker?.id,
              targetMessageId: streamTargetMessageId,
              content: latestPreview,
            });
          } catch (fallbackError) {
            diagnostics.recordTiming(
              "runtime_fallback",
              Date.now() - fallbackStartedAt,
            );
            throw new Error(
              `Failed to reach runtime endpoint ${endpoint}: ${normalizeError(
                fallbackError,
              )}`,
            );
          }
          diagnostics.recordTiming(
            "runtime_fallback",
            Date.now() - fallbackStartedAt,
          );
        } finally {
          recordStreamTiming();
        }
        diagnostics.recordRuntimeRequest({
          ...(finishReason ? { finishReason } : {}),
          ...(tokenUsage?.promptTokens === undefined
            ? {}
            : { promptTokens: tokenUsage.promptTokens }),
          ...(tokenUsage?.completionTokens === undefined
            ? {}
            : { completionTokens: tokenUsage.completionTokens }),
          ...(tokenUsage?.totalTokens === undefined
            ? {}
            : { totalTokens: tokenUsage.totalTokens }),
          streamFallbackUsed,
        });
        diagnostics.recordLifecycle("runtime_completed");
        diagnostics.recordRawOutput(rawContent);
        const compactInvalidDraft =
          sanitizeAssistantReply(rawContent, {
            speakerName: speaker?.name,
            userName: userProfile?.name,
          }) || rawContent;
        diagnostics.recordSanitizedOutput(compactInvalidDraft);
        const finalizeStartedAt = Date.now();
        const evaluation = await finalizeResponseOutput({
          rawOutput: rawContent,
          prepared: preparedResponse,
          repair: async (instruction) =>
            fetchNonStreamingCompletion(
              buildCanonicalRepairRequestBody({
                preparedResponse,
                repairInstruction: instruction,
                invalidDraft: compactInvalidDraft,
              }),
            ).then((completion) => completion.content),
          fallbackReply: `${speaker?.name ?? "Assistant"} has no response yet.`,
          diagnostics,
        });
        diagnostics.recordTiming("finalize", Date.now() - finalizeStartedAt);
        diagnostics.recordFinalEvaluation(evaluation);

        if (!evaluation.accepted) {
          const failureMessage = buildGenerationFailureMessage(speaker?.name);
          diagnostics.recordFailure("finalization rejected reply", failureMessage);
          throw new Error(failureMessage);
        }

        diagnostics.recordLifecycle("finalized");
        flushAfterAppend = true;
        return { content: evaluation.finalReply, diagnostics };
      } catch (error) {
        if (rawContent) {
          diagnostics.recordRawOutput(rawContent);
        }
        if (!diagnostics.entry.runtime.failureReason) {
          diagnostics.recordFailure(formatResponseDiagnosticError(error));
        }
        throw error;
      } finally {
        delete generationAbortByChatRef.current[chatId];
        if (!flushAfterAppend) {
          diagnostics.flush();
        }
      }
    },
    [
      setStreaming,
    ],
  );

  const generateAssistantReply = useCallback(
    async (context: ReplyExecutionContext): Promise<ChatMessage> => {
      return appendAssistantReplyWithFallback({
        context,
        generateReplyText: streamAssistantReplyText,
        appendMessageFn: appendMessage,
      });
    },
    [streamAssistantReplyText],
  );

  const processReplyQueue = useCallback(async () => {
    if (processingQueueRef.current) {
      return;
    }
    processingQueueRef.current = true;
    try {
      while (replyQueueRef.current.length > 0) {
        const task = replyQueueRef.current.shift();
        if (!task) {
          continue;
        }

        const {
          chats: queuedChats,
          participantsByChat: queuedParticipantsByChat,
          memoryByChat: queuedMemoryByChat,
          setParticipantsByChat: storeSetParticipantsByChat,
          setMessagesByChat: storeSetMessagesByChat,
        } = chatStore.getState();
        const {
          characters: queuedCharacters,
        } = characterStore.getState();
        const {
          userProfile: queuedUserProfile,
          relationshipStateByChat: queuedRelationshipStateByChat,
        } = profileStore.getState();
        const {
          runtime: queuedRuntime,
          models: queuedModels,
        } = modelStore.getState();
        const {
          generationPresets: queuedGenerationPresets,
          activeGenerationPresetId: queuedGenerationPresetId,
        } = presetStore.getState();
        const appendQueuedGenerationFailure = async (speaker?: Character) => {
          const failure = await appendMessage({
            chatId: task.chatId,
            role: "assistant",
            content: buildGenerationFailureMessage(speaker?.name),
            speakerCharacterId: speaker?.id,
            expectedHistoryEpoch: task.historyEpoch,
          });
          const failedHistory = [
            ...(chatStore.getState().messagesByChat[task.chatId] ?? []),
            failure,
          ];
          storeSetMessagesByChat((prev) => ({
            ...prev,
            [task.chatId]: failedHistory,
          }));
          try {
            await persistMemory(
              task.chatId,
              filterGenerationFailureMessages(failedHistory),
              task.historyEpoch,
            );
          } catch {
            // The visible failure message is the user-facing guarantee; memory can lag.
          }
          return failure;
        };

        if (queuedRuntime.status !== "running") {
          try {
            await appendQueuedGenerationFailure();
          } catch {
            // If persistence itself fails, the notice below is still the only safe fallback.
          }
          setReplyState(task.chatId, null);
          setNotice({ kind: "error", message: "Runtime is not running." });
          continue;
        }

        const queuedChat = queuedChats.find((chat) => chat.id === task.chatId) ?? null;
        if (!queuedChat) {
          try {
            await appendQueuedGenerationFailure();
          } catch {
            // The chat may have been deleted locally before the queue drained.
          }
          setReplyState(task.chatId, null);
          continue;
        }
        if (queuedChat.historyEpoch !== task.historyEpoch) {
          setReplyState(task.chatId, null);
          continue;
        }

        const queuedCharMap = new Map(
          queuedCharacters.map((character) => [character.id, character]),
        );
        const queuedRelationshipState = queuedRelationshipStateByChat[task.chatId];
        const queuedMemory = queuedMemoryByChat[task.chatId];
        const queuedActiveModel =
          queuedModels.find((model) => model.isActive) ?? null;
        const queuedGenerationPreset = queuedGenerationPresets.find(
          (preset) => preset.id === queuedGenerationPresetId,
        );

        let responders = chatParticipantIds(
          queuedChat,
          queuedParticipantsByChat[task.chatId],
        );
        const queuedGroupMode = isGroupChatMode(queuedChat, responders);
        if (queuedGroupMode) {
          try {
            const authoritative = dedupeIds(await listChatParticipants(task.chatId));
            if (authoritative.length > 0) {
              responders = authoritative;
              storeSetParticipantsByChat((prev) => ({
                ...prev,
                [task.chatId]: authoritative,
              }));
            }
          } catch {
            // Keep the cached roster if backend participant hydration fails.
          }
        } else if (responders.length === 0) {
          responders = dedupeIds(await listChatParticipants(task.chatId));
          if (responders.length > 0) {
            storeSetParticipantsByChat((prev) => ({
              ...prev,
              [task.chatId]: responders,
            }));
          }
        }
        if (responders.length === 0 && queuedChat.characterId) {
          responders = [queuedChat.characterId];
        }
        if (responders.length === 0) {
          try {
            await appendQueuedGenerationFailure();
          } catch {
            // If the backend cannot save a failure message, keep the visible notice.
          }
          setReplyState(task.chatId, null);
          setNotice({ kind: "error", message: "Chat has no participants." });
          continue;
        }

        let contextHits: ContextEntry[] = [];
        try {
          contextHits = await resolveContextEntries({
            characterIds: responders,
            query: task.text,
            limit: 6,
          });
        } catch {
          contextHits = [];
        }
        if (chatStore.getState().activeChatId === task.chatId) {
          setActiveContextHits(contextHits);
        }

        const participantDirectory = Object.fromEntries(
          responders
            .map((id) => [id, queuedCharMap.get(id)?.name?.trim() ?? ""])
            .filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        const turnOrder = isGroupChatMode(queuedChat, responders)
          ? selectGroupResponderIds({
              responderIds: responders,
              participantDirectory,
              latestUserMessage: task.text,
            })
          : responders.slice(0, 1);
        const memoryHitsBySpeaker = new Map<string, MemorySnippet[]>();
        try {
          const hitsBySpeaker = await resolveMemorySnippetsBatch(
            turnOrder.map((speakerId) => {
              const speaker = queuedCharMap.get(speakerId);
              return {
                chatId: task.chatId,
                query: task.text,
                limit: 6,
                speakerCharacterId: speaker?.id,
                retrievalHints: buildResponseRetrievalHints({
                  speaker,
                  userProfile: queuedUserProfile ?? undefined,
                  relationshipState: queuedRelationshipState,
                }),
              };
            }),
          );
          turnOrder.forEach((speakerId, index) => {
            memoryHitsBySpeaker.set(speakerId, hitsBySpeaker[index] ?? []);
          });
        } catch {
          turnOrder.forEach((speakerId) => memoryHitsBySpeaker.set(speakerId, []));
        }
        if (chatStore.getState().activeChatId === task.chatId) {
          setActiveMemoryHits(memoryHitsBySpeaker.get(turnOrder[0] ?? "") ?? []);
        }

        const baseTurnHistory =
          chatStore.getState().messagesByChat[task.chatId] ?? [];
        const groupTurnMode = isGroupChatMode(queuedChat, responders);
        let nextHistory = baseTurnHistory;
        try {
          setReplyState(task.chatId, "streaming");
          const failedSpeakers: string[] = [];
          for (const [turnIndex, speakerId] of turnOrder.entries()) {
            const speaker = queuedCharMap.get(speakerId);
            const memoryHits = memoryHitsBySpeaker.get(speakerId) ?? [];
            const historyForSpeaker = historyForQueuedSpeakerTurn({
              groupMode: groupTurnMode,
              roundHistoryBase: baseTurnHistory,
              currentHistory: nextHistory,
            });
            try {
              const reply = await generateAssistantReply({
                chatId: task.chatId,
                expectedHistoryEpoch: task.historyEpoch,
                speaker,
                mode: groupTurnMode ? "group" : "single",
                participantNames: responders
                  .map((id) => queuedCharMap.get(id)?.name?.trim())
                  .filter((name): name is string => Boolean(name)),
                participantDirectory,
                groupTurnIndex: turnIndex + 1,
                groupTurnCount: turnOrder.length,
                groupTurnSpeakerIds: [...turnOrder],
                groupTurnSpeakerNames: turnOrder
                  .map((id) => queuedCharMap.get(id)?.name?.trim())
                  .filter((name): name is string => Boolean(name)),
                history: historyForSpeaker,
                memory: queuedMemory,
                contextHits,
                memoryHits,
                relationshipState: queuedRelationshipState,
                userProfile: queuedUserProfile ?? undefined,
                runtimeEndpoint: queuedRuntime.endpoint,
                activeModelName: queuedActiveModel?.name ?? "local-model",
                samplingTemperature: queuedGenerationPreset?.temperature,
                samplingTopP: queuedGenerationPreset?.topP,
                samplingMaxTokens: queuedGenerationPreset?.maxTokens,
                samplingRepeatPenalty: queuedGenerationPreset?.repeatPenalty,
              });
              nextHistory = [...nextHistory, reply];
              storeSetMessagesByChat((prev) => ({
                ...prev,
                [task.chatId]: nextHistory,
              }));
            } catch (error) {
              if (isGenerationCancelledError(error) || isHistoryEpochConflictError(error)) {
                throw error;
              }
              failedSpeakers.push(
                speaker?.name
                  ? `${speaker.name}: ${normalizeError(error)}`
                  : normalizeError(error),
              );
            }
          }
          if (failedSpeakers.length > 0) {
            setNotice({
              kind: "error",
              message:
                failedSpeakers.length === 1
                  ? failedSpeakers[0]
                  : `Some group members could not respond: ${failedSpeakers.join(" | ")}`,
            });
          }
          await persistMemory(
            task.chatId,
            filterGenerationFailureMessages(nextHistory),
            task.historyEpoch,
          );
          await refreshChats();
        } catch (error) {
          if (isGenerationCancelledError(error) || isHistoryEpochConflictError(error)) {
            setNotice({ kind: "info", message: "Generation stopped." });
            if (nextHistory.length > 0) {
              try {
                await persistMemory(
                  task.chatId,
                  filterGenerationFailureMessages(nextHistory),
                  task.historyEpoch,
                );
              } catch {
                // Ignore memory update failures after cancellation.
              }
            }
          } else {
            setNotice({ kind: "error", message: normalizeError(error) });
          }
        } finally {
          setStreaming(task.chatId, null);
          setReplyState(task.chatId, null);
        }
      }
    } finally {
      processingQueueRef.current = false;
    }
  }, [
    generateAssistantReply,
    persistMemory,
    refreshChats,
    setActiveContextHits,
    setActiveMemoryHits,
    setNotice,
    setReplyState,
    setStreaming,
  ]);

  const createDirectChat = useCallback(
    async (character: Character, openingMessage: string = character.greeting ?? "") => {
      try {
        const created = await createChat({
          title: `${character.name} Chat`,
          characterId: character.id,
        });
        let initialMessages: ChatMessage[] = [];
        const greetingText = renderCardTemplate(openingMessage, {
          characterName: character.name,
          userName: userProfile?.name,
        });
        if (greetingText && shouldInjectGreetingAsFirstMessage(greetingText, character.name)) {
          const greeting = await appendMessage({
            chatId: created.id,
            role: "assistant",
            content: greetingText,
            speakerCharacterId: character.id,
          });
          initialMessages = [greeting];
        }
        setChats((prev) => sortChatsByRecent([created, ...prev.filter((chat) => chat.id !== created.id)]));
        setMessagesByChat((prev) => ({ ...prev, [created.id]: initialMessages }));
        setParticipantsByChat((prev) => ({
          ...prev,
          [created.id]: dedupeIds(
            created.participantIds.length > 0 ? created.participantIds : [character.id],
          ),
        }));
        setMemoryByChat((prev) => ({ ...prev, [created.id]: emptyMemory(created.id) }));
        setActiveChatId(created.id);
        setActiveCharacterId(character.id);
        setDetailTab("overview");
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [
      setActiveCharacterId,
      setActiveChatId,
      setChats,
      setDetailTab,
      setMemoryByChat,
      setMessagesByChat,
      setNotice,
      setParticipantsByChat,
      userProfile?.name,
    ],
  );

  const createGroup = useCallback(
    async (
      groupSelection: string[],
      groupTitle: string,
      options?: {
        summary?: string;
        currentScene?: string;
        interactionTone?: string;
        characterState?: string;
        userState?: string;
      },
    ) => {
      const members = dedupeIds(groupSelection);
      if (members.length < 2) {
        setNotice({
          kind: "error",
          message: "Pick at least 2 characters for group chat.",
        });
        return;
      }
      setCreatingGroup(true);
      try {
        const created = await createGroupChat({
          title: groupTitle.trim() || undefined,
          characterIds: members,
        });
        if (
          options?.summary?.trim() ||
          options?.currentScene?.trim() ||
          options?.interactionTone?.trim() ||
          options?.characterState?.trim() ||
          options?.userState?.trim()
        ) {
          const relationshipState = await upsertChatRelationshipState({
            chatId: created.id,
            summary: options.summary?.trim() || undefined,
            currentScene: options.currentScene?.trim() || undefined,
            interactionTone: options.interactionTone?.trim() || undefined,
            characterState: options.characterState?.trim() || undefined,
            userState: options.userState?.trim() || undefined,
          });
          profileStore.getState().hydrateRelationshipState(relationshipState);
        }
        setChats((prev) => sortChatsByRecent([created, ...prev.filter((chat) => chat.id !== created.id)]));
        setMessagesByChat((prev) => ({ ...prev, [created.id]: [] }));
        setParticipantsByChat((prev) => ({
          ...prev,
          [created.id]: dedupeIds(
            created.participantIds.length > 0 ? created.participantIds : members,
          ),
        }));
        setMemoryByChat((prev) => ({ ...prev, [created.id]: emptyMemory(created.id) }));
        setActiveChatId(created.id);
        setActiveCharacterId(members[0]);
        setGroupTitle("");
        setGroupBuilderOpen(false);
        setNotice({ kind: "info", message: "Group chat created." });
        return created;
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
        return null;
      } finally {
        setCreatingGroup(false);
      }
    },
    [
      setActiveCharacterId,
      setActiveChatId,
      setChats,
      setCreatingGroup,
      setGroupBuilderOpen,
      setGroupTitle,
      setMemoryByChat,
      setMessagesByChat,
      setNotice,
      setParticipantsByChat,
    ],
  );

  const updateGroup = useCallback(
    async (chatId: string, groupSelection: string[], groupTitle: string) => {
      const members = dedupeIds(groupSelection);
      if (members.length < 2) {
        setNotice({
          kind: "error",
          message: "Pick at least 2 characters for group chat.",
        });
        return null;
      }
      const title = groupTitle.trim();
      if (!title) {
        setNotice({ kind: "error", message: "Group chat title cannot be empty." });
        return null;
      }

      const updated = await updateGroupChat({
        chatId,
        title,
        characterIds: members,
      });

      setChats((prev) =>
        sortChatsByRecent([updated, ...prev.filter((chat) => chat.id !== updated.id)]),
      );
      setParticipantsByChat((prev) => ({
        ...prev,
        [updated.id]: dedupeIds(
          updated.participantIds.length > 0 ? updated.participantIds : members,
        ),
      }));
      if (!members.includes(characterStore.getState().activeCharacterId ?? "")) {
        setActiveCharacterId(members[0] ?? null);
      }
      await refreshChats(updated.id);
      setNotice({ kind: "info", message: "Group chat updated." });
      return updated;
    },
    [refreshChats, setActiveCharacterId, setChats, setNotice, setParticipantsByChat],
  );

  const sendMessage = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (!activeChat) {
        return;
      }
      const text = composerInput.trim();
      if (!text) {
        return;
      }
      if (runtime.status !== "running") {
        setNotice({ kind: "error", message: "Runtime is not running." });
        return;
      }
      if (replyStateByChat[activeChat.id]) {
        return;
      }

      setComposerInput("");
      if (composerRef.current) {
        composerRef.current.style.height = "42px";
      }

      const chatId = activeChat.id;
      const baseHistory = messagesByChat[chatId] ?? [];
      try {
        const userMessage = await appendMessage({
          chatId,
          role: "user",
          content: text,
          expectedHistoryEpoch: activeChat.historyEpoch,
        });
        const nextHistory = [...baseHistory, userMessage];
        setMessagesByChat((prev) => ({ ...prev, [chatId]: nextHistory }));
        setReplyState(chatId, "queued");
        replyQueueRef.current = [
          ...replyQueueRef.current,
          { chatId, text, historyEpoch: activeChat.historyEpoch },
        ];
        void processReplyQueue();
        try {
          await persistMemory(
            chatId,
            filterGenerationFailureMessages(nextHistory),
            activeChat.historyEpoch,
          );
        } catch (error) {
          if (isHistoryEpochConflictError(error)) {
            return;
          }
          setNotice({
            kind: "error",
            message: "Message saved, but memory update failed. Reply is still queued.",
          });
        }
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [
      activeChat,
      composerInput,
      composerRef,
      messagesByChat,
      persistMemory,
      processReplyQueue,
      replyStateByChat,
      runtime.status,
      setComposerInput,
      setMessagesByChat,
      setNotice,
      setReplyState,
    ],
  );

  const startEditUserMessage = useCallback(
    (message: ChatMessage) => {
      if (message.role !== "user") {
        return;
      }
      startEditMessage(message.id, message.content);
    },
    [startEditMessage],
  );

  const saveEditedUserMessage = useCallback(
    async (message: ChatMessage) => {
      const nextContent = editingMessageDraft.trim();
      if (!nextContent) {
        setNotice({ kind: "error", message: "Message content cannot be empty." });
        return;
      }
      if (!activeChatId || !activeChat) {
        return;
      }
      setMessageActionBusyId(message.id);
      try {
        const history = messagesByChat[activeChatId] ?? [];
        const targetIndex = history.findIndex((item) => item.id === message.id);
        if (targetIndex < 0) {
          throw new Error("Message not found in active chat.");
        }
        const hasDependentTurns = targetIndex < history.length - 1;
        let nextHistory: ChatMessage[];
        let nextEpoch = activeChat.historyEpoch;
        if (hasDependentTurns) {
          cancelChatWork(activeChatId);
          const mutation = await editMessageAndTruncate({
            id: message.id,
            content: nextContent,
            expectedHistoryEpoch: activeChat.historyEpoch,
          });
          nextHistory = mutation.messages;
          nextEpoch = mutation.historyEpoch;
          setChats((previous) =>
            sortChatsByRecent(
              previous.map((chat) =>
                chat.id === activeChatId
                  ? {
                      ...chat,
                      historyEpoch: mutation.historyEpoch,
                      updatedAt: mutation.updatedAt,
                    }
                  : chat,
              ),
            ),
          );
          setMemoryByChat((previous) => ({
            ...previous,
            [activeChatId]: emptyMemory(activeChatId),
          }));
        } else {
          const saved = await updateMessage({
            id: message.id,
            content: nextContent,
            expectedHistoryEpoch: activeChat.historyEpoch,
          });
          const merged: ChatMessage = {
            ...message,
            ...saved,
            content: saved.content || nextContent,
          };
          nextHistory = history.map((item) =>
            item.id === merged.id ? merged : item,
          );
        }
        setMessagesByChat((prev) => ({ ...prev, [activeChatId]: nextHistory }));
        await persistMemory(
          activeChatId,
          filterGenerationFailureMessages(nextHistory),
          nextEpoch,
        );
        cancelEditMessage();
        setNotice({
          kind: "info",
          message: hasDependentTurns
            ? "Message updated and later turns removed."
            : "Message updated.",
        });
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      } finally {
        setMessageActionBusyId(null);
      }
    },
    [
      activeChatId,
      activeChat,
      cancelChatWork,
      cancelEditMessage,
      editingMessageDraft,
      messagesByChat,
      persistMemory,
      setMessageActionBusyId,
      setChats,
      setMemoryByChat,
      setMessagesByChat,
      setNotice,
    ],
  );

  const regenerateAssistantMessage = useCallback(
    async (message: ChatMessage) => {
      if (message.role !== "assistant" || !activeChat || !activeChatId) {
        return;
      }
      if (runtime.status !== "running") {
        setNotice({ kind: "error", message: "Runtime is not running." });
        return;
      }
      const history = messagesByChat[activeChatId] ?? [];
      const targetIndex = history.findIndex((entry) => entry.id === message.id);
      if (targetIndex < 0) {
        setNotice({ kind: "error", message: "Message not found in active chat." });
        return;
      }
      if (targetIndex !== history.length - 1) {
        setNotice({
          kind: "info",
          message: "Branch from this message before regenerating; later turns cannot be silently rewritten.",
        });
        return;
      }
      setMessageActionBusyId(message.id);
      try {
        const beforeTarget = history.slice(0, targetIndex);
        let responders = chatParticipantIds(
          activeChat,
          participantsByChat[activeChatId],
        );
        if (isGroupChatMode(activeChat, responders)) {
          try {
            const authoritative = dedupeIds(await listChatParticipants(activeChatId));
            if (authoritative.length > 0) {
              responders = authoritative;
              setParticipantsByChat((prev) => ({
                ...prev,
                [activeChatId]: authoritative,
              }));
            }
          } catch {
            // Fall back to the local roster if backend hydration fails during regenerate.
          }
        }
        if (responders.length === 0 && message.speakerCharacterId) {
          responders = [message.speakerCharacterId];
        }
        const querySource = [...beforeTarget]
          .reverse()
          .find((entry) => entry.role === "user")
          ?.content.trim();
        const speaker =
          (message.speakerCharacterId
            ? charMap.get(message.speakerCharacterId)
            : undefined) ??
          activeParticipants[0] ??
          activeCharacter;
        let contextHits: ContextEntry[] = [];
        let memoryHits: MemorySnippet[] = [];
        if (querySource) {
          try {
            contextHits = await resolveContextEntries({
              characterIds: responders.length > 0 ? responders : undefined,
              query: querySource,
              limit: 6,
            });
          } catch {
            contextHits = [];
          }
          try {
            memoryHits = await resolveMemorySnippets({
              chatId: activeChatId,
              query: querySource,
              limit: 6,
              speakerCharacterId: speaker?.id,
              retrievalHints: buildResponseRetrievalHints({
                speaker,
                userProfile: userProfile ?? undefined,
                relationshipState: activeRelationshipState,
              }),
            });
          } catch {
            memoryHits = [];
          }
        }
        memoryHits = filterRegenerationMemoryHits(memoryHits, message);
        setActiveContextHits(contextHits);
        setActiveMemoryHits(memoryHits);
        setReplyState(activeChatId, "streaming");
        const groupMode = isGroupChatMode(activeChat, responders);
        const regenerated = normalizeReplyGenerationResult(
          await streamAssistantReplyText({
            chatId: activeChatId,
            expectedHistoryEpoch: activeChat.historyEpoch,
            speaker,
            mode: groupMode ? "group" : "single",
            isRegeneration: true,
            previousAssistantReply: message.content,
            streamTargetMessageId: message.id,
            participantNames: responders
              .map((id) => charMap.get(id)?.name?.trim())
              .filter((name): name is string => Boolean(name)),
            participantDirectory: Object.fromEntries(
              responders
                .map((id) => [id, charMap.get(id)?.name?.trim() ?? ""])
                .filter((entry): entry is [string, string] => Boolean(entry[1])),
            ),
            history: beforeTarget,
            memory: activeMemory,
            contextHits,
            memoryHits,
            relationshipState: activeRelationshipState,
            userProfile: userProfile ?? undefined,
            runtimeEndpoint: runtime.endpoint,
            activeModelName: activeModel?.name ?? "local-model",
            samplingTemperature,
            samplingTopP,
            samplingMaxTokens,
            samplingRepeatPenalty,
          }),
        );
        const regeneratedText = regenerated.content;
        regenerated.diagnostics?.recordLifecycle(
          "append_started",
          "updating existing assistant message",
        );
        let saved: ChatMessage;
        try {
          saved = await updateMessage({
            id: message.id,
            content: regeneratedText,
            expectedHistoryEpoch: activeChat.historyEpoch,
          });
          regenerated.diagnostics?.recordAppendResult({
            attempted: true,
            succeeded: true,
            messageId: saved.id,
            savedSpeakerCharacterId: saved.speakerCharacterId,
          });
        } catch (error) {
          regenerated.diagnostics?.recordAppendResult({
            attempted: true,
            succeeded: false,
            error: formatResponseDiagnosticError(error),
          });
          throw error;
        } finally {
          regenerated.diagnostics?.flush();
        }
        const merged: ChatMessage = {
          ...message,
          ...saved,
          speakerCharacterId:
            saved.speakerCharacterId ?? message.speakerCharacterId,
          content: saved.content || regeneratedText,
        };
        const nextHistory = history.map((entry) =>
          entry.id === merged.id ? merged : entry,
        );
        setMessagesByChat((prev) => ({ ...prev, [activeChatId]: nextHistory }));
        await persistMemory(
          activeChatId,
          filterGenerationFailureMessages(nextHistory),
          activeChat.historyEpoch,
        );
        setNotice({ kind: "info", message: "Assistant message regenerated." });
      } catch (error) {
        if (isGenerationCancelledError(error) || isHistoryEpochConflictError(error)) {
          setNotice({ kind: "info", message: "Generation stopped." });
          return;
        }
        setNotice({ kind: "error", message: normalizeError(error) });
      } finally {
        setStreaming(activeChatId, null);
        setReplyState(activeChatId, null);
        setMessageActionBusyId(null);
      }
    },
    [
      activeCharacter,
      activeChat,
      activeChatId,
      activeMemory,
      activeModel?.name,
      activeParticipants,
      activeRelationshipState,
      charMap,
      messagesByChat,
      participantsByChat,
      persistMemory,
      runtime.endpoint,
      runtime.status,
      samplingMaxTokens,
      samplingRepeatPenalty,
      samplingTemperature,
      samplingTopP,
      setActiveContextHits,
      setActiveMemoryHits,
      setMessageActionBusyId,
      setMessagesByChat,
      setNotice,
      setParticipantsByChat,
      setReplyState,
      setStreaming,
      streamAssistantReplyText,
      userProfile,
    ],
  );

  const branchFromMessage = useCallback(
    async (message: ChatMessage) => {
      if (!activeChat) {
        return;
      }
      setMessageActionBusyId(message.id);
      try {
        const branchTitle = `${activeChat.title} Branch`;
        const created = await branchChat({
          chatId: activeChat.id,
          messageId: message.id,
          title: branchTitle,
        });
        const sourceHistory = messagesByChat[activeChat.id] ?? [];
        const branchIndex = sourceHistory.findIndex((entry) => entry.id === message.id);
        if (branchIndex >= 0) {
          setMessagesByChat((prev) => ({
            ...prev,
            [created.id]: sourceHistory.slice(0, branchIndex + 1),
          }));
        }
        const sourceParticipants = chatParticipantIds(
          activeChat,
          participantsByChat[activeChat.id],
        );
        if (sourceParticipants.length > 0) {
          setParticipantsByChat((prev) => ({
            ...prev,
            [created.id]: sourceParticipants,
          }));
        }
        setChats((prev) => sortChatsByRecent([created, ...prev.filter((chat) => chat.id !== created.id)]));
        setActiveChatId(created.id);
        const nextCharacterId = chatParticipantIds(created, sourceParticipants)[0];
        if (nextCharacterId) {
          setActiveCharacterId(nextCharacterId);
        }
        await refreshChats(created.id);
        setNotice({ kind: "info", message: "Branch chat created." });
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      } finally {
        setMessageActionBusyId(null);
      }
    },
    [
      activeChat,
      messagesByChat,
      participantsByChat,
      refreshChats,
      setActiveCharacterId,
      setActiveChatId,
      setChats,
      setMessageActionBusyId,
      setMessagesByChat,
      setNotice,
      setParticipantsByChat,
    ],
  );

  const exportChat = useCallback(async () => {
    if (!activeChat) {
      return;
    }
    const history = messagesByChat[activeChat.id] ?? [];
    if (history.length === 0) {
      setNotice({ kind: "error", message: "No messages to export." });
      return;
    }
    const exportedAt = new Date().toISOString();
    const timestamp = exportedAt.replace(/[:.]/g, "-");
    const slug = buildExportSlug(activeChat.title);
    const participantNames = chatParticipantIds(
      activeChat,
      participantsByChat[activeChat.id],
    )
      .map((id) => charMap.get(id)?.name)
      .filter((name): name is string => Boolean(name));

    const exportPayload = {
      exportedAt,
      chat: activeChat,
      participants: participantNames,
      userProfile: userProfile ?? null,
      relationshipState: activeRelationshipState ?? null,
      messages: history,
    };
    const markdownLines: string[] = [
      `# ${activeChat.title}`,
      "",
      `Exported: ${exportedAt}`,
      `Mode: ${activeChat.chatMode}`,
      `Participants: ${participantNames.join(", ") || "Unknown"}`,
      `User profile: ${userProfile?.name ?? "Unset"}`,
      `Relationship state: ${activeRelationshipState?.summary || "None"}`,
      "",
      "## Messages",
      "",
    ];
    for (const message of history) {
      const speakerName =
        message.role === "user"
          ? "You"
          : textOr(
              message.speakerCharacterId
                ? charMap.get(message.speakerCharacterId)?.name
                : activeCharacter?.name,
              "Assistant",
            );
      markdownLines.push(`### ${speakerName} (${message.role})`);
      markdownLines.push(`${message.createdAt}`);
      markdownLines.push("");
      markdownLines.push(message.content);
      markdownLines.push("");
    }

    downloadTextFile(
      `${slug}-${timestamp}.json`,
      JSON.stringify(exportPayload, null, 2),
      "application/json;charset=utf-8",
    );
    downloadTextFile(
      `${slug}-${timestamp}.md`,
      markdownLines.join("\n"),
      "text/markdown;charset=utf-8",
    );
    setNotice({ kind: "info", message: "Chat transcript exported (JSON + Markdown)." });
  }, [
    activeCharacter?.name,
    activeChat,
    activeRelationshipState,
    charMap,
    messagesByChat,
    participantsByChat,
    setNotice,
    userProfile,
  ]);

  const stopGeneration = useCallback(() => {
    if (!activeChatId) {
      return;
    }
    generationAbortByChatRef.current[activeChatId]?.abort();
  }, [activeChatId]);

  return {
    activeChat,
    activeCharacter,
    activeParticipants,
    activeModel,
    activeMemory,
    activeGenerationPreset,
    activeRelationshipState,
    samplingTemperature,
    samplingTopP,
    samplingMaxTokens,
    samplingRepeatPenalty,
    createDirectChat,
    createGroup,
    updateGroup,
    sendMessage,
    startEditUserMessage,
    cancelEditUserMessage: cancelEditMessage,
    saveEditedUserMessage,
    regenerateAssistantMessage,
    branchFromMessage,
    exportChat,
    stopGeneration,
    cancelChatWork,
    refreshChats,
    userProfile,
  };
}
