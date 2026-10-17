import type {
  PreparedResponseRequest,
  ResponseEvaluationReason,
  TurnInterpretation,
} from "../types";
import { echoesStaticCharacterLore } from "../runtime-field-gating";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[*_"'`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SPEAKER_PREFACE_VERBS =
  "(?:repl(?:y|ies|ied)|responds?|responded|says?|said|asks?|asked|whispers?|whispered|mutters?|muttered|murmurs?|murmured|shouts?|shouted|exclaims?|exclaimed|continues?|continued)";

function nameAliases(name?: string, allNames: string[] = []): string[] {
  const trimmed = name?.trim();
  if (!trimmed) {
    return [];
  }
  const aliases = [trimmed];
  const firstToken = trimmed.split(/\s+/)[0]?.trim();
  if (firstToken && firstToken.length >= 3 && firstToken !== trimmed) {
    const firstTokenIsUnique =
      allNames.length === 0 ||
      allNames.filter(
        (entry) =>
          entry.trim().split(/\s+/)[0]?.toLowerCase() === firstToken.toLowerCase(),
      ).length === 1;
    if (firstTokenIsUnique) {
      aliases.push(firstToken);
    }
  }
  return [...new Set(aliases)];
}

function aliasesPattern(aliases: string[]): string | null {
  const escaped = aliases
    .map((alias) => alias.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  return escaped.length > 0 ? `(?:${escaped.join("|")})` : null;
}

function containsMetaReasoning(reply: string, speakerName?: string): boolean {
  const normalized = reply.trim().toLowerCase();
  const normalizedSpeaker = speakerName?.trim().toLowerCase();
  const escapedSpeaker = speakerName?.trim() ? escapeRegExp(speakerName.trim()) : null;
  return (
    normalized.startsWith("as an ai assistant") ||
    normalized.startsWith("as an assistant") ||
    normalized.startsWith("as the character") ||
    normalized.startsWith("as this character") ||
    Boolean(
      escapedSpeaker &&
        new RegExp(
          `^as\\s+${escapedSpeaker}\\b[^,\\.]{0,80}\\b(?:i\\s+)?(?:might|would|could|should|will)\\b`,
          "i",
        ).test(reply.trim()),
    ) ||
    Boolean(
      normalizedSpeaker &&
        normalized.startsWith(`as ${normalizedSpeaker}, i `),
    ) ||
    normalized.startsWith("assistant is") ||
    normalized.startsWith("assistant is asking") ||
    normalized.startsWith("system is asking") ||
    /^(?:analysis|reasoning|thought|thinking|system|developer|prompt|instructions?|response contract|turn frame|latest user move|current live scene)\s*:/.test(
      normalized,
    ) ||
    normalized.startsWith("i need to understand") ||
    normalized.startsWith("let me consider") ||
    normalized.startsWith("based on the") ||
    normalized.startsWith("the character would") ||
    normalized.startsWith("to respond") ||
    /\b(?:system prompt|developer message|chain-of-thought|chain of thought|hidden reasoning|internal reasoning|prompt metadata|transcript scaffolding|instructions say|prompt says)\b/.test(
      normalized,
    )
  );
}

function containsPromptEcho(reply: string, speakerName?: string): boolean {
  const normalized = reply.trim().toLowerCase();
  const escapedName = speakerName?.trim() ? escapeRegExp(speakerName.trim()) : null;
  return (
    normalized.startsWith("assistant must engage in a roleplay conversation") ||
    normalized.startsWith("you must engage in a roleplay conversation") ||
    normalized.startsWith("core contract:") ||
    normalized.startsWith("core contract") ||
    normalized.startsWith("scenario:") ||
    normalized.startsWith("characters:") ||
    normalized.startsWith("setting:") ||
    normalized.startsWith("response contract:") ||
    normalized.startsWith("turn frame:") ||
    normalized.startsWith("latest user move:") ||
    normalized.startsWith("current live scene:") ||
    normalized.includes("{{user}}") ||
    normalized.includes("{{char}}") ||
    normalized.includes("roleplay conversation with the user below this line") ||
    normalized.includes("write only the character's next reply") ||
    normalized.includes("write only the character s next reply") ||
    normalized.includes("write one short in-character reply in plain text") ||
    normalized.includes("write one short in character reply in plain text") ||
    normalized.includes("prompt metadata") ||
    normalized.includes("transcript scaffolding") ||
    (escapedName !== null &&
      new RegExp(`^${escapedName}\\s+-\\s+`, "i").test(reply.trim()))
  );
}

function containsInternalScaffoldWrapper(reply: string): boolean {
  const firstLine = reply.trim().split("\n", 1)[0] ?? "";
  return /^\s*(?:previous|prior|earlier|last)\s+(?:group\s+)?(?:assistant\s+)?reply\s+from\s+[^:\n]{1,80}\s*:/i.test(
    firstLine,
  );
}

function containsDanglingSpeakerAttribution(
  reply: string,
  speakerName?: string,
  userName?: string,
  prepared?: PreparedResponseRequest,
): boolean {
  const trimmed = reply.trim();
  if (!trimmed) {
    return false;
  }

  const participantNames = prepared?.context.participantNames ?? [];
  const labelPattern = aliasesPattern([
    "assistant",
    "character",
    "ai",
    "bot",
    "user",
    "human",
    "system",
    "developer",
    "analysis",
    "final",
    ...nameAliases(speakerName, participantNames),
    ...nameAliases(userName, participantNames),
    ...participantNames.flatMap((name) => nameAliases(name, participantNames)),
  ]);
  if (!labelPattern) {
    return false;
  }

  return new RegExp(
    `^(?:["“']\\s*)?${labelPattern}(?:\\s+${SPEAKER_PREFACE_VERBS}\\b[^:\\n]{0,120})?\\s*:\\s*$`,
    "i",
  ).test(trimmed);
}

function containsThirdPersonSelfNarration(
  reply: string,
  speakerName?: string,
): boolean {
  const trimmed = reply.trim();
  if (!trimmed) {
    return false;
  }
  const openingParagraph = trimmed.split(/\n{2,}/)[0]?.trim() ?? trimmed;
  if (
    !openingParagraph.startsWith("*") &&
    /^(?:the\s+[a-z][a-z' -]{1,40}|his|her|their)\b[^"\n]{0,140}\b(?:eyes?|voice|hands?|expression|gaze|posture|smile|status|demeanor|manner|face|body)\b/i.test(
      openingParagraph,
    )
  ) {
    return true;
  }
  if (!speakerName?.trim()) {
    return /["“][^"”\n]{3,220}["”]\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s+(responded|said|asked|replied|murmured|whispered|gestured|laughed|smiled|sighed)\b/i.test(
      trimmed,
    );
  }
  const escapedName = escapeRegExp(speakerName.trim());
  const selfPattern = aliasesPattern(nameAliases(speakerName)) ?? escapedName;
  const selfPrefacePattern = aliasesPattern(nameAliases(speakerName));
  if (
    selfPrefacePattern &&
    new RegExp(
      `^(?:["“']\\s*)?${selfPrefacePattern}\\s+${SPEAKER_PREFACE_VERBS}\\b[^:\\n]{0,120}:`,
      "i",
    ).test(trimmed)
  ) {
    return true;
  }
  const openingSentence = trimmed.split(/[.!?\n]/, 1)[0]?.trim() ?? trimmed;
  const selfAgencyPattern = new RegExp(
    `\\b${selfPattern}\\b(?:\\s+here)?\\s+(?:would|will|wants?|likes?|loves?|thinks?|feels?|needs?|prefers?|can|could|might|should)\\b`,
    "i",
  );
  return (
    new RegExp(`^(?:poor\\s+little\\s+|dear\\s+|sweet\\s+)?${selfPattern}\\b`, "i").test(
      openingSentence,
    ) ||
    new RegExp(`\\b${selfPattern}'s\\b`, "i").test(reply) ||
    selfAgencyPattern.test(reply) ||
    new RegExp(
      `\\b${selfPattern}\\b(?:\\s+here)?\\s+(is|are|looks|looked|glances|glanced|raises|raised|moves|moved|nods|nodded|smiles|smiled|laughs|laughed|stammers|stammered|says|said|asks|asked|holds|held|twirls|twirled|steps|stepped|backs|backed|appears|appeared|feels|felt)\\b`,
      "i",
    ).test(reply) ||
    new RegExp(
      `["“][^"”\\n]{3,220}["”]\\s+${selfPattern}\\s+(responded|said|asked|replied|murmured|whispered|gestured|laughed|smiled|sighed)\\b`,
      "i",
    ).test(reply)
  );
}

function containsInsufficientSubstance(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  const normalized = normalizeText(reply);
  if (!normalized) {
    return true;
  }

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return true;
  }

  const allowedSingleTokenReplies = new Set([
    "yes",
    "no",
    "fine",
    "okay",
    "ok",
    "sorry",
    "wait",
    "hello",
    "hi",
    "hey",
    "thanks",
  ]);

  if (tokens.length === 1) {
    return !allowedSingleTokenReplies.has(tokens[0] ?? "");
  }

  if (prepared?.context.mode === "group") {
    if (tokens.length <= 2 && reply.trim().length < 18) {
      return true;
    }
    if (
      tokens.length <= 4 &&
      !/[.!?"]/u.test(reply) &&
      !/\b(i|you|we|me|my|your|our|let|can|will|should|need|want|think|see|wait|sorry|please)\b/i.test(
        normalized,
      )
    ) {
      return true;
    }
  }

  return false;
}

function containsIncompleteSentence(reply: string): boolean {
  const trimmed = reply.trim();
  const withoutTrailingControls = trimmed
    .replace(/\s*(?:regenerate|branch|export)\s*$/i, "")
    .trim();
  if (!withoutTrailingControls) {
    return false;
  }

  const unclosedQuote =
    (withoutTrailingControls.match(/"/g) ?? []).length % 2 === 1 ||
    ((withoutTrailingControls.match(/“/g) ?? []).length >
      (withoutTrailingControls.match(/”/g) ?? []).length);
  const unclosedAsterisk = (withoutTrailingControls.match(/\*/g) ?? []).length % 2 === 1;
  if (unclosedQuote || unclosedAsterisk) {
    return true;
  }

  const tokens = normalizeText(withoutTrailingControls).split(" ").filter(Boolean);
  if (
    tokens.length >= 2 &&
    tokens.length <= 10 &&
    !/[.!?”"]$/.test(withoutTrailingControls)
  ) {
    const shortTail = tokens.slice(-4).join(" ");
    return (
      /[,;:]$/.test(withoutTrailingControls) ||
      /\b(?:and|or|but|because|while|as|before|after|toward|towards|with|without|in|on|at|by|into|onto|from|for|to|of|the|a|an|your|his|her|their|my|our|this|that|these|those)$/.test(
        shortTail,
      ) ||
      /\b(?:i|you|we|they|he|she)\s+(?:can|could|would|will|should|might|must|need|want|have|has|had|am|are|is|was|were)$/.test(
        shortTail,
      )
    );
  }

  if (/[.!?”"]$/.test(withoutTrailingControls)) {
    return false;
  }

  if (trimmed.length < 80) {
    return false;
  }

  const lastWords = tokens.slice(-4);
  const tail = lastWords.join(" ");
  if (!tail) {
    return false;
  }

  return (
    /\b(?:and|or|but|because|while|as|before|after|toward|towards|with|without|in|on|at|by|into|onto|from|for|to|of|the|a|an|your|his|her|their|my|our|this|that|these|those)$/.test(
      tail,
    ) ||
    /\b(?:i|you|we|they|he|she)\s+(?:can|could|would|will|should|might|must|need|want|have|has|had|am|are|is|was|were)$/.test(
      tail,
    )
  );
}

function recentAssistantMessages(prepared?: PreparedResponseRequest): string[] {
  return (prepared?.context.history ?? [])
    .filter((message) => message.role === "assistant" && message.content.trim())
    .slice(-4)
    .map((message) => message.content.trim())
    .reverse();
}

function normalizedOpening(value: string): string {
  return normalizeText(value)
    .split(" ")
    .filter(Boolean)
    .slice(0, 9)
    .join(" ");
}

function containsRepeatedRecentOpening(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  const replyOpening = normalizedOpening(reply);
  const replyTokens = replyOpening.split(" ").filter(Boolean);
  if (replyTokens.length < 6 || replyOpening.length < 26) {
    return false;
  }

  return recentAssistantMessages(prepared).some((previous) => {
    const previousOpening = normalizedOpening(previous);
    const previousTokens = previousOpening.split(" ").filter(Boolean);
    if (previousTokens.length < 6 || previousOpening.length < 26) {
      return false;
    }

    const sharedTokenCount = Math.min(replyTokens.length, previousTokens.length, 8);
    if (sharedTokenCount < 6) {
      return false;
    }
    const replySharedOpening = replyTokens.slice(0, sharedTokenCount).join(" ");
    const previousSharedOpening = previousTokens.slice(0, sharedTokenCount).join(" ");
    return (
      replySharedOpening === previousSharedOpening &&
      replySharedOpening.length >= 26
    );
  });
}

function containsStaticCharacterLoreEcho(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  if (!prepared?.context.speaker) {
    return false;
  }
  return echoesStaticCharacterLore(
    reply,
    prepared.context.speaker,
    prepared.context.history,
  );
}

function phraseWindows(tokens: string[], size: number): string[] {
  if (tokens.length < size) {
    return [];
  }
  const phrases: string[] = [];
  for (let index = 0; index <= tokens.length - size; index += 1) {
    const phrase = tokens.slice(index, index + size).join(" ").trim();
    if (phrase.length >= 22) {
      phrases.push(phrase);
    }
  }
  return phrases;
}

function containsSameRoundCopying(
  reply: string,
  prepared?: PreparedResponseRequest,
  speakerName?: string,
): boolean {
  if (prepared?.context.mode !== "group") {
    return false;
  }

  const normalizedReply = normalizeText(reply);
  if (!normalizedReply) {
    return false;
  }

  const currentSpeaker = speakerName?.trim().toLowerCase();
  const priorReplies = prepared.groupRoundState?.priorReplies ?? [];
  for (const priorReply of priorReplies) {
    if (priorReply.speakerName.trim().toLowerCase() === currentSpeaker) {
      continue;
    }
    const gist = normalizeText(priorReply.gist);
    if (!gist || gist.length < 24) {
      continue;
    }
    if (normalizedReply.includes(gist) || gist.includes(normalizedReply)) {
      return true;
    }
    const overlappingPhrase = phraseWindows(gist.split(" ").filter(Boolean), 5).find(
      (phrase) => normalizedReply.includes(phrase),
    );
    if (overlappingPhrase) {
      return true;
    }
  }

  return false;
}

function mentionsParticipant(
  reply: string,
  participantName: string,
  participantNames: string[],
): boolean {
  const trimmed = participantName.trim();
  if (!trimmed) {
    return false;
  }

  if (new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, "i").test(reply)) {
    return true;
  }

  const firstToken = trimmed.split(/\s+/)[0]?.trim();
  if (!firstToken || firstToken.length < 3) {
    return false;
  }

  const uniqueFirstToken =
    participantNames.filter(
      (name) => name.trim().split(/\s+/)[0]?.toLowerCase() === firstToken.toLowerCase(),
    ).length === 1;
  if (!uniqueFirstToken) {
    return false;
  }

  return new RegExp(`\\b${escapeRegExp(firstToken)}\\b`, "i").test(reply);
}

function containsSameRoundNonEngagement(
  reply: string,
  prepared?: PreparedResponseRequest,
  speakerName?: string,
): boolean {
  if (prepared?.context.mode !== "group") {
    return false;
  }

  const groupRoundState = prepared.groupRoundState;
  if (
    !groupRoundState ||
    groupRoundState.priorReplies.length === 0 ||
    groupRoundState.engagementExpectation !== "required"
  ) {
    return false;
  }

  const normalizedReply = normalizeText(reply);
  if (!normalizedReply) {
    return false;
  }

  const currentTopicCueTokens = groupRoundState.currentTopicCueTokens ?? [];

  const observerTopicConfusion =
    groupRoundState.currentSpeakerRole === "observer_to_other_address" &&
    currentTopicCueTokens.length > 0 &&
    /\b(how did that come up|where did that come from|out of nowhere|why are we talking about|what does that have to do with)\b/i.test(
      normalizedReply,
    );
  if (observerTopicConfusion) {
    return true;
  }

  const participantNames = prepared.context.participantNames ?? [];
  const currentSpeaker = speakerName?.trim().toLowerCase();
  const mentionsTargetParticipant = groupRoundState.engagementTargets.some(
    (participantName) =>
      participantName.trim().toLowerCase() !== currentSpeaker &&
      mentionsParticipant(reply, participantName, participantNames),
  );
  if (mentionsTargetParticipant) {
    return false;
  }

  const cueMatchCount = [...new Set(groupRoundState.engagementCueTokens)].filter((token) =>
    new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(normalizedReply),
  ).length;
  if (cueMatchCount >= 2) {
    return false;
  }

  const stanceSignal = /\b(agree|agreed|also|anyway|but|calm|come|either|exactly|fine|hold|instead|leave|listen|maybe|mean|please|rather|right|same|still|sure|though|too|wait|well|yeah|yes)\b/i.test(
    normalizedReply,
  );
  if (
    cueMatchCount >= 1 &&
    (
      stanceSignal ||
      groupRoundState.currentSpeakerRole !== "shared_group"
    )
  ) {
    return false;
  }

  return true;
}

function containsObserverRoleViolation(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  const groupRoundState = prepared?.groupRoundState;
  if (
    prepared?.context.mode !== "group" ||
    !groupRoundState ||
    groupRoundState.currentSpeakerRole !== "observer_to_other_address" ||
    groupRoundState.addressedParticipants.length === 0
  ) {
    return false;
  }

  const normalizedReply = normalizeText(reply);
  if (!normalizedReply) {
    return false;
  }

  const directComplianceLead =
    /^(sure thing|of course|right away|no problem|got it|consider this request granted)\b/i.test(
      normalizedReply,
    ) ||
    /^(i\s+(?:can|will|ll|am going to|gotta)|let me)\b/i.test(normalizedReply);
  const requestOwnership =
    /\b(i\s+(?:can|will|ll|am going to)\s+(?:change|turn|switch|mute|lower|raise|handle|take care of|deal with|pick|choose|drive|show|help|assist))\b/i.test(
      normalizedReply,
    ) ||
    /\b(let me\s+(?:change|turn|switch|mute|lower|raise|handle|pick|choose|show))\b/i.test(
      normalizedReply,
    );
  const addressesTargetParticipant = groupRoundState.addressedParticipants.some((name) =>
    mentionsParticipant(reply, name, prepared?.context.participantNames ?? []),
  );

  return (directComplianceLead || requestOwnership) && !addressesTargetParticipant;
}

const USER_CHOICE_REPLY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "classic",
  "extra",
  "flavor",
  "for",
  "get",
  "got",
  "have",
  "it",
  "its",
  "just",
  "large",
  "let",
  "lets",
  "mozzarella",
  "our",
  "please",
  "really",
  "small",
  "some",
  "that",
  "the",
  "then",
  "this",
  "up",
  "we",
  "well",
  "with",
  "you",
  "your",
]);

function tokenizeChoiceReplyText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[*_"'`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function containsUserChoiceOverwrite(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  const explicitUserChoice = prepared?.context.explicitUserChoice;
  if (!explicitUserChoice) {
    return false;
  }

  const normalizedReply = normalizeText(reply);
  if (!normalizedReply) {
    return false;
  }

  const lowerReply = reply.toLowerCase();
  const suggestionOrContrast =
    /\b(if you want|if you're|if youre|maybe|could|what about|another option|or\b|instead|i(?:'d| would)\s+(?:go|pick|choose|order|get)|you could|we could)\b/i.test(
      lowerReply,
    );
  if (suggestionOrContrast) {
    return false;
  }

  const commitmentPattern =
    /\b(it(?:'s| is)\s+settled|you(?:'ve| have)\s+got\s+yourself|that(?:\s+one)?\s+it\s+is|we(?:'re| are)\s+getting|your\s+order|coming\s+right\s+up|i(?:'ll| will)\s+(?:get|bring|order|take)\b|let(?:'s| us)\s+get|all in on)\b/i;
  const commitmentMatch = reply.match(commitmentPattern);
  if (!commitmentMatch) {
    return false;
  }

  const evaluationSegment =
    commitmentMatch.index !== undefined ? reply.slice(commitmentMatch.index) : reply;
  const normalizedSurface = normalizeText(explicitUserChoice.surfaceText);
  const normalizedSegment = normalizeText(evaluationSegment);
  if (normalizedSurface && normalizedSegment.includes(normalizedSurface)) {
    return false;
  }

  const sentenceTokens = tokenizeChoiceReplyText(evaluationSegment);
  const preservedAnchorCount = explicitUserChoice.anchorTokens.filter((token) =>
    sentenceTokens.includes(token),
  ).length;
  const missingProtectedAnchor = explicitUserChoice.anchorTokens.some(
    (token) => !sentenceTokens.includes(token),
  );
  const novelTokens = [...new Set(
    sentenceTokens.filter(
      (token) =>
        !explicitUserChoice.anchorTokens.includes(token) &&
        !USER_CHOICE_REPLY_STOPWORDS.has(token) &&
        token.length >= 4,
    ),
  )];

  if (preservedAnchorCount === 0 && novelTokens.length >= 1) {
    return true;
  }

  if (
    explicitUserChoice.anchorTokens.length >= 2 &&
    preservedAnchorCount >= 1 &&
    normalizedSurface &&
    !normalizedSegment.includes(normalizedSurface) &&
    novelTokens.length >= 1
  ) {
    return true;
  }

  return missingProtectedAnchor && novelTokens.length >= 2;
}

function containsOtherParticipantImpersonation(
  reply: string,
  prepared?: PreparedResponseRequest,
  speakerName?: string,
): boolean {
  if (prepared?.context.mode !== "group") {
    return false;
  }

  const currentSpeaker = speakerName?.trim().toLowerCase();
  const others = (prepared?.context.participantNames ?? [])
    .map((name) => name.trim())
    .filter(Boolean)
    .filter((name) => name.toLowerCase() !== currentSpeaker);

  if (others.length === 0) {
    return false;
  }

  const trimmed = reply.trim();
  const participantNames = prepared?.context.participantNames ?? [];
  const otherActionVerbs =
    "(?:says?|said|asks?|asked|repl(?:y|ies|ied)|responds?|responded|whispers?|whispered|mutters?|muttered|murmurs?|murmured|shouts?|shouted|exclaims?|exclaimed|nods?|nodded|smiles?|smiled|laughs?|laughed|sighs?|sighed|turns?|turned|looks?|looked|glances?|glanced|moves?|moved|steps?|stepped|reaches?|reached|raises?|raised|holds?|held|touches?|touched)";
  const otherAgencyVerbs =
    "(?:would|will|wants?|likes?|loves?|thinks?|feels?|needs?|prefers?|can|could|might|should)";
  const groupRoundState = prepared?.groupRoundState;

  return others.some((name) => {
    const pattern = aliasesPattern(nameAliases(name, participantNames));
    if (!pattern) {
      return false;
    }
    const opensByAddressingOtherParticipant =
      groupRoundState?.currentSpeakerRole === "directly_addressed" &&
      !groupRoundState.addressedParticipants.some(
        (participantName) => participantName.trim().toLowerCase() === name.toLowerCase(),
      ) &&
      new RegExp(
        `^(?:["“']\\s*)?(?:(?:sure|okay|ok|yes|yeah|well|hey|listen|alright|right|no)\\s*[,!]?\\s*)?${pattern}\\b\\s*[,!]`,
        "i",
      ).test(trimmed);
    const secondPersonVocativeToOtherParticipant =
      groupRoundState?.currentSpeakerRole === "directly_addressed" &&
      !groupRoundState.addressedParticipants.some(
        (participantName) => participantName.trim().toLowerCase() === name.toLowerCase(),
      ) &&
      new RegExp(
        `\\b(?:you|your|you're|you’re|you've|you’ve|yours)\\b[^.!?\\n]{0,140}\\b${pattern}\\b\\s*[,!.?]`,
        "i",
      ).test(reply);
    return (
      opensByAddressingOtherParticipant ||
      secondPersonVocativeToOtherParticipant ||
      new RegExp(
        `^(?:["“']\\s*)?${pattern}(?:\\s+${SPEAKER_PREFACE_VERBS}\\b[^:\\n]{0,120})?\\s*:`,
        "i",
      ).test(trimmed) ||
      new RegExp(
        `["“][^"”\\n]{1,220}["”]\\s*,?\\s*${pattern}\\s+${SPEAKER_PREFACE_VERBS}\\b`,
        "i",
      ).test(reply) ||
      new RegExp(`\\b${pattern}\\b\\s+${otherActionVerbs}\\b`, "i").test(
        reply,
      ) ||
      new RegExp(
        `\\b${pattern}\\b(?:\\s+and\\s+[A-Z][A-Za-z]+(?:\\s+[A-Z][A-Za-z]+)?)?\\s+${otherAgencyVerbs}\\b`,
        "i",
      ).test(reply) ||
      new RegExp(`\\bfor\\s+${pattern}\\s+to\\s+\\w+`, "i").test(reply) ||
      new RegExp(
        `\\b${pattern}'s\\b\\s+(?:eyes?|voice|hands?|face|expression|gaze|posture|smile|body)\\b`,
        "i",
      ).test(reply)
    );
  });
}

function containsUserEcho(reply: string, latestUserMessage?: string): boolean {
  if (!latestUserMessage?.trim()) {
    return false;
  }
  const normalizedReply = normalizeText(reply);
  const normalizedUser = normalizeText(latestUserMessage);
  if (!normalizedReply || !normalizedUser) {
    return false;
  }
  if (normalizedUser.length < 4) {
    return false;
  }
  return normalizedReply.includes(normalizedUser);
}

function containsUserTranscriptLeakage(
  reply: string,
  userName?: string,
): boolean {
  const prefixes = ["user", "human", "you", "me"];
  if (userName?.trim()) {
    prefixes.push(...nameAliases(userName));
  }

  return prefixes.some((prefix) =>
    new RegExp(
      `(^|\\n)\\s*["']?${escapeRegExp(prefix)}(?:\\s+${SPEAKER_PREFACE_VERBS}\\b[^:\\n]{0,120})?\\s*:`,
      "i",
    ).test(reply),
  );
}

function containsGenericUserReference(
  reply: string,
): boolean {
  const normalized = reply.toLowerCase();
  return /\bthe user\b|\bthe user['’]s\b|\buser['’]s\b/.test(normalized);
}

const BROAD_USER_SCRIPTING_ACTION_VERBS = [
  "approach",
  "approaches",
  "approached",
  "arrive",
  "arrives",
  "arrived",
  "back away",
  "backs away",
  "backed away",
  "blink",
  "blinks",
  "blinked",
  "catch",
  "catches",
  "caught",
  "enter",
  "enters",
  "entered",
  "flinch",
  "flinches",
  "flinched",
  "freeze",
  "freezes",
  "froze",
  "frown",
  "frowns",
  "frowned",
  "glance",
  "glances",
  "glanced",
  "look",
  "looks",
  "looked",
  "notice",
  "notices",
  "noticed",
  "nod",
  "nods",
  "nodded",
  "pause",
  "pauses",
  "paused",
  "reach",
  "reaches",
  "reached",
  "sit",
  "sits",
  "sat",
  "smile",
  "smiles",
  "smiled",
  "stand",
  "stands",
  "stood",
  "stare",
  "stares",
  "stared",
  "turn",
  "turns",
  "turned",
  "watch",
  "watches",
  "watched",
  "widen",
  "widens",
  "widened",
].join("|");

const USER_BODY_SCRIPTING_PATTERN =
  /\byour\s+(?:cock|dick|body|hips|hands?|mouth|voice|arms?|legs?|chest|breath|breathing|pulse|skin|eyes?|head|gaze|expression|posture|face|fingers?)\s+(?:swells?|twitches?|hardens?|aches?|moves?|moved|rise|rises|rising|falls?|falling|quickens?|quickened|flushes?|flushed|widens?|widened|narrows?|narrowed|turns?|turned|drops?|dropped|tightens?|tightened)\b/i;

const SCENE_LOCATION_PATTERNS = [
  { tag: "airport", pattern: /\bairport\b/i },
  { tag: "apartment", pattern: /\bapartment\b/i },
  { tag: "bar", pattern: /\bbar\b/i },
  { tag: "beach", pattern: /\bbeach\b/i },
  { tag: "bed", pattern: /\bbed\b/i },
  { tag: "bedroom", pattern: /\bbedroom\b/i },
  { tag: "cafe", pattern: /\bcaf(?:e|é)\b|\bcoffee shop\b/i },
  { tag: "car", pattern: /\bcar\b/i },
  { tag: "cinema", pattern: /\bcinema\b|\bmovie theater\b|\btheatre\b|\btheater\b/i },
  { tag: "diner", pattern: /\bdiner\b/i },
  { tag: "dining_room", pattern: /\bdining room\b/i },
  { tag: "house", pattern: /\bhouse\b/i },
  { tag: "mall", pattern: /\bshopping mall\b|\bmall\b/i },
  { tag: "market", pattern: /\bmarket\b/i },
  { tag: "pizzeria", pattern: /\bpizzeria\b/i },
  { tag: "pub", pattern: /\bpub\b/i },
  { tag: "restaurant", pattern: /\brestaurant\b/i },
  { tag: "room", pattern: /\broom\b/i },
  { tag: "sanctuary", pattern: /\bsanctuary\b/i },
  { tag: "showroom", pattern: /\bshowroom\b/i },
  { tag: "stadium", pattern: /\bstadium\b/i },
  { tag: "store", pattern: /\bstore\b|\bshop\b/i },
  { tag: "supermarket", pattern: /\bsupermarket\b|\bgrocery store\b/i },
  { tag: "tavern", pattern: /\btavern\b/i },
  { tag: "world", pattern: /\bworld\b/i },
  { tag: "woods", pattern: /\bwoods?\b|\bforest\b/i },
];

const GROUNDED_SCENE_TAGS = new Set([
  "airport",
  "bar",
  "beach",
  "cafe",
  "car",
  "cinema",
  "diner",
  "dining_room",
  "mall",
  "market",
  "pizzeria",
  "pub",
  "restaurant",
  "showroom",
  "stadium",
  "store",
  "supermarket",
]);

const PRIVATE_OR_FOREIGN_SCENE_TAGS = new Set([
  "apartment",
  "bed",
  "bedroom",
  "house",
  "room",
  "sanctuary",
  "tavern",
  "world",
  "woods",
]);

function extractSceneLocationTags(value: string): string[] {
  return SCENE_LOCATION_PATTERNS.filter(({ pattern }) => pattern.test(value)).map(
    ({ tag }) => tag,
  );
}

function currentLiveSceneText(prepared?: PreparedResponseRequest): string {
  const visibleScene = prepared?.sceneState?.visibleFacts.find((fact) =>
    /^Current live scene:/i.test(fact),
  );
  if (visibleScene) {
    return visibleScene.replace(/^Current live scene:/i, "").trim();
  }
  return (
    prepared?.context.sceneStateInput?.currentScene?.trim() ||
    prepared?.context.relationshipState?.currentScene?.trim() ||
    ""
  );
}

function containsUserAgencyViolation(
  reply: string,
  userName?: string,
): boolean {
  if (!reply.trim()) {
    return false;
  }

  const namedUser = userName?.trim();
  const subjects = ["you"];
  if (namedUser) {
    subjects.push(...nameAliases(namedUser));
  }
  const subjectPattern = aliasesPattern(subjects) ?? "(?:you)";
  const speechVerbPattern =
    "(?:say|says|said|ask|asks|asked|repl(?:y|ies|ied)|responds?|responded|whisper|whispers|whispered|moan|moans|moaned|groan|groans|groaned|murmur|murmurs|murmured|cry|cries|cried|shout|shouts|shouted|exclaim|exclaims|exclaimed|gasp|gasps|gasped)";
  const actionVerbPattern =
    "(?:take|takes|took|grab|grabs|grabbed|pull|pulls|pulled|push|pushes|pushed|slide|slides|slid|move|moves|moved|step|steps|stepped|walk|walks|walked|jump|jumps|jumped|climb|climbs|climbed|thrust|thrusts|thrusted|lean|leans|leaned|touch|touches|touched|kiss|kisses|kissed|spread|spreads|spread|tear|tears|tore|open|opens|opened|close|closes|closed|strip|strips|stripped)";

  const quotedSpeechAttribution = new RegExp(
    `["“][^"”\\n]{1,220}["”]\\s*,?\\s*${subjectPattern}\\s+${speechVerbPattern}\\b`,
    "i",
  );
  if (quotedSpeechAttribution.test(reply)) {
    return true;
  }

  const explicitUserAction = new RegExp(
    `\\b${subjectPattern}\\b\\s+${speechVerbPattern}\\b|\\b${subjectPattern}\\b\\s+${actionVerbPattern}\\b`,
    "i",
  );
  if (explicitUserAction.test(reply)) {
    return true;
  }

  const broadSecondPersonSceneScripting = new RegExp(
    `(?:^|[\\n(]\\s*)${subjectPattern}\\b\\s+(?:${BROAD_USER_SCRIPTING_ACTION_VERBS})\\b|\\b${subjectPattern}\\b\\s+(?:suddenly\\s+|slightly\\s+|slowly\\s+|softly\\s+|instinctively\\s+|briefly\\s+)?(?:${BROAD_USER_SCRIPTING_ACTION_VERBS})\\b\\s+(?:your\\b|as\\b|while\\b|before\\b|toward\\b|towards\\b|back\\b|into\\b|at\\b|from\\b)`,
    "i",
  );
  if (broadSecondPersonSceneScripting.test(reply)) {
    return true;
  }

  return USER_BODY_SCRIPTING_PATTERN.test(reply);
}

function containsTemplatePlaceholderLeak(reply: string): boolean {
  const placeholderNames =
    "user|user[_ -]?name|your[_ -]?name|name|char|char[_ -]?name|character|character[_ -]?name|speaker|speaker[_ -]?name|assistant|assistant[_ -]?name|bot|bot[_ -]?name|persona|profile|relationship|scene|context|message";
  return (
    /\{\{\s*[^}]{1,40}\s*\}\}/.test(reply) ||
    new RegExp(`\\{\\s*(?:${placeholderNames})\\s*\\}`, "i").test(
      reply,
    ) ||
    new RegExp(
      `<\\s*(?:${placeholderNames}|[A-Z][A-Z0-9_ -]{1,38})\\s*>`,
      "i",
    ).test(
      reply,
    ) ||
    new RegExp(`%\\s*(?:${placeholderNames})\\s*%`, "i").test(
      reply,
    ) ||
    new RegExp(`\\[\\s*(?:${placeholderNames})\\s*\\]`, "i").test(
      reply,
    )
  );
}

function containsSceneReplacementDrift(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  const liveScene = currentLiveSceneText(prepared);
  if (!liveScene) {
    return false;
  }

  const liveSceneTags = extractSceneLocationTags(liveScene);
  if (
    liveSceneTags.length === 0 ||
    !liveSceneTags.some(
      (tag) => GROUNDED_SCENE_TAGS.has(tag) || PRIVATE_OR_FOREIGN_SCENE_TAGS.has(tag),
    )
  ) {
    return false;
  }

  const replySceneTags = extractSceneLocationTags(reply);
  if (replySceneTags.length === 0) {
    return false;
  }

  const compatibleSceneTags = (tag: string): string[] => {
    if (tag === "bed" || tag === "bedroom" || tag === "room") {
      return ["bed", "bedroom", "room"];
    }
    return [tag];
  };
  const liveCompatibleTags = new Set(liveSceneTags.flatMap(compatibleSceneTags));
  if (replySceneTags.some((tag) => liveCompatibleTags.has(tag))) {
    return false;
  }

  const replyLower = reply.toLowerCase();
  const anchoredForeignSceneMention =
    /\b(?:in|inside|into|at|back in|back at|here in|here at|around|towards|toward|through)\s+(?:my|your|the|this|that|these|those|our)?\s*(?:apartment|bed|bedroom|cafe|café|car|cinema|diner|dining room|forest|house|mall|market|pizzeria|pub|restaurant|room|sanctuary|showroom|stadium|store|shop|supermarket|tavern|woods?|world)\b/i.test(
      replyLower,
    ) ||
    /\b(?:my|your|the|this|that|these|those|our)\s+(?:apartment|bed|bedroom|cafe|café|car|cinema|diner|dining room|forest|house|mall|market|pizzeria|pub|restaurant|room|sanctuary|showroom|stadium|store|shop|supermarket|tavern|woods?|world)\b/i.test(
      replyLower,
    ) ||
    /\b(?:what are you doing in|welcome to|been here the whole time|cozy|far-off)\b/i.test(
      replyLower,
    ) ||
    /\b(?:through|in|inside|into)\b.{0,60}\b(?:woods?|forest)\b/i.test(
      replyLower,
    );

  if (!anchoredForeignSceneMention) {
    return false;
  }

  return replySceneTags.some(
    (tag) =>
      !liveSceneTags.includes(tag) &&
      !liveCompatibleTags.has(tag) &&
      (PRIVATE_OR_FOREIGN_SCENE_TAGS.has(tag) || GROUNDED_SCENE_TAGS.has(tag)),
  );
}

function containsRoleInversion(
  reply: string,
  userName?: string,
  speakerName?: string,
): boolean {
  if (!reply.trim()) {
    return false;
  }

  if (
    userName?.trim() &&
    nameAliases(userName).some((alias) =>
      new RegExp(
        `(^|\\n)\\s*["']?${escapeRegExp(alias)}(?:\\s+${SPEAKER_PREFACE_VERBS}\\b[^:\\n]{0,120})?\\s*:`,
        "i",
      ).test(reply),
    )
  ) {
    return true;
  }

  if (
    speakerName?.trim() &&
    nameAliases(speakerName).some((alias) =>
      new RegExp(
        `(?:^|[,;!?]\\s+)${escapeRegExp(alias)}(?:[.!?,]|$)`,
        "i",
      ).test(reply),
    )
  ) {
    return true;
  }

  return new RegExp(
    `(^|\\n)\\s*["']?(?:you|me|user|human)(?:\\s+${SPEAKER_PREFACE_VERBS}\\b[^:\\n]{0,120})?\\s*:`,
    "i",
  ).test(reply);
}

function containsShortCommandEcho(
  reply: string,
  latestUserMessage?: string,
  turnInterpretation?: TurnInterpretation | null,
): boolean {
  if (!latestUserMessage?.trim()) {
    return false;
  }
  if (
    turnInterpretation?.actionType !== "armed-command" &&
    turnInterpretation?.actionType !== "armed-question" &&
    turnInterpretation?.actionType !== "threat" &&
    turnInterpretation?.actionType !== "command"
  ) {
    return false;
  }
  const normalizedReply = normalizeText(reply);
  const tokens = normalizeText(latestUserMessage)
    .split(" ")
    .filter(Boolean);
  if (tokens.length < 2 || tokens.length > 8) {
    return false;
  }
  const phrases = tokens
    .slice(0, -1)
    .map((token, index) => `${token} ${tokens[index + 1]}`)
    .filter((phrase) => phrase.replace(/\s/g, "").length >= 6);

  return phrases.some((phrase) => normalizedReply.includes(phrase));
}

function isShortDirectGreeting(latestUserMessage?: string): boolean {
  if (!latestUserMessage?.trim()) {
    return false;
  }
  return /^(hey|hi|hello|hey there|hi there|hello there|yo|good morning|good afternoon|good evening)([!.,?]+\s*|\s+[a-z0-9_'-]+[!.,?]*\s*){0,3}$/i.test(
    normalizeText(latestUserMessage),
  );
}

function contradictsDirectGreeting(
  reply: string,
  latestUserMessage?: string,
  prepared?: PreparedResponseRequest,
): boolean {
  const turn = prepared?.turnInterpretation;
  if (
    !turn?.requiresImmediateReaction ||
    (turn.actionType !== "greeting" && !/greeting/i.test(turn.intent))
  ) {
    return false;
  }
  if (!isShortDirectGreeting(latestUserMessage)) {
    return false;
  }

  const normalizedReply = normalizeText(reply);
  if (!normalizedReply) {
    return false;
  }

  return /\b(silent|silence|quiet|mute|wordless|speechless|remain silent|remains silent|stays silent|nothing to say|not speaking|say nothing|says nothing|said nothing)\b/i.test(
    normalizedReply,
  );
}

function relevantProfileCueTokens(prepared?: PreparedResponseRequest): string[] {
  const cue = prepared?.sceneState?.visibleFacts.find((fact) =>
    /^Relevant saved user profile fact:/i.test(fact),
  );
  if (!cue) {
    return [];
  }

  return normalizeText(cue.replace(/^Relevant saved user profile fact:/i, ""))
    .split(" ")
    .filter(
      (token) =>
        token.length >= 4 &&
        ![
          "that",
          "with",
          "from",
          "this",
          "have",
          "your",
          "user",
          "profile",
          "saved",
          "fact",
        ].includes(token),
    );
}

function visibleConditionCueTokens(prepared?: PreparedResponseRequest): string[] {
  const facts =
    prepared?.sceneState?.visibleFacts.filter((fact) =>
      /^Visible user condition:/i.test(fact),
    ) ?? [];
  if (facts.length === 0) {
    return [];
  }

  return normalizeText(
    facts.map((fact) => fact.replace(/^Visible user condition:/i, "")).join(" "),
  )
    .split(" ")
    .filter(
      (token) =>
        token.length >= 4 &&
        !["user", "condition", "with", "your", "their", "that", "from", "face", "clothes"].includes(token),
    );
}

function currentLiveSceneCueTokens(prepared?: PreparedResponseRequest): string[] {
  const cue = prepared?.sceneState?.visibleFacts.find((fact) =>
    /^Current live scene:/i.test(fact),
  );
  if (!cue) {
    return [];
  }

  return normalizeText(cue.replace(/^Current live scene:/i, ""))
    .split(" ")
    .filter(
      (token) =>
        token.length >= 4 &&
        ![
          "current",
          "live",
          "scene",
          "with",
          "from",
          "into",
          "onto",
          "they",
          "them",
          "were",
          "while",
          "standing",
          "sitting",
          "room",
        ].includes(token),
    );
}

function requiresCurrentSceneAnchoring(
  prepared?: PreparedResponseRequest,
): boolean {
  const latestUserMessage = prepared?.context.latestUserMessage?.trim();
  if (!latestUserMessage || prepared?.turnInterpretation?.actionType !== "question") {
    return false;
  }

  return (
    /\bwhat\s+are\s+we\s+doing\s+here\b/i.test(latestUserMessage) ||
    /\bwhere\s+are\s+we\b/i.test(latestUserMessage) ||
    /\bwhy\s+are\s+we\s+here\b/i.test(latestUserMessage)
  );
}

function missesImmediateReaction(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  const turn = prepared?.turnInterpretation;
  const requiresSceneAnchoring = requiresCurrentSceneAnchoring(prepared);
  const requiresVisibleObjectAcknowledgment = /visible object/i.test(turn?.intent ?? "");
  const requiresProfileCueAcknowledgment = /user-profile fact/i.test(turn?.intent ?? "");
  const requiresVisibleConditionAcknowledgment = /visible current condition|visible condition|injur/i.test(turn?.intent ?? "");
  if (
    !turn?.requiresImmediateReaction ||
    (!requiresVisibleObjectAcknowledgment &&
      !requiresVisibleConditionAcknowledgment &&
      !requiresProfileCueAcknowledgment &&
      !requiresSceneAnchoring &&
      turn.actionType !== "armed-command" &&
      turn.actionType !== "armed-question" &&
      turn.actionType !== "threat" &&
      turn.actionType !== "command" &&
      turn.actionType !== "greeting")
  ) {
    return false;
  }

  const normalized = normalizeText(reply);
  if (!normalized) {
    return false;
  }

  if (
    contradictsDirectGreeting(
      reply,
      prepared?.context.latestUserMessage,
      prepared,
    )
  ) {
    return true;
  }

  if (requiresProfileCueAcknowledgment) {
    const cueTokens = relevantProfileCueTokens(prepared);
    if (cueTokens.length > 0 && !cueTokens.some((token) => normalized.includes(token))) {
      return true;
    }
  }
  if (requiresVisibleConditionAcknowledgment) {
    const conditionCueTokens = visibleConditionCueTokens(prepared);
    const concernTokens = [
      "blood",
      "bleeding",
      "bleed",
      "hurt",
      "injured",
      "injury",
      "wound",
      "wounds",
      "face",
      "shirt",
      "clothes",
      "stains",
      "torn",
      "okay",
      "alright",
      "what happened",
    ];
    const noticedCondition =
      conditionCueTokens.some((token) => normalized.includes(token)) ||
      concernTokens.some((token) => normalized.includes(token));
    if (!noticedCondition) {
      return true;
    }
  }
  if (requiresSceneAnchoring) {
    const liveSceneCueTokens = currentLiveSceneCueTokens(prepared);
    if (
      liveSceneCueTokens.length > 0 &&
      !liveSceneCueTokens.some((token) => normalized.includes(token))
    ) {
      return true;
    }
  }

  const reactionSignalPatterns = [
    /\b(i|im|i m|me|my|mine|myself)\b/,
    /\b(you|your)\b/,
    /\b(okay|ok|alright|all right|easy|fine|wait|stop|listen|please|no|yes|hell)\b/,
    /\b(hands|gun|rifle|weapon|knife|skull|object|item|holding|hold|held|see|look|move|moving|back|raise|raising|raised|lift|lifting|lower|step|stepping|steady|calm|fear|scare|threat|drive|driving|car|vehicle|ride|wear|wearing|outfit|dress|shirt|jacket|coat|glasses|hat|blood|bleeding|hurt|injured|wound|torn|stain)\b/,
  ];

  return !reactionSignalPatterns.some((pattern) => pattern.test(normalized));
}

function containsGenericAssistantDrift(reply: string): boolean {
  const normalized = reply.trim().toLowerCase();
  return (
    normalized.startsWith("i understand") ||
    normalized.startsWith("i can help") ||
    normalized.startsWith("i'd be happy to help") ||
    normalized.startsWith("how can i help") ||
    normalized.startsWith("certainly") ||
    normalized.startsWith("of course") ||
    normalized.startsWith("i'm here to help") ||
    /\b(allow me to assist|i can assist you|let me assist you|let me show you|would you care if we|present (?:you|some)|perfect pair|suit your taste|available here today|what might suit your taste)\b/i.test(
      normalized,
    )
  );
}

function containsSceneRoleDrift(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  if (prepared?.sceneState?.sceneRoleExpectation !== "companions") {
    return false;
  }

  const normalized = reply.trim().toLowerCase();
  return (
    /\b(write(?:s|ing)?\s+down\s+(?:the|your|our|her|his)\s+order|(?:start|starts|started|begin|begins|began)\s+(?:writing\s+down\s+)?(?:the|your|our|her|his)\s+order|take(?:s|ing)?\s+(?:the|your|our)\s+order|what can i get you|coming right up|i(?:'ll| will)\s+(?:put|send)\s+(?:that|this|it)\s+(?:in|through)|our\s+(?:menu|store|shop|dealership|showroom|staff)|on behalf of\s+(?:our|the)\s+(?:staff|dealership|store)|available here today|let me present|would you care if we explored|excellent shops around here|perfect pair|suit your taste)\b/i.test(
      normalized,
    ) ||
    /\b(waiter|server|salesperson|salesman|saleswoman|cashier|clerk|dealership staff)\b/i.test(
      normalized,
    )
  );
}

function containsRelationshipToneViolation(
  reply: string,
  prepared?: PreparedResponseRequest,
): boolean {
  if (!reply.trim()) {
    return false;
  }
  const relationshipSummary = prepared?.context.relationshipState?.summary ?? "";
  const interactionTone = prepared?.context.relationshipState?.interactionTone ?? "";
  const platonicOrNeutral =
    /friend/i.test(relationshipSummary) ||
    (interactionTone.trim() !== "" &&
      !/\b(flirt|romantic|sensual|seductive|intimate)\b/i.test(interactionTone));
  if (!platonicOrNeutral) {
    return false;
  }

  return (
    /\b(my love|moan|moaning|sexy|seductive|breasts?|curves?|tonight~|good boy|good girl|sultry|intimate conversation)\b/i.test(
      reply,
    ) ||
    /\b(hand on (?:his|her|your)\s+thigh|touch(?:es|ing)?\s+(?:his|her|your)\s+thigh|places?\s+(?:her|his)\s+hand\s+on\s+(?:his|her|your)\s+thigh|leans\s+over\s+and\s+places?\s+(?:her|his)\s+hand|press(?:es|ing)?\s+(?:herself|himself)\s+against|caress(?:es|ing)?|stroke(?:s|d|ing)?\s+(?:his|her|your)\s+thigh|lap)\b/i.test(
      reply,
    )
  );
}

function dedupeReasons(reasons: ResponseEvaluationReason[]): ResponseEvaluationReason[] {
  return [...new Set(reasons)];
}

export interface ReplyAssessment {
  reasons: ResponseEvaluationReason[];
  retryRequested: boolean;
  suppressPreview: boolean;
  qualityScore: number;
  fatal: boolean;
}

export function evaluateCharacterReply(input: {
  reply: string;
  speakerName?: string;
  userName?: string;
  latestUserMessage?: string;
  prepared?: PreparedResponseRequest;
}): ReplyAssessment {
  const reasons: ResponseEvaluationReason[] = [];
  const trimmed = input.reply.trim();

  if (!trimmed) {
    reasons.push("empty_after_sanitize");
  }
  if (
    trimmed &&
    (containsMetaReasoning(trimmed, input.speakerName) ||
      containsPromptEcho(trimmed, input.speakerName) ||
      containsInternalScaffoldWrapper(trimmed))
  ) {
    reasons.push("meta_reasoning");
  }
  if (
    trimmed &&
    containsDanglingSpeakerAttribution(
      trimmed,
      input.speakerName,
      input.userName,
      input.prepared,
    )
  ) {
    reasons.push("incomplete_sentence");
  }
  if (trimmed && containsThirdPersonSelfNarration(trimmed, input.speakerName)) {
    reasons.push("third_person_self_narration");
  }
  if (trimmed && containsInsufficientSubstance(trimmed, input.prepared)) {
    reasons.push("insufficient_substance");
  }
  if (trimmed && containsIncompleteSentence(trimmed)) {
    reasons.push("incomplete_sentence");
  }
  if (trimmed && containsRepeatedRecentOpening(trimmed, input.prepared)) {
    reasons.push("repeated_opening");
  }
  if (trimmed && containsUserChoiceOverwrite(trimmed, input.prepared)) {
    reasons.push("user_choice_overwrite");
  }
  if (trimmed && containsSceneReplacementDrift(trimmed, input.prepared)) {
    reasons.push("scene_replacement_drift");
  }
  if (trimmed && containsObserverRoleViolation(trimmed, input.prepared)) {
    reasons.push("observer_role_violation");
  }
  const hasSameRoundCopying =
    trimmed && containsSameRoundCopying(trimmed, input.prepared, input.speakerName);
  if (hasSameRoundCopying) {
    reasons.push("same_round_copying");
  }
  if (
    trimmed &&
    !hasSameRoundCopying &&
    containsSameRoundNonEngagement(trimmed, input.prepared, input.speakerName)
  ) {
    reasons.push("same_round_non_engagement");
  }
  if (trimmed && containsStaticCharacterLoreEcho(trimmed, input.prepared)) {
    reasons.push("static_lore_echo");
  }
  if (trimmed && containsOtherParticipantImpersonation(trimmed, input.prepared, input.speakerName)) {
    reasons.push("other_participant_impersonation");
  }
  if (
    trimmed &&
    (containsUserEcho(trimmed, input.latestUserMessage) ||
      containsShortCommandEcho(
        trimmed,
        input.latestUserMessage,
        input.prepared?.turnInterpretation,
      ))
  ) {
    reasons.push("user_echo");
  }
  if (trimmed && containsTemplatePlaceholderLeak(trimmed)) {
    reasons.push("placeholder_leak");
  }
  if (trimmed && containsUserTranscriptLeakage(trimmed, input.userName)) {
    reasons.push("transcript_leakage");
  }
  if (trimmed && containsRoleInversion(trimmed, input.userName, input.speakerName)) {
    reasons.push("role_inversion");
  }
  if (trimmed && containsGenericAssistantDrift(trimmed)) {
    reasons.push("generic_assistant_drift");
  }
  if (trimmed && containsSceneRoleDrift(trimmed, input.prepared)) {
    reasons.push("scene_role_drift");
  }
  if (trimmed && containsGenericUserReference(trimmed)) {
    reasons.push("generic_user_reference");
  }
  if (trimmed && containsUserAgencyViolation(trimmed, input.userName)) {
    reasons.push("user_agency_violation");
  }
  if (trimmed && containsRelationshipToneViolation(trimmed, input.prepared)) {
    reasons.push("relationship_tone_violation");
  }
  if (trimmed && missesImmediateReaction(trimmed, input.prepared)) {
    reasons.push("missed_immediate_reaction");
  }

  const retryReasons = reasons.filter((reason) =>
    reason === "meta_reasoning" ||
    reason === "third_person_self_narration" ||
    reason === "insufficient_substance" ||
    reason === "incomplete_sentence" ||
    reason === "repeated_opening" ||
    reason === "user_choice_overwrite" ||
    reason === "scene_replacement_drift" ||
    reason === "observer_role_violation" ||
    reason === "same_round_copying" ||
    reason === "same_round_non_engagement" ||
    reason === "static_lore_echo" ||
    reason === "other_participant_impersonation" ||
    reason === "user_echo" ||
    reason === "placeholder_leak" ||
    reason === "transcript_leakage" ||
    reason === "role_inversion" ||
    reason === "generic_assistant_drift" ||
    reason === "scene_role_drift" ||
    reason === "generic_user_reference" ||
    reason === "user_agency_violation" ||
    reason === "relationship_tone_violation" ||
    reason === "missed_immediate_reaction",
  );

  const suppressPreviewReasons = reasons.filter((reason) =>
    reason === "meta_reasoning" ||
    reason === "third_person_self_narration" ||
    reason === "insufficient_substance" ||
    reason === "incomplete_sentence" ||
    reason === "repeated_opening" ||
    reason === "user_choice_overwrite" ||
    reason === "scene_replacement_drift" ||
    reason === "observer_role_violation" ||
    reason === "same_round_copying" ||
    reason === "same_round_non_engagement" ||
    reason === "static_lore_echo" ||
    reason === "other_participant_impersonation" ||
    reason === "placeholder_leak" ||
    reason === "transcript_leakage" ||
    reason === "role_inversion" ||
    reason === "scene_role_drift" ||
    reason === "user_agency_violation",
  );

  const fatalReasons = reasons.filter((reason) =>
    reason === "transcript_leakage" ||
    reason === "role_inversion" ||
    reason === "user_choice_overwrite" ||
    reason === "scene_replacement_drift" ||
    reason === "other_participant_impersonation" ||
    reason === "placeholder_leak" ||
    reason === "insufficient_substance" ||
    reason === "incomplete_sentence" ||
    reason === "repeated_opening" ||
    reason === "observer_role_violation" ||
    reason === "same_round_copying" ||
    reason === "same_round_non_engagement",
  );

  const qualityPenalty =
    reasons.reduce((score, reason) => {
      switch (reason) {
        case "meta_reasoning":
          return score + 0.4;
        case "third_person_self_narration":
          return score + 0.3;
        case "insufficient_substance":
          return score + 0.45;
        case "incomplete_sentence":
          return score + 0.4;
        case "repeated_opening":
          return score + 0.35;
        case "user_choice_overwrite":
          return score + 0.45;
        case "scene_replacement_drift":
          return score + 0.45;
        case "observer_role_violation":
          return score + 0.35;
        case "same_round_copying":
          return score + 0.4;
        case "same_round_non_engagement":
          return score + 0.35;
        case "static_lore_echo":
          return score + 0.45;
        case "other_participant_impersonation":
          return score + 0.5;
        case "user_echo":
          return score + 0.2;
        case "placeholder_leak":
          return score + 0.4;
        case "transcript_leakage":
          return score + 0.45;
        case "role_inversion":
          return score + 0.5;
        case "generic_assistant_drift":
          return score + 0.15;
        case "scene_role_drift":
          return score + 0.25;
        case "generic_user_reference":
          return score + 0.2;
        case "user_agency_violation":
          return score + 0.35;
        case "relationship_tone_violation":
          return score + 0.25;
        case "missed_immediate_reaction":
          return score + 0.25;
        case "empty_after_sanitize":
          return score + 0.5;
        default:
          return score;
      }
    }, 0);

  return {
    reasons: dedupeReasons(reasons),
    retryRequested: retryReasons.length > 0,
    suppressPreview: suppressPreviewReasons.length > 0 || !trimmed,
    qualityScore: Math.max(0, 1 - qualityPenalty),
    fatal: fatalReasons.length > 0,
  };
}
