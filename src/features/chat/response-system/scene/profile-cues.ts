const PROFILE_FACT_SPLIT_PATTERN = /(?:\r?\n+|[;|]+|(?<=[.!?])\s+)/;

const PROFILE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "im",
  "i'm",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "we",
  "what",
  "who",
  "you",
  "your",
]);

const DRIVING_PATTERN =
  /\b(driv(?:e|es|ing)|car|vehicle|ride|riding|sedan|suv|truck|bike|motorcycle|mercedes|bmw|audi|toyota|honda)\b/i;
const WEARING_PATTERN =
  /\b(wear(?:ing|s)?|dressed|outfit|jacket|dress|shirt|hoodie|coat|uniform|ring|necklace|watch|glasses|hat|tattoo)\b/i;
const HELD_OR_CARRIED_PATTERN =
  /\b(hold(?:ing)?|carry(?:ing)?|hand|hands|item|object|skull|briefcase|bag|case)\b/i;
const APPEARANCE_OR_CONDITION_PATTERN =
  /\b(clothes|shirt|jacket|face|bleed(?:ing)?|blood|bloodstain(?:s)?|blood stain(?:s)?|torn|injured|injury|wound|wounded|bruised|bruise|cut|cuts|scrape|scraped|limp|limping|dirty|soaked)\b/i;
const LOOKING_OR_NOTICE_PATTERN =
  /\b(look|see|guess|notice|describe|tell me what you see|tell me what you notice)\b/i;
const ABOUT_ME_PROMPT_PATTERN =
  /\b(what do you know about me|tell me about me|describe me|who am i|what am i like|what kind of person am i)\b/i;
const ENTRANCE_OR_GREETING_PATTERN =
  /\b(enter|enter the room|walk in|walk into|come in|came in|arrive|arrived|i'm here|im here|here i am|hey everyone|hello everyone|hi everyone|hey guys|hello guys|hi guys)\b/i;

function clipFact(value: string): string {
  return value
    .replace(/\r\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, "")
    .trim();
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(
      (token) =>
        token.length >= 3 &&
        !PROFILE_STOP_WORDS.has(token),
    );
}

function splitProfileFacts(about: string | undefined): string[] {
  const compact = about?.trim();
  if (!compact) {
    return [];
  }

  return compact
    .split(PROFILE_FACT_SPLIT_PATTERN)
    .map((value) => clipFact(value))
    .filter(Boolean);
}

function lexicalOverlapScore(fact: string, latestUserMessage: string): number {
  const factTokens = new Set(tokenize(fact));
  const latestTokens = tokenize(latestUserMessage);
  return latestTokens.reduce(
    (score, token) => score + (factTokens.has(token) ? 2 : 0),
    0,
  );
}

function categoryScore(fact: string, latestUserMessage: string): number {
  let score = 0;

  if (DRIVING_PATTERN.test(latestUserMessage) && DRIVING_PATTERN.test(fact)) {
    score += 6;
  }
  if (WEARING_PATTERN.test(latestUserMessage) && WEARING_PATTERN.test(fact)) {
    score += 6;
  }
  if (HELD_OR_CARRIED_PATTERN.test(latestUserMessage) && HELD_OR_CARRIED_PATTERN.test(fact)) {
    score += 6;
  }
  if (ABOUT_ME_PROMPT_PATTERN.test(latestUserMessage)) {
    score += 4;
  }

  return score;
}

function isSelfReferentialPrompt(latestUserMessage: string): boolean {
  return (
    ABOUT_ME_PROMPT_PATTERN.test(latestUserMessage) ||
    /\b(what do you think of my|what do you think about my)\b/i.test(latestUserMessage) ||
    /\bhow do i look\b/i.test(latestUserMessage) ||
    /\b(look|see|guess|notice)\b.*\b(i am|i'm|my|me)\b/i.test(latestUserMessage) ||
    /\bwhat am i\b/i.test(latestUserMessage)
  );
}

function isVisibleAppearanceFact(fact: string): boolean {
  return APPEARANCE_OR_CONDITION_PATTERN.test(fact);
}

export function extractRelevantProfileFacts(input: {
  about?: string;
  latestUserMessage?: string;
}): string[] {
  const latestUserMessage = input.latestUserMessage?.trim();
  if (!latestUserMessage) {
    return [];
  }

  const facts = splitProfileFacts(input.about);
  if (facts.length === 0) {
    return [];
  }

  const scoredFacts = facts
    .map((fact) => ({
      fact,
      score: lexicalOverlapScore(fact, latestUserMessage) + categoryScore(fact, latestUserMessage),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scoredFacts.length > 0) {
    return [...new Set(scoredFacts.slice(0, 2).map((entry) => entry.fact))];
  }

  if (isSelfReferentialPrompt(latestUserMessage)) {
    return facts.slice(0, 2);
  }

  return [];
}

export function extractVisibleAppearanceFacts(input: {
  about?: string;
  latestUserMessage?: string;
  currentScene?: string;
}): string[] {
  const facts = splitProfileFacts(input.about).filter(isVisibleAppearanceFact);
  if (facts.length === 0) {
    return [];
  }

  const latestUserMessage = input.latestUserMessage?.trim() ?? "";
  const currentScene = input.currentScene?.trim() ?? "";
  const shouldPromote =
    ENTRANCE_OR_GREETING_PATTERN.test(latestUserMessage) ||
    LOOKING_OR_NOTICE_PATTERN.test(latestUserMessage) ||
    /\b(how do i look|what happened to me|what happened)\b/i.test(latestUserMessage) ||
    Boolean(currentScene);

  if (!shouldPromote) {
    return [];
  }

  return facts.slice(0, 3);
}
