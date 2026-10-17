import type { CompiledCharacterPromptInput } from "./types";
import { compileResponseRequest } from "../response-system/compile/compile-response-request";
import { interpretLatestUserTurn } from "../response-system/interpretation/interpret-latest-turn";
import { buildCharacterReactionPlan } from "../response-system/planning/build-reaction-plan";
import { deriveDynamicSceneState } from "../response-system/scene/derive-scene-state";

function latestUserMessage(history: CompiledCharacterPromptInput["history"]): string | undefined {
  return [...history].reverse().find((message) => message.role === "user")?.content;
}

export function compileCharacterPrompt(input: CompiledCharacterPromptInput) {
  const sceneState = deriveDynamicSceneState({
    speaker: input.speaker,
    userProfile: input.userProfile,
    relationshipState: input.relationshipState,
    history: input.history,
  });
  const turnInterpretation = interpretLatestUserTurn({
    speaker: input.speaker,
    userProfile: input.userProfile,
    relationshipState: input.relationshipState,
    history: input.history,
  });
  const reactionPlan = buildCharacterReactionPlan({
    speaker: input.speaker,
    userProfile: input.userProfile,
    relationshipState: input.relationshipState,
    sceneStateInput: input.relationshipState
      ? {
          currentScene: input.relationshipState.currentScene,
          interactionTone: input.relationshipState.interactionTone,
          characterState: input.relationshipState.characterState,
          userState: input.relationshipState.userState,
        }
      : null,
    memory: input.memory,
    contextEntries: input.contextEntries,
    semanticMemorySnippets: input.semanticMemorySnippets ?? [],
    history: input.history,
    latestUserMessage: latestUserMessage(input.history),
    mode: "single",
    sceneState,
    turnInterpretation,
  });

  return compileResponseRequest({
    speaker: input.speaker,
    userProfile: input.userProfile,
    relationshipState: input.relationshipState,
    memory: input.memory,
    contextEntries: input.contextEntries,
    semanticMemorySnippets: input.semanticMemorySnippets,
    history: input.history,
    sceneState,
    turnInterpretation,
    reactionPlan,
  });
}
