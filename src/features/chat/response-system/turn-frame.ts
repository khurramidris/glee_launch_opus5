import type { ChatMessage } from "../../../types";
import { detectAddressedParticipants } from "./group-addressing";
import { latestUserTurnText } from "./latest-user-turn";
import {
  extractLatestMovementTarget,
  extractLatestSceneAssertion,
} from "./scene/scene-cues";
import type {
  TurnFrame,
  TurnFrameAction,
  TurnFrameResponseObligation,
  TurnFrameTone,
} from "./types";

export interface TurnFrameInput {
  latestUserMessage?: string;
  history?: ChatMessage[];
  currentScene?: string;
  participantNames?: string[];
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "have",
  "help",
  "hey",
  "hi",
  "i",
  "im",
  "in",
  "is",
  "it",
  "just",
  "me",
  "my",
  "on",
  "out",
  "please",
  "the",
  "there",
  "this",
  "to",
  "we",
  "what",
  "where",
  "which",
  "with",
  "you",
]);

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function latestUserMessageFromHistory(history: ChatMessage[] | undefined): string {
  return normalizeText(latestUserTurnText(history));
}

function stripOuterPunctuation(value: string): string {
  return value.replace(/^[\s"'“”‘’*.,!?;:]+|[\s"'“”‘’*.,!?;:]+$/g, "").trim();
}

function normalizePhrase(value: string): string | null {
  const cleaned = stripOuterPunctuation(
    value
      .replace(/\b(?:please|thanks?|thank you|right now|tonight|today)\b/gi, " ")
      .replace(/\b(?:as|while)\s+(?:i|my|we|our)\b[\s\S]*$/i, " ")
      .replace(/\s+/g, " "),
  );
  return cleaned.length > 0 ? cleaned : null;
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1] ? normalizePhrase(match[1]) : null;
    if (value) {
      return value;
    }
  }
  return null;
}

function extractConcreteChoice(message: string): string | null {
  if (/\b(?:can|could|would|will)\s+you\b/i.test(message)) {
    return null;
  }
  if (
    /\b(?:orgy|threesome|sexual|sex|fuck|sleep\s+with|private\s+fun\s+time|get\s+naked|naked|undress)\b/i.test(
      message,
    )
  ) {
    return null;
  }
  return firstMatch(message, [
    /\b(?:i\s*(?:will|would|ll|'ll)?\s*)?(?:choose|pick|take|get|want|order|prefer|grab)\s+(?:the\s+)?(.+?)(?:[.!?]|$)/i,
    /\b(?:let'?s|we should)\s+(?:choose|pick|take|get|order|grab)\s+(?:the\s+)?(.+?)(?:[.!?]|$)/i,
    /\b(?:make it|i'?ll have)\s+(?:the\s+)?(.+?)(?:[.!?]|$)/i,
  ]);
}

function extractSearchTopic(message: string): string | null {
  return firstMatch(message, [
    /\b(?:find|look for|search for|locate|where(?:'s| is| are)?|which\s+\w+\s+(?:has|holds|carries))\s+(?:the\s+)?(.+?)(?:\s+(?:at|in|on|near|by)\b|[.!?]|$)/i,
    /\b(?:help me|can you help)\s+(?:find|look for|search for|locate)\s+(?:the\s+)?(.+?)(?:\s+(?:at|in|on|near|by)\b|[.!?]|$)/i,
  ]);
}

function extractRequestTopic(message: string): string | null {
  return firstMatch(message, [
    /\b(?:can|could|would|will)\s+you\s+(.+?)(?:[.!?]|$)/i,
    /\b(?:please|pls)\s+(.+?)(?:[.!?]|$)/i,
    /\b(?:tell|show|give|bring|take|change|play|put|move|open|close|call)\s+(?:me\s+)?(.+?)(?:[.!?]|$)/i,
  ]);
}

function extractQuestionTopic(message: string): string | null {
  return firstMatch(message, [
    /\b(?:what|why|how|where|which|who|when)\s+(.+?)(?:[.!?]|$)/i,
  ]);
}

function detectLocationTarget(message: string, currentScene: string): string | null {
  const combined = `${message} ${currentScene}`;
  const match = combined.match(
    /\b(aisle|shelf|rack|counter|table|booth|kitchen|bar|fridge|freezer|checkout|register|car|room|door|window|stage|seat|line|queue)\b/i,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function detectEmotionalTone(message: string): TurnFrameTone {
  const normalized = message.toLowerCase();
  if (
    /\b(?:naughty|naughtily|naughilty|seductive|sensual|sexy|intimate)\b/i.test(message) ||
    /\b(?:orgy|threesome|sexual|sex|fuck|sleep\s+with|private\s+fun\s+time|get\s+naked|naked|undress)\b/i.test(message) ||
    /\bif\s+you\s+know\s+what\s+i\s+mean\b/i.test(message) ||
    /\b(?:wanna|want(?:ed)?|would\s+like\s+to|like\s+to)\s+eat\s+you\b/i.test(message) ||
    /\b(?:kiss|touch)\b/i.test(message)
  ) {
    return "provocative";
  }
  if (
    /\b(?:wink|flirt|flirty|flirtatious|darling|sweetheart|babe)\b/i.test(message) ||
    /\bhint\s+of\s+flirt\b/i.test(normalized)
  ) {
    return "flirtatious";
  }
  if (/\b(?:playful|joking|jokingly|teasingly)\b/i.test(message)) {
    return "playful";
  }
  if (/\b(?:hurry|quick|now|urgent|asap|right now)\b|!{2,}/i.test(message)) {
    return "urgent";
  }
  if (/\b(?:maybe|not sure|confused|wondering|do you think)\b/i.test(message)) {
    return "uncertain";
  }
  if (/\b(?:hi|hey|hello|thanks|please)\b/i.test(message)) {
    return "friendly";
  }
  return "neutral";
}

function detectUserAction(input: {
  message: string;
  visibleSearchCue: boolean;
  concreteChoice: string | null;
  requestTopic: string | null;
  questionTopic: string | null;
}): TurnFrameAction {
  if (/^\s*(?:hi|hey|hello|yo|good\s+(?:morning|afternoon|evening))\b[!.?\s]*$/i.test(input.message)) {
    return "greeting";
  }
  if (input.visibleSearchCue) {
    return "search";
  }
  if (input.concreteChoice) {
    return "choice";
  }
  if (input.requestTopic) {
    return "request";
  }
  if (input.questionTopic || /\?\s*$/.test(input.message)) {
    return "question";
  }
  return "statement";
}

function deriveResponseObligation(input: {
  userAction: TurnFrameAction;
  addressedParticipants: string[];
  sceneAssertion: string | null;
  sceneTransition: string | null;
}): TurnFrameResponseObligation {
  if (input.sceneAssertion) {
    return "honor_scene_correction";
  }
  if (input.sceneTransition) {
    return "honor_scene_transition";
  }
  if (input.addressedParticipants.length > 0) {
    return "answer_direct_address";
  }
  if (input.userAction === "greeting") {
    return "acknowledge_greeting";
  }
  if (input.userAction === "search") {
    return "help_with_search";
  }
  if (input.userAction === "choice") {
    return "honor_user_choice";
  }
  if (input.userAction === "question") {
    return "answer_question";
  }
  if (input.userAction === "request") {
    return "respond_to_request";
  }
  return "continue_conversation";
}

function tokenizeCueText(parts: Array<string | null | undefined>): string[] {
  const tokens = new Set<string>();
  for (const part of parts) {
    for (const token of (part ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? []) {
      const normalized = token.replace(/^'+|'+$/g, "");
      if (normalized.length >= 3 && !STOPWORDS.has(normalized)) {
        tokens.add(normalized);
      }
    }
  }
  return [...tokens].slice(0, 16);
}

export function deriveTurnFrame(input: TurnFrameInput): TurnFrame {
  const latestUserMessage = normalizeText(
    input.latestUserMessage ?? latestUserMessageFromHistory(input.history),
  );
  const currentScene = normalizeText(input.currentScene);
  const participantNames = (input.participantNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);

  const addressedParticipants = detectAddressedParticipants(
    latestUserMessage,
    participantNames,
  );
  const concreteChoice = extractConcreteChoice(latestUserMessage);
  const stopInstruction = null;
  const boundaryCue = false;
  const sceneAssertion = extractLatestSceneAssertion(latestUserMessage);
  const sceneTransition = extractLatestMovementTarget(latestUserMessage);
  const searchTopic = extractSearchTopic(latestUserMessage);
  const requestTopic = extractRequestTopic(latestUserMessage);
  const questionTopic = extractQuestionTopic(latestUserMessage);
  const visibleSearchCue =
    Boolean(searchTopic) ||
    /\b(?:find|look for|search for|locate|try(?:ing)?\s+to\s+locate|eyes?\s+(?:try|tries|scan|search)|which\s+\w+\s+has|where(?:'s| is| are)?)\b/i.test(
      latestUserMessage,
    );
  const locationTarget = detectLocationTarget(latestUserMessage, currentScene);
  const topic =
    concreteChoice ??
    searchTopic ??
    requestTopic ??
    questionTopic ??
    normalizePhrase(latestUserMessage);
  const userAction = detectUserAction({
    message: latestUserMessage,
    visibleSearchCue,
    concreteChoice,
    requestTopic,
    questionTopic,
  });

  return {
    latestUserMessage,
    addressedParticipants,
    userAction,
    topic,
    concreteChoice,
    boundaryCue,
    stopInstruction,
    sceneAssertion,
    sceneTransition,
    visibleSearchCue,
    locationTarget,
    emotionalTone: detectEmotionalTone(latestUserMessage),
    liveActionCueTokens: tokenizeCueText([
      topic,
      concreteChoice,
      latestUserMessage,
      searchTopic,
      requestTopic,
      locationTarget,
      sceneAssertion,
      sceneTransition,
      currentScene,
    ]),
    responseObligation: deriveResponseObligation({
      userAction,
      addressedParticipants,
      sceneAssertion,
      sceneTransition,
    }),
  };
}
