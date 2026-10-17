import { describe, expect, it } from "vitest";
import type {
  Character,
  ChatMemory,
  ChatMessage,
  ChatRelationshipState,
  ContextEntry,
  MemorySnippet,
  UserProfile,
} from "../../../types";
import { compileCharacterPrompt } from "./compiler";
import { buildCharacterRetrievalHints } from "./retrieval";

const speaker: Character = {
  id: "char-1",
  name: "Aria",
  description: "A sharp but caring detective with a dry sense of humor.",
  backstory: "Former internal affairs investigator who burned bridges exposing corruption.",
  scenario: "Meeting Sam in a diner after a dangerous case cracked open.",
  systemPrompt: "Never break character. Speak like Aria, not a generic assistant.",
  speechStyle: "Short, observant sentences with dry wit and flashes of warmth.",
  greeting: "You made it.",
  alternateGreetings: ["You made it back.", "There you are."],
  tags: ["observant", "dry", "protective"],
  likes: ["honesty", "follow-through"],
  dislikes: ["evasiveness", "grandstanding"],
  boundaries: "She does not grovel, flatter, or become syrupy.",
  creatorNotes: "Keep Aria grounded and emotionally restrained.",
  exampleDialogue: [
    "User: Can I trust you?",
    "Aria: Depends. But if you want the truth, stay close and listen.",
  ].join("\n"),
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const userProfile: UserProfile = {
  name: "Sam",
  about: "Sam likes emotionally grounded roleplay and direct answers.",
  gender: "",
  avatar: "",
  traits: ["curious", "persistent"],
  preferences: "Prefers tension with warmth.",
  boundaries: "Avoids cruelty and humiliation.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const relationshipState: ChatRelationshipState = {
  chatId: "chat-1",
  summary: "Aria and Sam trust each other after several close calls.",
  currentScene: "A quiet diner after midnight.",
  interactionTone: "Low-key, intimate, and slightly guarded.",
  characterState: "Tired, alert, and protective.",
  userState: "Anxious but steady.",
  userRoleName: "",
  userRoleDescription: "",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const memory: ChatMemory = {
  chatId: "chat-1",
  summary: "Sam previously revealed fear of abandonment.",
  facts: ["Sam hates being lied to", "Aria promised honesty"],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const contextEntries: ContextEntry[] = [
  {
    id: "ctx-1",
    scope: "character",
    characterId: "char-1",
    title: "Case File",
    keywords: ["conspiracy", "diner"],
    content: "The conspiracy reaches into city hall.",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const semanticMemorySnippets: MemorySnippet[] = [
  {
    chatId: "chat-1",
    role: "user",
    content: "Please don't disappear on me again.",
    createdAt: "2026-01-01T00:00:00.000Z",
    score: 0.92,
  },
];

const history: ChatMessage[] = [
  {
    id: "m1",
    chatId: "chat-1",
    role: "user",
    content: "Tell me what you found.",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("character prompt compiler", () => {
  it("assembles identity, user, relationship, context, memory, and examples", () => {
    const compiled = compileCharacterPrompt({
      speaker,
      userProfile,
      relationshipState,
      memory,
      contextEntries,
      semanticMemorySnippets,
      history,
    });

    expect(compiled.systemSections.map((section) => section.key)).toEqual([
      "system_contract",
      "latest_user_move",
      "dynamic_scene_state",
      "turn_interpretation",
      "character_identity",
      "reaction_plan",
      "identity_guardrails",
      "user_profile",
      "relationship_state",
      "response_style",
      "character_rules",
      "character_dynamics",
      "world_context",
      "memory_summary",
      "memory_snippets",
    ]);
    const section = (key: (typeof compiled.systemSections)[number]["key"]) =>
      compiled.systemSections.find((entry) => entry.key === key)?.content ?? "";

    expect(section("system_contract")).toContain("Write only the next in-character reply in plain text.");
    expect(section("character_identity")).toContain("You are Aria.");
    expect(section("character_identity")).toContain("A sharp but caring detective");
    expect(section("character_identity")).toContain("Former internal affairs investigator");
    expect(section("identity_guardrails")).toContain("Stay recognizably Aria");
    expect(section("identity_guardrails")).toContain("Core personality anchors: observant, dry, protective");
    expect(section("identity_guardrails")).toContain("Never violate these character boundaries");
    expect(compiled.systemSections.map((item) => item.content).join("\n")).not.toContain(
      speaker.creatorNotes,
    );
    expect(section("response_style")).not.toContain("Alternate opening lines");
    expect(section("latest_user_move")).toContain("Tell me what you found.");
    expect(section("user_profile")).toContain("Sam likes emotionally grounded roleplay");
    expect(section("relationship_state")).toContain("A quiet diner after midnight.");
    expect(section("dynamic_scene_state")).toContain("Power dynamic:");
    expect(section("turn_interpretation")).toContain("Latest user move type: request");
    expect(section("reaction_plan")).toContain("Immediate objective:");
    expect(section("reaction_plan")).toContain("Primary goal:");
    expect(section("reaction_plan")).toContain("Opening move:");
    expect(section("response_style")).toContain("Voice reference from the opening line");
    expect(section("response_style")).toContain("Speaking style");
    expect(section("character_rules")).toContain("Never break character.");
    expect(section("character_scene")).toBe("");
    expect(section("character_dynamics")).toContain("Usually drawn toward: honesty");
    expect(compiled.exampleMessages).toEqual([
      { role: "user", content: "Can I trust you?", source: "example_dialogue" },
      {
        role: "assistant",
        content: "Depends. But if you want the truth, stay close and listen.",
        source: "example_dialogue",
      },
    ]);
    expect(compiled.historyMessages).toEqual([{ role: "user", content: "Tell me what you found." }]);
  });

  it("builds retrieval hints from the same canonical inputs", () => {
    const hints = buildCharacterRetrievalHints({
      speaker,
      userProfile,
      relationshipState,
    });

    expect(hints).toContain("Character: Aria");
    expect(hints).toContain("User name: Sam");
    expect(hints).toContain("Interaction tone: Low-key, intimate, and slightly guarded.");
  });

  it("omits empty optional prompt layers", () => {
    const compiled = compileCharacterPrompt({
      speaker: {
        ...speaker,
        description: "",
        backstory: "",
        scenario: "",
        systemPrompt: "",
        speechStyle: "",
        alternateGreetings: [],
        exampleDialogue: "",
        tags: [],
        likes: [],
        dislikes: [],
        boundaries: "",
      },
      contextEntries: [],
      history,
    });

    expect(compiled.systemSections.map((section) => section.key)).toEqual([
      "system_contract",
      "latest_user_move",
      "turn_interpretation",
      "character_identity",
      "reaction_plan",
      "identity_guardrails",
      "response_style",
    ]);
    expect(compiled.exampleMessages).toEqual([]);
  });

  it("parses multiline card-style example dialogue into alternating examples", () => {
    const compiled = compileCharacterPrompt({
      speaker: {
        ...speaker,
        exampleDialogue: [
          "{{user}}: You look tired.",
          "{{char}}: Tired is one word for it.",
          "I still showed up, didn't I?",
          "",
          "User: Why?",
          "Aria: Because I said I would.",
        ].join("\n"),
      },
      contextEntries: [],
      history,
    });

    expect(compiled.exampleMessages).toEqual([
      { role: "user", content: "You look tired.", source: "example_dialogue" },
      {
        role: "assistant",
        content: "Tired is one word for it. I still showed up, didn't I?",
        source: "example_dialogue",
      },
      { role: "user", content: "Why?", source: "example_dialogue" },
      {
        role: "assistant",
        content: "Because I said I would.",
        source: "example_dialogue",
      },
    ]);
  });

  it("keeps the selected opening greeting in prompt history", () => {
    const compiled = compileCharacterPrompt({
      speaker: {
        ...speaker,
        greeting:
          "\"My prince...\" Anastasia's voice trembled in the cathedral air.\n\nHe turned slowly beneath the stained-glass light.",
      },
      contextEntries: [],
      history: [
        {
          id: "m-opening",
          chatId: "chat-1",
          role: "assistant",
          content:
            "\"My prince...\" Anastasia's voice trembled in the cathedral air.\n\nHe turned slowly beneath the stained-glass light.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m-user",
          chatId: "chat-1",
          role: "user",
          content: "What are you doing?",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const responseStyle = compiled.systemSections.find((section) => section.key === "response_style");
    expect(responseStyle?.content).not.toContain("Voice reference from the opening line");
    expect(compiled.historyMessages).toEqual([
      {
        role: "assistant",
        content:
          "\"My prince...\" Anastasia's voice trembled in the cathedral air.\n\nHe turned slowly beneath the stained-glass light.",
      },
      { role: "user", content: "What are you doing?" },
    ]);
  });

  it("derives dynamic scene state and armed-command interpretation from the latest user turn", () => {
    const compiled = compileCharacterPrompt({
      speaker,
      userProfile,
      relationshipState: {
        ...relationshipState,
        currentScene: "A tense alley standoff.",
        userState: "Holding an AK47 and ordering Chris to comply.",
      },
      contextEntries: [],
      history: [
        {
          id: "u-armed",
          chatId: "chat-1",
          role: "user",
          content: "Put your hands up. I have an AK47 on you.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const dynamicScene = compiled.systemSections.find(
      (section) => section.key === "dynamic_scene_state",
    );
    const latestTurn = compiled.systemSections.find(
      (section) => section.key === "turn_interpretation",
    );

    expect(dynamicScene?.content).toContain("AK47");
    expect(dynamicScene?.content).toContain("tactical advantage");
    expect(latestTurn?.content).toContain("Latest user move type: armed-command");
    expect(latestTurn?.content).toContain("Do not mirror the command wording back.");
  });

  it("treats visible non-weapon objects as immediate scene facts", () => {
    const compiled = compileCharacterPrompt({
      speaker,
      userProfile: {
        ...userProfile,
        about: "Sam has a golden skull in his hands.",
      },
      relationshipState: {
        ...relationshipState,
        currentScene: "We are sitting in the dining room eating pizza.",
      },
      contextEntries: [],
      history: [
        {
          id: "u-object",
          chatId: "chat-1",
          role: "user",
          content: "Look what I have in my hand.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const dynamicScene = compiled.systemSections.find(
      (section) => section.key === "dynamic_scene_state",
    );
    const latestTurn = compiled.systemSections.find(
      (section) => section.key === "turn_interpretation",
    );

    expect(dynamicScene?.content).toMatch(/golden skull/i);
    expect(latestTurn?.content).toContain("visible object");
    expect(latestTurn?.content).toContain("Do not drift into unrelated backstory");
  });

  it("treats relevant user-profile facts as live cues when the user points at them", () => {
    const compiled = compileCharacterPrompt({
      speaker,
      userProfile: {
        ...userProfile,
        about: "Sam is driving a black Mercedes sedan.",
      },
      relationshipState: {
        ...relationshipState,
        currentScene: "A late-night drive through the city.",
      },
      contextEntries: [],
      history: [
        {
          id: "u-driving",
          chatId: "chat-1",
          role: "user",
          content: "Look what I am driving.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const dynamicScene = compiled.systemSections.find(
      (section) => section.key === "dynamic_scene_state",
    );
    const latestTurn = compiled.systemSections.find(
      (section) => section.key === "turn_interpretation",
    );

    expect(dynamicScene?.content).toMatch(/Relevant saved user profile fact: Sam is driving a black Mercedes sedan/i);
    expect(latestTurn?.content).toContain("saved user-profile fact");
    expect(latestTurn?.content).toContain("Use the relevant saved user-profile fact directly.");
  });
});
