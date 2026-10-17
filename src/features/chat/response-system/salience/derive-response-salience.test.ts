import { describe, expect, it } from "vitest";

import type { Character, ChatRelationshipState, UserProfile } from "../../../../types";
import { createResponseContext } from "../prepare";
import { deriveDynamicSceneState } from "../scene/derive-scene-state";
import { interpretLatestUserTurn } from "../interpretation/interpret-latest-turn";
import { deriveResponseSalienceProfile } from "./derive-response-salience";

const speaker: Character = {
  id: "char-1",
  name: "Lara",
  description: "A focused engineer.",
  personality: "",
  backstory: "",
  scenario: "She usually talks about design drawings and projects.",
  systemPrompt: "",
  postHistoryInstructions: "",
  speechStyle: "",
  greeting: "",
  alternateGreetings: [],
  avatar: "",
  tags: [],
  likes: [],
  dislikes: [],
  boundaries: "",
  creatorNotes: "",
  creator: "",
  characterVersion: "",
  cardExtensions: {},
  exampleDialogue: "",
  createdAt: "",
  updatedAt: "",
};

const injuredUser: UserProfile = {
  name: "John Smith",
  about: "My clothes are torn and face is bleeding. There are blood stains on my clothes.",
  gender: "Man",
  avatar: "",
  traits: [],
  preferences: "",
  boundaries: "",
  createdAt: "",
  updatedAt: "",
};

const relationshipState: ChatRelationshipState = {
  chatId: "chat-1",
  summary: "Everyone is friends",
  currentScene: "We are sitting in dining room eating pizza.",
  interactionTone: "",
  characterState: "",
  userState: "",
  userRoleName: "",
  userRoleDescription: "",
  updatedAt: "",
};

describe("deriveResponseSalienceProfile", () => {
  it("prioritizes live scene and user state above character lore during an injured entrance", () => {
    const history = [
      {
        id: "user-1",
        chatId: "chat-1",
        role: "user" as const,
        content: "*I enter the room*\nHey everyone",
        createdAt: "",
      },
    ];
    const context = createResponseContext({
      speaker,
      userProfile: injuredUser,
      relationshipState,
      contextEntries: [],
      history,
      sampling: {},
      runtime: { model: "test-model", stream: true },
      mode: "group",
      participantNames: ["Lara", "Yara", "Pooja"],
    });
    context.sceneState = deriveDynamicSceneState({
      speaker,
      userProfile: injuredUser,
      relationshipState,
      history,
    });
    context.turnInterpretation = interpretLatestUserTurn({
      speaker,
      userProfile: injuredUser,
      relationshipState,
      history,
    });

    const profile = deriveResponseSalienceProfile(context);

    expect(profile.latestUserMoveWeight).toBe(100);
    expect(profile.liveSceneWeight).toBeGreaterThan(profile.characterLoreWeight);
    expect(profile.userProfileWeight).toBeGreaterThan(profile.memoryWeight);
    expect(profile.suppressStaticScenario).toBe(true);
    expect(profile.rankedFocus[0]?.key).toBe("latest_user_move");
    expect(profile.rankedFocus[1]?.key).toBe("live_scene");
  });

  it("keeps character lore more available in lower-pressure turns", () => {
    const calmUser: UserProfile = {
      ...injuredUser,
      about: "I like long drives and old music.",
    };
    const history = [
      {
        id: "user-2",
        chatId: "chat-1",
        role: "user" as const,
        content: "How has your day been?",
        createdAt: "",
      },
    ];
    const context = createResponseContext({
      speaker,
      userProfile: calmUser,
      relationshipState: {
        ...relationshipState,
        currentScene: "",
        summary: "",
      },
      contextEntries: [],
      history,
      sampling: {},
      runtime: { model: "test-model", stream: true },
    });
    context.sceneState = deriveDynamicSceneState({
      speaker,
      userProfile: calmUser,
      relationshipState: undefined,
      history,
    });
    context.turnInterpretation = interpretLatestUserTurn({
      speaker,
      userProfile: calmUser,
      relationshipState: undefined,
      history,
    });

    const profile = deriveResponseSalienceProfile(context);

    expect(profile.characterLoreWeight).toBeGreaterThan(25);
    expect(profile.suppressStaticScenario).toBe(false);
  });

  it("makes explicit live scene context outrank static card and unpromoted profile lore", () => {
    const calmUser: UserProfile = {
      ...injuredUser,
      about: "I carry a longbow and wear a jeweled crown.",
    };
    const liveRelationship: ChatRelationshipState = {
      ...relationshipState,
      summary: "They are traveling together.",
      currentScene: "We are waiting beside an airport taxi stand.",
    };
    const history = [
      {
        id: "user-3",
        chatId: "chat-1",
        role: "user" as const,
        content: "The cab is here.",
        createdAt: "",
      },
    ];
    const context = createResponseContext({
      speaker: {
        ...speaker,
        scenario: "She is lying on her bed in a private chamber.",
      },
      userProfile: calmUser,
      relationshipState: liveRelationship,
      contextEntries: [],
      history,
      sampling: {},
      runtime: { model: "test-model", stream: true },
    });
    context.sceneState = deriveDynamicSceneState({
      speaker,
      userProfile: calmUser,
      relationshipState: liveRelationship,
      sceneStateInput: context.sceneStateInput,
      history,
    });
    context.turnInterpretation = interpretLatestUserTurn({
      speaker,
      userProfile: calmUser,
      relationshipState: liveRelationship,
      sceneStateInput: context.sceneStateInput,
      history,
    });

    const profile = deriveResponseSalienceProfile(context);

    expect(profile.suppressStaticScenario).toBe(true);
    expect(profile.liveSceneWeight).toBeGreaterThan(profile.characterLoreWeight);
    expect(profile.liveSceneWeight).toBeGreaterThan(profile.userProfileWeight);
    expect(profile.rankedFocus[0]?.key).toBe("latest_user_move");
    expect(profile.rankedFocus[1]?.key).toBe("live_scene");
  });
});
