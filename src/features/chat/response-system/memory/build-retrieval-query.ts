import { clipText } from "../compile/prompt-budget";
import {
  deriveDynamicSceneState,
} from "../scene/derive-scene-state";
import { interpretLatestUserTurn } from "../interpretation/interpret-latest-turn";
import type { ResponseSystemInput } from "../types";

function formatList(label: string, values: string[]): string | null {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return null;
  }
  return `${label}: ${normalized.join(", ")}`;
}

export function buildResponseRetrievalHints(
  input: Pick<ResponseSystemInput, "speaker" | "userProfile" | "relationshipState" | "sceneStateInput">,
): string | undefined {
  const lines: string[] = [];
  const speaker = input.speaker;
  const userProfile = input.userProfile;
  const relationshipState = input.relationshipState;

  if (speaker?.name.trim()) {
    lines.push(`Character: ${speaker.name.trim()}`);
  }
  if (speaker?.description.trim()) {
    lines.push(`Character identity: ${clipText(speaker.description, 500)}`);
  }
  if (speaker?.personality?.trim()) {
    lines.push(`Character personality: ${clipText(speaker.personality, 320)}`);
  }
  if (speaker?.backstory?.trim()) {
    lines.push(`Character backstory: ${clipText(speaker.backstory, 320)}`);
  }
  if (speaker?.scenario?.trim()) {
    lines.push(`Character scenario: ${clipText(speaker.scenario, 320)}`);
  }
  const characterTraits = formatList("Character traits", speaker?.tags ?? []);
  if (characterTraits) {
    lines.push(characterTraits);
  }
  const likes = formatList("Character likes", speaker?.likes ?? []);
  if (likes) {
    lines.push(likes);
  }
  const dislikes = formatList("Character dislikes", speaker?.dislikes ?? []);
  if (dislikes) {
    lines.push(dislikes);
  }
  if (speaker?.speechStyle?.trim()) {
    lines.push(`Character voice: ${clipText(speaker.speechStyle, 260)}`);
  }
  if (speaker?.systemPrompt.trim()) {
    lines.push(`Character rules: ${clipText(speaker.systemPrompt, 420)}`);
  }
  if (speaker?.postHistoryInstructions?.trim()) {
    lines.push(
      `Character post-history instructions: ${clipText(speaker.postHistoryInstructions, 320)}`,
    );
  }

  if (userProfile?.name.trim()) {
    lines.push(`User name: ${userProfile.name.trim()}`);
  }
  if (relationshipState?.userRoleName?.trim()) {
    lines.push(`User role: ${clipText(relationshipState.userRoleName, 180)}`);
  }
  if (relationshipState?.userRoleDescription?.trim()) {
    lines.push(
      `User role details: ${clipText(relationshipState.userRoleDescription, 320)}`,
    );
  }
  if (userProfile?.about.trim()) {
    lines.push(`User profile: ${clipText(userProfile.about, 320)}`);
  }
  const userTraits = formatList("User traits", userProfile?.traits ?? []);
  if (userTraits) {
    lines.push(userTraits);
  }
  if (userProfile?.preferences.trim()) {
    lines.push(`User preferences: ${clipText(userProfile.preferences, 320)}`);
  }

  if (relationshipState?.summary.trim()) {
    lines.push(`Relationship summary: ${clipText(relationshipState.summary, 320)}`);
  }
  if (relationshipState?.currentScene.trim()) {
    lines.push(`Current scene: ${clipText(relationshipState.currentScene, 220)}`);
  }
  if (relationshipState?.interactionTone.trim()) {
    lines.push(
      `Interaction tone: ${clipText(relationshipState.interactionTone, 220)}`,
    );
  }
  if (relationshipState?.characterState.trim()) {
    lines.push(
      `Character state: ${clipText(relationshipState.characterState, 220)}`,
    );
  }
  if (relationshipState?.userState.trim()) {
    lines.push(`User state: ${clipText(relationshipState.userState, 220)}`);
  }
  if (input.sceneStateInput?.visibleFacts?.length) {
    lines.push(
      `Scene facts: ${clipText(input.sceneStateInput.visibleFacts.join(" | "), 260)}`,
    );
  }

  const derivedScene = deriveDynamicSceneState({
    speaker,
    userProfile,
    relationshipState,
    sceneStateInput: input.sceneStateInput,
    history: [],
  });
  if (derivedScene) {
    if (derivedScene.visibleFacts.length > 0) {
      lines.push(`Dynamic scene: ${clipText(derivedScene.visibleFacts.join(" | "), 420)}`);
    }
    lines.push(`Scene tension: ${derivedScene.tension}`);
  }

  const latestTurn = interpretLatestUserTurn({
    speaker,
    relationshipState,
    sceneStateInput: input.sceneStateInput,
    history: [],
  });
  if (latestTurn) {
    lines.push(`Latest move type: ${latestTurn.actionType}`);
  }

  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}
