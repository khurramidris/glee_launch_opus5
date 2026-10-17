import { describe, expect, it } from "vitest";
import type {
  Character,
  ChatMemory,
  ChatMessage,
  ChatSummary,
  ContextEntry,
  MemorySnippet,
} from "../types";
import {
  buildExportSlug,
  chatParticipantIds,
  composeMemorySystemMessage,
  composeSemanticMemorySystemMessage,
  createRollingSummary,
  dedupeIds,
  extractMemoryFacts,
  isGroupChatMode,
  parseBoundedNumber,
  parseOptionalPositiveInt,
  toLlamaMessages,
  toLlamaMessagesWithMemoryAndContext,
} from "./chat-domain";

function mockCharacter(): Character {
  return {
    id: "char-1",
    name: "Aria",
    description: "desc",
    systemPrompt: "Stay in character",
    alternateGreetings: [],
    tags: [],
    likes: [],
    dislikes: [],
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
  };
}

function mockMessages(): ChatMessage[] {
  return [
    {
      id: "m1",
      chatId: "c1",
      role: "user",
      content: "I like chess.",
      createdAt: "2000-01-01T00:00:00.000Z",
    },
    {
      id: "m2",
      chatId: "c1",
      role: "assistant",
      content: "Great hobby.",
      createdAt: "2000-01-01T00:01:00.000Z",
    },
  ];
}

describe("chat-domain", () => {
  it("dedupeIds trims and removes duplicates", () => {
    expect(dedupeIds([" a ", "a", "", "b"])).toEqual(["a", "b"]);
  });

  it("toLlamaMessages prepends character system prompts only", () => {
    const payload = toLlamaMessages(mockMessages(), mockCharacter());
    expect(payload[0]).toEqual({ role: "system", content: "Stay in character" });
    expect(payload[1]).toEqual({ role: "user", content: "I like chess." });
  });

  it("composeMemorySystemMessage formats summary and facts", () => {
    const memory: ChatMemory = {
      chatId: "c1",
      summary: "User likes games",
      facts: ["I like chess", "I live in SF"],
      updatedAt: "2000-01-01T00:02:00.000Z",
    };
    const text = composeMemorySystemMessage(memory) ?? "";
    expect(text).toContain("Summary: User likes games");
    expect(text).toContain("Facts: I like chess | I live in SF");
  });

  it("toLlamaMessagesWithMemoryAndContext adds context and memory layers", () => {
    const context: ContextEntry[] = [
      {
        id: "ctx1",
        scope: "global",
        title: "World",
        keywords: ["city"],
        content: "City is rainy",
        enabled: true,
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
    ];
    const memory: ChatMemory = {
      chatId: "c1",
      summary: "summary",
      facts: [],
      updatedAt: "2000-01-01T00:02:00.000Z",
    };
    const payload = toLlamaMessagesWithMemoryAndContext(
      mockMessages(),
      mockCharacter(),
      memory,
      context,
    );
    expect(payload[0].role).toBe("system");
    expect(payload[0].content).toContain("Relevant lore/context entries");
    expect(payload[1].content).toContain("Use this memory as soft context");
  });

  it("composeSemanticMemorySystemMessage includes role labels and caps snippets", () => {
    const snippets: MemorySnippet[] = Array.from({ length: 7 }).map((_, index) => ({
      chatId: "c1",
      role: index % 2 === 0 ? "user" : "assistant",
      content: `snippet-${index + 1}`,
      createdAt: "2000-01-01T00:00:00.000Z",
      score: 0.8,
    }));
    const text = composeSemanticMemorySystemMessage(snippets) ?? "";
    expect(text).toContain("continuity");
    expect(text).toContain("- [user] snippet-1");
    expect(text).toContain("- [assistant] snippet-2");
    expect(text).not.toContain("snippet-7");
  });

  it("toLlamaMessagesWithMemoryAndContext prepends semantic memory when snippets exist", () => {
    const snippets: MemorySnippet[] = [
      {
        chatId: "c1",
        role: "user",
        content: "User said they prefer direct answers.",
        createdAt: "2000-01-01T00:00:00.000Z",
        score: 0.92,
      },
    ];
    const payload = toLlamaMessagesWithMemoryAndContext(
      mockMessages(),
      mockCharacter(),
      undefined,
      [],
      snippets,
    );
    expect(payload[0].role).toBe("system");
    expect(payload[0].content).toContain("Semantic memory snippets");
    expect(payload[0].content).toContain("[user] User said they prefer direct answers.");
    expect(payload[1].content).toContain("Stay in character");
  });

  it("extractMemoryFacts picks user self-facts", () => {
    const facts = extractMemoryFacts([
      ...mockMessages(),
      {
        id: "m3",
        chatId: "c1",
        role: "user",
        content: "I work as an engineer.",
        createdAt: "2000-01-01T00:03:00.000Z",
      },
    ]);
    expect(facts.some((fact) => fact.toLowerCase().includes("i work as"))).toBe(true);
    expect(facts.some((fact) => fact.toLowerCase().includes("i like chess"))).toBe(true);
  });

  it("extractMemoryFacts normalizes, deduplicates, and keeps explicit continuity facts", () => {
    const facts = extractMemoryFacts([
      {
        id: "m1",
        chatId: "c1",
        role: "user",
        content: "My name is Sam. I'm from Denver. I dislike loud clubs.",
        createdAt: "2000-01-01T00:00:00.000Z",
      },
      {
        id: "m2",
        chatId: "c1",
        role: "user",
        content: "Please remember that I need direct answers. My name is Sam.",
        createdAt: "2000-01-01T00:01:00.000Z",
      },
    ]);

    expect(facts).toContain("My name is Sam");
    expect(facts).toContain("I'm from Denver");
    expect(facts).toContain("I dislike loud clubs");
    expect(facts).toContain("Please remember that I need direct answers");
    expect(facts.filter((fact) => fact.toLowerCase() === "my name is sam")).toHaveLength(1);
  });

  it("createRollingSummary returns bounded summary", () => {
    const summary = createRollingSummary(mockMessages());
    expect(summary).toContain("User:");
    expect(summary).toContain("Assistant:");
    expect(summary.length).toBeLessThanOrEqual(900);
  });

  it("createRollingSummary preserves group speaker names and omits failed replies", () => {
    const summary = createRollingSummary(
      [
        {
          id: "m1",
          chatId: "c1",
          role: "user",
          content: "Who has the map?",
          createdAt: "2000-01-01T00:00:00.000Z",
        },
        {
          id: "m2",
          chatId: "c1",
          role: "assistant",
          content: "I packed it this morning.",
          speakerCharacterId: "lara",
          createdAt: "2000-01-01T00:01:00.000Z",
        },
        {
          id: "m3",
          chatId: "c1",
          role: "assistant",
          content: "[Glee reply failed] Pooja could not complete this reply.",
          speakerCharacterId: "pooja",
          createdAt: "2000-01-01T00:02:00.000Z",
        },
      ],
      { lara: "Lara", pooja: "Pooja" },
    );

    expect(summary).toContain("Lara: I packed it this morning.");
    expect(summary).not.toContain("reply failed");
    expect(summary).not.toContain("Pooja:");
  });

  it("chatParticipantIds and group mode resolve correctly", () => {
    const chat: ChatSummary = {
      id: "c1",
      title: "chat",
      chatMode: "single",
      participantIds: ["char-1"],
      historyEpoch: 0,
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
    };
    const ids = chatParticipantIds(chat);
    expect(ids).toEqual(["char-1"]);
    expect(isGroupChatMode(chat, ids)).toBe(false);
    expect(isGroupChatMode({ ...chat, chatMode: "group" }, ids)).toBe(true);
  });

  it("numeric parsers clamp and sanitize values", () => {
    expect(parseBoundedNumber("9", 0.5, 0, 2)).toBe(2);
    expect(parseBoundedNumber("x", 0.5, 0, 2)).toBe(0.5);
    expect(parseOptionalPositiveInt("42")).toBe(42);
    expect(parseOptionalPositiveInt("0")).toBeUndefined();
    expect(parseOptionalPositiveInt("abc")).toBeUndefined();
  });

  it("buildExportSlug normalizes labels", () => {
    expect(buildExportSlug("My Chat / 42")).toBe("my-chat-42");
    expect(buildExportSlug("$$$")).toBe("chat");
  });
});
