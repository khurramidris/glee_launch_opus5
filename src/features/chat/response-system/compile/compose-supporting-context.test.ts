import { describe, expect, it } from "vitest";
import {
  composeMemorySummary,
  composeSemanticMemories,
  composeWorldContext,
  hasMemoryItemSnippets,
  isMemoryItemSnippet,
  isSameMemoryText,
} from "./compose-supporting-context";

describe("composeSemanticMemories", () => {
  it("makes ownership of first-person user memory facts explicit", () => {
    const composed = composeMemorySummary(
      {
        chatId: "chat-1",
        summary: "Sam told Mira that jasmine is his favorite tea.",
        facts: ["My favorite tea is jasmine"],
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
      "Sam",
    );

    expect(composed).toContain("Facts about Sam");
    expect(composed).toContain("I/my means Sam");
    expect(composed).toContain("My favorite tea is jasmine");
    expect(composed).toContain("Earlier: Sam told Mira that jasmine is his favorite tea.");
  });

  it("keeps every fact whole and drops the summary when it only repeats a fact", () => {
    const composed = composeMemorySummary(
      {
        chatId: "chat-1",
        summary: "My favorite tea is jasmine.",
        facts: ["My favorite tea is jasmine", "I have a dog named Biscuit ".repeat(20).trim()],
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
      "Sam",
    );

    expect(composed).toContain("My favorite tea is jasmine");
    expect(composed).not.toContain("Earlier:");
    expect(composed?.split("\n")).toHaveLength(1);
    expect(composed).not.toMatch(/\.\.\.$/);
  });

  it("preserves known group-speaker provenance in recalled assistant turns", () => {
    const composed = composeSemanticMemories(
      [
        {
          chatId: "chat-1",
          messageId: "message-1",
          role: "assistant",
          content: "I already promised to bring the map.",
          speakerCharacterId: "char-lara",
          createdAt: "2000-01-01T00:00:00.000Z",
          score: 0.91,
        },
      ],
      { "char-lara": "Lara" },
    );

    expect(composed).toContain("[assistant: Lara]");
    expect(composed).toContain("I already promised to bring the map.");
  });

  it("keeps user and unknown-speaker labels truthful", () => {
    const composed = composeSemanticMemories([
      {
        chatId: "chat-1",
        role: "user",
        content: "My favorite tea is jasmine.",
        createdAt: "2000-01-01T00:00:00.000Z",
        score: 0.8,
      },
      {
        chatId: "chat-1",
        role: "assistant",
        content: "I will remember that.",
        speakerCharacterId: "missing-character",
        createdAt: "2000-01-01T00:00:01.000Z",
        score: 0.7,
      },
    ]);

    expect(composed).toContain("[user] My favorite tea is jasmine.");
    expect(composed).toContain("[assistant] I will remember that.");
  });

  it("names the user in recalled user snippets when available", () => {
    const composed = composeSemanticMemories(
      [
        {
          chatId: "chat-1",
          role: "user",
          content: "My favorite tea is jasmine.",
          createdAt: "2000-01-01T00:00:00.000Z",
          score: 0.8,
        },
      ],
      undefined,
      "Sam",
    );

    expect(composed).toContain("[user: Sam] My favorite tea is jasmine.");
  });
});

function itemSnippet(id: string, content: string) {
  return {
    chatId: "chat-1",
    messageId: `memory-item:${id}`,
    source: "memory-item" as const,
    role: "system" as const,
    content,
    createdAt: "2000-01-01T00:00:00.000Z",
    score: 90,
  };
}

describe("remembered memory items", () => {
  it("lists items plainly ahead of recalled chat messages", () => {
    const composed = composeSemanticMemories([
      {
        chatId: "chat-1",
        messageId: "message-1",
        role: "user",
        content: "My favorite tea is jasmine.",
        createdAt: "2000-01-01T00:00:00.000Z",
        score: 80,
      },
      itemSnippet("a", "Sam is allergic to peanuts"),
      itemSnippet("b", "Ada promised to teach Sam chess"),
    ]);

    expect(composed?.split("\n")).toEqual([
      "Remembered: Sam is allergic to peanuts",
      "Remembered: Ada promised to teach Sam chess",
      "Recalled: [user] My favorite tea is jasmine.",
    ]);
  });

  it("does not repeat an item as a recalled message or twice as an item", () => {
    const composed = composeSemanticMemories([
      itemSnippet("a", "Sam is allergic to peanuts"),
      itemSnippet("b", "sam is allergic to peanuts."),
      {
        chatId: "chat-1",
        messageId: "message-2",
        role: "assistant",
        content: "Sam is allergic to peanuts",
        createdAt: "2000-01-01T00:00:00.000Z",
        score: 70,
      },
    ]);

    expect(composed).toBe("Remembered: Sam is allergic to peanuts");
  });

  it("caps the number and total size of remembered items", () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      itemSnippet(`m${index}`, `Sam visited place number ${index} ${"x".repeat(150)}`),
    );
    const lines = (composeSemanticMemories(many) ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.join("").length).toBeLessThanOrEqual(600 + lines.length * "Remembered: ".length);
    expect(lines.every((line) => line.startsWith("Remembered: "))).toBe(true);
  });

  it("recognises items by source or id prefix", () => {
    expect(isMemoryItemSnippet(itemSnippet("a", "x"))).toBe(true);
    expect(isMemoryItemSnippet({ ...itemSnippet("a", "x"), source: undefined })).toBe(true);
    expect(isMemoryItemSnippet({ ...itemSnippet("a", "x"), messageId: "message-1", source: undefined })).toBe(false);
    expect(hasMemoryItemSnippets([itemSnippet("a", "x")])).toBe(true);
    expect(hasMemoryItemSnippets([itemSnippet("a", "  ")])).toBe(false);
    expect(hasMemoryItemSnippets(undefined)).toBe(false);
  });
});

describe("isSameMemoryText", () => {
  it("treats punctuation and case differences as the same memory", () => {
    expect(isSameMemoryText("My favorite tea is jasmine", "my favorite tea is jasmine.")).toBe(true);
    expect(isSameMemoryText("My favorite tea is jasmine", "I like coffee")).toBe(false);
    expect(isSameMemoryText("tea", "My favorite tea is jasmine")).toBe(false);
  });
});

describe("composeWorldContext", () => {
  it("lists enabled entries as short whole lines", () => {
    const composed = composeWorldContext([
      {
        id: "a",
        scope: "global",
        title: "Harbor",
        keywords: ["port"],
        content: "A foggy harbor town. ".repeat(30),
        enabled: true,
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
      {
        id: "b",
        scope: "global",
        title: "Hidden",
        keywords: [],
        content: "Disabled entry.",
        enabled: false,
        createdAt: "2000-01-01T00:00:00.000Z",
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
    ]);

    expect(composed).toContain("World: Harbor: A foggy harbor town.");
    expect(composed).not.toContain("Hidden");
    expect((composed ?? "").length).toBeLessThanOrEqual(160);
  });
});
