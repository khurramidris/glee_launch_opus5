function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Names are matched with unicode-aware boundaries: `\b` only knows ASCII word
// characters, so names that start or end with an accented letter never match.
const NAME_BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}_])";
const NAME_BOUNDARY_AFTER = "(?![\\p{L}\\p{N}_])";
// Scripts written without spaces between words, where a name is routinely
// followed or preceded directly by other letters.
const UNSPACED_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

// Names that are also everyday words ("Will you pass the salt?"). Without a
// capital letter in the middle of a sentence or a vocative, they are words.
const COMMON_WORD_NAMES = new Set([
  "will",
  "may",
  "hope",
  "grace",
  "joy",
  "faith",
  "mark",
  "bill",
  "rose",
  "frank",
  "pat",
  "rich",
  "art",
  "dawn",
  "eve",
  "hunter",
  "summer",
  "august",
  "april",
  "june",
  "page",
  "chase",
]);

function nameBoundaries(candidate: string): { before: string; after: string } {
  if (UNSPACED_SCRIPT_PATTERN.test(candidate)) {
    return { before: "", after: "" };
  }
  return { before: NAME_BOUNDARY_BEFORE, after: NAME_BOUNDARY_AFTER };
}

function isCommonWordName(candidate: string): boolean {
  return COMMON_WORD_NAMES.has(candidate.trim().toLowerCase());
}

// A common-word name counts as addressed only when it is written capitalised
// somewhere other than the start of a sentence, or at the start of one with a
// vocative mark ("Will, come here").
function hasDeliberateCommonWordAddress(message: string, candidate: string): boolean {
  const { before, after } = nameBoundaries(candidate);
  const pattern = new RegExp(`${before}${escapeRegExp(candidate)}${after}`, "giu");
  for (const match of message.matchAll(pattern)) {
    const written = match[0];
    const first = written.charAt(0);
    if (first === first.toLowerCase()) {
      continue;
    }
    const preceding = message.slice(0, match.index);
    const atSentenceStart = /(?:^|[.!?\n]\s*|["“]\s*)$/.test(preceding);
    if (!atSentenceStart) {
      return true;
    }
    if (/^\s*[,:!?]/.test(message.slice(match.index + written.length))) {
      return true;
    }
  }
  return false;
}

function uniqueFirstTokenCandidates(participantNames: string[]): Map<string, string[]> {
  const firstTokenMap = new Map<string, string[]>();
  for (const name of participantNames) {
    const firstToken = name.trim().split(/\s+/)[0]?.toLowerCase();
    if (!firstToken || firstToken.length < 3) {
      continue;
    }
    const existing = firstTokenMap.get(firstToken) ?? [];
    existing.push(name);
    firstTokenMap.set(firstToken, existing);
  }
  return firstTokenMap;
}

function stripTrailingRoleplayAside(value: string): string {
  return value
    .replace(/\s*\*[^*]{0,240}\*\s*$/g, "")
    .replace(
      /\s+\b(?:i|we)\s+(?:say|said|ask|asked|whisper|whispered|murmur|murmured|tell|told|add|added|reply|replied|exclaim|exclaimed)\b[\s\S]*$/i,
      "",
    )
    .trim();
}

export function detectAddressedParticipants(
  latestUserMessage: string | undefined,
  participantNames: string[],
): string[] {
  const normalizedMessage = latestUserMessage?.trim();
  if (!normalizedMessage) {
    return [];
  }

  const firstTokenMap = uniqueFirstTokenCandidates(participantNames);
  const addressingMessage = stripTrailingRoleplayAside(normalizedMessage) || normalizedMessage;
  const openingClause = addressingMessage.split(/[.!?]/, 1)[0] ?? addressingMessage;
  const hasDirectQuestionOrRequestCue =
    /\b(what|why|how|do|did|can|could|would|will|are|is|please|tell|show|change|give|bring|take|look|let|want|wanna)\b/i.test(
      openingClause,
    ) && /\byou\b/i.test(openingClause);

  const addressed = participantNames.filter((name) => {
    const trimmed = name.trim();
    const candidates = [trimmed];
    const firstToken = trimmed.split(/\s+/)[0] ?? "";
    const firstTokenMatches = firstTokenMap.get(firstToken.toLowerCase()) ?? [];
    if (firstToken && firstTokenMatches.length === 1) {
      candidates.push(firstToken);
    }

    return candidates.some((candidate) => {
      const escaped = escapeRegExp(candidate);
      const { before, after } = nameBoundaries(candidate);
      const startAddress = new RegExp(
        `^\\s*(?:["“])?${escaped}${after}(?:[,:!?.，：！？。、\\s]|$)`,
        "iu",
      );
      const punctuatedClauseAddress = new RegExp(
        `${before}${escaped}${after}(?:[,:!?，：！？、]|\\s*$)`,
        "iu",
      );
      const prepositionalAddress = new RegExp(
        `\\b(?:to|at)\\s+${escaped}${after}`,
        "iu",
      );
      const appositiveRoleAddress = new RegExp(
        `${before}${escaped}${after}\\s+(?:who|that)\\b`,
        "iu",
      );
      const trailingVocativeAddress = new RegExp(
        `\\byou\\b[^.!?\\n]{0,120}${before}${escaped}${after}(?:\\s+(?:darlin|darling|dear|love|hon|honey|sweetheart|sweetie|babe|buddy|man|girl|boy))?(?:[,:!?]|\\s*$)`,
        "iu",
      );
      const directQuestionAddress =
        hasDirectQuestionOrRequestCue &&
        new RegExp(
          `\\byou\\b[^.!?\\n]{0,120}${before}${escaped}${after}`,
          "iu",
        ).test(openingClause);

      const mentioned =
        startAddress.test(addressingMessage) ||
        punctuatedClauseAddress.test(openingClause) ||
        prepositionalAddress.test(openingClause) ||
        appositiveRoleAddress.test(openingClause) ||
        trailingVocativeAddress.test(openingClause) ||
        directQuestionAddress;
      if (!mentioned) {
        return false;
      }
      return (
        !isCommonWordName(candidate) ||
        hasDeliberateCommonWordAddress(addressingMessage, candidate)
      );
    });
  });

  return [...new Set(addressed)];
}

export function prioritizeTurnOrderByAddress(input: {
  responderIds: string[];
  participantDirectory: Record<string, string>;
  latestUserMessage?: string;
}): string[] {
  const addressedIds = addressedResponderIds(input);
  if (addressedIds.length === 0) {
    return input.responderIds;
  }

  const observerIds = input.responderIds.filter((id) => !addressedIds.includes(id));
  return [...addressedIds, ...observerIds];
}

function addressedResponderIds(input: {
  responderIds: string[];
  participantDirectory: Record<string, string>;
  latestUserMessage?: string;
}): string[] {
  const participantNames = input.responderIds
    .map((id) => input.participantDirectory[id]?.trim())
    .filter((name): name is string => Boolean(name));
  const addressedParticipants = detectAddressedParticipants(
    input.latestUserMessage,
    participantNames,
  );
  if (addressedParticipants.length === 0) {
    return [];
  }

  const addressedSet = new Set(addressedParticipants.map((name) => name.toLowerCase()));
  const addressedIds = input.responderIds.filter((id) =>
    addressedSet.has((input.participantDirectory[id] ?? "").trim().toLowerCase()),
  );
  if (addressedIds.length === 0) {
    return [];
  }
  return addressedIds;
}

// With nobody addressed, the whole roster answering every turn is slow and
// repetitive, so only the next couple of members in rotation reply.
export const MAX_UNADDRESSED_RESPONDERS = 2;

function rotateAfter(ids: string[], afterId?: string): string[] {
  const index = afterId ? ids.indexOf(afterId) : -1;
  if (index < 0) {
    return ids;
  }
  return [...ids.slice(index + 1), ...ids.slice(0, index + 1)];
}

export function selectGroupResponderIds(input: {
  responderIds: string[];
  participantDirectory: Record<string, string>;
  latestUserMessage?: string;
  // The character who spoke last, so unaddressed turns can rotate onward.
  lastSpeakerId?: string;
}): string[] {
  const addressedIds = addressedResponderIds(input);
  if (addressedIds.length > 0) {
    return addressedIds;
  }
  return rotateAfter(input.responderIds, input.lastSpeakerId).slice(
    0,
    MAX_UNADDRESSED_RESPONDERS,
  );
}
