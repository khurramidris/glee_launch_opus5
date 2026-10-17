import type { ChatMemory, ContextEntry, MemorySnippet } from "../../../../types";

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
  if (facts.length > 0) {
    lines.push(
      `User memory facts for ${userName} (I/my means ${userName}, not the replying character): ${facts.join(" | ")}`,
    );
  }
  if (summary) {
    lines.push(`Memory summary: ${summary}`);
  }
  lines.push(
    "Keep these facts consistent without revealing the memory source.",
    "If older memory conflicts with the current live scene or saved user profile, follow the current live context.",
  );
  return lines.join("\n");
}

export function composeWorldContext(entries: ContextEntry[]): string | null {
  const enabled = entries.filter((entry) => entry.enabled);
  if (enabled.length === 0) {
    return null;
  }

  const lines = ["Relevant world/context entries:"];
  for (const entry of enabled.slice(0, 6)) {
    const keywords = entry.keywords.length > 0 ? ` [${entry.keywords.join(", ")}]` : "";
    lines.push(`- ${entry.title}${keywords}: ${entry.content}`);
  }
  return lines.join("\n");
}

export function composeSemanticMemories(
  snippets: MemorySnippet[],
  participantDirectory?: Record<string, string>,
  userName?: string,
): string | null {
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
    return null;
  }

  const lines = ["Relevant recalled snippets:"];
  for (const snippet of normalized.slice(0, 6)) {
    const roleLabel = (() => {
      if (snippet.role === "assistant" && snippet.speakerName) {
        return `assistant: ${snippet.speakerName}`;
      }
      if (snippet.role === "user" && userName?.trim()) {
        return `user: ${userName.trim()}`;
      }
      return snippet.role;
    })();
    lines.push(`- [${roleLabel}] ${snippet.content}`);
  }
  lines.push(
    "Use these only when they strengthen continuity; current live context wins any conflict.",
  );
  return lines.join("\n");
}
