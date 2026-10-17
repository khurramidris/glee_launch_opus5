import { describe, expect, it } from "vitest";
import type { LlamaChatMessage } from "../../../types";
import {
  clampOutputTokens,
  estimateChatMessagesTokens,
  fitChatMessagesToContextWindow,
} from "./token-budget";

describe("runtime token budget", () => {
  it("drops oldest conversation turns while preserving system and latest user input", () => {
    const messages: LlamaChatMessage[] = [
      { role: "system", content: "identity and contract ".repeat(100) },
      ...Array.from({ length: 100 }).flatMap((_, index) => [
        { role: "user" as const, content: `old user turn ${index} ${"detail ".repeat(20)}` },
        { role: "assistant" as const, content: `old reply ${index} ${"reply ".repeat(20)}` },
      ]),
      { role: "user", content: "LATEST USER MOVE MUST SURVIVE" },
    ];

    const fitted = fitChatMessagesToContextWindow(messages, {
      contextWindowTokens: 4096,
      maxOutputTokens: 512,
    });

    expect(fitted.droppedMessages).toBeGreaterThan(0);
    expect(fitted.messages[0]?.role).toBe("system");
    expect(fitted.messages[fitted.messages.length - 1]?.content).toContain(
      "LATEST USER MOVE MUST SURVIVE",
    );
    expect(estimateChatMessagesTokens(fitted.messages)).toBeLessThanOrEqual(
      fitted.inputTokenBudget,
    );
  });

  it("bounds unsafe output requests so input context remains available", () => {
    expect(clampOutputTokens(50_000, 4096)).toBe(1024);
    expect(clampOutputTokens(undefined, 4096)).toBe(512);
  });

  it("clips a pathological latest user paste without discarding its ending", () => {
    const ending = "FINAL QUESTION: what should we do now?";
    const fitted = fitChatMessagesToContextWindow(
      [
        { role: "system", content: "Stay in character." },
        { role: "user", content: `${"large paste ".repeat(5000)}${ending}` },
      ],
      { contextWindowTokens: 1024, maxOutputTokens: 256 },
    );

    expect(fitted.latestUserMessageClipped).toBe(true);
    expect(fitted.messages[fitted.messages.length - 1]?.content).toContain(ending);
    expect(fitted.estimatedInputTokens).toBeLessThanOrEqual(fitted.inputTokenBudget);
  });
});
