import { describe, expect, it, vi } from "vitest";

import { createResponseDiagnostics } from "./diagnostics";
import { buildStreamingPreview, finalizeResponseOutput } from "./finalize";
import type { PreparedResponseRequest } from "./types";

const baseSalienceProfile = {
  latestUserMoveWeight: 100,
  liveSceneWeight: 76,
  relationshipWeight: 38,
  userProfileWeight: 24,
  recentTurnWeight: 8,
  memoryWeight: 20,
  contextWeight: 18,
  characterLoreWeight: 44,
  suppressStaticScenario: false,
  prioritizeRelationshipTone: false,
  rankedFocus: [
    { key: "latest_user_move" as const, weight: 100 },
    { key: "live_scene" as const, weight: 76 },
    { key: "character_lore" as const, weight: 44 },
    { key: "relationship" as const, weight: 38 },
    { key: "user_profile" as const, weight: 24 },
    { key: "memory" as const, weight: 20 },
    { key: "world_context" as const, weight: 18 },
    { key: "recent_turn" as const, weight: 8 },
  ],
};

const prepared: PreparedResponseRequest = {
  context: {
    speaker: {
      id: "character-1",
      name: "Priyanka",
      description: "A flirt.",
      systemPrompt: "",
      greeting: "",
      exampleDialogue: "",
      tags: [],
      avatar: "",
      backstory: "",
      scenario: "",
      speechStyle: "",
      alternateGreetings: [],
      likes: [],
      dislikes: [],
      boundaries: "",
      creatorNotes: "",
      createdAt: "",
      updatedAt: "",
    },
    contextEntries: [],
    semanticMemorySnippets: [],
    history: [],
    latestUserMessage: "Put your hands up.",
      userProfile: {
        name: "Riley",
        about: "",
        gender: "",
        avatar: "",
        traits: [],
        preferences: "",
        boundaries: "",
      createdAt: "",
      updatedAt: "",
    },
    mode: "single",
    sceneState: null,
    turnInterpretation: null,
    groupRoundState: null,
  },
  sceneState: null,
  turnInterpretation: null,
  turnFrame: null,
  responsePlan: null,
  salienceProfile: baseSalienceProfile,
  groupRoundState: null,
  reactionPlan: {
    strategy: "v2",
    immediateObjective: "Respond directly",
    primaryGoal: "Show Priyanka's immediate choice in response to the user's move.",
    responseStrategy: "Stay in character",
    interactionStance: "Active and character-led.",
    emotionalPosture: "alert",
    sceneFocus: "the latest user action",
    replyOpening: "Open with Priyanka's immediate reaction.",
    salientFacts: ["Latest move intent: The user is issuing a command."],
    continuityAnchors: [],
    mustAddress: [],
    styleAnchors: [],
    forbiddenMoves: [],
  },
  memorySelection: {
    contextEntries: [],
    semanticMemorySnippets: [],
    retrievalHints: "",
  },
  compiledPrompt: {
    systemSections: [],
    exampleMessages: [],
    historyMessages: [],
  },
  runtimeRequest: {
    model: "test-model",
    messages: [],
    stream: true,
  },
};

describe("finalizeResponseOutput", () => {
  it("suppresses first-turn narrative-heavy streaming previews", () => {
    const preview = buildStreamingPreview(
      [
        "The golden-hour light drips across the university park like liquid amber, turning every leaf into a fleeting spark before the Tokyo night swallows it whole.",
        "",
        "I've claimed this weathered bench in the quiet corner again, laptop open, because the rest of campus is too loud to think.",
        "",
        "My fingers keep moving over the keys even while I watch you from the corner of my eye, half-daring you to interrupt and half-hoping you will anyway.",
        "",
        "The screen throws pale code-light across my knuckles while the city trains groan in the distance and the first neon signs start waking up beyond the trees.",
      ].join("\n"),
      {
        ...prepared,
        context: {
          ...prepared.context,
          speaker: {
            ...prepared.context.speaker!,
            name: "Yara",
          },
          history: [],
          latestUserMessage: "hi",
        },
      },
    );

    expect(preview).toBe("");
  });

  it("suppresses first-turn previews that echo the character description", () => {
    const description = [
      "Yara is a 22-year-old computer science major and reluctant yakuza heiress with a razor-sharp tsundere heart.",
      "She carries herself like campus royalty: jet-black ponytail streaked with electric blue highlights that match her terminal theme, golden-tanned skin that glows under any light, and a voluptuous hourglass figure that turns heads wherever she goes.",
      "Full-sleeve irezumi in vibrant dragons and koi coil down her arms and thighs—traditional marks of her family lineage that she wears with a mix of pride and quiet resentment.",
    ].join(" ");

    const preview = buildStreamingPreview(description, {
      ...prepared,
      context: {
        ...prepared.context,
        speaker: {
          ...prepared.context.speaker!,
          name: "Yara",
          description,
        },
        history: [],
        latestUserMessage: "hi",
      },
    });

    expect(preview).toBe("");
  });

  it("suppresses oversized first-turn previews even before validation settles", () => {
    const preview = buildStreamingPreview(
      "I can see you made it. " + "The cathedral bells shiver over the marble hall while incense curls through the air and candlelight glints across every gilded icon in sight. ".repeat(3),
      {
        ...prepared,
        context: {
          ...prepared.context,
          speaker: {
            ...prepared.context.speaker!,
            name: "Yulian",
          },
          history: [],
          latestUserMessage: "hi",
        },
      },
    );

    expect(preview).toBe("");
  });

  it("records repair success with policy reasons and repaired score", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValue("Easy. I'm lifting my hands, but keep that rifle steady.");

    const result = await finalizeResponseOutput({
      rawOutput: "Put your hands up. Do not move.",
      prepared,
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    expect(result.repaired).toBe(true);
    expect(result.retryRequested).toBe(true);
    expect(result.reasons).toContain("user_echo");
    expect(result.reasons).toContain("policy_retry_requested");
    expect(result.reasons).toContain("repair_applied");
    expect(result.finalReply).toContain("I'm lifting my hands");
    expect(result.qualityScore).toBe(1);
  });

  it("records local diagnostics for sanitize, validation, and repair results", async () => {
    const diagnostics = createResponseDiagnostics({
      chatId: "chat-1",
      speakerCharacterId: "character-1",
      speakerName: "Priyanka",
      mode: "single",
    });
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValue("Easy. I'm lifting my hands, but keep that rifle steady.");

    const result = await finalizeResponseOutput({
      rawOutput: "Put your hands up. Do not move.",
      prepared,
      repair,
      diagnostics,
    });

    expect(result.accepted).toBe(true);
    expect(diagnostics.entry.output.raw).toBe("Put your hands up. Do not move.");
    expect(diagnostics.entry.output.sanitized).toBe(
      "Put your hands up. Do not move.",
    );
    expect(diagnostics.entry.output.final).toContain("I'm lifting my hands");
    expect(diagnostics.entry.validation.initialReasons).toContain("user_echo");
    expect(diagnostics.entry.validation.finalReasons).toContain("repair_applied");
    expect(diagnostics.entry.repairAttempts).toHaveLength(1);
    expect(diagnostics.entry.repairAttempts[0]).toMatchObject({
      kind: "policy",
      rawOutput: "Easy. I'm lifting my hands, but keep that rifle steady.",
      sanitizedOutput: "Easy. I'm lifting my hands, but keep that rifle steady.",
      accepted: true,
    });
    expect(JSON.stringify(diagnostics.entry.repairAttempts[0])).not.toContain(
      "Repair requirements",
    );
  });

  it("falls back when sanitize removes everything", async () => {
    const result = await finalizeResponseOutput({
      rawOutput: "<thinking>Let me consider this</thinking>",
      prepared,
      fallbackReply: "Priyanka has no response yet.",
    });

    expect(result.accepted).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.retryRequested).toBe(true);
    expect(result.reasons).toContain("empty_after_sanitize");
    expect(result.reasons).toContain("fallback_used");
    expect(result.finalReply).toBe("Priyanka has no response yet.");
    expect(result.qualityScore).toBe(0);
  });

  it("preserves scaffold meta-reasoning when sanitize removes the visible output", async () => {
    const result = await finalizeResponseOutput({
      rawOutput: 'Previous group reply from Lara: "I am listening."',
      prepared,
      fallbackReply: "Priyanka has no response yet.",
    });

    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("meta_reasoning");
    expect(result.reasons).toContain("empty_after_sanitize");
    expect(result.reasons).toContain("fallback_used");
    expect(result.finalReply).toBe("Priyanka has no response yet.");
  });

  it("rejects the reply when repair still fails validation", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValue("I understand. How can I help you today?");

    const result = await finalizeResponseOutput({
      rawOutput: "Put your hands up. Do not move.",
      prepared,
      repair,
    });

    expect(result.accepted).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.retryRequested).toBe(true);
    expect(result.reasons).toContain("user_echo");
    expect(result.reasons).toContain("policy_retry_requested");
    expect(result.reasons).toContain("repair_failed");
    expect(result.finalReply).toBe("");
    expect(result.qualityScore).toBeLessThan(1);
  });

  it("keeps a safe cleaned single-chat draft when repair returns a worse invalid draft", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValue("I understand. How can I help you today?");

    const result = await finalizeResponseOutput({
      rawOutput:
        "She struggled against the user's grip, her face flushing red as she tried to break free.",
      prepared,
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    expect(result.accepted).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.reasons).toContain("generic_user_reference");
    expect(result.reasons).not.toContain("generic_assistant_drift");
    expect(result.reasons).toContain("repair_failed");
    expect(result.finalReply).toContain("user's grip");
  });

  it("rejects trivial fragment salvage after repair failure in group mode", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValue(new Error("repair timed out"));

    const result = await finalizeResponseOutput({
      rawOutput: "royalty",
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          mode: "group",
          latestUserMessage: "I think I am gonna order a steak",
          speaker: {
            ...prepared.context.speaker!,
            name: "Lara Lightland",
          },
          relationshipState: {
            chatId: "chat-1",
            summary: "Friendly",
            currentScene: "We are at a restaurant",
            interactionTone: "Friendly",
            characterState: "",
            userState: "",
            userRoleName: "",
            userRoleDescription: "",
            updatedAt: "",
          },
        },
      },
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("insufficient_substance");
    expect(result.reasons).toContain("repair_failed");
    expect(result.finalReply).toBe("");
  });

  it("keeps the original nonfatal reply when repair throws", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValue(new Error("repair timed out"));

    const result = await finalizeResponseOutput({
      rawOutput:
        "She struggled against the user's grip, her face flushing red as she tried to break free.",
      prepared,
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    expect(result.accepted).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.reasons).toContain("repair_failed");
    expect(result.reasons).toContain("generic_user_reference");
    expect(result.finalReply).toContain("user's grip");
  });

  it("keeps a repaired single-chat reply when only generic user reference remains", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValue(
        "I narrow my eyes at the user's demand, then ease my hands up an inch.",
      );

    const result = await finalizeResponseOutput({
      rawOutput: "Put your hands up. Do not move.",
      prepared,
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    expect(result.accepted).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.reasons).toContain("repair_applied");
    expect(result.reasons).toContain("user_echo");
    expect(result.reasons).toContain("generic_user_reference");
    expect(result.finalReply).toContain("user's demand");
  });

  it("salvages quoted dialogue from third-person group narration before dropping the turn", async () => {
    const result = await finalizeResponseOutput({
      rawOutput:
        'Yulian glances toward you, his expression unreadable. "I apologize for the intrusion, but I assure you it is out of genuine curiosity."',
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          mode: "group",
          latestUserMessage: "hello",
          speaker: {
            ...prepared.context.speaker!,
            name: "Yulian",
          },
        },
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.finalReply).toBe(
      '"I apologize for the intrusion, but I assure you it is out of genuine curiosity."',
    );
  });

  it("keeps a degraded group reply when only a soft miss remains after salvage", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValue(new Error("repair timed out"));

    const result = await finalizeResponseOutput({
      rawOutput:
        'Yulian glances toward you, his expression unreadable. "I apologize for the intrusion."',
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          mode: "group",
          latestUserMessage: "hello",
          speaker: {
            ...prepared.context.speaker!,
            name: "Yulian",
          },
        },
      },
      repair,
    });

    expect(repair).not.toHaveBeenCalled();
    expect(result.accepted).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.finalReply).toBe('"I apologize for the intrusion."');
  });

  it("rejects degraded group replies with lingering third-person self narration", async () => {
    const result = await finalizeResponseOutput({
      rawOutput:
        "Yulian glances toward you, his expression unreadable as Yulian's shoulders tense.",
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          mode: "group",
          latestUserMessage: "hello",
          speaker: {
            ...prepared.context.speaker!,
            name: "Yulian",
          },
        },
      },
    });

    expect(result.accepted).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.reasons).toContain("empty_after_sanitize");
    expect(result.retryRequested).toBe(true);
  });

  it("normalizes malformed group roleplay formatting before accepting the reply", async () => {
    const result = await finalizeResponseOutput({
      rawOutput: [
        "What should Priyanka do next? How can she interact with this scene and characters?</thinking><RESPONSE>Priyanka: She immediately gets up from her spot on the blanket, her long blonde hair flowing behind her. *",
        "",
        "Oh my gosh! A dolphin?! That is so amazing! Can we go over there and see it more closely? *Her face lights up with curiosity and enthusiasm as she stretches out her arm towards you.*",
        "",
        "*Her voice turns into a girly giggle, and she leans forward slightly on the blanket.*</RESPONSE>",
      ].join("\n"),
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          mode: "group",
          latestUserMessage: "Hey look over there, i see a dolphin *I say excitingly*",
          speaker: {
            ...prepared.context.speaker!,
            name: "Priyanka",
          },
          relationshipState: {
            chatId: "chat-1",
            summary: "Friendly",
            currentScene: "We are on a picnic, sitting at the beach.",
            interactionTone: "",
            characterState: "",
            userState: "",
            userRoleName: "",
            userRoleDescription: "",
            updatedAt: "",
          },
          userProfile: {
            name: "John Smith",
            about: "I am dressed like a medieval king. I have a longbow in my hand.",
            gender: "Man",
            avatar: "",
            traits: [],
            preferences: "",
            boundaries: "",
            createdAt: "",
            updatedAt: "",
          },
        },
        sceneState: {
          visibleFacts: [
            "Current live scene: We are on a picnic, sitting at the beach.",
            "Visible user-held object: longbow.",
          ],
          powerDynamic: "No obvious tactical advantage is established.",
          tension: "low",
          immediatePriority:
            "Acknowledge the user's visible excitement before drifting into unrelated character lore.",
        },
      },
    });

    expect(result.accepted).toBe(true);
    expect(result.finalReply).toContain("Oh my gosh! A dolphin?!");
    expect(result.finalReply).not.toContain("Priyanka:");
    expect(result.finalReply).not.toContain("* Oh my gosh!");
    expect(result.finalReply).toContain(
      "She immediately gets up from her spot on the blanket, her long blonde hair flowing behind her.",
    );
  });

  it("rejects the original reply after repair failure when the miss is scene-critical", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockRejectedValue(new Error("repair timed out"));

    const result = await finalizeResponseOutput({
      rawOutput:
        '"Ah, my King of the Stars," she said in a warm, welcoming tone. "Welcome to my little sanctuary on this far-off world."',
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          latestUserMessage: "so what are we doing here",
          mode: "group",
          userProfile: {
            name: "John Smith",
            about: "I am dressed like a medieval king. I have a longbow in my hand.",
            gender: "Man",
            avatar: "",
            traits: [],
            preferences: "",
            boundaries: "",
            createdAt: "",
            updatedAt: "",
          },
          relationshipState: {
            chatId: "chat-1",
            summary: "",
            currentScene: "We are all standing at Airport terminal.",
            interactionTone: "",
            characterState: "",
            userState: "",
            userRoleName: "",
            userRoleDescription: "",
            updatedAt: "",
          },
        },
        sceneState: {
          visibleFacts: [
            "Current live scene: We are all standing at Airport terminal.",
            "Visible user-held object: longbow.",
          ],
          powerDynamic: "No obvious tactical advantage is established.",
          tension: "low",
          immediatePriority:
            "Acknowledge what the user is asking about the live airport scene before drifting into unrelated character lore.",
        },
        turnInterpretation: {
          actionType: "question",
          intent: "The user is seeking an answer or explanation.",
          emotionalPressure: "low",
          requiresImmediateReaction: true,
          antiParrotDirective:
            "Answer or react directly instead of restating the question.",
        },
        salienceProfile: {
          ...baseSalienceProfile,
          liveSceneWeight: 82,
          userProfileWeight: 82,
          characterLoreWeight: 24,
          suppressStaticScenario: true,
          rankedFocus: [
            { key: "latest_user_move" as const, weight: 100 },
            { key: "live_scene" as const, weight: 82 },
            { key: "user_profile" as const, weight: 82 },
            { key: "character_lore" as const, weight: 24 },
            { key: "relationship" as const, weight: 38 },
            { key: "memory" as const, weight: 20 },
            { key: "world_context" as const, weight: 18 },
            { key: "recent_turn" as const, weight: 8 },
          ],
          prioritizeRelationshipTone: false,
        },
      },
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    expect(result.accepted).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.reasons).toContain("missed_immediate_reaction");
    expect(result.reasons).toContain("repair_failed");
    expect(result.finalReply).toBe("");
  });

  it("repairs generic user placeholders into a named in-character reply", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValue("Sam, hands off. I'm not going to let you manhandle me.");

    const result = await finalizeResponseOutput({
      rawOutput:
        "She struggled against the user's grip, her face flushing red as she tried to break free.",
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          speaker: {
            ...prepared.context.speaker!,
            name: "Pooja",
          },
          userProfile: {
            name: "Sam",
            about: "",
            gender: "Man",
            avatar: "",
            traits: [],
            preferences: "",
            boundaries: "",
            createdAt: "",
            updatedAt: "",
          },
        },
      },
      repair,
    });

    expect(repair).toHaveBeenCalledOnce();
    expect(result.repaired).toBe(true);
    expect(result.reasons).toContain("generic_user_reference");
    expect(result.finalReply).toContain("Sam");
  });

  it("rejects pure user-transcript output after a failed repair", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValue('Riley: "Stay down."');

    const result = await finalizeResponseOutput({
      rawOutput: 'Riley: "Stay down."',
      prepared,
      repair,
    });

    expect(result.accepted).toBe(false);
    expect(result.reasons).toContain("transcript_leakage");
    expect(result.reasons).toContain("role_inversion");
    expect(result.reasons).toContain("empty_after_sanitize");
  });

  it("uses a second rescue repair pass for invalid group replies", async () => {
    const repair = vi
      .fn<(_: string) => Promise<string>>()
      .mockResolvedValueOnce("My love, I'll make it up to you tonight.")
      .mockResolvedValueOnce("What happened to your face? You're bleeding.");

    const result = await finalizeResponseOutput({
      rawOutput: "My love, I'll make it up to you tonight.",
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          mode: "group",
          latestUserMessage: "*I enter the room* Hey everyone",
          relationshipState: {
            chatId: "chat-1",
            summary: "Everyone is friends.",
            currentScene: "We are sitting in dining room eating pizza.",
            interactionTone: "",
            characterState: "",
            userState: "",
            userRoleName: "",
            userRoleDescription: "",
            updatedAt: "",
          },
          userProfile: {
            name: "John Smith",
            about: "My clothes are torn and face is bleeding. There are blood stains on my clothes.",
            gender: "",
            avatar: "",
            traits: [],
            preferences: "",
            boundaries: "",
            createdAt: "",
            updatedAt: "",
          },
        },
        sceneState: {
          visibleFacts: [
            "Visible user condition: My clothes are torn and face is bleeding.",
          ],
          powerDynamic: "No obvious tactical advantage is established.",
          tension: "medium",
          immediatePriority:
            "Acknowledge the user's visible condition or injuries before drifting into unrelated character lore or banter.",
        },
        salienceProfile: {
          ...baseSalienceProfile,
          liveSceneWeight: 90,
          relationshipWeight: 58,
          userProfileWeight: 86,
          characterLoreWeight: 20,
          suppressStaticScenario: true,
          prioritizeRelationshipTone: true,
          rankedFocus: [
            { key: "latest_user_move" as const, weight: 100 },
            { key: "live_scene" as const, weight: 90 },
            { key: "user_profile" as const, weight: 86 },
            { key: "relationship" as const, weight: 58 },
            { key: "memory" as const, weight: 20 },
            { key: "character_lore" as const, weight: 20 },
            { key: "world_context" as const, weight: 18 },
            { key: "recent_turn" as const, weight: 8 },
          ],
        },
      },
      repair,
    });

    expect(repair).toHaveBeenCalledTimes(2);
    expect(result.accepted).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.finalReply).toContain("bleeding");
  });
});
