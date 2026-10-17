import type {
  Character,
  ChatMessage,
  ChatRelationshipState,
  UserProfile,
} from "../../../../types";
import {
  detectWeapons,
  extractPresentHeldObjectFacts,
  extractPresentWeaponFacts,
  isHeldObjectInspectionPrompt,
} from "../scene/threat-cues";
import {
  extractRelevantProfileFacts,
  extractVisibleAppearanceFacts,
} from "../scene/profile-cues";
import { latestUserTurnText } from "../latest-user-turn";
import type { SceneStateInput, TurnInterpretation } from "../types";

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

function hasQuestionLanguage(text: string): boolean {
  return /\?\s*$/.test(text.trim()) || /^(what|why|how|when|where|who|can|could|would|will|do|did|are|is)\b/i.test(text.trim());
}

function hasRequestLanguage(text: string): boolean {
  return /\b(please|can you|could you|help me|i need you to|tell me)\b/i.test(text);
}

function hasEntranceOrGreetingLanguage(text: string): boolean {
  return /\b(enter|enter the room|walk in|come in|arrive|hey everyone|hello everyone|hi everyone|hey guys|hello guys|hi guys)\b/i.test(
    text,
  );
}

function hasDirectGreetingLanguage(text: string): boolean {
  return /^(hey|hi|hello|hey there|hi there|hello there|yo|good morning|good afternoon|good evening)([!.,?]+\s*|\s+[a-z0-9_'-]+[!.,?]*\s*){0,3}$/i.test(
    text.trim(),
  );
}

export function interpretLatestUserTurn(input: {
  speaker?: Character;
  userProfile?: UserProfile;
  relationshipState?: ChatRelationshipState;
  sceneStateInput?: SceneStateInput | null;
  history: ChatMessage[];
}): TurnInterpretation | null {
  const text = latestUserTurnText(input.history)?.trim();
  if (!text) {
    return null;
  }

  const recentSceneCorpus = [
    text,
    input.sceneStateInput?.currentScene,
    input.sceneStateInput?.userState,
    ...(input.sceneStateInput?.visibleFacts ?? []),
    input.relationshipState?.currentScene,
    input.relationshipState?.userState,
  ]
    .filter(Boolean)
    .join("\n");
  const isCommand = hasCommandLanguage(text);
  const latestHasThreatLanguage = hasThreatLanguage(text);
  const shouldPromoteProfileGear =
    latestMovePointsAtProfileGear(text) ||
    isCommand ||
    latestHasThreatLanguage;
  const armedFacts = [
    ...detectWeapons(recentSceneCorpus),
    ...(shouldPromoteProfileGear
      ? extractPresentWeaponFacts(input.userProfile?.about)
      : []),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const heldObjectFacts = [
    ...extractPresentHeldObjectFacts(recentSceneCorpus),
    ...(shouldPromoteProfileGear
      ? extractPresentHeldObjectFacts(input.userProfile?.about)
      : []),
  ]
    .filter((value) => !armedFacts.some((weapon) => weapon.toLowerCase() === value.toLowerCase()))
    .filter((value, index, all) => all.indexOf(value) === index);
  const relevantProfileFacts = extractRelevantProfileFacts({
    about: input.userProfile?.about,
    latestUserMessage: text,
  }).filter(
    (value) =>
      !heldObjectFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()) &&
      !armedFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()),
  );
  const visibleAppearanceFacts = extractVisibleAppearanceFacts({
    about: input.userProfile?.about,
    latestUserMessage: text,
    currentScene:
      input.sceneStateInput?.currentScene ?? input.relationshipState?.currentScene,
  }).filter(
    (value) =>
      !relevantProfileFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()) &&
      !heldObjectFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()) &&
      !armedFacts.some((fact) => fact.toLowerCase() === value.toLowerCase()),
  );
  const isThreat = armedFacts.length > 0 || latestHasThreatLanguage;
  const isInspectionPrompt = isHeldObjectInspectionPrompt(text);
  const isArmedQuestion = armedFacts.length > 0 && isInspectionPrompt;

  if (armedFacts.length > 0 && isCommand) {
    return {
      actionType: "armed-command",
      intent: "The user is issuing a direct command while presenting an implied or explicit weapon threat.",
      emotionalPressure: "high",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Do not mirror the command wording back. Show how the character reacts to being threatened, challenged, or tested.",
    };
  }
  if (isArmedQuestion) {
    return {
      actionType: "armed-question",
      intent:
        "The user is forcing the character to acknowledge a visible weapon or threat cue in the scene.",
      emotionalPressure: "high",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Answer what the character sees directly, but treat it as a coercive moment rather than a casual question.",
    };
  }
  if (heldObjectFacts.length > 0 && isInspectionPrompt) {
    return {
      actionType: hasQuestionLanguage(text) ? "question" : "request",
      intent:
        `The user is showing the character a visible object (${heldObjectFacts.join(", ")}) and expects them to notice or react to it immediately.`,
      emotionalPressure: "medium",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Identify or react to the visible object directly. Do not drift into unrelated backstory, old scenario lore, or generic banter.",
    };
  }
  if (visibleAppearanceFacts.length > 0 && hasEntranceOrGreetingLanguage(text)) {
    return {
      actionType: "statement",
      intent:
        `The user's visible current condition (${visibleAppearanceFacts.join(" | ")}) should be noticed immediately during this in-person arrival or greeting.`,
      emotionalPressure: "medium",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Acknowledge the user's visible condition or injuries directly. Do not act like the scene is casual or ignore what everyone can see.",
    };
  }
  if (relevantProfileFacts.length > 0) {
    return {
      actionType: hasQuestionLanguage(text) ? "question" : "request",
      intent:
        `The user's latest move implicitly points at a saved user-profile fact (${relevantProfileFacts.join(" | ")}) and expects the character to use it.`,
      emotionalPressure: "medium",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Use the relevant saved user-profile fact directly. Do not ignore it, contradict it, or drift into unrelated card lore.",
    };
  }
  if (isThreat) {
    return {
      actionType: "threat",
      intent: "The user is escalating pressure or coercion.",
      emotionalPressure: "high",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Do not paraphrase the threat back as filler. React to the danger, pressure, or intimidation.",
    };
  }
  if (isCommand) {
    return {
      actionType: "command",
      intent: "The user is directing the character to do something immediately.",
      emotionalPressure: "medium",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Treat the line as an action to respond to. Do not repeat the command unless the character is intentionally quoting it.",
    };
  }
  if (hasDirectGreetingLanguage(text)) {
    return {
      actionType: "greeting",
      intent: "The user is greeting or opening the exchange directly and expects an immediate in-character acknowledgment.",
      emotionalPressure: "low",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Acknowledge the greeting directly in character. Do not act as if the user stayed silent or failed to speak.",
    };
  }
  if (hasQuestionLanguage(text)) {
    return {
      actionType: "question",
      intent: "The user is seeking an answer or explanation.",
      emotionalPressure: "low",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Answer or react directly instead of restating the question.",
    };
  }
  if (hasRequestLanguage(text)) {
    return {
      actionType: "request",
      intent: "The user is asking for help, cooperation, or emotional response.",
      emotionalPressure: "medium",
      requiresImmediateReaction: true,
      antiParrotDirective:
        "Respond to the request itself. Do not repeat the request phrasing back.",
    };
  }
  return {
    actionType: "statement",
    intent: "The user is making a statement that still deserves an in-character reaction.",
    emotionalPressure: "low",
    requiresImmediateReaction: true,
    antiParrotDirective:
      "Advance the exchange with a character-shaped response, not a paraphrase of the user's statement.",
  };
}
