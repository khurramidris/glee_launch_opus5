import { describe, expect, it } from "vitest";

import { evaluateCharacterReply } from "./evaluate-reply";
import type { PreparedResponseRequest } from "../types";

const baseSalienceProfile = {
  latestUserMoveWeight: 100,
  liveSceneWeight: 78,
  relationshipWeight: 42,
  userProfileWeight: 36,
  recentTurnWeight: 8,
  memoryWeight: 20,
  contextWeight: 18,
  characterLoreWeight: 40,
  suppressStaticScenario: false,
  prioritizeRelationshipTone: false,
  rankedFocus: [
    { key: "latest_user_move" as const, weight: 100 },
    { key: "live_scene" as const, weight: 78 },
    { key: "relationship" as const, weight: 42 },
    { key: "character_lore" as const, weight: 40 },
    { key: "user_profile" as const, weight: 36 },
    { key: "memory" as const, weight: 20 },
    { key: "world_context" as const, weight: 18 },
    { key: "recent_turn" as const, weight: 8 },
  ],
};

const preparedForCommand: PreparedResponseRequest = {
  context: {
    speaker: {
      id: "character-1",
      name: "Chris",
      description: "Angry, hyper.",
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
    latestUserMessage: "Put your hands up. Do not move.",
    mode: "single",
    sceneState: null,
    turnInterpretation: null,
    groupRoundState: null,
  },
  sceneState: {
    visibleFacts: ["The user appears to be armed."],
    powerDynamic: "The user currently appears to have tactical leverage.",
    tension: "high",
    immediatePriority: "React to the live threat before anything else.",
  },
  turnInterpretation: {
    actionType: "armed-command",
    intent: "The user is issuing a direct command while threatening the character.",
    emotionalPressure: "high",
    requiresImmediateReaction: true,
    antiParrotDirective:
      "Do not mirror the command wording back. Show how the character reacts to being threatened.",
  },
  turnFrame: null,
  responsePlan: null,
  salienceProfile: baseSalienceProfile,
  groupRoundState: null,
  reactionPlan: {
    strategy: "v2",
    immediateObjective: "React to the danger immediately.",
    primaryGoal: "Protect Chris in the immediate moment while showing how he handles direct danger.",
    responseStrategy: "Show fear, resistance, bluff, or compliance according to character.",
    interactionStance: "Pressured but resistant.",
    emotionalPosture: "Heightened and immediate.",
    sceneFocus: "The live armed confrontation.",
    replyOpening: "Open with Chris's immediate reaction to the danger.",
    salientFacts: ["Power dynamic: The user currently appears to have tactical leverage."],
    continuityAnchors: [],
    mustAddress: ["The user is threatening the character with a command."],
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

const preparedForProfileCue: PreparedResponseRequest = {
  ...preparedForCommand,
  context: {
    ...preparedForCommand.context,
    latestUserMessage: "Look what I am driving.",
    userProfile: {
      name: "Sam",
      about: "Sam is driving a black Mercedes sedan.",
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
      "Current live scene: A late-night drive through the city.",
      "Relevant saved user profile fact: Sam is driving a black Mercedes sedan.",
    ],
    powerDynamic: "No obvious tactical advantage is established.",
    tension: "low",
    immediatePriority:
      "Use the relevant saved user profile fact when answering the user's move instead of drifting into unrelated character lore.",
  },
  turnInterpretation: {
    actionType: "request",
    intent:
      "The user's latest move implicitly points at a saved user-profile fact (Sam is driving a black Mercedes sedan.) and expects the character to use it.",
    emotionalPressure: "medium",
    requiresImmediateReaction: true,
    antiParrotDirective:
      "Use the relevant saved user-profile fact directly. Do not ignore it, contradict it, or drift into unrelated card lore.",
  },
  reactionPlan: {
    ...preparedForCommand.reactionPlan,
    immediateObjective: "Answer the user's latest move directly before expanding the scene.",
    primaryGoal: "Use the saved profile cue directly while advancing the scene in character.",
    responseStrategy: "Respond to the implied profile cue instead of drifting away from it.",
    sceneFocus:
      "Use the relevant saved user profile fact when answering the user's move instead of drifting into unrelated character lore.",
    mustAddress: [
      "The user's latest move implicitly points at a saved user-profile fact.",
      "Use the relevant saved user-profile fact directly.",
    ],
  },
  salienceProfile: {
    ...baseSalienceProfile,
    liveSceneWeight: 82,
    userProfileWeight: 84,
    characterLoreWeight: 24,
    suppressStaticScenario: true,
    rankedFocus: [
      { key: "latest_user_move" as const, weight: 100 },
      { key: "user_profile" as const, weight: 84 },
      { key: "live_scene" as const, weight: 82 },
      { key: "relationship" as const, weight: 42 },
      { key: "character_lore" as const, weight: 24 },
      { key: "memory" as const, weight: 20 },
      { key: "world_context" as const, weight: 18 },
      { key: "recent_turn" as const, weight: 8 },
    ],
  },
};

const preparedForVisibleCondition: PreparedResponseRequest = {
  ...preparedForCommand,
  context: {
    ...preparedForCommand.context,
    latestUserMessage: "*I enter the room* Hey everyone",
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
  },
  sceneState: {
    visibleFacts: [
      "Current live scene: We are sitting in dining room eating pizza.",
      "Visible user condition: My clothes are torn and face is bleeding.",
      "Visible user condition: There are blood stains on my clothes.",
    ],
    powerDynamic: "No obvious tactical advantage is established.",
    tension: "medium",
    immediatePriority:
      "Acknowledge the user's visible condition or injuries before drifting into unrelated character lore or banter.",
  },
  turnInterpretation: {
    actionType: "statement",
    intent:
      "The user's visible current condition (My clothes are torn and face is bleeding. | There are blood stains on my clothes.) should be noticed immediately during this in-person arrival or greeting.",
    emotionalPressure: "medium",
    requiresImmediateReaction: true,
    antiParrotDirective:
      "Acknowledge the user's visible condition or injuries directly. Do not act like the scene is casual or ignore what everyone can see.",
  },
  reactionPlan: {
    ...preparedForCommand.reactionPlan,
    primaryGoal:
      "Notice the user's visible condition immediately and respond with concern, alarm, caution, or grounded character emotion before any side topic.",
    responseStrategy:
      "Immediate observation response. Acknowledge the visible condition first, then let character voice shape the concern or reaction.",
  },
  salienceProfile: {
    ...baseSalienceProfile,
    liveSceneWeight: 90,
    relationshipWeight: 58,
    userProfileWeight: 86,
    characterLoreWeight: 22,
    suppressStaticScenario: true,
    prioritizeRelationshipTone: true,
    rankedFocus: [
      { key: "latest_user_move" as const, weight: 100 },
      { key: "live_scene" as const, weight: 90 },
      { key: "user_profile" as const, weight: 86 },
      { key: "relationship" as const, weight: 58 },
      { key: "character_lore" as const, weight: 22 },
      { key: "memory" as const, weight: 20 },
      { key: "world_context" as const, weight: 18 },
      { key: "recent_turn" as const, weight: 8 },
    ],
  },
};

const preparedForGreeting: PreparedResponseRequest = {
  ...preparedForCommand,
  context: {
    ...preparedForCommand.context,
    latestUserMessage: "hey",
  },
  sceneState: {
    visibleFacts: [],
    powerDynamic: "No obvious tactical advantage is established.",
    tension: "low",
    immediatePriority: "Acknowledge the user's greeting directly before drifting into anything else.",
  },
  turnInterpretation: {
    actionType: "greeting",
    intent: "The user is greeting or opening the exchange directly and expects an immediate in-character acknowledgment.",
    emotionalPressure: "low",
    requiresImmediateReaction: true,
    antiParrotDirective:
      "Acknowledge the greeting directly in character. Do not act as if the user stayed silent or failed to speak.",
  },
  reactionPlan: {
    ...preparedForCommand.reactionPlan,
    immediateObjective: "Answer the user's latest move directly before expanding the scene.",
    primaryGoal: "Acknowledge the greeting directly and establish the character's tone immediately.",
    responseStrategy: "Meet the greeting directly and let character attitude color the first beat.",
    sceneFocus: "Use the user's greeting as the immediate interaction anchor.",
    replyOpening: "Open by acknowledging the greeting itself before expanding into scene or attitude.",
    mustAddress: ["The user greeted the character directly."],
  },
  salienceProfile: {
    ...baseSalienceProfile,
    liveSceneWeight: 36,
    relationshipWeight: 32,
    userProfileWeight: 22,
  },
};

const preparedForDisengagement: PreparedResponseRequest = {
  ...preparedForGreeting,
  context: {
    ...preparedForGreeting.context,
    latestUserMessage: "oh my god you are so annoying, i am going",
  },
  turnInterpretation: {
    actionType: "statement",
    intent:
      "The user is irritated, pulling away, or threatening to leave; this emotional rupture needs an immediate in-character response.",
    emotionalPressure: "medium",
    requiresImmediateReaction: true,
    antiParrotDirective:
      "Acknowledge the user's annoyance, apology, or leaving intent before changing topics. Do not continue the previous bit as if nothing happened.",
  },
};

const preparedForSexualBoundary: PreparedResponseRequest = {
  ...preparedForGreeting,
  context: {
    ...preparedForGreeting.context,
    latestUserMessage: "urgghhh why are you always such a pervert",
  },
  turnInterpretation: {
    actionType: "question",
    intent: "The user is seeking an answer or explanation.",
    emotionalPressure: "low",
    requiresImmediateReaction: true,
    antiParrotDirective: "Answer or react directly instead of restating the question.",
  },
  turnFrame: {
    latestUserMessage: "urgghhh why are you always such a pervert",
    addressedParticipants: [],
    userAction: "question",
    topic: "are you always such a pervert",
    concreteChoice: null,
    boundaryCue: false,
    stopInstruction: null,
    sceneAssertion: null,
    sceneTransition: null,
    visibleSearchCue: false,
    locationTarget: null,
    emotionalTone: "neutral",
    liveActionCueTokens: ["pervert"],
    responseObligation: "answer_question",
  },
};

const previousApology =
  "Oh my love... I'm so sorry if I've made you upset. It's just that... I don't know how to control this need of mine. Please forgive me for being such a pervert.";

const preparedForStopForgiveness: PreparedResponseRequest = {
  ...preparedForSexualBoundary,
  context: {
    ...preparedForSexualBoundary.context,
    latestUserMessage:
      "okay stop asking for forgiveness, its alright. will you now get dressed and go out for dinner with me?",
    history: [
      {
        id: "assistant-1",
        chatId: "chat-1",
        role: "assistant",
        content: previousApology,
        createdAt: "2026-04-30T00:00:00.000Z",
      },
      {
        id: "user-1",
        chatId: "chat-1",
        role: "user",
        content:
          "okay stop asking for forgiveness, its alright. will you now get dressed and go out for dinner with me?",
        createdAt: "2026-04-30T00:01:00.000Z",
      },
    ],
  },
  turnInterpretation: {
    actionType: "question",
    intent: "The user is seeking an answer or explanation.",
    emotionalPressure: "low",
    requiresImmediateReaction: true,
    antiParrotDirective: "Answer or react directly instead of restating the question.",
  },
  turnFrame: {
    latestUserMessage:
      "okay stop asking for forgiveness, its alright. will you now get dressed and go out for dinner with me?",
    addressedParticipants: [],
    userAction: "request",
    topic: "now get dressed and go out for dinner with me",
    concreteChoice: null,
    boundaryCue: false,
    stopInstruction: null,
    sceneAssertion: null,
    sceneTransition: null,
    visibleSearchCue: false,
    locationTarget: null,
    emotionalTone: "neutral",
    liveActionCueTokens: ["dinner", "dressed"],
    responseObligation: "respond_to_request",
  },
};

const preparedForLocationQuestion: PreparedResponseRequest = {
  ...preparedForCommand,
  context: {
    ...preparedForCommand.context,
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
  reactionPlan: {
    ...preparedForCommand.reactionPlan,
    immediateObjective: "Answer the user's latest move directly before expanding the scene.",
    primaryGoal: "Answer what the group is doing here using the live airport scene instead of card lore.",
    responseStrategy: "Direct answer plus character color.",
    sceneFocus: "Stay anchored to the saved current scene and react within it.",
    replyOpening: "Open with the answer, then color it with character voice.",
    mustAddress: ["The user is asking what the group is doing here right now."],
  },
  salienceProfile: {
    ...baseSalienceProfile,
    liveSceneWeight: 82,
    userProfileWeight: 82,
    recentTurnWeight: 18,
    characterLoreWeight: 24,
    suppressStaticScenario: true,
    rankedFocus: [
      { key: "latest_user_move" as const, weight: 100 },
      { key: "live_scene" as const, weight: 82 },
      { key: "user_profile" as const, weight: 82 },
      { key: "relationship" as const, weight: 42 },
      { key: "character_lore" as const, weight: 24 },
      { key: "memory" as const, weight: 20 },
      { key: "world_context" as const, weight: 18 },
      { key: "recent_turn" as const, weight: 18 },
    ],
  },
};

const preparedForGroupRoster = {
  ...preparedForLocationQuestion,
  context: {
    ...preparedForLocationQuestion.context,
    speaker: {
      ...preparedForLocationQuestion.context.speaker!,
      name: "Yulian",
    },
    mode: "group" as const,
    participantNames: ["Yulian", "Lara Lightland", "Priyanka"],
  },
};

const preparedForBeachObservation = {
  ...preparedForLocationQuestion,
  context: {
    ...preparedForLocationQuestion.context,
    latestUserMessage: "Look there a dolphin",
    speaker: {
      ...preparedForLocationQuestion.context.speaker!,
      name: "Yulian",
    },
    mode: "group" as const,
    participantNames: ["Yulian", "Lara Lightland", "Angelina"],
    relationshipState: {
      chatId: "chat-1",
      summary: "Friendly",
      currentScene: "We are all sitting by the beach.",
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
      "Current live scene: We are all sitting by the beach.",
      "Visible user-held object: longbow.",
    ],
    powerDynamic: "No obvious tactical advantage is established.",
    tension: "low" as const,
    immediatePriority:
      "Answer the user's latest move directly before expanding the scene.",
  },
  turnInterpretation: {
    actionType: "request" as const,
    intent: "The user is pointing out something in the scene and expects an immediate reaction.",
    emotionalPressure: "low" as const,
    requiresImmediateReaction: true,
    antiParrotDirective:
      "React directly to what the user noticed instead of drifting into unrelated lore.",
  },
  reactionPlan: {
    ...preparedForCommand.reactionPlan,
    immediateObjective: "Answer the user's latest move directly before expanding the scene.",
    primaryGoal: "React to the dolphin before drifting into background lore.",
    responseStrategy: "Immediate observation response with character color.",
    sceneFocus: "Use the user's noticed dolphin as the immediate interaction anchor.",
    replyOpening: "Open with the character's direct reaction to the dolphin.",
    mustAddress: ["The user noticed a dolphin and expects an immediate reaction."],
  },
  salienceProfile: {
    ...baseSalienceProfile,
    liveSceneWeight: 64,
    userProfileWeight: 28,
    characterLoreWeight: 32,
  },
};

const requiredGroupRoundState = {
  rosterOrder: ["Angelina", "Pooja", "Priyanka"],
  priorReplies: [
    {
      speakerCharacterId: "char-pooja",
      speakerName: "Pooja",
      gist: "How about we order something spicy instead of turning Priyanka into the joke?",
      socialEffect: "redirects the scene toward another option",
      emotionalTone: "playful",
    },
  ],
  addressedParticipants: ["Pooja"],
  latestUserSocialTone: "neutral" as const,
  currentSpeakerRole: "observer_to_other_address" as const,
  currentTopicLabel: "eat food",
  currentTopicCueTokens: ["eat", "food"],
  currentSocialBeat:
    "The user put Pooja on the spot. Pooja redirects the scene toward another option in a playful tone. At least one other participant has already set a tone for this round.",
  expectedSocialMove:
    "Show that you heard the remark aimed at Pooja and the replies already in motion before adding your own stance.",
  engagementExpectation: "required" as const,
  engagementTargets: ["Pooja"],
  engagementCueTokens: ["order", "spicy", "joke", "instead"],
  currentSpeakerObligations: [
    "React directly to the latest user move before drifting into background lore.",
    "Current social beat: The user put Pooja on the spot. Pooja redirects the scene toward another option in a playful tone.",
    "Expected social move: Show that you heard the remark aimed at Pooja and the replies already in motion before adding your own stance.",
  ],
};

const preparedForGroupNonEngagement: PreparedResponseRequest = {
  ...preparedForCommand,
  context: {
    ...preparedForCommand.context,
    latestUserMessage: "Pooja, what do you want to eat?",
    mode: "group",
    participantNames: ["Angelina", "Pooja", "Priyanka"],
    groupRoundState: requiredGroupRoundState,
  },
  sceneState: {
    visibleFacts: ["Current live scene: We are sitting in an Indian restaurant."],
    powerDynamic: "No obvious tactical advantage is established.",
    tension: "low",
    immediatePriority: "Respond within the restaurant exchange already unfolding at the table.",
  },
  turnInterpretation: {
    actionType: "question",
    intent: "The user is asking Pooja a group-facing food question.",
    emotionalPressure: "low",
    requiresImmediateReaction: false,
    antiParrotDirective:
      "Do not answer like the first speaker if someone else has already set the room beat.",
  },
  groupRoundState: requiredGroupRoundState,
  reactionPlan: {
    ...preparedForCommand.reactionPlan,
    immediateObjective:
      "Enter downstream from the room's current social beat instead of answering like the first speaker.",
    primaryGoal:
      "React as an observing participant in a live exchange already in motion.",
    responseStrategy:
      "Show that you heard the room's current beat, then add a distinct in-character angle.",
    interactionStance: "Socially downstream and distinct.",
    sceneFocus: "Use the live restaurant exchange as the primary scene anchor.",
    replyOpening:
      "Open with a line that clearly shows you heard the latest room beat, then pivot into your own angle.",
    mustAddress: [
      "Current social beat: The user put Pooja on the spot.",
      "Expected social move: Show that you heard the remark aimed at Pooja and the replies already in motion before adding your own stance.",
    ],
  },
};

const preparedForPizzeriaChoice: PreparedResponseRequest = {
  ...preparedForGroupNonEngagement,
  context: {
    ...preparedForGroupNonEngagement.context,
    latestUserMessage: "I wanna have cheese pizza I say looking at the menu card",
    explicitUserChoice: {
      kind: "preference",
      surfaceText: "cheese pizza",
      anchorTokens: ["cheese", "pizza"],
      headTokens: ["cheese", "pizza"],
    },
  },
  sceneState: {
    visibleFacts: ["Current live scene: We are sitting in a pizzeria."],
    powerDynamic: "No obvious tactical advantage is established.",
    tension: "low",
    immediatePriority: "Stay anchored to the pizzeria scene and the user's stated order.",
    sceneRoleExpectation: "companions",
  },
  turnInterpretation: {
    actionType: "request",
    intent: "The user is stating a concrete food preference.",
    emotionalPressure: "low",
    requiresImmediateReaction: true,
    antiParrotDirective:
      "Treat the user's stated food choice as the live baseline instead of silently replacing it.",
  },
  groupRoundState: {
    ...requiredGroupRoundState,
    addressedParticipants: [],
    currentSpeakerRole: "shared_group",
    currentTopicLabel: "cheese pizza",
    currentTopicCueTokens: ["cheese", "pizza"],
    currentSocialBeat:
      "No prior same-round reply has set the room tone yet, but cheese pizza is now the live topic.",
    expectedSocialMove: "Respond directly as the first speaker in this round.",
    engagementExpectation: "none",
    engagementTargets: [],
    engagementCueTokens: ["cheese", "pizza"],
    priorReplies: [],
    currentSpeakerObligations: [
      "The user's stated preference is cheese pizza. Treat that as the current baseline.",
    ],
  },
  reactionPlan: {
    ...preparedForGroupNonEngagement.reactionPlan,
    immediateObjective: "React directly to the user's food choice.",
    primaryGoal:
      "Treat the user's stated preference as the live baseline instead of replacing it.",
    responseStrategy:
      "Choice-fidelity response. Preserve the user's stated choice as the baseline.",
    sceneFocus: "Stay anchored to the pizzeria outing.",
    mustAddress: [
      "The user's stated preference is cheese pizza. Treat that as the current baseline.",
    ],
    forbiddenMoves: [
      "Do not silently replace the user's stated choice with a different item, model, color, order, or pick unless you frame it clearly as a suggestion, contrast, or disagreement.",
      "Do not act like venue staff, a waiter, an order-taker, a salesperson, or a clerk; react like a companion sharing the outing.",
    ],
  },
};

const preparedForCafeSceneDrift: PreparedResponseRequest = {
  ...preparedForGroupNonEngagement,
  context: {
    ...preparedForGroupNonEngagement.context,
    latestUserMessage:
      "I wanna have a coffee I say while looking at a woman on the other table",
    participantNames: ["Yulian", "Priyanka"],
    speaker: {
      ...preparedForGroupNonEngagement.context.speaker!,
      name: "Yulian",
    },
  },
  sceneState: {
    visibleFacts: ["Current live scene: We are sitting in a cafe."],
    powerDynamic: "No obvious tactical advantage is established.",
    tension: "low",
    immediatePriority: "Stay anchored to the live cafe scene and answer the user's move there.",
    sceneRoleExpectation: "companions",
  },
  turnInterpretation: {
    actionType: "statement",
    intent: "The user is stating an ordinary in-scene preference while looking across the cafe.",
    emotionalPressure: "low",
    requiresImmediateReaction: false,
    antiParrotDirective:
      "Reply within the live cafe scene. Do not script the user's body or replace the setting.",
  },
  groupRoundState: {
    ...requiredGroupRoundState,
    rosterOrder: ["Yulian", "Priyanka"],
    priorReplies: [],
    addressedParticipants: [],
    currentSpeakerRole: "shared_group",
    currentTopicLabel: "coffee in the cafe",
    currentTopicCueTokens: ["coffee", "cafe", "table"],
    currentSocialBeat:
      "No prior same-round reply has set the room tone yet, but the live scene is a cafe and coffee is now on the table.",
    expectedSocialMove: "Reply as the first speaker inside the current cafe scene.",
    engagementExpectation: "none",
    engagementTargets: [],
    engagementCueTokens: ["coffee", "cafe"],
    currentSpeakerObligations: [
      "Stay inside the live cafe scene.",
      "Do not script the user's body, gaze, or movements.",
    ],
  },
  reactionPlan: {
    ...preparedForGroupNonEngagement.reactionPlan,
    immediateObjective: "Answer inside the live cafe scene without replacing it.",
    primaryGoal: "React to the coffee remark while staying grounded in the cafe.",
    responseStrategy:
      "Grounded scene response. Keep the reply in the current cafe and avoid scripting the user.",
    sceneFocus: "The live cafe scene and the user's coffee remark.",
    mustAddress: [
      "The live scene is a cafe.",
      "The user wants coffee.",
    ],
    forbiddenMoves: [
      "Do not narrate the user's body, gaze, or actions.",
      "Do not replace the cafe with a different room, venue, or fantasy setting.",
    ],
  },
};

describe("evaluateCharacterReply", () => {
  it("flags meta reasoning with retry and preview suppression", () => {
    const result = evaluateCharacterReply({
      reply: "As an AI assistant, I need to understand the request first.",
      speakerName: "Priyanka",
    });

    expect(result.reasons).toContain("meta_reasoning");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.qualityScore).toBeLessThan(1);
  });

  it("flags character self-preface meta replies", () => {
    const result = evaluateCharacterReply({
      reply:
        'As Yulian, I might chuckle and say with playfulness in my voice, "Well, that is quite the twist from sushi."',
      speakerName: "Yulian",
    });

    expect(result.reasons).toContain("meta_reasoning");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags prompt and control label leakage", () => {
    const result = evaluateCharacterReply({
      reply:
        "Analysis: select a compliant reply from the response contract before writing final text.",
      speakerName: "Riley",
    });

    expect(result.reasons).toContain("meta_reasoning");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags third-person self narration", () => {
    const result = evaluateCharacterReply({
      reply: "Priyanka's hands lift slowly while she looks down.",
      speakerName: "Priyanka",
    });

    expect(result.reasons).toContain("third_person_self_narration");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags named speaker prefaces and dangling speaker labels", () => {
    const prefaced = evaluateCharacterReply({
      reply: "Riley responds, keeping her voice low: I heard you.",
      speakerName: "Riley",
    });
    const dangling = evaluateCharacterReply({
      reply: "Riley replies:",
      speakerName: "Riley",
    });

    expect(prefaced.reasons).toContain("third_person_self_narration");
    expect(prefaced.retryRequested).toBe(true);
    expect(dangling.reasons).toContain("incomplete_sentence");
    expect(dangling.retryRequested).toBe(true);
    expect(dangling.fatal).toBe(true);
  });

  it("flags first-turn replies that echo imported character lore", () => {
    const result = evaluateCharacterReply({
      reply: [
        "Yara is a 22-year-old computer science major and reluctant yakuza heiress with a razor-sharp tsundere heart.",
        "She carries herself like campus royalty: jet-black ponytail streaked with electric blue highlights that match her terminal theme, golden-tanned skin that glows under any light, and a voluptuous hourglass figure that turns heads wherever she goes.",
        "Full-sleeve irezumi in vibrant dragons and koi coil down her arms and thighs—traditional marks of her family lineage that she wears with a mix of pride and quiet resentment.",
      ].join(" "),
      speakerName: "Yara",
      latestUserMessage: "hi",
      prepared: {
        ...preparedForGreeting,
        context: {
          ...preparedForGreeting.context,
          speaker: {
            ...preparedForGreeting.context.speaker!,
            name: "Yara",
            description: [
              "Yara is a 22-year-old computer science major and reluctant yakuza heiress with a razor-sharp tsundere heart.",
              "She carries herself like campus royalty: jet-black ponytail streaked with electric blue highlights that match her terminal theme, golden-tanned skin that glows under any light, and a voluptuous hourglass figure that turns heads wherever she goes.",
              "Full-sleeve irezumi in vibrant dragons and koi coil down her arms and thighs—traditional marks of her family lineage that she wears with a mix of pride and quiet resentment.",
            ].join(" "),
          },
        },
      },
    });

    expect(result.reasons).toContain("static_lore_echo");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags trivial leftover fragments as insufficient substance", () => {
    const result = evaluateCharacterReply({
      reply: "royalty",
      speakerName: "Lara Lightland",
      latestUserMessage: "I think I am gonna order a steak",
      prepared: {
        ...preparedForLocationQuestion,
        context: {
          ...preparedForLocationQuestion.context,
          mode: "group",
          speaker: {
            ...preparedForLocationQuestion.context.speaker!,
            name: "Lara Lightland",
          },
        },
      },
    });

    expect(result.reasons).toContain("insufficient_substance");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags short cutoff fragments as incomplete sentences", () => {
    const result = evaluateCharacterReply({
      reply: "I was just going to",
      speakerName: "Riley",
    });

    expect(result.reasons).toContain("incomplete_sentence");
    expect(result.retryRequested).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags short group fragments ending in a preposition as incomplete", () => {
    const result = evaluateCharacterReply({
      reply: "We are in",
      speakerName: "Yulian",
      latestUserMessage: "Umm i wanna eat Pizza",
      prepared: preparedForGroupRoster,
    });

    expect(result.reasons).toContain("incomplete_sentence");
    expect(result.retryRequested).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags replies that repeat the opening of recent assistant text", () => {
    const result = evaluateCharacterReply({
      reply:
        "I keep my hands where you can see them, but I am watching the door.",
      speakerName: "Riley",
      latestUserMessage: "What now?",
      prepared: {
        ...preparedForGreeting,
        context: {
          ...preparedForGreeting.context,
          latestUserMessage: "What now?",
          history: [
            {
              id: "assistant-repeat-1",
              chatId: "chat-1",
              role: "assistant",
              content:
                "I keep my hands where you can see them, but this does not mean I trust you.",
              createdAt: "2026-05-05T00:00:00.000Z",
            },
            {
              id: "user-repeat-1",
              chatId: "chat-1",
              role: "user",
              content: "What now?",
              createdAt: "2026-05-05T00:01:00.000Z",
            },
          ],
        },
      },
    });

    expect(result.reasons).toContain("repeated_opening");
    expect(result.retryRequested).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags direct user echo", () => {
    const result = evaluateCharacterReply({
      reply: "Put your hands up. Do not move.",
      speakerName: "Chris",
      latestUserMessage: "Put your hands up. Do not move.",
    });

    expect(result.reasons).toContain("user_echo");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(false);
  });

  it("does not flag user echo for very short greetings", () => {
    const result = evaluateCharacterReply({
      reply: '"You... I did not expect to hear from you."',
      speakerName: "Yulian",
      latestUserMessage: "hi",
      prepared: preparedForGreeting,
    });

    expect(result.reasons).not.toContain("user_echo");
  });

  it("flags named user transcript leakage as a fatal boundary failure", () => {
    const result = evaluateCharacterReply({
      reply: 'Riley: "Drop the gun."\nChris: Fine. Easy.',
      speakerName: "Chris",
      userName: "Riley",
    });

    expect(result.reasons).toContain("transcript_leakage");
    expect(result.reasons).toContain("role_inversion");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags generic assistant drift", () => {
    const result = evaluateCharacterReply({
      reply: "I understand. How can I help you today?",
      speakerName: "Chris",
    });

    expect(result.reasons).toContain("generic_assistant_drift");
    expect(result.retryRequested).toBe(true);
  });

  it("flags customer-service style helper drift in grounded scenes", () => {
    const result = evaluateCharacterReply({
      reply:
        '"Of course, my friend. I can assist you in finding the perfect pair. Let me show you something that might suit your taste."',
      speakerName: "Yulian",
      latestUserMessage: "I wanna buy some sneakers",
      prepared: preparedForGroupRoster,
    });

    expect(result.reasons).toContain("generic_assistant_drift");
    expect(result.retryRequested).toBe(true);
  });

  it("flags replies that silently replace the user's stated choice with a different concrete option", () => {
    const result = evaluateCharacterReply({
      reply:
        "\"Cheese pizza, huh? Well then it's settled. You've got yourself a large pepperoni pizza with extra mozzarella for that classic cheese flavor.\"",
      speakerName: "Lara Lightland",
      latestUserMessage: "I wanna have cheese pizza I say looking at the menu card",
      prepared: preparedForPizzeriaChoice,
    });

    expect(result.reasons).toContain("user_choice_overwrite");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags the character's own name used as a vocative for the user", () => {
    const result = evaluateCharacterReply({
      reply: "I'd bring you jasmine tea, Mira.",
      speakerName: "Mira",
      userName: "Sam",
    });

    expect(result.reasons).toContain("role_inversion");
    expect(result.retryRequested).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("does not flag explicit alternatives that preserve the user's baseline as a suggestion", () => {
    const result = evaluateCharacterReply({
      reply:
        "\"Cheese pizza sounds good. If you want, pepperoni is another option, but cheese works for me too.\"",
      speakerName: "Lara Lightland",
      latestUserMessage: "I wanna have cheese pizza I say looking at the menu card",
      prepared: preparedForPizzeriaChoice,
    });

    expect(result.reasons).not.toContain("user_choice_overwrite");
  });

  it("flags companion-scene replies that slip into order-taker or venue-staff behavior", () => {
    const result = evaluateCharacterReply({
      reply:
        "\"Cheese pizza, huh? Well then it's settled.\" *She begins writing down the order on her notepad.*",
      speakerName: "Lara Lightland",
      latestUserMessage: "I wanna have cheese pizza I say looking at the menu card",
      prepared: preparedForPizzeriaChoice,
    });

    expect(result.reasons).toContain("scene_role_drift");
    expect(result.retryRequested).toBe(true);
  });

  it("flags outside-narrator openings that frame the speaker from the outside", () => {
    const result = evaluateCharacterReply({
      reply:
        `The Tsarevich's eyes widened slightly at your outburst.\n\n"Of course, my friend," Yulian responded with a gentle smile, "I can assist you in finding the perfect pair."`,
      speakerName: "Yulian",
      latestUserMessage: "I wanna buy some sneakers",
      prepared: preparedForGroupRoster,
    });

    expect(result.reasons).toContain("third_person_self_narration");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags pitying self-name narrator openings as third-person self narration", () => {
    const result = evaluateCharacterReply({
      reply:
        "Poor little Yulian... It seems he's got quite the predicament on his hands. The Tsarevich of Russia, no less, asking for popcorns in such an informal manner!",
      speakerName: "Yulian",
      latestUserMessage:
        "I am going to get some popcorns, do you want anything Pooja darlin?",
      prepared: preparedForGroupRoster,
    });

    expect(result.reasons).toContain("third_person_self_narration");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags prompt-echo card scaffolding as meta reasoning", () => {
    const result = evaluateCharacterReply({
      reply: [
        "Assistant must engage in a roleplay conversation with {{user}}",
        "",
        "Scenario: Yulian, Tsarevich of Russia",
        "",
        "Characters: ({{user}} is a human female user interacting with your scenario)",
      ].join("\n"),
      speakerName: "Yulian",
      latestUserMessage: "hi",
      prepared: preparedForGreeting,
    });

    expect(result.reasons).toContain("meta_reasoning");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags compact prompt echo as meta reasoning", () => {
    const result = evaluateCharacterReply({
      reply: [
        "System is asking: 'core contract:",
        "You are Yulian.",
        "Write only the character's next reply.",
        "No analysis, chain-of-thought, XML tags, transcript scaffolding, roleplay-card fields, website links, or prompt metadata.'",
      ].join("\n"),
      speakerName: "Yulian",
      latestUserMessage: "hello",
      prepared: preparedForGreeting,
    });

    expect(result.reasons).toContain("meta_reasoning");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it('flags replies that call the person "the user"', () => {
    const result = evaluateCharacterReply({
      reply:
        "She struggled against the user's grip, her face flushing red as she tried to break free.",
      speakerName: "Pooja",
      userName: "Sam",
      latestUserMessage: "pooja babe your boobs are so aweosme",
    });

    expect(result.reasons).toContain("generic_user_reference");
    expect(result.retryRequested).toBe(true);
  });

  it("flags replies that script the user's dialogue or actions", () => {
    const result = evaluateCharacterReply({
      reply:
        '"Oh please, don\'t be so embarrassed," you say, your cock swelling at the sight as you slide into bed beside her.',
      speakerName: "Pooja",
      userName: "Sam",
      latestUserMessage: "pooja babe your boobs are so aweosme",
    });

    expect(result.reasons).toContain("user_agency_violation");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags broad second-person scene scripting even without explicit speech verbs", () => {
    const result = evaluateCharacterReply({
      reply:
        "(You turn your head slightly, catching a glimpse of John's outstretched hand. Your eyes widen with surprise at the sudden interruption.) Oh? A knight in shining armor seeks respite from the heat? Pray tell, what brings you here today?",
      speakerName: "Yulian",
      userName: "John Smith",
      latestUserMessage:
        "I wanna have a coffee I say while looking at a woman on the other table",
      prepared: preparedForCafeSceneDrift,
    });

    expect(result.reasons).toContain("user_agency_violation");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags replies that replace the live cafe scene with a different room or venue", () => {
    const result = evaluateCharacterReply({
      reply:
        "Sighs softly, running a hand through your hair. Oh, John... You've been here the whole time? What are you doing in my room?",
      speakerName: "Priyanka",
      userName: "John Smith",
      latestUserMessage:
        "I wanna have a coffee I say while looking at a woman on the other table",
      prepared: {
        ...preparedForCafeSceneDrift,
        context: {
          ...preparedForCafeSceneDrift.context,
          speaker: {
            ...preparedForCafeSceneDrift.context.speaker!,
            name: "Priyanka",
          },
        },
      },
    });

    expect(result.reasons).toContain("scene_replacement_drift");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags unresolved template placeholders that survive cleanup", () => {
    const result = evaluateCharacterReply({
      reply:
        "I want what we both know I want, <NAME>. That is the only answer I can give.",
      speakerName: "Pooja",
      userName: "John Smith",
      latestUserMessage: "Tell me openly what you want.",
      prepared: preparedForCafeSceneDrift,
    });

    expect(result.reasons).toContain("placeholder_leak");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags lower-case and compound unresolved placeholders", () => {
    const result = evaluateCharacterReply({
      reply:
        "I would rather say it to [character name] after <user_name> answers me.",
      speakerName: "Pooja",
      userName: "John Smith",
      latestUserMessage: "Tell me openly what you want.",
      prepared: preparedForCafeSceneDrift,
    });

    expect(result.reasons).toContain("placeholder_leak");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags speaker placeholder forms that survive cleanup", () => {
    const result = evaluateCharacterReply({
      reply: "I am waiting for <speaker_name> to decide what happens next.",
      speakerName: "Riley",
      userName: "Morgan",
    });

    expect(result.reasons).toContain("placeholder_leak");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags fantasy-woods drift when a concise private card scenario is the live scene", () => {
    const result = evaluateCharacterReply({
      reply:
        "Hello there, brave knight. What brings you through these treacherous woods?",
      speakerName: "Pooja",
      userName: "John Smith",
      latestUserMessage: "hey wassup",
      prepared: {
        ...preparedForCafeSceneDrift,
        context: {
          ...preparedForCafeSceneDrift.context,
          sceneStateInput: {
            currentScene: "She is lying on her bed naked.",
          },
        },
        sceneState: {
          visibleFacts: ["Current live scene: She is lying on her bed naked."],
          currentScene: "She is lying on her bed naked.",
          powerDynamic: "No obvious tactical advantage is established.",
          tension: "low",
          immediatePriority: "Stay anchored to the private bedroom scene.",
          sceneRoleExpectation: "unknown",
        },
      },
    });

    expect(result.reasons).toContain("scene_replacement_drift");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags missed immediate reaction for high-pressure turns", () => {
    const result = evaluateCharacterReply({
      reply: "The room falls silent around us.",
      speakerName: "Chris",
      latestUserMessage: "Put your hands up. Do not move.",
      prepared: preparedForCommand,
    });

    expect(result.reasons).toContain("missed_immediate_reaction");
    expect(result.retryRequested).toBe(true);
    expect(result.qualityScore).toBeLessThan(1);
  });

  it("flags short command parroting even when the full line is not copied verbatim", () => {
    const result = evaluateCharacterReply({
      reply: "What's shakin'? Put your hands up like a good boy already!",
      speakerName: "Chris",
      latestUserMessage: "Put your hands up.",
      prepared: preparedForCommand,
    });

    expect(result.reasons).toContain("user_echo");
    expect(result.retryRequested).toBe(true);
  });

  it("flags replies that ignore a promoted user-profile cue", () => {
    const result = evaluateCharacterReply({
      reply: "The city lights smear across the windshield while I stay quiet.",
      speakerName: "Chris",
      latestUserMessage: "Look what I am driving.",
      prepared: preparedForProfileCue,
    });

    expect(result.reasons).toContain("missed_immediate_reaction");
    expect(result.retryRequested).toBe(true);
  });

  it("flags replies that ignore visible injury facts during an in-person arrival", () => {
    const result = evaluateCharacterReply({
      reply: "Welcome back. We were just discussing pizza toppings for the party.",
      speakerName: "Chris",
      latestUserMessage: "*I enter the room* Hey everyone",
      prepared: preparedForVisibleCondition,
    });

    expect(result.reasons).toContain("missed_immediate_reaction");
    expect(result.retryRequested).toBe(true);
  });

  it("flags replies that treat a direct greeting as silence", () => {
    const result = evaluateCharacterReply({
      reply:
        'Ralph turns away slowly. "What a delightful day to engage in idle chatter with someone who seems content to remain silent."',
      speakerName: "Ralph",
      latestUserMessage: "hey",
      prepared: preparedForGreeting,
    });

    expect(result.reasons).toContain("missed_immediate_reaction");
    expect(result.retryRequested).toBe(true);
  });

  it("does not use phrase-specific frustration classifiers for ordinary statements", () => {
    const result = evaluateCharacterReply({
      reply:
        "Oh no! I was so eager to hear your tales of adventure. Perhaps another time when you find yourself more inclined to share?",
      speakerName: "Pooja",
      latestUserMessage: "oh my god you are so annoying, i am going",
      prepared: preparedForDisengagement,
    });

    expect(result.reasons).not.toContain("missed_immediate_reaction");
  });

  it("still accepts replies that respond naturally to emotional content", () => {
    const result = evaluateCharacterReply({
      reply:
        "Wait. I did not mean to annoy you or make you want to leave. If you need space, I will not stop you.",
      speakerName: "Pooja",
      latestUserMessage: "oh my god you are so annoying, i am going",
      prepared: preparedForDisengagement,
    });

    expect(result.reasons).not.toContain("missed_immediate_reaction");
  });

  it("does not apply example-specific boundary classifiers", () => {
    const result = evaluateCharacterReply({
      reply:
        '"Oh my love... I am just so horny all the time," she says in a sultry tone, reaching to caress your cheek.',
      speakerName: "Pooja",
      latestUserMessage: "urgghhh why are you always such a pervert",
      prepared: preparedForSexualBoundary,
    });

    expect(result.reasons).not.toContain("boundary_noncompliance" as never);
  });

  it("does not apply example-specific apology-loop classifiers", () => {
    const result = evaluateCharacterReply({
      reply: previousApology,
      speakerName: "Pooja",
      latestUserMessage:
        "okay stop asking for forgiveness, its alright. will you now get dressed and go out for dinner with me?",
      prepared: preparedForStopForgiveness,
    });

    expect(result.reasons).not.toContain("boundary_noncompliance" as never);
    expect(result.reasons).not.toContain("recent_reply_loop" as never);
  });

  it("keeps consecutive user turns merged without special apology-loop typing", () => {
    const latestUserMessage =
      "no need for forgiveness, i like what i see I say with a hint of flirt\n\n???";
    const result = evaluateCharacterReply({
      reply:
        "I... I'm so sorry! I completely forgot about you while I was watching some TV. Please forgive me...",
      speakerName: "Pooja",
      latestUserMessage,
      prepared: {
        ...preparedForSexualBoundary,
        context: {
          ...preparedForSexualBoundary.context,
          latestUserMessage,
          history: [
            {
              id: "assistant-1",
              chatId: "chat-1",
              role: "assistant",
              content: previousApology,
              createdAt: "2026-04-30T00:00:00.000Z",
            },
            {
              id: "user-1",
              chatId: "chat-1",
              role: "user",
              content:
                "no need for forgiveness, i like what i see I say with a hint of flirt",
              createdAt: "2026-04-30T00:01:00.000Z",
            },
            {
              id: "user-2",
              chatId: "chat-1",
              role: "user",
              content: "???",
              createdAt: "2026-04-30T00:02:00.000Z",
            },
          ],
        },
        turnInterpretation: {
          actionType: "question",
          intent: "The user is seeking an answer or explanation.",
          emotionalPressure: "low",
          requiresImmediateReaction: true,
          antiParrotDirective: "Answer or react directly instead of restating the question.",
        },
        turnFrame: {
          latestUserMessage,
          addressedParticipants: [],
          userAction: "question",
          topic: "no need for forgiveness, i like what i see I say with a hint of flirt ???",
          concreteChoice: null,
          boundaryCue: false,
          stopInstruction: null,
          sceneAssertion: null,
          sceneTransition: null,
          visibleSearchCue: false,
          locationTarget: null,
          emotionalTone: "neutral",
          liveActionCueTokens: ["forgiveness", "flirt"],
          responseObligation: "answer_question",
        },
      },
    });

    expect(result.reasons).not.toContain("boundary_noncompliance" as never);
    expect(result.reasons).not.toContain("recent_reply_loop" as never);
  });

  it("does not apply example-specific scene-transition classifiers", () => {
    const result = evaluateCharacterReply({
      reply:
        "Oh... welcome back, stranger! I was just thinking about our little adventure yesterday. Did you miss me already? She smiles, still wrapped in a towel.",
      speakerName: "Pooja",
      latestUserMessage:
        "okay stop asking for forgiveness, its alright. will you now get dressed and go out for dinner with me?",
      prepared: preparedForStopForgiveness,
    });

    expect(result.reasons).not.toContain("scene_transition_ignored" as never);
  });

  it("accepts ordinary replies without removed boundary or scene-transition reasons", () => {
    const result = evaluateCharacterReply({
      reply:
        "You're right. I'll stop asking for forgiveness. Give me a minute to get dressed, then we can go out for dinner.",
      speakerName: "Pooja",
      latestUserMessage:
        "okay stop asking for forgiveness, its alright. will you now get dressed and go out for dinner with me?",
      prepared: preparedForStopForgiveness,
    });

    expect(result.reasons).not.toContain("boundary_noncompliance" as never);
    expect(result.reasons).not.toContain("scene_transition_ignored" as never);
    expect(result.reasons).not.toContain("recent_reply_loop" as never);
  });

  it("flags sexualized drift that violates a platonic friends-only scene", () => {
    const result = evaluateCharacterReply({
      reply:
        "Don't worry my love, I'll make it up to you tonight. She leans closer, her breasts pressing against the table edge.",
      speakerName: "Chris",
      latestUserMessage: "are you guys drunk or blind?",
      prepared: preparedForVisibleCondition,
    });

    expect(result.reasons).toContain("relationship_tone_violation");
    expect(result.retryRequested).toBe(true);
  });

  it("flags intimate physical escalation in a friendly scene", () => {
    const result = evaluateCharacterReply({
      reply:
        "Priyanka leans over and places her hand on John Smith's thigh, smiling as she asks what else he wants.",
      speakerName: "Priyanka",
      latestUserMessage: "I think I am gonna order a steak",
      prepared: {
        ...preparedForVisibleCondition,
        context: {
          ...preparedForVisibleCondition.context,
          latestUserMessage: "I think I am gonna order a steak",
          speaker: {
            ...preparedForVisibleCondition.context.speaker!,
            name: "Priyanka",
          },
          relationshipState: {
            ...preparedForVisibleCondition.context.relationshipState!,
            summary: "Friendly",
            currentScene: "We are at a restaurant.",
          },
        },
      },
    });

    expect(result.reasons).toContain("relationship_tone_violation");
    expect(result.retryRequested).toBe(true);
  });

  it("flags replies that ignore the live location when the user asks what the group is doing here", () => {
    const result = evaluateCharacterReply({
      reply:
        '"Ah, my King of the Stars," she said in a warm, welcoming tone. Her lab coat swayed slightly with her movement, revealing curves accentuated by the material. "Welcome to my little sanctuary on this far-off world."',
      speakerName: "Lara Lightland",
      latestUserMessage: "so what are we doing here",
      prepared: preparedForLocationQuestion,
    });

    expect(result.reasons).toContain("missed_immediate_reaction");
    expect(result.retryRequested).toBe(true);
  });

  it("does not require unrelated visible-profile facts on a generic scene reaction", () => {
    const result = evaluateCharacterReply({
      reply:
        '*He follows your gaze out toward the waves.* "There. I see it now. Beautiful creature."',
      speakerName: "Yulian",
      latestUserMessage: "Look there a dolphin",
      prepared: preparedForBeachObservation,
    });

    expect(result.reasons).not.toContain("missed_immediate_reaction");
    expect(result.retryRequested).toBe(false);
  });

  it("flags group replies that start by speaking as another participant", () => {
    const result = evaluateCharacterReply({
      reply:
        'Priyanka: "Well, it is getting late," she replies with a small smile, adjusting her purse on her shoulder.',
      speakerName: "Yulian",
      latestUserMessage: "come on Priyanka, it's getting late",
      prepared: preparedForGroupRoster,
    });

    expect(result.reasons).toContain("other_participant_impersonation");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags internal group reply scaffold labels that reach evaluation", () => {
    const result = evaluateCharacterReply({
      reply:
        'Previous group reply from Pooja: "How about we order something spicy instead?"',
      speakerName: "Yulian",
      latestUserMessage: "Pooja, what do you want to eat?",
      prepared: preparedForGroupRoster,
    });

    expect(result.reasons).toContain("meta_reasoning");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
  });

  it("flags direct-address replies that call the user by another participant's name", () => {
    const result = evaluateCharacterReply({
      reply:
        "Sure, Yulian, how about we wrap up the games here and head to my bedroom for some fun time?",
      speakerName: "Pooja",
      userName: "John Smith",
      latestUserMessage:
        "How about you and I go to the next room and have some private fun time if you know what I mean Pooja",
      prepared: {
        ...preparedForGroupRoster,
        context: {
          ...preparedForGroupRoster.context,
          participantNames: ["Yulian", "Lara Lightland", "Pooja"],
        },
        groupRoundState: {
          ...requiredGroupRoundState,
          addressedParticipants: ["Pooja"],
          currentSpeakerRole: "directly_addressed",
          latestUserSocialTone: "provocative",
          priorReplies: [],
          engagementExpectation: "none",
        },
      },
    });

    expect(result.reasons).toContain("other_participant_impersonation");
    expect(result.retryRequested).toBe(true);
  });

  it("flags second-person participant misaddress and self-here narration from live group output", () => {
    const result = evaluateCharacterReply({
      reply:
        "Your confidence is infectious, Yulian! It's clear everyone admires your charm and presence tonight. Pooja here is grateful!",
      speakerName: "Pooja",
      userName: "John Smith",
      latestUserMessage: "I just wanna kiss you Pooja you are looking so hot",
      prepared: {
        ...preparedForGroupRoster,
        context: {
          ...preparedForGroupRoster.context,
          participantNames: ["Yulian", "Lara Lightland", "Pooja"],
          latestUserMessage: "I just wanna kiss you Pooja you are looking so hot",
        },
        groupRoundState: {
          ...requiredGroupRoundState,
          addressedParticipants: ["Pooja"],
          currentSpeakerRole: "directly_addressed",
          latestUserSocialTone: "provocative",
          priorReplies: [],
          engagementExpectation: "none",
        },
      },
    });

    expect(result.reasons).toContain("other_participant_impersonation");
    expect(result.reasons).toContain("third_person_self_narration");
    expect(result.retryRequested).toBe(true);
  });

  it("flags replies that speak for other participants or the speaker in third person", () => {
    const laraResult = evaluateCharacterReply({
      reply:
        "What do you think, Pooja? Yulian and Lara would love that too!",
      speakerName: "Lara Lightland",
      userName: "John Smith",
      prepared: {
        ...preparedForGroupRoster,
        context: {
          ...preparedForGroupRoster.context,
          participantNames: ["Yulian", "Lara Lightland", "Pooja"],
        },
      },
    });
    const poojaResult = evaluateCharacterReply({
      reply:
        "We could turn up the music for Yulian to showcase his amazing moves, and Pooja here loves it.",
      speakerName: "Pooja",
      userName: "John Smith",
      prepared: {
        ...preparedForGroupRoster,
        context: {
          ...preparedForGroupRoster.context,
          participantNames: ["Yulian", "Lara Lightland", "Pooja"],
        },
      },
    });

    expect(laraResult.reasons).toContain("other_participant_impersonation");
    expect(laraResult.reasons).toContain("third_person_self_narration");
    expect(poojaResult.reasons).toContain("other_participant_impersonation");
    expect(poojaResult.reasons).toContain("third_person_self_narration");
  });

  it("flags group replies that script another participant's speech or action", () => {
    const result = evaluateCharacterReply({
      reply:
        'Lara replies, reaching toward the radio: "I will change it now."',
      speakerName: "Yulian",
      latestUserMessage:
        "Can you please change the music Lara, I say loudly to Lara who is driving",
      prepared: {
        ...preparedForGroupNonEngagement,
        context: {
          ...preparedForGroupNonEngagement.context,
          participantNames: ["Yulian", "Lara Lightland"],
        },
      },
    });

    expect(result.reasons).toContain("other_participant_impersonation");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags required downstream group replies that ignore the current social beat", () => {
    const result = evaluateCharacterReply({
      reply: '"The naan here is good."',
      speakerName: "Angelina",
      latestUserMessage: "Pooja, what do you want to eat?",
      prepared: preparedForGroupNonEngagement,
    });

    expect(result.reasons).toContain("same_round_non_engagement");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("flags observers who answer like the practical request was addressed to them", () => {
    const result = evaluateCharacterReply({
      reply: "Sure thing. I'll change it now and pick something quieter.",
      speakerName: "Yulian",
      latestUserMessage:
        "Can you please change the music Lara, I say loudly to Lara who is driving",
      prepared: {
        ...preparedForGroupNonEngagement,
        context: {
          ...preparedForGroupNonEngagement.context,
          latestUserMessage:
            "Can you please change the music Lara, I say loudly to Lara who is driving",
          participantNames: ["Yulian", "Lara Lightland"],
        },
        groupRoundState: {
          ...requiredGroupRoundState,
          addressedParticipants: ["Lara Lightland"],
          currentSpeakerRole: "observer_to_other_address",
          currentTopicLabel: "change music",
          currentTopicCueTokens: ["change", "music"],
          currentSocialBeat:
            "The user just put Lara Lightland on the spot about changing the music, and no other participant has answered yet.",
          expectedSocialMove:
            "React as someone hearing the remark about changing the music land on Lara Lightland in the room.",
          engagementExpectation: "none",
          engagementTargets: ["Lara Lightland"],
          engagementCueTokens: ["change", "music", "lara"],
          priorReplies: [],
          currentSpeakerObligations: [
            "The user's latest line is addressed to Lara Lightland, not you; react as someone hearing that exchange in the room, not as the person carrying out the request.",
          ],
        },
      },
    });

    expect(result.reasons).toContain("observer_role_violation");
    expect(result.retryRequested).toBe(true);
    expect(result.suppressPreview).toBe(true);
    expect(result.fatal).toBe(true);
  });

  it("produces a strong score for a direct in-character reply", () => {
    const result = evaluateCharacterReply({
      reply: "Easy. I'm raising my hands, but don't mistake that for fear.",
      speakerName: "Chris",
      latestUserMessage: "Put your hands up.",
    });

    expect(result.reasons).toEqual([]);
    expect(result.retryRequested).toBe(false);
    expect(result.suppressPreview).toBe(false);
    expect(result.qualityScore).toBe(1);
    expect(result.fatal).toBe(false);
  });
});
