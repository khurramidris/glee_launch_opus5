import type { ChatMemory, ContextEntry, MemorySnippet } from "../../../../types";
import { clipText } from "./prompt-budget";

const MAX_MEMORY_FACT_CHARS = 240;
const MAX_MEMORY_SUMMARY_CHARS = 200;
const MIN_CONTAINED_MATCH_CHARS = 12;
const MAX_SNIPPETS = 3;
const MAX_SNIPPET_CHARS = 120;
const MAX_WORLD_ENTRIES = 3;
const MAX_WORLD_ENTRY_CHARS = 160;
const MAX_REMEMBERED_ITEMS = 6;
const MAX_REMEMBERED_ITEM_CHARS = 200;
const MAX_REMEMBERED_TOTAL_CHARS = 600;
const MEMORY_ITEM_ID_PREFIX = "memory-item:";

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// True when two memory texts say the same thing, so it is only shown once.
export function isSameMemoryText(left: string, right: string): boolean {
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  if (!a || !b) {
    return false;
  }
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return a === b || (shorter.length >= MIN_CONTAINED_MATCH_CHARS && longer.includes(shorter));
}

// True for a long-term memory item (as opposed to a recalled chat message).
export function isMemoryItemSnippet(snippet: MemorySnippet): boolean {
  return snippet.source === "memory-item" || snippet.messageId?.startsWith(MEMORY_ITEM_ID_PREFIX) === true;
}

export function hasMemoryItemSnippets(snippets: MemorySnippet[] | undefined): boolean {
  return (snippets ?? []).some(
    (snippet) => isMemoryItemSnippet(snippet) && snippet.content.trim().length > 0,
  );
}

export function composeMemorySummary(
  memory?: ChatMemory,
  userName = "the user",
): string | null {
  if (!memory) {
    return null;
  }
  const summary = memory.summary.trim();
  const facts = memory.facts.map((fact) => fact.trim()).filter(Boolean);
  if (!summary && facts.length === 0) {
    return null;
  }

  const lines: string[] = [];
  const shownFacts: string[] = [];
  for (const fact of facts) {
    const next = [...shownFacts, fact].join(" | ");
    if (shownFacts.length > 0 && next.length > MAX_MEMORY_FACT_CHARS) {
      break;
    }
    shownFacts.push(fact);
  }
  if (shownFacts.length > 0) {
    lines.push(
      `Facts about ${userName} (I/my means ${userName}, not you): ${clipText(
        shownFacts.join(" | "),
        MAX_MEMORY_FACT_CHARS,
      )}`,
    );
  }
  if (summary && !shownFacts.some((fact) => isSameMemoryText(summary, fact))) {
    lines.push(`Earlier: ${clipText(summary, MAX_MEMORY_SUMMARY_CHARS)}`);
  }
  return lines.join("\n");
}

export function composeWorldContext(entries: ContextEntry[]): string | null {
  const enabled = entries.filter((entry) => entry.enabled);
  if (enabled.length === 0) {
    return null;
  }

  return enabled
    .slice(0, MAX_WORLD_ENTRIES)
    .map((entry) =>
      clipText(`World: ${entry.title}: ${entry.content}`, MAX_WORLD_ENTRY_CHARS),
    )
    .join("\n");
}

// Remembered items are statements about the people involved, so they are listed
// plainly and ahead of the recalled chat messages they might also appear in.
function composeRememberedItems(items: MemorySnippet[]): string[] {
  const lines: string[] = [];
  const shown: string[] = [];
  let usedChars = 0;
  for (const item of items) {
    const content = clipText(item.content, MAX_REMEMBERED_ITEM_CHARS);
    if (!content || shown.some((text) => isSameMemoryText(text, content))) {
      continue;
    }
    if (lines.length >= MAX_REMEMBERED_ITEMS) {
      break;
    }
    if (lines.length > 0 && usedChars + content.length > MAX_REMEMBERED_TOTAL_CHARS) {
      continue;
    }
    usedChars += content.length;
    shown.push(content);
    lines.push(`Remembered: ${content}`);
  }
  return lines;
}

export function composeSemanticMemories(
  allSnippets: MemorySnippet[],
  participantDirectory?: Record<string, string>,
  userName?: string,
): string | null {
  const rememberedLines = composeRememberedItems(allSnippets.filter(isMemoryItemSnippet));
  const remembered = rememberedLines.map((line) => line.slice("Remembered: ".length));
  const snippets = allSnippets.filter(
    (snippet) =>
      !isMemoryItemSnippet(snippet) &&
      !remembered.some((text) => isSameMemoryText(snippet.content, text)),
  );
  const normalized = snippets
    .map((snippet) => ({
      role: snippet.role,
      speakerName: snippet.speakerCharacterId
        ? participantDirectory?.[snippet.speakerCharacterId]?.trim()
        : undefined,
      content: snippet.content.trim(),
    }))
    .filter((snippet) => Boolean(snippet.content));
  if (normalized.length === 0) {
    return rememberedLines.length > 0 ? rememberedLines.join("\n") : null;
  }

  const lines: string[] = [...rememberedLines];
  for (const snippet of normalized.slice(0, MAX_SNIPPETS)) {
    const roleLabel = (() => {
      if (snippet.role === "assistant" && snippet.speakerName) {
        return `assistant: ${snippet.speakerName}`;
      }
      if (snippet.role === "user" && userName?.trim()) {
        return `user: ${userName.trim()}`;
      }
      return snippet.role;
    })();
    lines.push(`Recalled: [${roleLabel}] ${clipText(snippet.content, MAX_SNIPPET_CHARS)}`);
  }
  return lines.join("\n");
}
