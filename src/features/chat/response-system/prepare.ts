import { toLlamaChatRequest } from "../runtime-adapters/llama";
import { compileResponseRequest } from "./compile/compile-response-request";
import { interpretLatestUserTurn } from "./interpretation/interpret-latest-turn";
import { buildResponseRetrievalHints as buildOwnedResponseRetrievalHints } from "./memory/build-retrieval-query";
import { buildCharacterReactionPlan } from "./planning/build-reaction-plan";
import { buildHarnessResponsePlan } from "./planning/build-harness-response-plan";
import { deriveResponseSalienceProfile } from "./salience/derive-response-salience";
import { deriveDynamicSceneState } from "./scene/derive-scene-state";
import { deriveTurnFrame } from "./turn-frame";
import { clipText } from "./compile/prompt-budget";
import { sanitizeAssistantHistoryContent } from "../response-sanitizer";
import { filterGenerationFailureMessages } from "../generation-failure";
import { detectAddressedParticipants } from "./group-addressing";
import { latestUserTurnText } from "./latest-user-turn";
import type {
  ExplicitUserChoice,
  GroupRoundEngagementExpectation,
  GroupRoundReplySummary,
  GroupRoundState,
  PreparedResponseRequest,
  ResponseContext,
  SceneStateInput,
  ResponseSystemInput,
  TurnFrameTone,
} from "./types";

function deriveConciseScenarioScene(
  speaker?: ResponseSystemInput["speaker"],
  userProfile?: ResponseSystemInput["userProfile"],
): string | undefined {
  const rawScenario = speaker?.scenario?.trim();
  if (!rawScenario) {
    return undefined;
  }

  const speakerName = speaker?.name?.trim() || "the character";
  const userName = userProfile?.name?.trim() || "you";
  const scenario = rawScenario
    .replace(/<\s*START\s*>/gi, "")
    .replace(/\{\{\s*char\s*\}\}/gi, speakerName)
    .replace(/\{\{\s*character\s*\}\}/gi, speakerName)
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*name\s*\}\}/gi, userName)
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!scenario || scenario.length > 240) {
    return undefined;
  }
  if (/[{}<>]/.test(scenario)) {
    return undefined;
  }
  if (/\b(?:appearance|personality|backstory|description|creator notes?)\s*:/i.test(scenario)) {
    return undefined;
  }
  if (
    !/\b(?:we are|we're|i am|i'm|you are|you're|she is|he is|they are|lying|sitting|standing|driving|walking|inside|in|at|on|near)\b/i.test(
      scenario,
    )
  ) {
    return undefined;
  }

  return clipText(scenario, 220);
}

function normalizeSceneStateInput(
  sceneStateInput?: SceneStateInput | null,
  relationshipState?: ResponseSystemInput["relationshipState"],
  speaker?: ResponseSystemInput["speaker"],
  userProfile?: ResponseSystemInput["userProfile"],
): SceneStateInput | null {
  const fallbackScenarioScene =
    !sceneStateInput?.currentScene?.trim() && !relationshipState?.currentScene?.trim()
      ? deriveConciseScenarioScene(speaker, userProfile)
      : undefined;
  const merged: SceneStateInput = {
    currentScene:
      sceneStateInput?.currentScene?.trim() ||
      relationshipState?.currentScene?.trim() ||
      fallbackScenarioScene ||
      undefined,
    interactionTone:
      sceneStateInput?.interactionTone?.trim() ||
      relationshipState?.interactionTone?.trim() ||
      undefined,
    characterState:
      sceneStateInput?.characterState?.trim() ||
      relationshipState?.characterState?.trim() ||
      undefined,
    userState:
      sceneStateInput?.userState?.trim() || relationshipState?.userState?.trim() || undefined,
    visibleFacts:
      sceneStateInput?.visibleFacts
        ?.map((fact) => fact.trim())
        .filter(Boolean) ?? [],
  };

  if (
    !merged.currentScene &&
    !merged.interactionTone &&
    !merged.characterState &&
    !merged.userState &&
    (!merged.visibleFacts || merged.visibleFacts.length === 0)
  ) {
    return null;
  }

  return merged;
}

function lastUserTurnIndex(history: ResponseSystemInput["history"]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function inferGroupReplyTone(text: string): string {
  const normalized = text.toLowerCase();
  if (/\b(sorry|apolog|forgive)\b/.test(normalized)) {
    return "apologetic";
  }
  if (/\b(love|darling|sweet|honey|kiss|touch|wink|flirt)\b/.test(normalized)) {
    return "flirtatious";
  }
  if (/\b(calm|careful|steady|okay|alright|safe|concern|worry)\b/.test(normalized)) {
    return "cautious";
  }
  if (/\b(angry|furious|shut up|idiot|stupid|damn|fuck|hell no)\b/.test(normalized)) {
    return "hostile";
  }
  if (/\b(smile|laugh|giggle|tease|playful|joke)\b/.test(normalized)) {
    return "playful";
  }
  if (/\b(hurry|now|urgent|immediately|danger|watch out)\b/.test(normalized)) {
    return "urgent";
  }
  if (/\b(gentle|warm|kind|soft|comfort|reassure)\b/.test(normalized)) {
    return "warm";
  }
  return "steady";
}

function inferGroupReplyEffect(text: string): string {
  const normalized = text.toLowerCase();
  if (/\b(yes|agree|right|exactly|good idea|that one|let's)\b/.test(normalized)) {
    return "backs the user's move";
  }
  if (/\b(no|don't|shouldn't|wait|hold on|not so fast)\b/.test(normalized)) {
    return "pushes back on the current direction";
  }
  if (/\b(sorry|apolog|forgive)\b/.test(normalized)) {
    return "tries to smooth the interaction";
  }
  if (/\b(what about|how about|instead|another|other option|alternative)\b/.test(normalized)) {
    return "redirects the scene toward another option";
  }
  if (/\b(why|how|what)\b/.test(normalized) && /\?/.test(text)) {
    return "asks for clarification";
  }
  if (/\b(careful|watch out|danger|safe|steady|calm)\b/.test(normalized)) {
    return "adds caution to the moment";
  }
  if (/\b(smile|laugh|giggle|tease|playful|joke)\b/.test(normalized)) {
    return "lightens the mood";
  }
  return "adds a personal angle to the exchange";
}

const GROUP_CUE_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "already",
  "also",
  "and",
  "any",
  "back",
  "because",
  "before",
  "being",
  "both",
  "bring",
  "came",
  "come",
  "could",
  "does",
  "dont",
  "down",
  "each",
  "else",
  "exchange",
  "from",
  "good",
  "group",
  "have",
  "heard",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "into",
  "just",
  "keep",
  "latest",
  "line",
  "made",
  "make",
  "more",
  "move",
  "next",
  "only",
  "other",
  "over",
  "part",
  "participant",
  "participants",
  "person",
  "reply",
  "room",
  "round",
  "say",
  "said",
  "same",
  "scene",
  "should",
  "show",
  "some",
  "someone",
  "still",
  "that",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "those",
  "through",
  "tone",
  "toward",
  "user",
  "very",
  "want",
  "wanna",
  "naughty",
  "naughtily",
  "naughilty",
  "what",
  "when",
  "with",
  "wording",
  "would",
  "your",
]);

const GROUP_SHORT_CUE_ALLOWLIST = new Set([
  "car",
  "eat",
  "red",
]);

const USER_CHOICE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "buy",
  "card",
  "for",
  "get",
  "gonna",
  "going",
  "guy",
  "have",
  "having",
  "i",
  "just",
  "like",
  "look",
  "looking",
  "menu",
  "my",
  "of",
  "on",
  "order",
  "pick",
  "prefer",
  "some",
  "take",
  "that",
  "the",
  "this",
  "to",
  "want",
  "wanna",
  "will",
]);

const USER_CHOICE_SHORT_ALLOWLIST = new Set(["red", "blue", "pink", "one"]);

function tokenizeGroupCueText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[*_"'`]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function extractGroupCueTokens(
  value: string,
  excludedTokens: string[] = [],
): string[] {
  if (!value.trim()) {
    return [];
  }

  const excluded = new Set(
    excludedTokens.map((token) => token.trim().toLowerCase()).filter(Boolean),
  );

  return [...new Set(
    tokenizeGroupCueText(value).filter(
      (token) =>
        !excluded.has(token) &&
        !GROUP_CUE_STOPWORDS.has(token) &&
        (token.length >= 4 || GROUP_SHORT_CUE_ALLOWLIST.has(token)),
    ),
  )];
}

function tokenizeExplicitChoiceText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[*_"'`]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function participantNameTokens(participantNames?: string[]): Set<string> {
  return new Set(
    (participantNames ?? [])
      .flatMap((name) => tokenizeExplicitChoiceText(name))
      .filter(Boolean),
  );
}

function stripTrailingAttribution(text: string): string {
  return text
    .replace(/\*[^*]*\*/g, " ")
    .replace(
      /\b(?:i|we)\s+(?:say|said|ask|asked|whisper|whispered|murmur|murmured|tell|told|add|added|reply|replied|exclaim|exclaimed)\b[\s\S]*$/i,
      "",
    )
    .trim();
}

function normalizeExplicitChoiceSurface(
  rawSurface: string,
  participantNames?: string[],
): string {
  let next = stripTrailingAttribution(rawSurface)
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
  if (!next) {
    return "";
  }

  const names = (participantNames ?? []).filter(Boolean);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ").replace(/\s+/g, " ").trim();
  }

  return next.replace(/^[,\s]+|[,\s]+$/g, "").trim();
}

function extractExplicitUserChoice(input: {
  latestUserMessage?: string;
  participantNames?: string[];
}): ExplicitUserChoice | null {
  const latestUserMessage = input.latestUserMessage?.trim();
  if (!latestUserMessage) {
    return null;
  }

  const cleaned = stripTrailingAttribution(latestUserMessage);
  const patterns: Array<{ kind: ExplicitUserChoice["kind"]; regex: RegExp }> = [
    {
      kind: "preference",
      regex:
        /\bi\s+(?:think\s+)?(?:(?:am|m)\s+gonna|(?:am|m)\s+going\s+to|will|would\s+like(?:\s+to)?|would\s+love(?:\s+to)?|want(?:\s+to)?|wanna)\s+(?:have|get|buy|order|take)?\s*([^,.!?;\n]+)/i,
    },
    {
      kind: "preference",
      regex:
        /\bi['’]ll\s+(?:have|get|buy|order|take|go\s+with|pick|choose)\s+([^,.!?;\n]+)/i,
    },
    {
      kind: "preference",
      regex:
        /\bi['’](?:d\s+(?:like|love)(?:\s+to)?|m\s+(?:gonna|going\s+to))\s+(?:have|get|buy|order|take)?\s*([^,.!?;\n]+)/i,
    },
    {
      kind: "selection",
      regex: /\bi\s+(?:choose|pick|prefer)\s+([^,.!?;\n]+)/i,
    },
    {
      kind: "selection",
      regex: /\bi\s+like\s+([^,.!?;\n]+)/i,
    },
  ];

  const participantTokens = participantNameTokens(input.participantNames);
  for (const pattern of patterns) {
    const match = cleaned.match(pattern.regex);
    const surfaceText = normalizeExplicitChoiceSurface(match?.[1] ?? "", input.participantNames);
    if (!surfaceText) {
      continue;
    }

    const anchorTokens = [...new Set(
      tokenizeExplicitChoiceText(surfaceText).filter(
        (token) =>
          !participantTokens.has(token) &&
          !USER_CHOICE_STOPWORDS.has(token) &&
          (token.length >= 4 || USER_CHOICE_SHORT_ALLOWLIST.has(token)),
      ),
    )];
    if (anchorTokens.length === 0) {
      continue;
    }

    const headTokens = anchorTokens.filter((token) => token !== "one");
    return {
      kind: pattern.kind,
      surfaceText,
      anchorTokens,
      headTokens: headTokens.length > 0 ? headTokens.slice(-2) : anchorTokens.slice(-1),
    };
  }

  return null;
}

function inferEffectCueTokens(socialEffect: string): string[] {
  const normalized = socialEffect.toLowerCase();
  if (normalized.includes("backs the user's move")) {
    return ["agree", "choose", "support", "take"];
  }
  if (normalized.includes("pushes back on the current direction")) {
    return ["careful", "easy", "hold", "wait"];
  }
  if (normalized.includes("tries to smooth the interaction")) {
    return ["calm", "easy", "sorry", "steady"];
  }
  if (normalized.includes("redirects the scene toward another option")) {
    return ["another", "choose", "instead", "option", "order"];
  }
  if (normalized.includes("asks for clarification")) {
    return ["clarify", "explain", "mean", "why"];
  }
  if (normalized.includes("adds caution to the moment")) {
    return ["careful", "safe", "steady", "watch"];
  }
  if (normalized.includes("lightens the mood")) {
    return ["joke", "laugh", "playful", "tease"];
  }
  return [];
}

function isChargedLatestUserTone(tone: TurnFrameTone | undefined): boolean {
  return tone === "provocative" || tone === "flirtatious" || tone === "playful";
}

function describeLatestUserSocialTone(tone: TurnFrameTone | undefined): string {
  switch (tone) {
    case "provocative":
      return "provocative/flirtatious";
    case "flirtatious":
      return "flirtatious";
    case "playful":
      return "playful/teasing";
    default:
      return tone ?? "neutral";
  }
}

function buildRoomMomentumDescription(
  priorReplies: GroupRoundReplySummary[],
): string {
  if (priorReplies.length < 2) {
    return "At least one other participant has already set a tone for this round.";
  }

  const hasPushbackOrCaution = priorReplies.some(
    (reply) =>
      reply.socialEffect === "pushes back on the current direction" ||
      reply.socialEffect === "adds caution to the moment",
  );
  if (hasPushbackOrCaution) {
    return "The room is already reacting to pressure instead of staying neutral.";
  }

  const hasRedirection = priorReplies.some(
    (reply) => reply.socialEffect === "redirects the scene toward another option",
  );
  const hasSupport = priorReplies.some(
    (reply) => reply.socialEffect === "backs the user's move",
  );
  if (hasRedirection && hasSupport) {
    return "The room is already shaping the decision from multiple angles.";
  }
  if (hasRedirection) {
    return "The room has already started steering the scene toward a concrete next option.";
  }
  if (hasSupport) {
    return "The room has already started leaning into one direction instead of answering cold.";
  }

  const hasPlayfulOrWarmTone = priorReplies.some((reply) =>
    ["playful", "warm"].includes(reply.emotionalTone),
  );
  if (hasPlayfulOrWarmTone) {
    return "The room already has a social tone, so do not answer flat or in isolation.";
  }

  return "The room already has an established beat, so do not answer like the first speaker.";
}

function buildCurrentTopicCueTokens(input: {
  latestUserMessage?: string;
  participantNames: string[];
  addressedParticipants: string[];
  currentSpeakerName?: string;
}): string[] {
  const excludedTokens = [
    ...input.participantNames.flatMap((name) => extractGroupCueTokens(name)),
    ...input.addressedParticipants.flatMap((name) => extractGroupCueTokens(name)),
    ...extractGroupCueTokens(input.currentSpeakerName ?? ""),
  ];

  return extractGroupCueTokens(input.latestUserMessage ?? "", excludedTokens).slice(0, 8);
}

function buildCurrentTopicLabel(topicCueTokens: string[]): string {
  if (topicCueTokens.length === 0) {
    return "";
  }

  return topicCueTokens.slice(0, 4).join(" ");
}

function deriveGroupEngagementExpectation(input: {
  priorReplies: GroupRoundReplySummary[];
  currentSpeakerRole: GroupRoundState["currentSpeakerRole"];
}): GroupRoundEngagementExpectation {
  if (input.priorReplies.length === 0) {
    return "none";
  }
  return "required";
}

function buildGroupSocialBeat(input: {
  priorReplies: GroupRoundReplySummary[];
  addressedParticipants: string[];
  latestUserSocialTone: TurnFrameTone;
  currentSpeakerRole: GroupRoundState["currentSpeakerRole"];
  currentTopicLabel: string;
}): string {
  const chargedTone = isChargedLatestUserTone(input.latestUserSocialTone);
  const socialToneLabel = describeLatestUserSocialTone(input.latestUserSocialTone);
  if (input.priorReplies.length === 0) {
    if (
      input.currentSpeakerRole === "observer_to_other_address" &&
      input.addressedParticipants.length > 0
    ) {
      if (chargedTone) {
        return `The user just aimed a ${socialToneLabel} remark at ${input.addressedParticipants.join(", ")}; the live room beat is that social tension now, not an older practical topic.`;
      }
      return input.currentTopicLabel
        ? `The user just put ${input.addressedParticipants.join(", ")} on the spot about ${input.currentTopicLabel}, and no other participant has answered yet.`
        : `The user just put ${input.addressedParticipants.join(", ")} on the spot, and no other participant has answered yet.`;
    }
    if (input.currentSpeakerRole === "directly_addressed" && chargedTone) {
      return `The user just aimed a ${socialToneLabel} remark at you; answer that social beat directly before returning to any practical topic.`;
    }
    if (chargedTone) {
      return `The user's latest line carries a ${socialToneLabel} tone; keep the reply on that live social beat.`;
    }
    return input.currentTopicLabel
      ? `No prior same-round reply has set the room tone yet, but ${input.currentTopicLabel} is now the live topic.`
      : "No prior same-round reply has set the room tone yet.";
  }

  const latestPriorReply = input.priorReplies[input.priorReplies.length - 1];
  const parts: string[] = [];

  if (input.addressedParticipants.length > 0) {
    parts.push(`The user put ${input.addressedParticipants.join(", ")} on the spot.`);
  }
  if (input.currentTopicLabel) {
    parts.push(`The live topic is ${input.currentTopicLabel}.`);
  }
  if (chargedTone) {
    parts.push(`The latest user line carries a ${socialToneLabel} tone; that tone is the live social frame.`);
  }
  parts.push(
    `${latestPriorReply.speakerName} ${latestPriorReply.socialEffect} in a ${latestPriorReply.emotionalTone} tone.`,
  );
  parts.push(buildRoomMomentumDescription(input.priorReplies));

  return parts.join(" ");
}

function buildExpectedSocialMove(input: {
  priorReplies: GroupRoundReplySummary[];
  addressedParticipants: string[];
  latestUserSocialTone: TurnFrameTone;
  currentSpeakerRole: GroupRoundState["currentSpeakerRole"];
  engagementExpectation: GroupRoundEngagementExpectation;
  currentTopicLabel: string;
}): string {
  const chargedTone = isChargedLatestUserTone(input.latestUserSocialTone);
  const socialToneLabel = describeLatestUserSocialTone(input.latestUserSocialTone);
  if (input.priorReplies.length === 0) {
    if (
      input.currentSpeakerRole === "observer_to_other_address" &&
      input.addressedParticipants.length > 0
    ) {
      if (chargedTone) {
        return `React as someone hearing a ${socialToneLabel} remark land on ${input.addressedParticipants.join(", ")}: tease, show surprise, set a boundary, or redirect without answering for them or treating it like an older practical topic.`;
      }
      return input.currentTopicLabel
        ? `React as someone hearing the remark about ${input.currentTopicLabel} land on ${input.addressedParticipants.join(", ")} in the room.`
        : `React as someone hearing the remark land on ${input.addressedParticipants.join(", ")} in the room.`;
    }
    if (input.currentSpeakerRole === "directly_addressed" && chargedTone) {
      return `Answer as the addressee to the ${socialToneLabel} remark; tease back, deflect, set a boundary, or redirect in character.`;
    }
    if (chargedTone) {
      return `Answer the live ${socialToneLabel} social beat directly instead of drifting to older scene logistics.`;
    }
    return "Respond directly as the first speaker in this round.";
  }

  if (
    input.currentSpeakerRole === "observer_to_other_address" &&
    input.addressedParticipants.length > 0
  ) {
    if (chargedTone) {
      return `Show that you heard the ${socialToneLabel} remark aimed at ${input.addressedParticipants.join(", ")} and the replies already in motion before adding your observer reaction.`;
    }
    return input.currentTopicLabel
      ? `Show that you heard the remark about ${input.currentTopicLabel} aimed at ${input.addressedParticipants.join(", ")} and the replies already in motion before adding your own stance.`
      : `Show that you heard the remark aimed at ${input.addressedParticipants.join(", ")} and the replies already in motion before adding your own stance.`;
  }
  if (input.currentSpeakerRole === "directly_addressed") {
    if (chargedTone) {
      return `Answer as the addressee to the ${socialToneLabel} remark, while letting the earlier replies shape your tone.`;
    }
    return input.currentTopicLabel
      ? `Answer as the addressee on ${input.currentTopicLabel}, but make it obvious the earlier replies already changed the room before you speak.`
      : "Answer as the addressee, but make it obvious the earlier replies already changed the room before you speak.";
  }
  if (input.engagementExpectation === "required") {
    return input.currentTopicLabel
      ? `Make it obvious that the existing room beat around ${input.currentTopicLabel} changed your angle before you add your own.`
      : "Make it obvious that the existing room beat changed your angle before you add your own.";
  }
  return "Stay lightly aware of the earlier reply so you do not sound detached from the room.";
}

function buildGroupEngagementTargets(input: {
  priorReplies: GroupRoundReplySummary[];
  addressedParticipants: string[];
  currentSpeakerName?: string;
}): string[] {
  return [...new Set(
    [
      ...input.addressedParticipants,
      ...input.priorReplies.map((reply) => reply.speakerName),
    ].filter(
      (name) =>
        name.trim() &&
        name.trim().toLowerCase() !== input.currentSpeakerName?.trim().toLowerCase(),
    ),
  )];
}

function buildGroupEngagementCueTokens(input: {
  priorReplies: GroupRoundReplySummary[];
  currentTopicCueTokens: string[];
  currentSocialBeat: string;
  expectedSocialMove: string;
  currentSpeakerName?: string;
  engagementTargets: string[];
}): string[] {
  const excludedTokens = [
    ...extractGroupCueTokens(input.currentSpeakerName ?? ""),
    ...input.engagementTargets.flatMap((name) => extractGroupCueTokens(name)),
  ];

  const tokens = [
    ...input.currentTopicCueTokens,
    ...input.priorReplies.flatMap((reply) => [
      ...extractGroupCueTokens(reply.gist, excludedTokens),
      ...inferEffectCueTokens(reply.socialEffect),
    ]),
    ...extractGroupCueTokens(input.currentSocialBeat, excludedTokens),
    ...extractGroupCueTokens(input.expectedSocialMove, excludedTokens),
  ];

  return [...new Set(tokens)].slice(0, 12);
}

function deriveGroupRoundState(context: ResponseContext): GroupRoundState | null {
  if (context.mode !== "group") {
    return null;
  }

  const rosterOrder = (context.participantNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean);
  const participantDirectory = context.participantDirectory ?? {};
  const sameRoundMessages = context.history
    .slice(Math.max(0, lastUserTurnIndex(context.history) + 1))
    .filter((message) => message.role === "assistant");

  const priorReplies: GroupRoundReplySummary[] = [];
  for (const message of sameRoundMessages) {
    const speakerName =
      (message.speakerCharacterId
        ? participantDirectory[message.speakerCharacterId]?.trim()
        : "") || "Someone";
    const sanitized = sanitizeAssistantHistoryContent(message.content, {
      userName: context.userProfile?.name?.trim() || "you",
    })
      .replace(/^[A-Za-z][^:\n]{0,60}:\s*/, "")
      .trim();
    if (!sanitized) {
      continue;
    }
    const entry: GroupRoundReplySummary = {
      speakerCharacterId: message.speakerCharacterId,
      speakerName,
      gist: clipText(sanitized, 140),
      socialEffect: inferGroupReplyEffect(sanitized),
      emotionalTone: inferGroupReplyTone(sanitized),
    };
    const alreadyIncluded = priorReplies.some(
      (candidate) =>
        candidate.speakerName === entry.speakerName &&
        candidate.gist === entry.gist,
    );
    if (!alreadyIncluded) {
      priorReplies.push(entry);
    }
  }
  const boundedPriorReplies = priorReplies.slice(-3);
  const latestPriorReply = boundedPriorReplies[boundedPriorReplies.length - 1];
  const addressedParticipants = detectAddressedParticipants(
    context.latestUserMessage,
    rosterOrder,
  );
  const latestUserSocialTone = context.turnFrame?.emotionalTone ?? "neutral";

  const currentSpeakerName = context.speaker?.name?.trim();
  const currentTopicCueTokens = buildCurrentTopicCueTokens({
    latestUserMessage: context.latestUserMessage,
    participantNames: rosterOrder,
    addressedParticipants,
    currentSpeakerName,
  });
  const currentTopicLabel = buildCurrentTopicLabel(currentTopicCueTokens);
  const currentSpeakerRole: GroupRoundState["currentSpeakerRole"] =
    currentSpeakerName && addressedParticipants.includes(currentSpeakerName)
      ? "directly_addressed"
      : addressedParticipants.length > 0
        ? "observer_to_other_address"
        : "shared_group";
  const currentSocialBeat = buildGroupSocialBeat({
    priorReplies: boundedPriorReplies,
    addressedParticipants,
    latestUserSocialTone,
    currentSpeakerRole,
    currentTopicLabel,
  });
  const engagementExpectation = deriveGroupEngagementExpectation({
    priorReplies: boundedPriorReplies,
    currentSpeakerRole,
  });
  const expectedSocialMove = buildExpectedSocialMove({
    priorReplies: boundedPriorReplies,
    addressedParticipants,
    latestUserSocialTone,
    currentSpeakerRole,
    engagementExpectation,
    currentTopicLabel,
  });
  const engagementTargets = buildGroupEngagementTargets({
    priorReplies: boundedPriorReplies,
    addressedParticipants,
    currentSpeakerName,
  });
  const engagementCueTokens = buildGroupEngagementCueTokens({
    priorReplies: boundedPriorReplies,
    currentTopicCueTokens,
    currentSocialBeat,
    expectedSocialMove,
    currentSpeakerName,
    engagementTargets,
  });
  const currentSpeakerObligations = [
    "React directly to the latest user move before drifting into background lore.",
    "Stay anchored to the live scene and interaction tone.",
    currentSpeakerName
      ? `Reply only as ${currentSpeakerName}; do not speak for any other participant.`
      : "Reply only as the current speaker.",
    currentSpeakerRole === "directly_addressed"
      ? "The user's latest line is addressed to you specifically, so answer as the addressee."
      : "",
    currentSpeakerRole === "directly_addressed" &&
    isChargedLatestUserTone(latestUserSocialTone)
      ? `The latest line is ${describeLatestUserSocialTone(latestUserSocialTone)} and addressed to you; answer the social beat as ${currentSpeakerName ?? "the addressee"}, not as a stale practical topic.`
      : "",
    currentSpeakerRole === "observer_to_other_address" && addressedParticipants.length > 0
      ? `The user's latest line is addressed to ${addressedParticipants.join(", ")}, not you; react as someone hearing that exchange in the room, not as the person carrying out the request.`
      : "",
    currentSpeakerRole === "observer_to_other_address" &&
    addressedParticipants.length > 0 &&
    isChargedLatestUserTone(latestUserSocialTone)
      ? `The latest line is ${describeLatestUserSocialTone(latestUserSocialTone)} and aimed at ${addressedParticipants.join(", ")}; react as an observer with a brief in-room reaction without taking over their answer.`
      : "",
    isChargedLatestUserTone(latestUserSocialTone)
      ? `Latest user social tone: ${latestUserSocialTone}.`
      : "",
    currentTopicLabel
      ? `The live topic already on the floor is ${currentTopicLabel}; treat it as established, not unexplained.`
      : "",
    latestPriorReply
      ? `You just heard ${latestPriorReply.speakerName} say: ${clipText(latestPriorReply.gist, 120)} React as if you heard that in the room.`
      : "",
    boundedPriorReplies.length > 0
      ? "Absorb the earlier same-round replies and answer downstream from them without copying their wording."
      : "",
    latestPriorReply
      ? `Position your reply relative to ${latestPriorReply.speakerName}'s move: build on it, soften it, contrast it, or redirect it.`
      : "",
    boundedPriorReplies.length > 1
      ? "Let the earlier same-round replies change your stance; agree, build on, soften, or contrast them instead of answering in isolation."
      : "",
    boundedPriorReplies.length > 0 ? `Current social beat: ${currentSocialBeat}` : "",
    boundedPriorReplies.length > 0 ? `Expected social move: ${expectedSocialMove}` : "",
    engagementExpectation === "required"
      ? "Make it explicit that you heard the existing room beat before adding your own angle."
      : "",
    engagementTargets.length > 0 && engagementExpectation === "required"
      ? `Key people already shaping this beat: ${engagementTargets.join(", ")}.`
      : "",
  ].filter(Boolean);

  return {
    rosterOrder,
    priorReplies: boundedPriorReplies,
    addressedParticipants,
    latestUserSocialTone,
    currentSpeakerRole,
    currentTopicLabel,
    currentTopicCueTokens,
    currentSocialBeat,
    expectedSocialMove,
    engagementExpectation,
    engagementTargets,
    engagementCueTokens,
    currentSpeakerObligations,
  };
}

export function createResponseContext(
  input: ResponseSystemInput,
): ResponseContext {
  const history = filterGenerationFailureMessages(input.history);
  const previousAssistantReply = input.previousAssistantReply?.trim();
  return {
    speaker: input.speaker,
    userProfile: input.userProfile,
    relationshipState: input.relationshipState,
    participantNames: input.participantNames?.map((name) => name.trim()).filter(Boolean),
    participantDirectory: input.participantDirectory,
    sceneStateInput: normalizeSceneStateInput(
      input.sceneStateInput,
      input.relationshipState,
      input.speaker,
      input.userProfile,
    ),
    memory: input.memory,
    contextEntries: input.contextEntries,
    semanticMemorySnippets: input.semanticMemorySnippets ?? [],
    history,
    latestUserMessage: latestUserTurnText(history),
    mode: input.mode ?? "single",
    isRegeneration: Boolean(input.isRegeneration || previousAssistantReply),
    previousAssistantReply: previousAssistantReply || undefined,
    explicitUserChoice: null,
    turnFrame: null,
    responsePlan: null,
    sceneState: null,
    turnInterpretation: null,
    groupRoundState: null,
  };
}

export function buildResponseRetrievalHints(
  input: Pick<ResponseSystemInput, "speaker" | "userProfile" | "relationshipState" | "sceneStateInput">,
): string | undefined {
  return buildOwnedResponseRetrievalHints(input);
}

export function prepareResponseRequest(
  input: ResponseSystemInput,
): PreparedResponseRequest {
  const context = createResponseContext(input);
  const sceneState = deriveDynamicSceneState({
    speaker: context.speaker,
    userProfile: context.userProfile,
    relationshipState: context.relationshipState,
    sceneStateInput: context.sceneStateInput,
    history: context.history,
  });
  const turnInterpretation = interpretLatestUserTurn({
    speaker: context.speaker,
    userProfile: context.userProfile,
    relationshipState: context.relationshipState,
    sceneStateInput: context.sceneStateInput,
    history: context.history,
  });
  context.sceneState = sceneState;
  context.turnInterpretation = turnInterpretation;
  context.explicitUserChoice = extractExplicitUserChoice({
    latestUserMessage: context.latestUserMessage,
    participantNames: context.participantNames,
  });
  context.turnFrame = deriveTurnFrame({
    latestUserMessage: context.latestUserMessage,
    currentScene: context.sceneStateInput?.currentScene ?? context.relationshipState?.currentScene,
    participantNames: context.participantNames,
    history: context.history,
  });
  context.groupRoundState = deriveGroupRoundState(context);
  context.responsePlan = buildHarnessResponsePlan(context);
  const salienceProfile = deriveResponseSalienceProfile(context);
  context.salienceProfile = salienceProfile;
  const reactionPlan = buildCharacterReactionPlan(context);
  const compiledPrompt = compileResponseRequest({
    speaker: context.speaker,
    userProfile: context.userProfile,
    relationshipState: context.relationshipState,
    mode: context.mode,
    isRegeneration: context.isRegeneration,
    previousAssistantReply: context.previousAssistantReply,
    participantNames: context.participantNames,
    participantDirectory: context.participantDirectory,
    memory: context.memory,
    contextEntries: context.contextEntries,
    semanticMemorySnippets: context.semanticMemorySnippets,
    history: context.history,
    sceneState,
    turnInterpretation,
    explicitUserChoice: context.explicitUserChoice,
    groupRoundState: context.groupRoundState,
  });
  // Rebuilt with extra per-turn note lines when an extension contributes any;
  // the stable system message is the same either way.
  const buildRuntimeRequest = (turnNotes?: readonly string[]) =>
    toLlamaChatRequest({
      model: input.runtime.model,
      compiledPrompt,
      sampling: {
        ...input.sampling,
      },
      stream: input.runtime.stream,
      userName: context.userProfile?.name?.trim() || "you",
      ...(context.mode === "group"
        ? {
            speakerName: context.speaker?.name,
            participantNames: context.participantNames,
          }
        : {}),
      turnNotes,
    });
  const runtimeRequest = buildRuntimeRequest();

  return {
    context,
    sceneState,
    turnInterpretation,
    turnFrame: context.turnFrame,
    responsePlan: context.responsePlan,
    salienceProfile,
    groupRoundState: context.groupRoundState,
    reactionPlan,
    memorySelection: {
      contextEntries: context.contextEntries,
      semanticMemorySnippets: context.semanticMemorySnippets,
      retrievalHints: buildResponseRetrievalHints(input),
    },
    compiledPrompt,
    runtimeRequest,
    buildRuntimeRequest,
  };
}
