import type { ResponseContext, ResponseSalienceProfile } from "../types";

function clampWeight(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function lastUserMessageIndex(history: ResponseContext["history"]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function countRecentAssistantTurns(context: ResponseContext): number {
  const lastUserIndex = lastUserMessageIndex(context.history);
  if (lastUserIndex < 0) {
    return 0;
  }
  return context.history
    .slice(lastUserIndex + 1)
    .filter((message) => message.role === "assistant")
    .length;
}

function countLiveVisibleFacts(context: ResponseContext): number {
  return context.sceneState?.visibleFacts.length ?? 0;
}

function hasLiveSceneOrCorrection(context: ResponseContext): boolean {
  return Boolean(
    context.sceneStateInput?.currentScene?.trim() ||
      context.sceneStateInput?.interactionTone?.trim() ||
      context.sceneStateInput?.characterState?.trim() ||
      context.sceneStateInput?.userState?.trim() ||
      (context.sceneStateInput?.visibleFacts?.length ?? 0) > 0 ||
      context.relationshipState?.currentScene.trim() ||
      context.sceneState?.currentScene?.trim() ||
      (context.sceneState?.visibleFacts ?? []).some((fact) =>
        /^(Current live scene|User appears|Character appears):/i.test(fact),
      ),
  );
}

function hasPromotedUserProfileCue(context: ResponseContext): boolean {
  return (context.sceneState?.visibleFacts ?? []).some((fact) =>
    /^(Visible threat cue|Visible user condition|Visible user-held object|Relevant saved user profile fact):/i.test(
      fact,
    ),
  );
}

function weightLatestUserMove(): number {
  return 100;
}

function weightLiveScene(context: ResponseContext): number {
  let score = 24;
  if (hasLiveSceneOrCorrection(context)) {
    score += 18;
  }
  if (context.turnInterpretation?.requiresImmediateReaction) {
    score += 26;
  }
  score += Math.min(24, countLiveVisibleFacts(context) * 8);
  if (context.sceneState?.tension === "high") {
    score += 18;
  } else if (context.sceneState?.tension === "medium") {
    score += 10;
  }
  if (hasPromotedUserProfileCue(context)) {
    score += 12;
  }
  return clampWeight(score);
}

function weightRelationship(context: ResponseContext): number {
  let score = 18;
  if (context.relationshipState?.summary.trim()) {
    score += 28;
  }
  if (context.relationshipState?.interactionTone.trim()) {
    score += 26;
  }
  if (context.relationshipState?.currentScene.trim()) {
    score += 12;
  }
  return clampWeight(score);
}

function weightUserProfile(context: ResponseContext): number {
  let score = context.userProfile?.about.trim() ? 28 : 10;
  if (hasPromotedUserProfileCue(context)) {
    score += 48;
  }
  if (!hasPromotedUserProfileCue(context) && hasLiveSceneOrCorrection(context)) {
    score -= 10;
  }
  if (context.userProfile?.name.trim()) {
    score += 6;
  }
  return clampWeight(score);
}

function weightRecentTurn(context: ResponseContext): number {
  if (context.mode !== "group") {
    return 8;
  }
  const assistantTurns = countRecentAssistantTurns(context);
  if (assistantTurns === 0) {
    return 18;
  }
  return clampWeight(46 + assistantTurns * 16);
}

function weightMemory(context: ResponseContext, liveSceneWeight: number): number {
  let score = context.memory?.summary.trim() || (context.memory?.facts.length ?? 0) > 0 ? 42 : 16;
  if (liveSceneWeight >= 80) {
    score -= 22;
  } else if (liveSceneWeight >= 60) {
    score -= 12;
  }
  return clampWeight(score);
}

function weightWorldContext(context: ResponseContext, liveSceneWeight: number): number {
  let score = context.contextEntries.length > 0 ? 40 : 14;
  if (liveSceneWeight >= 80) {
    score -= 20;
  } else if (liveSceneWeight >= 60) {
    score -= 10;
  }
  return clampWeight(score);
}

function weightCharacterLore(context: ResponseContext, liveSceneWeight: number): number {
  let score = context.speaker ? 62 : 26;
  if (hasLiveSceneOrCorrection(context)) {
    score -= 18;
  }
  if (liveSceneWeight >= 80) {
    score -= 34;
  } else if (liveSceneWeight >= 60) {
    score -= 20;
  }
  if (countRecentAssistantTurns(context) > 0) {
    score -= 10;
  }
  return clampWeight(score);
}

export function deriveResponseSalienceProfile(
  context: ResponseContext,
): ResponseSalienceProfile {
  const latestUserMoveWeight = weightLatestUserMove();
  const liveSceneWeight = weightLiveScene(context);
  const relationshipWeight = weightRelationship(context);
  const userProfileWeight = weightUserProfile(context);
  const recentTurnWeight = weightRecentTurn(context);
  const memoryWeight = weightMemory(context, liveSceneWeight);
  const contextWeight = weightWorldContext(context, liveSceneWeight);
  const characterLoreWeight = weightCharacterLore(context, liveSceneWeight);

  const rankedFocus = [
    { key: "latest_user_move" as const, weight: latestUserMoveWeight },
    { key: "live_scene" as const, weight: liveSceneWeight },
    { key: "relationship" as const, weight: relationshipWeight },
    { key: "user_profile" as const, weight: userProfileWeight },
    { key: "recent_turn" as const, weight: recentTurnWeight },
    { key: "memory" as const, weight: memoryWeight },
    { key: "world_context" as const, weight: contextWeight },
    { key: "character_lore" as const, weight: characterLoreWeight },
  ].sort((left, right) => right.weight - left.weight);

  return {
    latestUserMoveWeight,
    liveSceneWeight,
    relationshipWeight,
    userProfileWeight,
    recentTurnWeight,
    memoryWeight,
    contextWeight,
    characterLoreWeight,
    suppressStaticScenario:
      hasLiveSceneOrCorrection(context) ||
      (liveSceneWeight >= 75 &&
        (userProfileWeight >= 75 || recentTurnWeight >= 70)),
    prioritizeRelationshipTone: relationshipWeight >= 65,
    rankedFocus,
  };
}
