import type { LlamaChatMessage } from "../../../types";
import type {
  PreparedResponseRequest,
  PromptSectionKey,
  ResponseEvaluation,
  ResponseEvaluationReason,
  TurnFrame,
} from "./types";

export const RESPONSE_DIAGNOSTICS_GLOBAL_KEY = "__GLEE_RESPONSE_DIAGNOSTICS__";
export const RESPONSE_DIAGNOSTICS_LOG_LABEL = "[Glee response diagnostics]";
export const RESPONSE_DIAGNOSTICS_LOG_PATH =
  "globalThis.__GLEE_RESPONSE_DIAGNOSTICS__";

const MAX_DIAGNOSTIC_ENTRIES = 25;
const MAX_INSPECTION_TEXT_LENGTH = 4000;
const MAX_INSPECTION_INLINE_TEXT_LENGTH = 1200;
const MAX_INSPECTION_LIST_ITEMS = 40;
const MAX_INSPECTION_CONTEXT_ITEMS = 12;

const RESPONSE_DIAGNOSTICS_CAPTURE_ENV =
  "VITE_GLEE_RESPONSE_DIAGNOSTICS";
const RESPONSE_DIAGNOSTICS_CONSOLE_ENV =
  "VITE_GLEE_RESPONSE_DIAGNOSTICS_CONSOLE";

type PreparedGroupRoundState = NonNullable<
  PreparedResponseRequest["groupRoundState"]
>;

export type ResponseDiagnosticsTimingName =
  | "prepare"
  | "time_to_first_token"
  | "runtime_stream"
  | "runtime_fallback"
  | "finalize"
  | "total";

export type ResponseDiagnosticsRepairKind = "policy" | "rescue";

export type ResponseDiagnosticsLifecycleStage =
  | "prepared"
  | "runtime_started"
  | "runtime_completed"
  | "finalized"
  | "append_started"
  | "persisted"
  | "failed";

export interface ResponseDiagnosticsRuntimeSummary {
  endpoint?: string;
  model?: string;
  stream?: boolean;
  messageCount?: number;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  repeatPenalty?: number;
  contextWindowTokens?: number;
  estimatedInputTokens?: number;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  streamFallbackUsed?: boolean;
  failureReason?: string;
}

export interface ResponseDiagnosticsRepairAttempt {
  index: number;
  kind: ResponseDiagnosticsRepairKind;
  startedAt: string;
  durationMs?: number;
  rawOutput?: string;
  sanitizedOutput?: string;
  reasons?: ResponseEvaluationReason[];
  accepted?: boolean;
  error?: string;
}

export interface ResponseDiagnosticsLifecycleEvent {
  stage: ResponseDiagnosticsLifecycleStage;
  at: string;
  detail?: string;
}

export interface ResponseDiagnosticsAppendResult {
  attempted: boolean;
  succeeded: boolean;
  messageId?: string;
  savedSpeakerCharacterId?: string;
  error?: string;
}

export interface ResponseDiagnosticsTextSample {
  content: string;
  charCount: number;
  clipped: boolean;
}

export interface ResponseDiagnosticsPromptSection {
  key: PromptSectionKey;
  priority: number;
  charCount: number;
  clipped: boolean;
  content: string;
}

export interface ResponseDiagnosticsRuntimeMessage {
  index: number;
  role: LlamaChatMessage["role"];
  charCount: number;
  clipped: boolean;
  content: string;
}

export interface ResponseDiagnosticsContextHit {
  id: string;
  scope: "global" | "character";
  characterId?: string;
  title: string;
  enabled: boolean;
  keywords: string[];
  content: ResponseDiagnosticsTextSample;
}

export interface ResponseDiagnosticsMemoryHit {
  messageId?: string;
  role: LlamaChatMessage["role"];
  speakerCharacterId?: string;
  createdAt: string;
  score: number;
  content: ResponseDiagnosticsTextSample;
}

export interface ResponseDiagnosticsGroupTurnSummary {
  turnIndex?: number;
  turnCount?: number;
  speakerIdOrder?: string[];
  speakerNameOrder?: string[];
}

export interface ResponseDiagnosticsInspection {
  context: {
    mode: PreparedResponseRequest["context"]["mode"];
    speakerName?: string;
    speakerCharacterId?: string;
    userName?: string;
    participantNames: string[];
    participantDirectory?: Record<string, string>;
    latestUserMessage?: ResponseDiagnosticsTextSample;
    scene?: ResponseDiagnosticsTextSample;
    relationshipSummary?: ResponseDiagnosticsTextSample;
  };
  turnFrame: Pick<
    TurnFrame,
    | "addressedParticipants"
    | "userAction"
    | "topic"
    | "concreteChoice"
    | "boundaryCue"
    | "stopInstruction"
    | "sceneAssertion"
    | "sceneTransition"
    | "visibleSearchCue"
    | "locationTarget"
    | "emotionalTone"
    | "liveActionCueTokens"
    | "responseObligation"
  > | null;
  groupRoundState: {
    rosterOrder: string[];
    priorReplyCount: number;
    priorReplies: PreparedGroupRoundState["priorReplies"];
    addressedParticipants: string[];
    latestUserSocialTone: PreparedGroupRoundState["latestUserSocialTone"];
    currentSpeakerRole: PreparedGroupRoundState["currentSpeakerRole"];
    currentTopicLabel: string;
    currentSocialBeat: ResponseDiagnosticsTextSample;
    expectedSocialMove: ResponseDiagnosticsTextSample;
    engagementExpectation: PreparedGroupRoundState["engagementExpectation"];
    engagementTargets: string[];
    engagementCueTokens: string[];
    currentSpeakerObligations: string[];
  } | null;
  responsePlan: PreparedResponseRequest["responsePlan"];
  reactionPlan: Pick<
    PreparedResponseRequest["reactionPlan"],
    | "immediateObjective"
    | "primaryGoal"
    | "responseStrategy"
    | "interactionStance"
    | "emotionalPosture"
    | "sceneFocus"
    | "replyOpening"
    | "salientFacts"
    | "continuityAnchors"
    | "mustAddress"
    | "styleAnchors"
    | "forbiddenMoves"
  >;
  salienceProfile: PreparedResponseRequest["salienceProfile"];
  memory: {
    contextEntryCount: number;
    omittedContextEntryCount: number;
    contextEntries: ResponseDiagnosticsContextHit[];
    semanticMemorySnippetCount: number;
    omittedSemanticMemorySnippetCount: number;
    semanticMemorySnippets: ResponseDiagnosticsMemoryHit[];
    retrievalHints?: ResponseDiagnosticsTextSample;
  };
  prompt: {
    systemSectionCount: number;
    omittedSystemSectionCount: number;
    systemPromptMaxLength?: number;
    systemSections: ResponseDiagnosticsPromptSection[];
    exampleMessageCount: number;
    historyMessageCount: number;
    runtimeMessageCount: number;
    omittedRuntimeMessageCount: number;
    runtimeMessages: ResponseDiagnosticsRuntimeMessage[];
    finalMessageRole?: LlamaChatMessage["role"];
    endsWithUserTurn: boolean;
    stopSequenceCount: number;
  };
}

export interface ResponseDiagnosticsEntry {
  id: string;
  logPath: string;
  startedAt: string;
  finishedAt?: string;
  chatId?: string;
  speakerCharacterId?: string;
  speakerName?: string;
  mode?: "single" | "group";
  groupTurn?: ResponseDiagnosticsGroupTurnSummary;
  runtime: ResponseDiagnosticsRuntimeSummary;
  inspection?: ResponseDiagnosticsInspection;
  lifecycle: {
    latestStage?: ResponseDiagnosticsLifecycleStage;
    events: ResponseDiagnosticsLifecycleEvent[];
    append?: ResponseDiagnosticsAppendResult;
  };
  timingsMs: Partial<Record<ResponseDiagnosticsTimingName, number>>;
  output: {
    raw?: string;
    sanitized?: string;
    final?: string;
    failureMessage?: string;
  };
  validation: {
    initialReasons?: ResponseEvaluationReason[];
    finalReasons?: ResponseEvaluationReason[];
    accepted?: boolean;
    repaired?: boolean;
    retryRequested?: boolean;
    qualityScore?: number;
  };
  repairAttempts: ResponseDiagnosticsRepairAttempt[];
}

export interface ResponseDiagnosticsStore {
  entries: ResponseDiagnosticsEntry[];
  latest?: ResponseDiagnosticsEntry;
}

export interface ResponseDiagnosticsRecorder {
  readonly entry: ResponseDiagnosticsEntry;
  recordRuntimeRequest(summary: ResponseDiagnosticsRuntimeSummary): void;
  recordInspection(inspection: ResponseDiagnosticsInspection): void;
  recordLifecycle(stage: ResponseDiagnosticsLifecycleStage, detail?: string): void;
  recordAppendResult(result: ResponseDiagnosticsAppendResult): void;
  recordTiming(name: ResponseDiagnosticsTimingName, durationMs: number): void;
  recordRawOutput(rawOutput: string): void;
  recordSanitizedOutput(sanitizedOutput: string): void;
  recordInitialValidation(input: {
    reasons: ResponseEvaluationReason[];
    qualityScore: number;
  }): void;
  recordFinalEvaluation(evaluation: ResponseEvaluation): void;
  recordFailure(reason: string, failureMessage?: string): void;
  startRepairAttempt(
    kind: ResponseDiagnosticsRepairKind,
  ): {
    finish(result: {
      rawOutput?: string;
      sanitizedOutput?: string;
      reasons?: ResponseEvaluationReason[];
      accepted?: boolean;
      error?: string;
    }): void;
  };
  flush(): void;
}

type DiagnosticsGlobal = typeof globalThis & {
  __GLEE_RESPONSE_DIAGNOSTICS__?: ResponseDiagnosticsStore;
};

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Math.round(nowMs() - startedAtMs));
}

function cloneDiagnosticValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedText(
  value: string | undefined,
  maxLength = MAX_INSPECTION_TEXT_LENGTH,
): ResponseDiagnosticsTextSample | undefined {
  const content = value?.trim() ?? "";
  if (!content) {
    return undefined;
  }
  return {
    content: content.slice(0, maxLength),
    charCount: content.length,
    clipped: content.length > maxLength,
  };
}

function requiredBoundedText(
  value: string | undefined,
  maxLength = MAX_INSPECTION_TEXT_LENGTH,
): ResponseDiagnosticsTextSample {
  return (
    boundedText(value, maxLength) ?? {
      content: "",
      charCount: 0,
      clipped: false,
    }
  );
}

function inspectRuntimeMessages(
  messages: LlamaChatMessage[],
): {
  messages: ResponseDiagnosticsRuntimeMessage[];
  omittedCount: number;
} {
  const indexedMessages = messages.map((message, index) => ({ message, index }));
  const selected =
    indexedMessages.length <= MAX_INSPECTION_LIST_ITEMS
      ? indexedMessages
      : [
          ...indexedMessages.slice(0, Math.ceil(MAX_INSPECTION_LIST_ITEMS / 2)),
          ...indexedMessages.slice(
            indexedMessages.length - Math.floor(MAX_INSPECTION_LIST_ITEMS / 2),
          ),
        ];

  return {
    messages: selected.map(({ message, index }) => {
      const sample = requiredBoundedText(message.content);
      return {
        index,
        role: message.role,
        charCount: sample.charCount,
        clipped: sample.clipped,
        content: sample.content,
      };
    }),
    omittedCount: Math.max(0, messages.length - selected.length),
  };
}

export function buildResponseDiagnosticsInspection(
  prepared: PreparedResponseRequest,
): ResponseDiagnosticsInspection {
  const contextEntries = prepared.memorySelection.contextEntries.slice(
    0,
    MAX_INSPECTION_CONTEXT_ITEMS,
  );
  const semanticMemorySnippets =
    prepared.memorySelection.semanticMemorySnippets.slice(
      0,
      MAX_INSPECTION_CONTEXT_ITEMS,
    );
  const systemSections = prepared.compiledPrompt.systemSections.slice(
    0,
    MAX_INSPECTION_LIST_ITEMS,
  );
  const inspectedRuntimeMessages = inspectRuntimeMessages(
    prepared.runtimeRequest.messages,
  );

  return {
    context: {
      mode: prepared.context.mode,
      speakerName: prepared.context.speaker?.name,
      speakerCharacterId: prepared.context.speaker?.id,
      userName: prepared.context.userProfile?.name,
      participantNames: [...(prepared.context.participantNames ?? [])],
      participantDirectory: prepared.context.participantDirectory
        ? { ...prepared.context.participantDirectory }
        : undefined,
      latestUserMessage: boundedText(prepared.context.latestUserMessage),
      scene: boundedText(
        prepared.sceneState?.currentScene ??
          prepared.context.relationshipState?.currentScene,
      ),
      relationshipSummary: boundedText(
        prepared.context.relationshipState?.summary,
        MAX_INSPECTION_INLINE_TEXT_LENGTH,
      ),
    },
    turnFrame: prepared.turnFrame
      ? {
          addressedParticipants: [...prepared.turnFrame.addressedParticipants],
          userAction: prepared.turnFrame.userAction,
          topic: prepared.turnFrame.topic,
          concreteChoice: prepared.turnFrame.concreteChoice,
          boundaryCue: prepared.turnFrame.boundaryCue,
          stopInstruction: prepared.turnFrame.stopInstruction,
          sceneAssertion: prepared.turnFrame.sceneAssertion,
          sceneTransition: prepared.turnFrame.sceneTransition,
          visibleSearchCue: prepared.turnFrame.visibleSearchCue,
          locationTarget: prepared.turnFrame.locationTarget,
          emotionalTone: prepared.turnFrame.emotionalTone,
          liveActionCueTokens: [...prepared.turnFrame.liveActionCueTokens],
          responseObligation: prepared.turnFrame.responseObligation,
        }
      : null,
    groupRoundState: prepared.groupRoundState
      ? {
          rosterOrder: [...prepared.groupRoundState.rosterOrder],
          priorReplyCount: prepared.groupRoundState.priorReplies.length,
          priorReplies: prepared.groupRoundState.priorReplies.map((reply) => ({
            ...reply,
          })),
          addressedParticipants: [
            ...prepared.groupRoundState.addressedParticipants,
          ],
          latestUserSocialTone: prepared.groupRoundState.latestUserSocialTone,
          currentSpeakerRole: prepared.groupRoundState.currentSpeakerRole,
          currentTopicLabel: prepared.groupRoundState.currentTopicLabel,
          currentSocialBeat: requiredBoundedText(
            prepared.groupRoundState.currentSocialBeat,
            MAX_INSPECTION_INLINE_TEXT_LENGTH,
          ),
          expectedSocialMove: requiredBoundedText(
            prepared.groupRoundState.expectedSocialMove,
            MAX_INSPECTION_INLINE_TEXT_LENGTH,
          ),
          engagementExpectation:
            prepared.groupRoundState.engagementExpectation,
          engagementTargets: [...prepared.groupRoundState.engagementTargets],
          engagementCueTokens: [
            ...prepared.groupRoundState.engagementCueTokens,
          ],
          currentSpeakerObligations: [
            ...prepared.groupRoundState.currentSpeakerObligations,
          ],
        }
      : null,
    responsePlan: prepared.responsePlan
      ? {
          ...prepared.responsePlan,
          mustAcknowledge: [...prepared.responsePlan.mustAcknowledge],
          mustAvoid: [...prepared.responsePlan.mustAvoid],
        }
      : null,
    reactionPlan: {
      immediateObjective: prepared.reactionPlan.immediateObjective,
      primaryGoal: prepared.reactionPlan.primaryGoal,
      responseStrategy: prepared.reactionPlan.responseStrategy,
      interactionStance: prepared.reactionPlan.interactionStance,
      emotionalPosture: prepared.reactionPlan.emotionalPosture,
      sceneFocus: prepared.reactionPlan.sceneFocus,
      replyOpening: prepared.reactionPlan.replyOpening,
      salientFacts: [...prepared.reactionPlan.salientFacts],
      continuityAnchors: [...prepared.reactionPlan.continuityAnchors],
      mustAddress: [...prepared.reactionPlan.mustAddress],
      styleAnchors: [...prepared.reactionPlan.styleAnchors],
      forbiddenMoves: [...prepared.reactionPlan.forbiddenMoves],
    },
    salienceProfile: {
      ...prepared.salienceProfile,
      rankedFocus: prepared.salienceProfile.rankedFocus.map((focus) => ({
        ...focus,
      })),
    },
    memory: {
      contextEntryCount: prepared.memorySelection.contextEntries.length,
      omittedContextEntryCount: Math.max(
        0,
        prepared.memorySelection.contextEntries.length - contextEntries.length,
      ),
      contextEntries: contextEntries.map((entry) => ({
        id: entry.id,
        scope: entry.scope,
        characterId: entry.characterId,
        title: entry.title,
        enabled: entry.enabled,
        keywords: entry.keywords.slice(0, 12),
        content: requiredBoundedText(
          entry.content,
          MAX_INSPECTION_INLINE_TEXT_LENGTH,
        ),
      })),
      semanticMemorySnippetCount:
        prepared.memorySelection.semanticMemorySnippets.length,
      omittedSemanticMemorySnippetCount: Math.max(
        0,
        prepared.memorySelection.semanticMemorySnippets.length -
          semanticMemorySnippets.length,
      ),
      semanticMemorySnippets: semanticMemorySnippets.map((snippet) => ({
        messageId: snippet.messageId,
        role: snippet.role,
        speakerCharacterId: snippet.speakerCharacterId,
        createdAt: snippet.createdAt,
        score: snippet.score,
        content: requiredBoundedText(
          snippet.content,
          MAX_INSPECTION_INLINE_TEXT_LENGTH,
        ),
      })),
      retrievalHints: boundedText(
        prepared.memorySelection.retrievalHints,
        MAX_INSPECTION_INLINE_TEXT_LENGTH,
      ),
    },
    prompt: {
      systemSectionCount: prepared.compiledPrompt.systemSections.length,
      omittedSystemSectionCount: Math.max(
        0,
        prepared.compiledPrompt.systemSections.length - systemSections.length,
      ),
      systemPromptMaxLength: prepared.compiledPrompt.systemPromptMaxLength,
      systemSections: systemSections.map((section) => {
        const sample = requiredBoundedText(section.content);
        return {
          key: section.key,
          priority: section.priority,
          charCount: sample.charCount,
          clipped: sample.clipped,
          content: sample.content,
        };
      }),
      exampleMessageCount: prepared.compiledPrompt.exampleMessages.length,
      historyMessageCount: prepared.compiledPrompt.historyMessages.length,
      runtimeMessageCount: prepared.runtimeRequest.messages.length,
      omittedRuntimeMessageCount: inspectedRuntimeMessages.omittedCount,
      runtimeMessages: inspectedRuntimeMessages.messages,
      finalMessageRole:
        prepared.runtimeRequest.messages[prepared.runtimeRequest.messages.length - 1]
          ?.role,
      endsWithUserTurn:
        prepared.runtimeRequest.messages[prepared.runtimeRequest.messages.length - 1]
          ?.role === "user",
      stopSequenceCount: prepared.runtimeRequest.stop?.length ?? 0,
    },
  };
}

function makeDiagnosticId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `response-${Date.now().toString(36)}-${random}`;
}

function pushLifecycleEvent(
  entry: ResponseDiagnosticsEntry,
  stage: ResponseDiagnosticsLifecycleStage,
  detail?: string,
): void {
  entry.lifecycle.latestStage = stage;
  entry.lifecycle.events.push({
    stage,
    at: new Date().toISOString(),
    detail,
  });
}

function cloneEntry(entry: ResponseDiagnosticsEntry): ResponseDiagnosticsEntry {
  return {
    ...entry,
    runtime: { ...entry.runtime },
    groupTurn: entry.groupTurn
      ? {
          ...entry.groupTurn,
          speakerIdOrder: entry.groupTurn.speakerIdOrder
            ? [...entry.groupTurn.speakerIdOrder]
            : undefined,
          speakerNameOrder: entry.groupTurn.speakerNameOrder
            ? [...entry.groupTurn.speakerNameOrder]
            : undefined,
        }
      : undefined,
    inspection: entry.inspection
      ? cloneDiagnosticValue(entry.inspection)
      : undefined,
    lifecycle: {
      latestStage: entry.lifecycle.latestStage,
      events: entry.lifecycle.events.map((event) => ({ ...event })),
      append: entry.lifecycle.append
        ? { ...entry.lifecycle.append }
        : undefined,
    },
    timingsMs: { ...entry.timingsMs },
    output: { ...entry.output },
    validation: {
      ...entry.validation,
      initialReasons: entry.validation.initialReasons
        ? [...entry.validation.initialReasons]
        : undefined,
      finalReasons: entry.validation.finalReasons
        ? [...entry.validation.finalReasons]
        : undefined,
    },
    repairAttempts: entry.repairAttempts.map((attempt) => ({
      ...attempt,
      reasons: attempt.reasons ? [...attempt.reasons] : undefined,
    })),
  };
}

function diagnosticsGlobal(): DiagnosticsGlobal {
  return globalThis as DiagnosticsGlobal;
}

function diagnosticsEnvironmentFlag(name: string): boolean {
  const value = (import.meta.env as Record<string, unknown>)[name];
  return value === true || value === "1" || value === "true";
}

function shouldCaptureResponseDiagnostics(): boolean {
  return (
    import.meta.env.MODE === "test" ||
    diagnosticsEnvironmentFlag(RESPONSE_DIAGNOSTICS_CAPTURE_ENV)
  );
}

function shouldLogResponseDiagnostics(): boolean {
  return diagnosticsEnvironmentFlag(RESPONSE_DIAGNOSTICS_CONSOLE_ENV);
}

export function getResponseDiagnosticsStore(): ResponseDiagnosticsStore {
  const target = diagnosticsGlobal();
  target.__GLEE_RESPONSE_DIAGNOSTICS__ ??= { entries: [] };
  return target.__GLEE_RESPONSE_DIAGNOSTICS__;
}

export function resetResponseDiagnosticsStoreForTest(): void {
  delete diagnosticsGlobal().__GLEE_RESPONSE_DIAGNOSTICS__;
}

export function formatResponseDiagnosticError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function createResponseDiagnostics(input: {
  chatId?: string;
  speakerCharacterId?: string;
  speakerName?: string;
  mode?: "single" | "group";
  groupTurn?: ResponseDiagnosticsGroupTurnSummary;
  runtime?: ResponseDiagnosticsRuntimeSummary;
}): ResponseDiagnosticsRecorder {
  const startedAtMs = nowMs();
  let flushed = false;
  const entry: ResponseDiagnosticsEntry = {
    id: makeDiagnosticId(),
    logPath: RESPONSE_DIAGNOSTICS_LOG_PATH,
    startedAt: new Date().toISOString(),
    chatId: input.chatId,
    speakerCharacterId: input.speakerCharacterId,
    speakerName: input.speakerName,
    mode: input.mode,
    groupTurn: input.groupTurn
      ? {
          ...input.groupTurn,
          speakerIdOrder: input.groupTurn.speakerIdOrder
            ? [...input.groupTurn.speakerIdOrder]
            : undefined,
          speakerNameOrder: input.groupTurn.speakerNameOrder
            ? [...input.groupTurn.speakerNameOrder]
            : undefined,
        }
      : undefined,
    runtime: { ...input.runtime },
    lifecycle: { events: [] },
    timingsMs: {},
    output: {},
    validation: {},
    repairAttempts: [],
  };

  const recorder: ResponseDiagnosticsRecorder = {
    entry,
    recordRuntimeRequest(summary) {
      entry.runtime = {
        ...entry.runtime,
        ...summary,
      };
    },
    recordInspection(inspection) {
      entry.inspection = cloneDiagnosticValue(inspection);
    },
    recordLifecycle(stage, detail) {
      pushLifecycleEvent(entry, stage, detail);
    },
    recordAppendResult(result) {
      entry.lifecycle.append = { ...result };
      pushLifecycleEvent(
        entry,
        result.succeeded ? "persisted" : "failed",
        result.succeeded ? result.messageId : result.error,
      );
    },
    recordTiming(name, durationMs) {
      entry.timingsMs[name] = Math.max(0, Math.round(durationMs));
    },
    recordRawOutput(rawOutput) {
      entry.output.raw = rawOutput;
    },
    recordSanitizedOutput(sanitizedOutput) {
      entry.output.sanitized = sanitizedOutput;
    },
    recordInitialValidation(input) {
      entry.validation.initialReasons = [...input.reasons];
      entry.validation.qualityScore = input.qualityScore;
    },
    recordFinalEvaluation(evaluation) {
      entry.validation.finalReasons = [...evaluation.reasons];
      entry.validation.accepted = evaluation.accepted;
      entry.validation.repaired = evaluation.repaired;
      entry.validation.retryRequested = evaluation.retryRequested;
      entry.validation.qualityScore = evaluation.qualityScore;
      entry.output.final = evaluation.finalReply;
    },
    recordFailure(reason, failureMessage) {
      entry.runtime.failureReason = reason;
      if (failureMessage) {
        entry.output.failureMessage = failureMessage;
      }
      pushLifecycleEvent(entry, "failed", reason);
    },
    startRepairAttempt(kind) {
      const attemptStartedAtMs = nowMs();
      const attempt: ResponseDiagnosticsRepairAttempt = {
        index: entry.repairAttempts.length + 1,
        kind,
        startedAt: new Date().toISOString(),
      };
      entry.repairAttempts.push(attempt);

      return {
        finish(result) {
          attempt.durationMs = elapsedMs(attemptStartedAtMs);
          attempt.rawOutput = result.rawOutput;
          attempt.sanitizedOutput = result.sanitizedOutput;
          attempt.reasons = result.reasons ? [...result.reasons] : undefined;
          attempt.accepted = result.accepted;
          attempt.error = result.error;
        },
      };
    },
    flush() {
      if (flushed) {
        return;
      }
      flushed = true;
      entry.finishedAt = new Date().toISOString();
      entry.timingsMs.total ??= elapsedMs(startedAtMs);

      const captureEnabled = shouldCaptureResponseDiagnostics();
      const consoleEnabled = shouldLogResponseDiagnostics();
      if (!captureEnabled && !consoleEnabled) {
        return;
      }

      const snapshot = cloneEntry(entry);
      if (captureEnabled) {
        const store = getResponseDiagnosticsStore();
        store.latest = snapshot;
        store.entries = [...store.entries, snapshot].slice(-MAX_DIAGNOSTIC_ENTRIES);
      }
      if (consoleEnabled) {
        console.debug(RESPONSE_DIAGNOSTICS_LOG_LABEL, snapshot);
      }
    },
  };

  return recorder;
}
