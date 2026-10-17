import type { Character, ChatMessage } from "../../../types";
import type { PromptDialogueExample } from "./types";

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

function collapseWhitespace(value: string | undefined): string {
  return normalizeText(value).replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasInlineTranscriptLabel(
  text: string,
  characterName?: string,
  userName?: string,
): boolean {
  const labels = [
    characterName,
    userName,
    "user",
    "assistant",
    "human",
    "you",
    "me",
  ]
    .map((entry) => (entry ?? "").trim())
    .filter(Boolean)
    .map(escapeRegExp);
  if (labels.length === 0) {
    return false;
  }
  return new RegExp(`(?:^|\\n)\\s*(?:${labels.join("|")})\\s*:`, "i").test(text);
}

function paragraphCount(text: string): number {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean).length;
}

function lineCount(text: string): number {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function tokenizeText(value: string | undefined): string[] {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[*_"'`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function longestCommonTokenRun(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  let longest = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > longest) {
          longest = current[j];
        }
      }
    }
    previous = current;
  }
  return longest;
}

function narrativeSignalCount(text: string, characterName?: string): number {
  const compact = normalizeText(text);
  if (!compact) {
    return 0;
  }

  const safeName = (characterName ?? "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const thirdPersonOrName = safeName
    ? `(?:he|she|they|${safeName})`
    : "(?:he|she|they)";
  const narrativeRegex = new RegExp(
    `\\b${thirdPersonOrName}\\b\\s+(?:is|was|looks|looked|glances|glanced|turns|turned|moves|moved|steps|stepped|raises|raised|holds|held|smiles|smiled|laughs|laughed|asks|asked|says|said|stares|stared|walks|walked|approaches|approached|backs|backed|feels|felt|seems|seemed)\\b`,
    "gi",
  );

  let signals = 0;
  if (paragraphCount(compact) > 1 || lineCount(compact) > 4) {
    signals += 1;
  }
  if (compact.length > 420) {
    signals += 1;
  }
  if ((compact.match(narrativeRegex) ?? []).length >= 2) {
    signals += 1;
  }
  if (
    /\b[A-Z][a-z]+'s\b/.test(compact) ||
    /\b(?:his|her|their)\b\s+(?:voice|eyes|expression|arm|arms|hair|hand|hands|breath|heart|perfume|stance)\b/i.test(
      compact,
    )
  ) {
    signals += 1;
  }
  if ((compact.match(/"[^"\n]{18,}"/g) ?? []).length >= 2 && compact.length > 320) {
    signals += 1;
  }

  return signals;
}

export function isNarrativeHeavyRuntimeText(
  text: string | undefined,
  characterName?: string,
): boolean {
  const compact = normalizeText(text);
  if (!compact) {
    return false;
  }
  return narrativeSignalCount(compact, characterName) >= 2;
}

export function echoesStaticCharacterLore(
  text: string | undefined,
  speaker?: Pick<
    Character,
    "description" | "greeting" | "scenario" | "personality" | "backstory"
  >,
  history: ChatMessage[] = [],
): boolean {
  const hasAssistantHistory = history.some((message) => message.role === "assistant");
  if (hasAssistantHistory) {
    return false;
  }

  const normalizedReply = collapseWhitespace(text);
  if (normalizedReply.length < 220) {
    return false;
  }

  const replyTokens = tokenizeText(normalizedReply);
  if (replyTokens.length < 36) {
    return false;
  }

  const loreSources = [
    speaker?.description,
    speaker?.greeting,
    speaker?.scenario,
    speaker?.personality,
    speaker?.backstory,
  ];

  const combinedLore = collapseWhitespace(loreSources.filter(Boolean).join(" "));
  const combinedLoreTokens = tokenizeText(combinedLore);
  if (
    combinedLore.length >= 260 &&
    (combinedLore.includes(normalizedReply) ||
      (combinedLoreTokens.length >= 40 &&
        longestCommonTokenRun(replyTokens, combinedLoreTokens) >= 18))
  ) {
    return true;
  }

  return loreSources.some((source) => {
    const normalizedLore = collapseWhitespace(source);
    if (normalizedLore.length < 260) {
      return false;
    }
    if (normalizedLore.includes(normalizedReply)) {
      return true;
    }
    const loreTokens = tokenizeText(normalizedLore);
    if (loreTokens.length < 40) {
      return false;
    }
    return longestCommonTokenRun(replyTokens, loreTokens) >= 18;
  });
}

export function shouldInjectGreetingAsFirstMessage(
  greeting: string | undefined,
  _characterName?: string,
): boolean {
  return !!normalizeText(greeting);
}

export function shouldReuseGreetingAsVoiceReference(
  greeting: string | undefined,
  characterName?: string,
): boolean {
  const compact = normalizeText(greeting);
  if (!compact) {
    return false;
  }
  if (compact.length > 280 || paragraphCount(compact) > 1 || lineCount(compact) > 3) {
    return false;
  }
  return !isNarrativeHeavyRuntimeText(compact, characterName);
}

function isRuntimeSafeExampleTurn(
  example: PromptDialogueExample,
  characterName?: string,
  userName?: string,
): boolean {
  const compact = normalizeText(example.content);
  if (!compact) {
    return false;
  }
  if (paragraphCount(compact) > 1 || lineCount(compact) > 4) {
    return false;
  }
  if (hasInlineTranscriptLabel(compact, characterName, userName)) {
    return false;
  }
  const maxLength = example.role === "assistant" ? 360 : 300;
  if (compact.length > maxLength) {
    return false;
  }
  if (example.role === "assistant") {
    if (narrativeSignalCount(compact, characterName) >= 1) {
      return false;
    }
    if (isNarrativeHeavyRuntimeText(compact, characterName)) {
      return false;
    }
  }
  return true;
}

export function gateRuntimeExampleDialogue(
  examples: PromptDialogueExample[],
  characterName?: string,
  userName?: string,
): PromptDialogueExample[] {
  if (examples.length < 2) {
    return [];
  }

  const hasUser = examples.some((example) => example.role === "user");
  const hasAssistant = examples.some((example) => example.role === "assistant");
  if (!hasUser || !hasAssistant) {
    return [];
  }

  let previousRole: PromptDialogueExample["role"] | null = null;
  for (const example of examples) {
    if (!isRuntimeSafeExampleTurn(example, characterName, userName)) {
      return [];
    }
    if (previousRole === example.role) {
      return [];
    }
    previousRole = example.role;
  }

  return examples.slice(0, 8);
}
