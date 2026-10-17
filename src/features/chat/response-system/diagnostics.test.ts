import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RESPONSE_DIAGNOSTICS_LOG_LABEL,
  buildResponseDiagnosticsInspection,
  createResponseDiagnostics,
  getResponseDiagnosticsStore,
  resetResponseDiagnosticsStoreForTest,
} from "./diagnostics";
import type { PreparedResponseRequest } from "./types";

const longSystemContract =
  `Core contract: ${"Stay in character. ".repeat(260)}`.trim();

function makePreparedResponse(): PreparedResponseRequest {
  return {
    context: {
      mode: "group",
      speaker: { id: "pooja", name: "Pooja" },
      userProfile: { name: "Aarav" },
      participantNames: ["Pooja", "Yulian", "Lara"],
      participantDirectory: {
        pooja: "Pooja",
        yulian: "Yulian",
        lara: "Lara",
      },
      latestUserMessage: "How about you and I go to the next room Pooja?",
      relationshipState: {
        summary: "The group is playing Monopoly in Pooja's room.",
        currentScene: "We are all gathered in Pooja's room and playing monopoly.",
      },
    },
    sceneState: {
      currentScene: "We are all gathered in Pooja's room and playing monopoly.",
    },
    turnFrame: {
      latestUserMessage: "How about you and I go to the next room Pooja?",
      addressedParticipants: ["Pooja"],
      userAction: "request",
      topic: "private time",
      concreteChoice: null,
      boundaryCue: false,
      stopInstruction: null,
      sceneAssertion: null,
      sceneTransition: null,
      visibleSearchCue: false,
      locationTarget: null,
      emotionalTone: "provocative",
      liveActionCueTokens: ["private", "pooja"],
      responseObligation: "answer_direct_address",
    },
    responsePlan: {
      mustAcknowledge: ["The user directly addressed Pooja."],
      mustAvoid: ["Do not call the user Yulian."],
      sceneAnchor: "Pooja's room",
      personaAnchor: "Warm and socially quick.",
      groupObligation: "Answer as the addressee.",
      outputContract: "One in-character reply only.",
    },
    salienceProfile: {
      latestUserMoveWeight: 1,
      liveSceneWeight: 0.9,
      relationshipWeight: 0.3,
      userProfileWeight: 0.2,
      recentTurnWeight: 0.5,
      memoryWeight: 0.2,
      contextWeight: 0.2,
      characterLoreWeight: 0.4,
      suppressStaticScenario: true,
      prioritizeRelationshipTone: true,
      rankedFocus: [{ key: "latest_user_move", weight: 1 }],
    },
    groupRoundState: {
      rosterOrder: ["Pooja", "Yulian", "Lara"],
      priorReplies: [
        {
          speakerCharacterId: "lara",
          speakerName: "Lara",
          gist: "Lara suggests keeping the group comfortable.",
          socialEffect: "sets a cautious tone",
          emotionalTone: "careful",
        },
      ],
      addressedParticipants: ["Pooja"],
      latestUserSocialTone: "provocative",
      currentSpeakerRole: "directly_addressed",
      currentTopicLabel: "private time",
      currentTopicCueTokens: ["private", "pooja"],
      currentSocialBeat: "The user is teasing Pooja while everyone is in the room.",
      expectedSocialMove: "Pooja should answer as the addressee without speaking for the user.",
      engagementExpectation: "required",
      engagementTargets: ["Lara"],
      engagementCueTokens: ["comfortable"],
      currentSpeakerObligations: ["Answer the direct address."],
    },
    reactionPlan: {
      strategy: "v2",
      immediateObjective: "Answer Pooja's direct-address social beat.",
      primaryGoal: "Stay in character and respond to the provocative ask.",
      responseStrategy: "Short, socially aware answer.",
      interactionStance: "present",
      emotionalPosture: "playful but bounded",
      sceneFocus: "Monopoly group in Pooja's room",
      replyOpening: "Oh?",
      salientFacts: ["The room is a group setting."],
      continuityAnchors: ["Monopoly game"],
      mustAddress: ["Pooja was named directly."],
      styleAnchors: ["short"],
      forbiddenMoves: ["Do not call the user Yulian."],
    },
    memorySelection: {
      contextEntries: [
        {
          id: "ctx-1",
          scope: "character",
          characterId: "pooja",
          title: "Pooja room etiquette",
          keywords: ["room", "group", "privacy"],
          content: "Pooja prefers playful but clear group boundaries.",
          enabled: true,
          createdAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        },
      ],
      semanticMemorySnippets: [
        {
          chatId: "chat-1",
          messageId: "m-1",
          role: "assistant",
          content: "Lara kept the room calm earlier.",
          speakerCharacterId: "lara",
          createdAt: "2000-01-01T00:00:00.000Z",
          score: 0.78,
        },
      ],
      retrievalHints: "Pooja group direct address private room",
    },
    compiledPrompt: {
      systemSections: [
        { key: "system_contract", priority: 100, content: longSystemContract },
        {
          key: "group_round_state",
          priority: 95,
          content: "Current speaker role: directly_addressed",
        },
      ],
      systemPromptMaxLength: 8000,
      exampleMessages: [],
      historyMessages: [{ role: "user", content: "How about the next room Pooja?" }],
    },
    runtimeRequest: {
      model: "local-model",
      stream: true,
      temperature: 0.8,
      top_p: 0.92,
      max_tokens: 384,
      repeat_penalty: 1.05,
      stop: ["\nUser:"],
      messages: [
        { role: "system", content: longSystemContract },
        { role: "user", content: "How about the next room Pooja?" },
      ],
    },
  } as unknown as PreparedResponseRequest;
}

describe("response diagnostics", () => {
  afterEach(() => {
    resetResponseDiagnosticsStoreForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("flushes local response diagnostics with bounded prompt inspection", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const diagnostics = createResponseDiagnostics({
      chatId: "chat-1",
      speakerCharacterId: "pooja",
      speakerName: "Pooja",
      mode: "group",
      groupTurn: {
        turnIndex: 1,
        turnCount: 3,
        speakerIdOrder: ["pooja", "yulian", "lara"],
        speakerNameOrder: ["Pooja", "Yulian", "Lara"],
      },
      runtime: {
        endpoint: "http://127.0.0.1:8080/v1/chat/completions",
        model: "local-model",
      },
    });

    diagnostics.recordRuntimeRequest({
      stream: true,
      messageCount: 3,
      maxTokens: 384,
      temperature: 0.8,
    });
    diagnostics.recordInspection(
      buildResponseDiagnosticsInspection(makePreparedResponse()),
    );
    diagnostics.recordTiming("prepare", 4.4);
    diagnostics.recordRawOutput("Put your hands up. Do not move.");
    diagnostics.recordSanitizedOutput("Put your hands up. Do not move.");
    diagnostics.recordInitialValidation({
      reasons: ["user_echo"],
      qualityScore: 0.1,
    });
    diagnostics.startRepairAttempt("policy").finish({
      rawOutput: "I'm lifting my hands.",
      sanitizedOutput: "I'm lifting my hands.",
      reasons: [],
      accepted: true,
    });
    diagnostics.recordFinalEvaluation({
      accepted: true,
      repaired: true,
      retryRequested: true,
      qualityScore: 1,
      reasons: ["user_echo", "policy_retry_requested", "repair_applied"],
      rawReply: "Put your hands up. Do not move.",
      finalReply: "I'm lifting my hands.",
    });

    diagnostics.flush();

    const latest = getResponseDiagnosticsStore().latest;
    diagnostics.recordInspection(
      buildResponseDiagnosticsInspection({
        ...makePreparedResponse(),
        runtimeRequest: {
          ...makePreparedResponse().runtimeRequest,
          messages: [{ role: "user", content: "mutated after flush" }],
        },
      }),
    );
    expect(latest).toMatchObject({
      chatId: "chat-1",
      speakerName: "Pooja",
      groupTurn: {
        turnIndex: 1,
        turnCount: 3,
        speakerNameOrder: ["Pooja", "Yulian", "Lara"],
      },
      output: {
        raw: "Put your hands up. Do not move.",
        sanitized: "Put your hands up. Do not move.",
        final: "I'm lifting my hands.",
      },
      validation: {
        finalReasons: ["user_echo", "policy_retry_requested", "repair_applied"],
        accepted: true,
        repaired: true,
      },
      runtime: {
        messageCount: 3,
        maxTokens: 384,
      },
    });
    expect(latest?.inspection?.context.latestUserMessage?.content).toContain(
      "next room Pooja",
    );
    expect(latest?.inspection?.turnFrame?.addressedParticipants).toEqual([
      "Pooja",
    ]);
    expect(latest?.inspection?.groupRoundState).toMatchObject({
      currentSpeakerRole: "directly_addressed",
      latestUserSocialTone: "provocative",
      priorReplyCount: 1,
    });
    expect(latest?.inspection?.memory.contextEntryCount).toBe(1);
    expect(latest?.inspection?.memory.semanticMemorySnippetCount).toBe(1);
    expect(latest?.inspection?.prompt.systemSections[0]).toMatchObject({
      key: "system_contract",
      priority: 100,
      charCount: longSystemContract.length,
      clipped: true,
    });
    expect(latest?.inspection?.prompt.systemSections[0]?.content.length).toBe(
      4000,
    );
    expect(latest?.inspection?.prompt.runtimeMessages[0]).toMatchObject({
      index: 0,
      role: "system",
      clipped: true,
    });
    expect(latest?.inspection?.prompt.endsWithUserTurn).toBe(true);
    expect(getResponseDiagnosticsStore().latest?.inspection?.prompt.runtimeMessages[1]?.content).toBe(
      "How about the next room Pooja?",
    );
    expect(latest?.repairAttempts[0]).toMatchObject({
      kind: "policy",
      rawOutput: "I'm lifting my hands.",
      sanitizedOutput: "I'm lifting my hands.",
      accepted: true,
    });
    expect((latest?.runtime as Record<string, unknown>).messages).toBeUndefined();
    expect(JSON.stringify(latest?.runtime)).not.toContain("Core contract");
    expect(JSON.stringify(latest?.inspection)).toContain("Core contract");
    expect(debug).not.toHaveBeenCalled();
  });

  it("logs sensitive response details only after explicit console opt-in", () => {
    vi.stubEnv("VITE_GLEE_RESPONSE_DIAGNOSTICS_CONSOLE", "1");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const diagnostics = createResponseDiagnostics({
      chatId: "chat-opt-in",
      runtime: { model: "local-model" },
    });

    diagnostics.recordRawOutput("private response text");
    diagnostics.flush();

    expect(debug).toHaveBeenCalledWith(
      RESPONSE_DIAGNOSTICS_LOG_LABEL,
      expect.objectContaining({ chatId: "chat-opt-in" }),
    );
  });

  it("records runtime failure reason and visible failure message", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const diagnostics = createResponseDiagnostics({
      chatId: "chat-1",
      runtime: { model: "local-model" },
    });

    diagnostics.recordFailure(
      "Failed to reach runtime endpoint",
      "[Glee reply failed] This reply could not be completed after an automatic retry. Select Regenerate to try again.",
    );
    diagnostics.flush();

    expect(getResponseDiagnosticsStore().latest?.runtime.failureReason).toBe(
      "Failed to reach runtime endpoint",
    );
    expect(getResponseDiagnosticsStore().latest?.output.failureMessage).toBe(
      "[Glee reply failed] This reply could not be completed after an automatic retry. Select Regenerate to try again.",
    );
  });
});
