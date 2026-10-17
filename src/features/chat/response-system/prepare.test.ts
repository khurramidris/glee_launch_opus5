import { describe, expect, it } from "vitest";

import type { Character, ChatMessage, UserProfile } from "../../../types";
import { prepareResponseRequest } from "./prepare";
import {
  toLlamaChatMessages,
  TURN_NOTES_CLOSE,
  TURN_NOTES_OPEN,
} from "../runtime-adapters/llama";
import type { LlamaChatMessage } from "../../../types";
import type { CompiledCharacterPrompt } from "./types";

const speaker: Character = {
  id: "char-1",
  name: "Julian",
  description: "{{char}} waits for {{user}} in the palace corridor.",
  backstory: "",
  scenario: "<START>\n{{user}} corners {{char}} after the ceremony.",
  systemPrompt: "Remain poised, but do not ignore {{user}}'s emotional state.",
  speechStyle: "Measured, formal, intimate with {{user}} in private.",
  greeting: "You came back to me, {{user}}.",
  alternateGreetings: ["{{char}}: You returned.", "{{char}}: I had hoped for this."],
  avatar: "",
  tags: ["formal", "guarded"],
  likes: [],
  dislikes: [],
  boundaries: "",
  creatorNotes: "",
  exampleDialogue: "{{user}}: Did you wait for me?\n{{char}}: I always do.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const userProfile: UserProfile = {
  name: "Sam",
  about: "",
  gender: "",
  avatar: "",
  traits: [],
  preferences: "",
  boundaries: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const history: ChatMessage[] = [
  {
    id: "m1",
    chatId: "chat-1",
    role: "user",
    content: "Put your hands up. I have an AK47 on you.",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];


/** Everything the model is told: the stable system prompt plus this turn's notes. */
function promptInstructions(compiled: CompiledCharacterPrompt): string {
  const messages = toLlamaChatMessages(compiled);
  const latest = messages[messages.length - 1]?.content ?? "";
  const open = latest.indexOf(TURN_NOTES_OPEN);
  const close = latest.indexOf(TURN_NOTES_CLOSE);
  const notes = open === 0 && close > 0 ? latest.slice(TURN_NOTES_OPEN.length, close).trim() : "";
  return [messages[0]?.content ?? "", notes].filter(Boolean).join("\n\n");
}

function systemPromptOf(compiled: CompiledCharacterPrompt): string {
  return toLlamaChatMessages(compiled)[0]?.content ?? "";
}

function withoutTurnNotes(message: LlamaChatMessage | undefined): LlamaChatMessage | undefined {
  if (!message?.content.startsWith(TURN_NOTES_OPEN)) {
    return message;
  }
  const close = message.content.indexOf(TURN_NOTES_CLOSE);
  return { ...message, content: message.content.slice(close + TURN_NOTES_CLOSE.length).trim() };
}

describe("prepareResponseRequest", () => {
  it("resolves imported card placeholders with live speaker and user names", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile,
      contextEntries: [],
      history,
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    const identity = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "character_identity",
    );
    const scene = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "character_scene",
    );
    const rules = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "character_rules",
    );
    const style = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "response_style",
    );

    expect(identity?.content).toContain("Julian waits for Sam");
    expect(scene?.content).toContain("Sam corners Julian");
    expect(scene?.content).not.toContain("<START>");
    expect(rules?.content).toContain("Sam's emotional state");
    expect(style?.content).toContain("Sam");
    expect(prepared.compiledPrompt.exampleMessages).toEqual([
      { role: "user", content: "Did you wait for me?", source: "example_dialogue" },
      { role: "assistant", content: "I always do.", source: "example_dialogue" },
    ]);
    expect(prepared.reactionPlan.strategy).toBe("v2");
    expect(prepared.reactionPlan.primaryGoal).toContain(
      "Protect the character in the immediate moment",
    );
  });

  it("adds regeneration guardrails without changing the chat mode", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile,
      contextEntries: [],
      history,
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      isRegeneration: true,
      previousAssistantReply:
        "Oh, please. You're the one who put the idea in my head by being so obvious about it.",
      participantNames: ["Julian", "Mira"],
      participantDirectory: {
        "char-1": "Julian",
        "char-2": "Mira",
      },
    });

    const systemContract = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "system_contract",
    );

    expect(prepared.context.mode).toBe("group");
    expect(prepared.context.isRegeneration).toBe(true);
    expect(prepared.groupRoundState).not.toBeNull();
    expect(systemContract?.content).toContain("Regeneration request");
    expect(systemContract?.content).toContain("Do not copy, reprint");
    expect(systemContract?.content).toContain(
      "Previous assistant reply to avoid repeating: Oh, please.",
    );
    expect(systemContract?.content).toContain("This is a multi-character group chat");
  });

  it("honors explicit scene-state input and carries it into the derived scene", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile,
      sceneStateInput: {
        currentScene: "A rain-soaked palace courtyard.",
        interactionTone: "Tense, intimate, dangerous.",
        userState: "Armed with an AK47 and demanding surrender.",
        characterState: "Trying to stay composed while cornered.",
        visibleFacts: ["The guards have backed away.", "The courtyard gates are shut."],
      },
      contextEntries: [],
      history,
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    expect(prepared.context.sceneStateInput?.currentScene).toBe(
      "A rain-soaked palace courtyard.",
    );
    expect(prepared.sceneState?.visibleFacts.join(" | ")).toContain(
      "The guards have backed away.",
    );
    expect(prepared.sceneState?.visibleFacts.join(" | ")).toContain(
      "Armed with an AK47",
    );
    expect(prepared.sceneState?.powerDynamic).toContain("tactical advantage");
    expect(prepared.turnInterpretation?.actionType).toBe("armed-command");
    expect(prepared.reactionPlan.salientFacts.join(" | ")).toContain("tactical advantage");
    expect(prepared.reactionPlan.replyOpening).toContain("immediate reaction to the danger");
  });

  it("orders latest user turn and live scene ahead of static card and profile lore", () => {
    const prepared = prepareResponseRequest({
      speaker: {
        ...speaker,
        description: "A palace-bound royal who expects every scene to stay in the palace.",
        backstory: "The palace history is old, formal, and heavy.",
        scenario: "She is lying on her bed in a private chamber.",
      },
      userProfile: {
        ...userProfile,
        about: "Sam wears a jeweled crown and carries a longbow.",
      },
      relationshipState: {
        chatId: "chat-1",
        summary: "They know each other well.",
        currentScene: "We are waiting beside an airport taxi stand.",
        interactionTone: "Busy but friendly.",
        characterState: "",
        userState: "",
        userRoleName: "",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "a-airport-1",
          chatId: "chat-1",
          role: "assistant",
          content: "The palace is quiet tonight.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "u-airport-1",
          chatId: "chat-1",
          role: "user",
          content: "Actually we are outside the airport now.",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
        {
          id: "u-airport-2",
          chatId: "chat-1",
          role: "user",
          content: "The cab is here.",
          createdAt: "2026-01-01T00:02:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    const mergedSystem = promptInstructions(prepared.compiledPrompt);
    const latestIndex = mergedSystem.indexOf("Raw latest user move:");
    const liveSceneIndex = mergedSystem.indexOf("Current live scene:");
    const profileIndex = mergedSystem.indexOf("Background about the user:");
    const cardLoreIndex = mergedSystem.indexOf("A palace-bound royal");
    const turnFrameSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "turn_frame",
    );
    const profileSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "user_profile",
    );

    expect(prepared.context.latestUserMessage).toContain(
      "Actually we are outside the airport now.",
    );
    expect(prepared.context.latestUserMessage).toContain("The cab is here.");
    expect(prepared.salienceProfile.suppressStaticScenario).toBe(true);
    expect(prepared.reactionPlan.continuityAnchors.join(" | ")).not.toContain(
      "Scenario frame:",
    );
    expect(mergedSystem).toContain(
      "Priority: latest user move > live scene/corrections > same-round room context > relationship > profile/memory > static character card.",
    );
    expect(mergedSystem).toContain(
      "Keep its named people, objects, colors, and locations intact unless the character explicitly corrects them.",
    );
    expect(mergedSystem).not.toContain("Scenario and roleplay framing:");
    expect(mergedSystem).toMatch(/Current live scene: .*airport/i);
    expect(latestIndex).toBeGreaterThanOrEqual(0);
    expect(liveSceneIndex).toBeGreaterThanOrEqual(0);
    expect(profileSection?.content).toContain("Background about the user:");
    expect(turnFrameSection?.priority ?? 999).toBeLessThan(profileSection?.priority ?? 999);
    // Live, per-turn grounding rides with the newest message; static profile and
    // card lore stay in the cache-stable system prompt that comes first.
    const systemPrompt = systemPromptOf(prepared.compiledPrompt);
    expect(systemPrompt).not.toContain("Current live scene:");
    if (profileIndex >= 0) {
      expect(profileIndex).toBeLessThan(liveSceneIndex);
      expect(systemPrompt).toContain("Background about the user:");
    }
    if (cardLoreIndex >= 0) {
      expect(cardLoreIndex).toBeLessThan(liveSceneIndex);
    }
    expect(prepared.responsePlan?.outputContract).toContain("speaker labels");
    expect(prepared.responsePlan?.outputContract).toContain("prompt text");
    expect(prepared.responsePlan?.outputContract).not.toContain("[dialogue]");
  });

  it("promotes present-tense weapon cues from the user profile into live scene state", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile: {
        ...userProfile,
        about: "I have an AK47 in my hand.",
      },
      contextEntries: [],
      history: [
        {
          id: "m2",
          chatId: "chat-1",
          role: "user",
          content: "What do you see in my hands?",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    expect(prepared.sceneState?.visibleFacts.join(" | ")).toContain("holding AK47");
    expect(prepared.turnInterpretation?.actionType).toBe("armed-question");
    expect(prepared.reactionPlan.primaryGoal).toContain("visible threat directly");
  });

  it("promotes non-weapon held objects from the user profile into live scene state", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile: {
        ...userProfile,
        about: "Sam has a Golden Skull in his hands.",
      },
      relationshipState: {
        chatId: "chat-1",
        summary: "Everyone is friends.",
        currentScene: "We are sitting in the dining room eating pizza.",
        interactionTone: "",
        characterState: "",
        userState: "",
        userRoleName: "",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "m-golden-skull",
          chatId: "chat-1",
          role: "user",
          content: "Look what I have in my hand.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      participantNames: ["Julian", "Lara", "Yara", "Priyanka"],
    });

    expect(prepared.sceneState?.visibleFacts.join(" | ")).toMatch(/golden skull/i);
    expect(prepared.turnInterpretation?.requiresImmediateReaction).toBe(true);
    expect(prepared.turnInterpretation?.intent).toContain("visible object");
    expect(prepared.reactionPlan.mustAddress.join(" | ")).toContain(
      "Identify or react to the visible object directly.",
    );
  });

  it("promotes relevant saved user-profile facts when the user points at their current state", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile: {
        ...userProfile,
        about: "Sam is driving a black Mercedes coupe.",
      },
      relationshipState: {
        chatId: "chat-1",
        summary: "Everyone is friends.",
        currentScene: "",
        interactionTone: "",
        characterState: "",
        userState: "",
        userRoleName: "",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "m-mercedes",
          chatId: "chat-1",
          role: "user",
          content: "Look what I am driving.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    expect(prepared.sceneState?.visibleFacts.join(" | ")).toMatch(
      /Relevant saved user profile fact: Sam is driving a black Mercedes coupe/i,
    );
    expect(prepared.turnInterpretation?.requiresImmediateReaction).toBe(true);
    expect(prepared.turnInterpretation?.intent).toContain("saved user-profile fact");
    expect(prepared.reactionPlan.mustAddress.join(" | ")).toContain(
      "Use the relevant saved user-profile fact directly.",
    );
  });

  it("promotes relevant saved user-profile facts when the latest move points at them", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile: {
        ...userProfile,
        about: "Sam is driving a black Mercedes sedan.",
      },
      relationshipState: {
        chatId: "chat-1",
        summary: "Everyone is friends.",
        currentScene: "We are out on the road together.",
        interactionTone: "",
        characterState: "",
        userState: "",
        userRoleName: "",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "m-mercedes",
          chatId: "chat-1",
          role: "user",
          content: "Look what I am driving.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    expect(prepared.sceneState?.visibleFacts.join(" | ")).toMatch(/mercedes/i);
    expect(prepared.turnInterpretation?.requiresImmediateReaction).toBe(true);
    expect(prepared.turnInterpretation?.intent).toContain("saved user-profile fact");
    expect(prepared.reactionPlan.mustAddress.join(" | ")).toContain(
      "Use the relevant saved user-profile fact directly.",
    );
  });

  it("does not promote unrelated saved user-profile facts for a generic look/notice message", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile: {
        ...userProfile,
        name: "John Smith",
        about: "I am dressed like a medieval king. I have a longbow in my hand.",
      },
      relationshipState: {
        chatId: "chat-1",
        summary: "Everyone is friends.",
        currentScene: "We are all sitting by the beach.",
        interactionTone: "",
        characterState: "",
        userState: "",
        userRoleName: "",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "m-dolphin",
          chatId: "chat-1",
          role: "user",
          content: "Look there a dolphin",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      participantNames: ["Julian", "Lara", "Yara"],
    });

    expect(prepared.turnInterpretation?.intent).not.toContain("saved user-profile fact");
    expect(prepared.sceneState?.visibleFacts.join(" | ")).not.toContain(
      "Relevant saved user profile fact:",
    );
    expect(prepared.reactionPlan.mustAddress.join(" | ")).not.toContain(
      "Use the relevant saved user-profile fact directly.",
    );
  });

  it("promotes visible user injuries from the saved profile during an in-person entrance", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile: {
        ...userProfile,
        name: "John Smith",
        about: "My clothes are torn and face is bleeding. There are blood stains on my clothes.",
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
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "m-injured-entry",
          chatId: "chat-1",
          role: "user",
          content: "*I enter the room*\nHey everyone",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      participantNames: ["Julian", "Lara", "Yara", "Priyanka"],
    });

    expect(prepared.sceneState?.visibleFacts.join(" | ")).toMatch(/Visible user condition: .*bleeding/i);
    expect(prepared.turnInterpretation?.requiresImmediateReaction).toBe(true);
    expect(prepared.turnInterpretation?.intent).toContain("visible current condition");
    expect(prepared.reactionPlan.primaryGoal).toContain("visible condition");
  });

  it("uses concise character scenario as a current-scene fallback when no chat scene is saved", () => {
    const prepared = prepareResponseRequest({
      speaker: {
        ...speaker,
        scenario: "She is lying on her bed naked.",
      },
      userProfile,
      contextEntries: [],
      history: [
        {
          id: "m-bedroom-scene",
          chatId: "chat-1",
          role: "user",
          content: "hey wassup",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    expect(prepared.context.sceneStateInput?.currentScene).toBe(
      "She is lying on her bed naked.",
    );
    expect(prepared.sceneState?.currentScene).toBe("She is lying on her bed naked.");
    expect(prepared.responsePlan?.sceneAnchor).toBe("She is lying on her bed naked.");
    expect(
      prepared.compiledPrompt.systemSections.find(
        (section) => section.key === "turn_frame",
      )?.content,
    ).toContain("Current live scene: She is lying on her bed naked.");
  });

  it("keeps user-profile props as background when the latest turn does not point at them", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile: {
        ...userProfile,
        about: "I am dressed like a medieval king. I have a longbow in my hand.",
      },
      contextEntries: [],
      history: [
        {
          id: "m-ordinary-greeting",
          chatId: "chat-1",
          role: "user",
          content: "hey wassup",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    const mergedSystem = promptInstructions(prepared.compiledPrompt);
    expect(prepared.sceneState?.visibleFacts.join(" | ") ?? "").not.toContain(
      "Visible user-held object",
    );
    expect(prepared.reactionPlan.continuityAnchors.join(" | ")).not.toContain(
      "User profile:",
    );
    expect(mergedSystem).toContain("Background about the user:");
    expect(mergedSystem).toContain(
      "Treat saved user-profile clothing, props, weapons, vehicles, and biography as background unless the latest user move points at them.",
    );
  });

  it("extracts explicit user choices and marks grounded venue scenes as companion outings", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile,
      relationshipState: {
        chatId: "chat-1",
        summary: "Friendly",
        currentScene: "We are sitting in a pizzeria.",
        interactionTone: "Friendly",
        characterState: "",
        userState: "",
        userRoleName: "",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "m-pizza-choice",
          chatId: "chat-1",
          role: "user",
          content: "I wanna have cheese pizza I say looking at the menu card",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      participantNames: ["Julian", "Pooja"],
    });

    expect(prepared.context.explicitUserChoice).toEqual({
      kind: "preference",
      surfaceText: "cheese pizza",
      anchorTokens: ["cheese", "pizza"],
      headTokens: ["cheese", "pizza"],
    });
    expect(prepared.sceneState?.sceneRoleExpectation).toBe("companions");
    expect(prepared.reactionPlan.mustAddress.join(" | ")).toContain(
      "The user's stated preference is cheese pizza. Treat that as the current baseline.",
    );
    expect(prepared.reactionPlan.forbiddenMoves.join(" | ")).toContain(
      "Do not act like venue staff, a waiter, an order-taker, a salesperson, or a clerk; react like a companion sharing the outing.",
    );
  });

  it("promotes turn frame and response contract into the compiled prompt", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile,
      relationshipState: {
        chatId: "chat-1",
        summary: "Friendly",
        currentScene: "We are in a supermarket.",
        interactionTone: "Friendly",
        characterState: "",
        userState: "",
        userRoleName: "",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "m-almond-milk",
          chatId: "chat-1",
          role: "user",
          content: "I want to get some almond milk as my eyes try to locate the milk shelf",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      participantNames: ["Lara", "Pooja"],
    });

    const turnFrameSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "turn_frame",
    );
    const responseContractSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "response_contract",
    );

    expect(prepared.turnFrame?.userAction).toBe("search");
    expect(prepared.turnFrame?.topic).toContain("almond milk");
    expect(prepared.turnFrame?.locationTarget).toBe("shelf");
    expect(turnFrameSection?.content).toContain("Visible search/action cue");
    expect(responseContractSection?.content).toContain("Must acknowledge:");
    expect(responseContractSection?.content).toContain("almond milk");
    expect(responseContractSection?.content).toContain("Output contract:");
  });

  it("keeps live user and scene grounding inside the merged group system prompt even for huge cards", () => {
    const prepared = prepareResponseRequest({
      speaker: {
        ...speaker,
        description: "Lara ".repeat(600),
        personality: "Scientist ".repeat(600),
        scenario: "Working on design drawings and old engineering plans. ".repeat(120),
        exampleDialogue: "User: Tell me about the portal.\nJulian: The design still needs work.\n".repeat(40),
      },
      userProfile: {
        ...userProfile,
        about: "Sam has a Golden Skull in his hands.",
      },
      relationshipState: {
        chatId: "chat-1",
        summary: "Everyone is friends.",
        currentScene: "We are sitting in the dining room eating pizza.",
        interactionTone: "",
        characterState: "",
        userState: "",
        userRoleName: "Sam",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "m-golden-skull",
          chatId: "chat-1",
          role: "user",
          content: "Look what I have in my hand.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      participantNames: ["Julian", "Lara", "Yara", "Priyanka"],
    });

    const mergedSystem = promptInstructions(prepared.compiledPrompt);

    expect(mergedSystem).toContain("It is this character's turn right now.");
    expect(mergedSystem).toContain("About the user: Sam has a Golden Skull in his hands.");
    expect(mergedSystem).toContain(
      "If the latest move points at the user's current state or possessions",
    );
    expect(mergedSystem).toContain(
      "Current live scene: We are sitting in the dining room eating pizza.",
    );
    expect(mergedSystem).toMatch(/Visible user-held object: .*golden skull/i);
    expect(mergedSystem).toContain("Latest user move:");
    expect(mergedSystem).toContain("Raw latest user move: Look what I have in my hand.");
    expect(mergedSystem).not.toContain("Scenario and roleplay framing:");
    expect(prepared.compiledPrompt.exampleMessages).toEqual([]);
    expect(prepared.runtimeRequest.max_tokens).toBe(512);
  });

  it("treats consecutive user messages after one assistant as a single live turn", () => {
    const prepared = prepareResponseRequest({
      speaker: {
        ...speaker,
        name: "Pooja",
        scenario: "She is resting in her room.",
      },
      userProfile: {
        ...userProfile,
        name: "John",
      },
      contextEntries: [],
      history: [
        {
          id: "a1",
          chatId: "chat-1",
          role: "assistant",
          content: "I am so sorry. Please forgive me.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "u1",
          chatId: "chat-1",
          role: "user",
          content: "no need for forgiveness, i like what i see I say with a hint of flirt",
          createdAt: "2026-01-01T00:01:00.000Z",
        },
        {
          id: "u2",
          chatId: "chat-1",
          role: "user",
          content: "???",
          createdAt: "2026-01-01T00:02:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    const mergedSystem = promptInstructions(prepared.compiledPrompt);

    expect(prepared.context.latestUserMessage).toContain("no need for forgiveness");
    expect(prepared.context.latestUserMessage).toContain("???");
    expect(prepared.turnInterpretation?.actionType).toBe("question");
    expect(prepared.turnFrame?.stopInstruction).toBeNull();
    expect(prepared.responsePlan?.mustAvoid.join(" ")).not.toContain("forgiveness");
    expect(mergedSystem).toContain("Raw latest user move: no need for forgiveness");
    expect(mergedSystem).toContain("???");
  });

  it("compresses heavy imported lore without lowering the single-chat token budget", () => {
    const prepared = prepareResponseRequest({
      speaker: {
        ...speaker,
        description: "**Yulian** ".repeat(700),
        personality: "Gentle and trapped by imperial duty. ".repeat(220),
        backstory: "Raised under a tyrant father and forced toward an arranged marriage. ".repeat(120),
        scenario: "The imperial wedding cathedral is packed with nobility and old obligation. ".repeat(160),
        greeting:
          "The Winter Palace cathedral swelled with bodies, candlelight, incense, and duty. ".repeat(50),
        exampleDialogue:
          "{{user}}: Who are you?\n{{char}}: I am the Tsarevich.\n".repeat(60),
      },
      userProfile: {
        ...userProfile,
        name: "John Smith",
        about: "I am dressed like a medieval king. I have a longbow in my hand.",
        gender: "Man",
      },
      contextEntries: [],
      history: [
        {
          id: "m-hi",
          chatId: "chat-1",
          role: "user",
          content: "hi",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
    });

    const identity = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "character_identity",
    );
    const scene = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "character_scene",
    );
    const mergedSystem = promptInstructions(prepared.compiledPrompt);

    expect(prepared.runtimeRequest.max_tokens).toBe(512);
    expect(identity?.content.length ?? 0).toBeLessThan(1300);
    expect(scene?.content.length ?? 0).toBeLessThan(320);
    expect(mergedSystem).toContain("Raw latest user move: hi");
    expect(systemPromptOf(prepared.compiledPrompt).length).toBeLessThan(4300);
    expect(prepared.compiledPrompt.exampleMessages).toHaveLength(8);
  });

  it("preserves prior group speaker identities in runtime history", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile,
      contextEntries: [],
      history: [
        {
          id: "u1",
          chatId: "chat-1",
          role: "user",
          content: "Everyone, focus.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "a1",
          chatId: "chat-1",
          role: "assistant",
          content: "We're listening.",
          speakerCharacterId: "char-lara",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "a2",
          chatId: "chat-1",
          role: "assistant",
          content: "Then stop stalling and say it.",
          speakerCharacterId: "char-yara",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "u2",
          chatId: "chat-1",
          role: "user",
          content: "I need one answer from Julian.",
          createdAt: "2026-01-01T00:00:03.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      participantNames: ["Julian", "Lara", "Yara"],
      participantDirectory: {
        "char-1": "Julian",
        "char-lara": "Lara",
        "char-yara": "Yara",
      },
    });

    const runtimeMessages = toLlamaChatMessages(prepared.compiledPrompt);
    const groupStateSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "group_round_state",
    );

    expect(runtimeMessages).toContainEqual({
      role: "user",
      content: "[Group speaker: Lara]\nWe're listening.",
    });
    expect(runtimeMessages).toContainEqual({
      role: "user",
      content: "[Group speaker: Yara]\nThen stop stalling and say it.",
    });
    expect(promptInstructions(prepared.compiledPrompt)).toContain(
      "Treat another speaker's lines as room context, not as your own words.",
    );
    expect(JSON.stringify(runtimeMessages)).not.toContain("Previous group reply");
    expect(withoutTurnNotes(runtimeMessages[runtimeMessages.length - 1])).toEqual({
      role: "user",
      content: "I need one answer from Julian.",
    });
    expect(prepared.context.groupRoundState?.priorReplies).toEqual([]);
    expect(prepared.context.groupRoundState?.addressedParticipants).toEqual(["Julian"]);
    expect(prepared.context.groupRoundState?.currentSpeakerRole).toBe("directly_addressed");
    expect(prepared.context.groupRoundState?.engagementExpectation).toBe("none");
    expect(prepared.context.groupRoundState?.currentSocialBeat).toMatch(
      /No prior same-round reply/i,
    );
    expect(groupStateSection?.content).toContain("Current speaker obligations:");
  });

  it("uses a concise identity-and-memory prompt for the shipped 0.5B model", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile,
      contextEntries: [],
      memory: {
        chatId: "chat-1",
        summary: "Sam told Julian that jasmine is his favorite tea.",
        facts: ["My favorite tea is jasmine"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      history: [
        {
          id: "u1",
          chatId: "chat-1",
          role: "user",
          content: "What tea would you bring me?",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "qwen2.5-0.5b-instruct-q4_k_m",
        stream: true,
      },
    });

    const sectionKeys = prepared.compiledPrompt.systemSections.map(
      (section) => section.key,
    );
    const mergedSystem = promptInstructions(prepared.compiledPrompt);

    expect(sectionKeys).toContain("character_identity");
    expect(sectionKeys).toContain("memory_summary");
    expect(sectionKeys).not.toContain("reaction_plan");
    expect(sectionKeys).not.toContain("response_contract");
    expect(mergedSystem).toContain("jasmine");
    expect(mergedSystem).toContain("not a description of the desired voice");
    expect(systemPromptOf(prepared.compiledPrompt).length).toBeLessThanOrEqual(3600);
  });

  it("keeps same-round group replies as structured room context instead of runtime assistant history", () => {
    const prepared = prepareResponseRequest({
      speaker,
      userProfile,
      contextEntries: [],
      history: [
        {
          id: "u1",
          chatId: "chat-1",
          role: "user",
          content: "Everyone, focus.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "a1",
          chatId: "chat-1",
          role: "assistant",
          content: "We're listening.",
          speakerCharacterId: "char-lara",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "a2",
          chatId: "chat-1",
          role: "assistant",
          content: "Then stop stalling and say it.",
          speakerCharacterId: "char-yara",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group",
      participantNames: ["Julian", "Lara", "Yara"],
      participantDirectory: {
        "char-1": "Julian",
        "char-lara": "Lara",
        "char-yara": "Yara",
      },
    });

    const runtimeMessages = toLlamaChatMessages(prepared.compiledPrompt);
    const groupStateSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "group_round_state",
    );

    expect(withoutTurnNotes(runtimeMessages[runtimeMessages.length - 1])).toEqual({
      role: "user",
      content: "Everyone, focus.",
    });
    expect(JSON.stringify(runtimeMessages)).not.toContain("Previous group reply");
    expect(runtimeMessages.some((message) => message.role === "assistant")).toBe(false);
    expect(prepared.context.groupRoundState?.priorReplies).toEqual([
      {
        speakerCharacterId: "char-lara",
        speakerName: "Lara",
        gist: "We're listening.",
        socialEffect: "adds a personal angle to the exchange",
        emotionalTone: "steady",
      },
      {
        speakerCharacterId: "char-yara",
        speakerName: "Yara",
        gist: "Then stop stalling and say it.",
        socialEffect: "adds a personal angle to the exchange",
        emotionalTone: "steady",
      },
    ]);
    expect(prepared.context.groupRoundState?.addressedParticipants).toEqual([]);
    expect(prepared.context.groupRoundState?.currentSpeakerRole).toBe("shared_group");
    expect(prepared.context.groupRoundState?.engagementExpectation).toBe("required");
    expect(prepared.context.groupRoundState?.currentSocialBeat).toContain(
      "Yara adds a personal angle to the exchange in a steady tone.",
    );
    expect(prepared.context.groupRoundState?.expectedSocialMove).toMatch(
      /existing room beat|changed your angle/i,
    );
    expect(prepared.context.groupRoundState?.engagementTargets).toEqual(["Lara", "Yara"]);
    expect(prepared.context.groupRoundState?.engagementCueTokens).toEqual(
      expect.arrayContaining(["listening", "stalling"]),
    );
    expect(groupStateSection?.content).toContain("Earlier replies this round:");
    expect(groupStateSection?.content).toContain(
      "Use these as room context already heard by the current speaker",
    );
    expect(groupStateSection?.content).toContain(
      "Lara: adds a personal angle to the exchange; tone=steady; gist=We're listening.",
    );
    expect(groupStateSection?.content).toContain("Current social beat:");
    expect(groupStateSection?.content).toContain("Expected social move:");
  });

  it("routes provocative direct-address group turns as live social beats", () => {
    const poojaSpeaker: Character = {
      ...speaker,
      id: "char-pooja",
      name: "Pooja",
      tags: ["playful", "direct"],
      speechStyle: "Warm, teasing, and socially quick.",
    };
    const yulianSpeaker: Character = {
      ...speaker,
      id: "char-yulian",
      name: "Yulian",
      tags: ["guarded", "observant"],
      speechStyle: "Dry, restrained, and socially observant.",
    };
    const baseInput = {
      userProfile,
      relationshipState: {
        chatId: "chat-1",
        summary: "Everyone is having dinner together.",
        currentScene: "We are sitting in a restaurant after discussing food.",
        interactionTone: "Playful group banter.",
        characterState: "",
        userState: "",
        userRoleName: "",
        userRoleDescription: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      contextEntries: [],
      history: [
        {
          id: "u-pooja-direct",
          chatId: "chat-1",
          role: "user" as const,
          content: "I wanna eat you Pooja *I say naughtily*",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      sampling: {},
      runtime: {
        model: "test-model",
        stream: true,
      },
      mode: "group" as const,
      participantNames: ["Yulian", "Pooja", "Lara"],
      participantDirectory: {
        "char-yulian": "Yulian",
        "char-pooja": "Pooja",
        "char-lara": "Lara",
      },
    };

    const poojaPrepared = prepareResponseRequest({
      ...baseInput,
      speaker: poojaSpeaker,
    });
    const yulianPrepared = prepareResponseRequest({
      ...baseInput,
      speaker: yulianSpeaker,
    });
    const poojaGroupSection = poojaPrepared.compiledPrompt.systemSections.find(
      (section) => section.key === "group_round_state",
    );
    const yulianGroupSection = yulianPrepared.compiledPrompt.systemSections.find(
      (section) => section.key === "group_round_state",
    );

    expect(poojaPrepared.groupRoundState?.addressedParticipants).toEqual(["Pooja"]);
    expect(poojaPrepared.groupRoundState?.latestUserSocialTone).toBe("provocative");
    expect(poojaPrepared.groupRoundState?.currentSpeakerRole).toBe("directly_addressed");
    expect(poojaPrepared.groupRoundState?.currentSocialBeat).toMatch(/provocative\/flirtatious/i);
    expect(poojaPrepared.groupRoundState?.expectedSocialMove).toMatch(/addressee/i);
    expect(poojaPrepared.responsePlan?.groupObligation).toMatch(/addressee.*provocative/i);
    expect(poojaPrepared.reactionPlan.primaryGoal).toMatch(/addressee.*provocative/i);
    expect(poojaPrepared.reactionPlan.forbiddenMoves.join(" ")).toMatch(/stale practical topic/i);
    expect(poojaGroupSection?.content).toContain("Latest user social tone: provocative");

    expect(yulianPrepared.groupRoundState?.addressedParticipants).toEqual(["Pooja"]);
    expect(yulianPrepared.groupRoundState?.latestUserSocialTone).toBe("provocative");
    expect(yulianPrepared.groupRoundState?.currentSpeakerRole).toBe("observer_to_other_address");
    expect(yulianPrepared.groupRoundState?.expectedSocialMove).toMatch(/hearing.*Pooja/i);
    expect(yulianPrepared.responsePlan?.groupObligation).toMatch(/observing.*Pooja/i);
    expect(yulianPrepared.reactionPlan.primaryGoal).toMatch(/observing participant.*Pooja/i);
    expect(yulianPrepared.reactionPlan.forbiddenMoves.join(" ")).toMatch(/addressed to you/i);
    expect(yulianGroupSection?.content).toContain("Latest user social tone: provocative");
  });
});
