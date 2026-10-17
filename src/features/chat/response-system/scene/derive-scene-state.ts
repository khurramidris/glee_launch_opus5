import type {
  Character,
  ChatMessage,
  ChatRelationshipState,
  UserProfile,
} from "../../../../types";
import { clipText } from "../compile/prompt-budget";
import {
  detectWeapons,
  extractPresentHeldObjectFacts,
  extractPresentWeaponFacts,
} from "./threat-cues";
import {
  extractRelevantProfileFacts,
  extractVisibleAppearanceFacts,
} from "./profile-cues";
import { latestUserTurnText } from "../latest-user-turn";
import {
  extractLatestMovementTarget,
  extractLatestSceneAssertion,
} from "./scene-cues";
import type { DerivedSceneState, SceneStateInput } from "../types";

function collectRecentUserText(history: ChatMessage[]): string {
  return history
    .filter((message) => message.role === "user")
    .slice(-4)
    .map((message) => message.content)
    .join("\n");
}

function hasCommandLanguage(text: string): boolean {
  return (
    /\b(put your hands up|hands up|freeze|don't move|do not move|drop it|kneel|back up|stand down)\b/i.test(
      text,
    ) ||
    /^(put|drop|freeze|stop|listen|back up|move)\b/i.test(text.trim())
  );
}

function hasThreatLanguage(text: string): boolean {
  return /\b(or else|shoot|kill|dead|blow your head off|don't test me|last warning)\b/i.test(
    text,
  );
}

function latestMovePointsAtProfileGear(text: string): boolean {
  return (
    /\b(what do i have|what am i holding|what do you see (?:in|on|with) my|look what i|look at me|look at my|see me|see my|notice me|notice my)\b/i.test(
      text,
    ) ||
    /\b(i am|i'm|i have|i'm holding|i am holding|my)\b.{0,80}\b(holding|hold|wearing|wear|dressed|hand|hands|weapon|armed|carrying|carry)\b/i.test(
      text,
    )
  );
}

function normalizeScenarioFrame(input: {
  scenario?: string;
  speakerName?: string;
  userName?: string;
}): string {
  return (input.scenario ?? "")
    .replace(/<\s*START\s*>/gi, "")
    .replace(/\{\{\s*char\s*\}\}/gi, input.speakerName?.trim() || "the character")
    .replace(/\{\{\s*character\s*\}\}/gi, input.speakerName?.trim() || "the character")
    .replace(/\{\{\s*user\s*\}\}/gi, input.userName?.trim() || "you")
    .replace(/\{\{\s*name\s*\}\}/gi, input.userName?.trim() || "you")
    .replace(/\s+/g, " ")
    .trim();
}

function inferPowerDynamic(input: {
  armedFacts: string[];
  isThreat: boolean;
  isCommand: boolean;
  sceneStateInput?: SceneStateInput | null;
  relationshipState?: ChatRelationshipState;
}): string {
  if (input.armedFacts.length > 0 && (input.isThreat || input.isCommand)) {
    return "The user currently appears to hold the tactical advantage. The character should react to immediate danger before anything else.";
  }
  if (input.sceneStateInput?.interactionTone?.trim()) {
    return `Use the authored scene tone as the baseline: ${clipText(
      input.sceneStateInput.interactionTone,
      220,
    )}`;
  }
  if (input.relationshipState?.interactionTone.trim()) {
    return `Use the saved interaction tone as the baseline: ${clipText(
      input.relationshipState.interactionTone,
      220,
    )}`;
  }
  return "No obvious tactical advantage is established. React based on the immediate social and emotional pressure.";
}

function inferSceneRoleExpectation(input: {
  sceneStateInput?: SceneStateInput | null;
  relationshipState?: ChatRelationshipState;
  recentUserText: string;
}): DerivedSceneState["sceneRoleExpectation"] {
  const corpus = [
    input.sceneStateInput?.currentScene,
    input.sceneStateInput?.interactionTone,
    input.relationshipState?.summary,
    input.relationshipState?.currentScene,
    input.relationshipState?.interactionTone,
    input.recentUserText,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!corpus.trim()) {
    return "unknown";
  }

  if (
    /\b(waiter|waitress|server|cashier|bartender|barista|clerk|salesperson|salesman|saleswoman|dealer|attendant|hostess|host|guide|employee|staff|working a shift|on shift|our staff|dealership staff)\b/.test(
      corpus,
    )
  ) {
    return "service_possible";
  }

  if (
    /\b(restaurant|pizzeria|cafe|coffee shop|diner|bar|supermarket|grocery store|mall|shopping mall|showroom|stadium|cinema|movie theater|airport|train station|bookstore|market|shop)\b/.test(
      corpus,
    )
  ) {
    return "companions";
  }

  return "unknown";
}

export function deriveDynamicSceneState(input: {
  speaker?: Character;
  userProfile?: UserProfile;
  relationshipState?: ChatRelationshipState;
  sceneStateInput?: SceneStateInput | null;
  history: ChatMessage[];
}): DerivedSceneState | null {
  const latestUserText = latestUserTurnText(input.history) ?? "";
  const recentUserText = collectRecentUserText(input.history);
  const stateCorpus = [
    input.sceneStateInput?.currentScene,
    input.sceneStateInput?.userState,
    input.sceneStateInput?.characterState,
    ...(input.sceneStateInput?.visibleFacts ?? []),
    input.relationshipState?.summary,
    input.relationshipState?.currentScene,
    input.relationshipState?.userState,
    input.relationshipState?.characterState,
    recentUserText,
  ]
    .filter(Boolean)
    .join("\n");

  const isCommand = hasCommandLanguage(latestUserText);
  const latestHasThreatLanguage = hasThreatLanguage(latestUserText);
  const latestSceneAssertion = extractLatestSceneAssertion(latestUserText);
  const latestMovementTarget = extractLatestMovementTarget(latestUserText);
  const profileAbout = input.userProfile?.about;
  const stateArmedFacts = detectWeapons(stateCorpus);
  const profileArmedFacts = extractPresentWeaponFacts(profileAbout);
  const stateHeldObjectFacts = extractPresentHeldObjectFacts(stateCorpus);
  const profileHeldObjectFacts = extractPresentHeldObjectFacts(profileAbout);
  const shouldPromoteProfileGear =
    latestMovePointsAtProfileGear(latestUserText) ||
    isCommand ||
    latestHasThreatLanguage;
  const armedFacts = [
    ...stateArmedFacts,
    ...(shouldPromoteProfileGear ? profileArmedFacts : []),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const heldObjectFacts = [
    ...stateHeldObjectFacts,
    ...(shouldPromoteProfileGear ? profileHeldObjectFacts : []),
  ]
    .filter((value) => !armedFacts.some((weapon) => weapon.toLowerCase() === value.toLowerCase()))
    .filter((value, index, all) => all.indexOf(value) === index);
  const relevantProfileFacts = extractRelevantProfileFacts({
    about: input.userProfile?.about,
    latestUserMessage: latestUserText,
  }).filter(
    (value) =>
      !heldObjectFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()) &&
      !armedFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()),
  );
  const visibleAppearanceFacts = extractVisibleAppearanceFacts({
    about: input.userProfile?.about,
    latestUserMessage: latestUserText,
    currentScene:
      input.sceneStateInput?.currentScene ?? input.relationshipState?.currentScene,
  }).filter(
    (value) =>
      !relevantProfileFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()) &&
      !heldObjectFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()) &&
      !armedFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()),
  );
  const isThreat = armedFacts.length > 0 || latestHasThreatLanguage;
  const visibleFacts: string[] = [];
  const activeCurrentScene =
    latestSceneAssertion ||
    input.sceneStateInput?.currentScene?.trim() ||
    input.relationshipState?.currentScene.trim() ||
    undefined;
  const hasExplicitLiveScene = Boolean(activeCurrentScene);

  if (latestSceneAssertion) {
    visibleFacts.push(
      `Current live scene: ${clipText(latestSceneAssertion, 260)}`,
      "Latest user scene assertion overrides older saved scene or static card scenario for this reply.",
    );
  } else if (input.sceneStateInput?.currentScene?.trim()) {
    visibleFacts.push(
      `Current live scene: ${clipText(input.sceneStateInput.currentScene, 260)}`,
    );
  } else if (input.relationshipState?.currentScene.trim()) {
    visibleFacts.push(
      `Current live scene: ${clipText(input.relationshipState.currentScene, 260)}`,
    );
  }
  if (latestMovementTarget) {
    visibleFacts.push(
      `User-directed movement target: ${clipText(latestMovementTarget, 220)}.`,
    );
  }
  if (input.sceneStateInput?.userState?.trim()) {
    visibleFacts.push(
      `User appears: ${clipText(input.sceneStateInput.userState, 220)}`,
    );
  } else if (input.relationshipState?.userState.trim()) {
    visibleFacts.push(
      `User appears: ${clipText(input.relationshipState.userState, 220)}`,
    );
  }
  if (input.sceneStateInput?.characterState?.trim()) {
    visibleFacts.push(
      `Character appears: ${clipText(input.sceneStateInput.characterState, 220)}`,
    );
  } else if (input.relationshipState?.characterState.trim()) {
    visibleFacts.push(
      `Character appears: ${clipText(input.relationshipState.characterState, 220)}`,
    );
  }
  if (input.sceneStateInput?.visibleFacts?.length) {
    visibleFacts.push(...input.sceneStateInput.visibleFacts.map((fact) => clipText(fact, 220)));
  }
  if (armedFacts.length > 0) {
    visibleFacts.push(
      `Visible threat cue: the user appears to be holding ${armedFacts.join(", ")} in the active scene.`,
    );
  }
  if (heldObjectFacts.length > 0) {
    visibleFacts.push(
      `Visible user-held object: ${heldObjectFacts.join(", ")}.`,
    );
  }
  if (relevantProfileFacts.length > 0) {
    visibleFacts.push(
      ...relevantProfileFacts.map(
        (fact) => `Relevant saved user profile fact: ${clipText(fact, 220)}`,
      ),
    );
  }
  if (visibleAppearanceFacts.length > 0) {
    visibleFacts.push(
      ...visibleAppearanceFacts.map(
        (fact) => `Visible user condition: ${clipText(fact, 220)}`,
      ),
    );
  }
  const scenarioFrame = normalizeScenarioFrame({
    scenario: input.speaker?.scenario,
    speakerName: input.speaker?.name,
    userName: input.userProfile?.name,
  });
  if (
    scenarioFrame &&
    !hasExplicitLiveScene &&
    armedFacts.length === 0 &&
    heldObjectFacts.length === 0 &&
    relevantProfileFacts.length === 0 &&
    visibleAppearanceFacts.length === 0 &&
    !isCommand &&
    !isThreat
  ) {
    visibleFacts.push(
      `Character scenario frame: ${clipText(scenarioFrame, 220)}`,
    );
  }

  const tension: DerivedSceneState["tension"] = isThreat
    ? "high"
    : visibleAppearanceFacts.length > 0
      ? "medium"
    : isCommand
      ? "medium"
      : "low";

  const immediatePriority = isThreat
    ? "Acknowledge the immediate danger or coercion before moving into personality flavor."
    : visibleAppearanceFacts.length > 0
      ? "Acknowledge the user's visible condition or injuries before drifting into unrelated character lore or banter."
    : heldObjectFacts.length > 0
      ? "Acknowledge what the user is showing or holding before drifting into unrelated character lore."
      : relevantProfileFacts.length > 0
        ? "Use the relevant saved user profile fact when answering the user's move instead of drifting into unrelated character lore."
      : isCommand
        ? "React to the user's action as a live scene move, not as a phrase to mirror."
        : "Continue the interaction with awareness of the current emotional situation.";
  const sceneRoleExpectation = inferSceneRoleExpectation({
    sceneStateInput: input.sceneStateInput,
    relationshipState: input.relationshipState,
    recentUserText,
  });

  if (
    visibleFacts.length === 0 &&
    !isCommand &&
    !isThreat &&
    visibleAppearanceFacts.length === 0 &&
    heldObjectFacts.length === 0 &&
    relevantProfileFacts.length === 0
  ) {
    return null;
  }

  return {
    currentScene:
      activeCurrentScene,
    visibleFacts,
    powerDynamic: inferPowerDynamic({
      armedFacts,
      isThreat,
      isCommand,
      sceneStateInput: input.sceneStateInput,
      relationshipState: input.relationshipState,
    }),
    tension,
    immediatePriority,
    sceneRoleExpectation,
  };
}
