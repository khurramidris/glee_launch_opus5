import { describe, expect, it } from "vitest";
import {
  composeMemorySummary,
  composeSemanticMemories,
} from "./compose-supporting-context";

describe("composeSemanticMemories", () => {
  it("makes ownership of first-person user memory facts explicit", () => {
    const composed = composeMemorySummary(
      {
        chatId: "chat-1",
        summary: "Sam told Mira that jasmine is his favorite tea.",
        facts: ["My favorite tea is jasmine"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      "Sam",
    );

    expect(composed).toContain("User memory facts for Sam");
    expect(composed).toContain("I/my means Sam");
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
          createdAt: "2026-01-01T00:00:00.000Z",
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
        createdAt: "2026-01-01T00:00:00.000Z",
        score: 0.8,
      },
      {
        chatId: "chat-1",
        role: "assistant",
        content: "I will remember that.",
        speakerCharacterId: "missing-character",
        createdAt: "2026-01-01T00:00:01.000Z",
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
          createdAt: "2026-01-01T00:00:00.000Z",
          score: 0.8,
        },
      ],
      undefined,
      "Sam",
    );

    expect(composed).toContain("[user: Sam] My favorite tea is jasmine.");
  });
});
