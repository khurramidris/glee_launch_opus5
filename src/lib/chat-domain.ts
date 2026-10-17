import type {
  Character,
  ChatMemory,
  ChatMessage,
  ChatSummary,
  ContextEntry,
  LlamaChatMessage,
  MemorySnippet,
} from "../types";

export function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => Boolean(id.trim())).map((id) => id.trim()))];
}

export function toLlamaMessages(
  history: ChatMessage[],
  activeCharacter?: Character,
): LlamaChatMessage[] {
  const payload: LlamaChatMessage[] = [];
  if (activeCharacter?.systemPrompt.trim()) {
    payload.push({ role: "system", content: activeCharacter.systemPrompt.trim() });
  }
  for (const message of history) {
    if (message.role === "user" || message.role === "assistant") {
      payload.push({ role: message.role, content: message.content });
    }
  }
  return payload;
}

export function composeMemorySystemMessage(memory?: ChatMemory): string | null {
  if (!memory) {
    return null;
  }
  const summary = memory.summary.trim();
  const facts = memory.facts.map((fact) => fact.trim()).filter((fact) => Boolean(fact));
  if (!summary && facts.length === 0) {
    return null;
  }
  const lines: string[] = [
    "Use this memory as soft context. Keep consistency, but do not reveal memory source.",
  ];
  if (summary) {
    lines.push(`Summary: ${summary}`);
  }
  if (facts.length > 0) {
    lines.push(`Facts: ${facts.join(" | ")}`);
  }
  return lines.join("\n");
}

export function composeContextSystemMessage(entries: ContextEntry[]): string | null {
  const enabled = entries.filter((entry) => entry.enabled);
  if (enabled.length === 0) {
    return null;
  }
  const lines = ["Relevant lore/context entries:"];
  for (const entry of enabled.slice(0, 6)) {
    const keywords = entry.keywords.length > 0 ? ` [${entry.keywords.join(", ")}]` : "";
    lines.push(`- ${entry.title}${keywords}: ${entry.content}`);
  }
  return lines.join("\n");
}

export function composeSemanticMemorySystemMessage(snippets: MemorySnippet[]): string | null {
  const normalized = snippets
    .map((snippet) => ({
      role: snippet.role,
      content: snippet.content.trim(),
    }))
    .filter((snippet) => Boolean(snippet.content));
  if (normalized.length === 0) {
    return null;
  }
  const lines = [
    "Use these semantic memory snippets for continuity when relevant. Integrate naturally and do not quote them mechanically.",
    "Semantic memory snippets:",
  ];
  for (const snippet of normalized.slice(0, 6)) {
    lines.push(`- [${snippet.role}] ${snippet.content}`);
  }
  return lines.join("\n");
}

export function toLlamaMessagesWithMemory(
  history: ChatMessage[],
  activeCharacter: Character | undefined,
  memory: ChatMemory | undefined,
): LlamaChatMessage[] {
  const payload = toLlamaMessages(history, activeCharacter);
  const memorySystem = composeMemorySystemMessage(memory);
  if (!memorySystem) {
    return payload;
  }
  const systemMessage: LlamaChatMessage = { role: "system", content: memorySystem };
  return [systemMessage, ...payload];
}

export function toLlamaMessagesWithMemoryAndContext(
  history: ChatMessage[],
  activeCharacter: Character | undefined,
  memory: ChatMemory | undefined,
  contextEntries: ContextEntry[],
  semanticMemorySnippets?: MemorySnippet[],
): LlamaChatMessage[] {
  const withMemory = toLlamaMessagesWithMemory(history, activeCharacter, memory);
  const contextSystem = composeContextSystemMessage(contextEntries);
  const withContext = (() => {
    if (!contextSystem) {
      return withMemory;
    }
    const systemMessage: LlamaChatMessage = { role: "system", content: contextSystem };
    return [systemMessage, ...withMemory];
  })();
  const semanticSystem = composeSemanticMemorySystemMessage(semanticMemorySnippets ?? []);
  if (!semanticSystem) {
    return withContext;
  }
  const semanticSystemMessage: LlamaChatMessage = { role: "system", content: semanticSystem };
  return [semanticSystemMessage, ...withContext];
}

export function extractMemoryFacts(messages: ChatMessage[]): string[] {
  const candidates = new Map<string, string>();
  const regexes = [
    /\bmy name is\s+[^.!?\n]+/i,
    /\bi(?:'m| am) from\s+[^.!?\n]+/i,
    /\bi live in\s+[^.!?\n]+/i,
    /\bi work as\s+[^.!?\n]+/i,
    /\bi (?:work|study) (?:at|in)\s+[^.!?\n]+/i,
    /\bmy favorite\s+[^.!?\n]+/i,
    /\bi (?:like|love|prefer)\s+[^.!?\n]+/i,
    /\bi (?:do not|don't) like\s+[^.!?\n]+/i,
    /\bi (?:dislike|hate)\s+[^.!?\n]+/i,
    /\bi have\s+[^.!?\n]+/i,
    /\bi need\s+[^.!?\n]+/i,
    /\b(?:please\s+)?remember(?:\s+that)?\s+[^.!?\n]+/i,
    /\bi am\s+[^.!?\n]+/i,
  ];
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const clauses = message.content.match(/[^.!?\n]+[.!?]?/g) ?? [];
    for (const clause of clauses) {
      for (const regex of regexes) {
        const match = clause.match(regex);
        if (!match?.[0]) {
          continue;
        }
        const normalized = match[0]
          .replace(/\s+/g, " ")
          .replace(/[\s,;:]+$/g, "")
          .trim()
          .slice(0, 180);
        if (!normalized) {
          continue;
        }
        const dedupeKey = normalized.toLocaleLowerCase();
        candidates.delete(dedupeKey);
        candidates.set(dedupeKey, normalized);
      }
    }
  }
  return [...candidates.values()].slice(-16);
}

const STORED_GENERATION_FAILURE_PREFIX = "[Glee reply failed]";
const ROLLING_SUMMARY_MAX_LENGTH = 900;
const ROLLING_SUMMARY_LINE_MAX_LENGTH = 220;

function clipMemoryText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function createRollingSummary(
  messages: ChatMessage[],
  participantDirectory: Record<string, string> = {},
): string {
  const recent = messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !(
          message.role === "assistant" &&
          message.content.trim().startsWith(STORED_GENERATION_FAILURE_PREFIX)
        ),
    )
    .slice(-14);
  if (recent.length === 0) {
    return "";
  }

  const lines = recent.flatMap((message) => {
    const content = clipMemoryText(message.content, ROLLING_SUMMARY_LINE_MAX_LENGTH);
    if (!content) {
      return [];
    }
    const speakerName = message.speakerCharacterId
      ? participantDirectory[message.speakerCharacterId]?.trim()
      : undefined;
    const who = message.role === "user" ? "User" : speakerName || "Assistant";
    return [`${who}: ${content}`];
  });

  const selectedNewestFirst: string[] = [];
  let usedLength = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const separatorLength = selectedNewestFirst.length > 0 ? 3 : 0;
    if (usedLength + separatorLength + line.length > ROLLING_SUMMARY_MAX_LENGTH) {
      continue;
    }
    selectedNewestFirst.push(line);
    usedLength += separatorLength + line.length;
  }

  return selectedNewestFirst.reverse().join(" | ");
}

export function chatParticipantIds(chat: ChatSummary | null, override?: string[]): string[] {
  if (!chat) {
    return [];
  }
  const ids = [...chat.participantIds];
  if (override && override.length > 0) {
    ids.push(...override);
  }
  if (chat.characterId) {
    ids.push(chat.characterId);
  }
  return dedupeIds(ids);
}

export function isGroupChatMode(chat: ChatSummary | null, participantIds: string[]): boolean {
  return chat?.chatMode === "group" || participantIds.length > 1;
}

export function parseBoundedNumber(
  value: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function parseOptionalPositiveInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.round(parsed);
}

export function sortByRecent<T extends { createdAt: string; updatedAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

export function buildExportSlug(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return cleaned || "chat";
}
