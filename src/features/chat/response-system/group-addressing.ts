function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
      const startAddress = new RegExp(
        `^\\s*(?:["“])?${escaped}\\b(?:[,:!?.\\s]|$)`,
        "i",
      );
      const punctuatedClauseAddress = new RegExp(
        `\\b${escaped}\\b(?:[,:!?]|\\s*$)`,
        "i",
      );
      const prepositionalAddress = new RegExp(`\\b(?:to|at)\\s+${escaped}\\b`, "i");
      const appositiveRoleAddress = new RegExp(`\\b${escaped}\\b\\s+(?:who|that)\\b`, "i");
      const trailingVocativeAddress = new RegExp(
        `\\byou\\b[^.!?\\n]{0,120}\\b${escaped}\\b(?:\\s+(?:darlin|darling|dear|love|hon|honey|sweetheart|sweetie|babe|buddy|man|girl|boy))?(?:[,:!?]|\\s*$)`,
        "i",
      );
      const directQuestionAddress =
        hasDirectQuestionOrRequestCue &&
        new RegExp(`\\byou\\b[^.!?\\n]{0,120}\\b${escaped}\\b`, "i").test(openingClause);

      return (
        startAddress.test(addressingMessage) ||
        punctuatedClauseAddress.test(openingClause) ||
        prepositionalAddress.test(openingClause) ||
        appositiveRoleAddress.test(openingClause) ||
        trailingVocativeAddress.test(openingClause) ||
        directQuestionAddress
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

export function selectGroupResponderIds(input: {
  responderIds: string[];
  participantDirectory: Record<string, string>;
  latestUserMessage?: string;
}): string[] {
  const addressedIds = addressedResponderIds(input);
  return addressedIds.length > 0 ? addressedIds : input.responderIds;
}
