import { describe, expect, it } from "vitest";

import {
  defaultUserProfile,
  evalCases,
  evalModel,
} from "../../../../tests/evals/eval-cases";
import {
  DEFAULT_MIN_PASS_RATE,
  replyHasTerm,
  resolveMinPassRate,
  scoreTerms,
  summarizeEval,
} from "../../../../tests/evals/eval-scoring";
import { estimateChatMessagesTokens } from "../runtime-adapters/token-budget";
import { prepareResponseRequest } from "./prepare";

// The live-model eval is skipped without a model, so these checks keep its
// prompts and scoring honest in the regular test run.
function prepareEvalCase(id: string) {
  const evalCase = evalCases.find((entry) => entry.id === id);
  if (!evalCase) {
    throw new Error(`Missing eval case ${id}`);
  }
  return prepareResponseRequest({
    speaker: evalCase.speaker,
    userProfile: evalCase.userProfile ?? defaultUserProfile,
    memory: evalCase.memory,
    semanticMemorySnippets: evalCase.semanticMemorySnippets,
    contextEntries: [],
    history: evalCase.history,
    sampling: { temperature: 0.2, topP: 0.9, maxTokens: 192, repeatPenalty: 1.1 },
    runtime: { model: evalModel, stream: false },
    mode: evalCase.mode,
    participantNames: evalCase.participantNames,
    participantDirectory: evalCase.participantDirectory,
  });
}

function lastMessage(id: string): string {
  const messages = prepareEvalCase(id).runtimeRequest.messages;
  return messages[messages.length - 1]?.content ?? "";
}

describe("live-model eval cases", () => {
  it("covers the planned scenarios with unique ids", () => {
    const ids = evalCases.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(16);
    expect(ids.length).toBeLessThanOrEqual(24);
    expect(ids).toEqual(
      expect.arrayContaining([
        "persona-directness",
        "memory-continuity",
        "memory-item-allergy",
        "memory-item-promise",
        "memory-item-pet",
        "group-speaker-provenance",
        "greeting-hi",
        "one-word-answer",
        "emotional-support",
        "card-question",
        "roleplay-actions",
        "explicit-choice",
        "long-history",
        "example-dialogue",
        "persona-user-name",
        "group-addresses-other-member",
        "group-asks-about-other-member",
        "group-open-question",
        "group-follows-earlier-replies",
      ]),
    );
    for (const evalCase of evalCases) {
      expect(evalCase.expectedTerms.length).toBeGreaterThan(0);
    }
    expect(evalCases.find((entry) => entry.id === "long-history")?.history.length).toBeGreaterThanOrEqual(12);
    expect(evalCases.filter((entry) => entry.mode === "group").length).toBeGreaterThanOrEqual(4);
    expect(
      evalCases.some((entry) => entry.mode === "group" && (entry.participantNames?.length ?? 0) >= 3),
    ).toBe(true);
  });

  it("keeps every prompt small and ending on a user turn", () => {
    for (const evalCase of evalCases) {
      const { runtimeRequest } = prepareEvalCase(evalCase.id);

      expect(runtimeRequest.messages[runtimeRequest.messages.length - 1]?.role).toBe("user");
      expect(estimateChatMessagesTokens(runtimeRequest.messages)).toBeLessThan(900);
    }
    expect(
      estimateChatMessagesTokens(prepareEvalCase("persona-directness").runtimeRequest.messages),
    ).toBeLessThanOrEqual(800);
  });

  it("sends the context each scenario depends on", () => {
    expect(lastMessage("memory-continuity")).toContain("My favorite tea is jasmine");
    expect(lastMessage("memory-item-allergy")).toContain("Remembered: Sam is allergic to peanuts");
    expect(lastMessage("memory-item-promise")).toContain(
      "Remembered: Mira promised to teach Sam chess on Sunday",
    );
    expect(lastMessage("memory-item-pet")).toContain("Remembered: Sam's dog is named Juniper");
    expect(lastMessage("explicit-choice")).toContain("Sam's choice: the red one.");
    expect(lastMessage("group-follows-earlier-replies")).toContain(
      "Kofi already said: Something funny.",
    );
    expect(lastMessage("greeting-hi")).toContain("Sam is greeting you");

    const provenance = prepareEvalCase("group-speaker-provenance").runtimeRequest.messages;
    expect(provenance).toContainEqual({
      role: "user",
      content: "[Group speaker: Lara]\nI will carry the map.",
    });

    const persona = prepareEvalCase("persona-user-name").runtimeRequest.messages;
    expect(persona[0]?.content).toContain("Name: Priya");
    expect(persona[0]?.content).toContain("marine biologist");
    expect(persona[0]?.content).toContain("chatting with Priya");

    const example = prepareEvalCase("example-dialogue").runtimeRequest.messages;
    expect(example.map((message) => message.content)).toContain(
      "Ahoy, matey! Ye look like ye've weathered a squall.",
    );

    const longHistory = prepareEvalCase("long-history").runtimeRequest.messages;
    expect(longHistory.filter((message) => message.role !== "system").length).toBeGreaterThanOrEqual(12);
    expect(longHistory.some((message) => message.content.includes("Tollbridge"))).toBe(true);
  });
});

describe("live-model eval scoring", () => {
  it("matches expected terms from a word start and forbidden terms as whole words", () => {
    expect(replyHasTerm("The door was locked.", "lock")).toBe(true);
    expect(replyHasTerm("This is fine.", "hi")).toBe(false);
    expect(replyHasTerm("Hi there!", "hi")).toBe(true);
    expect(replyHasTerm("A small miracle.", "Mira", "whole")).toBe(false);
    expect(replyHasTerm("Mira: hello", "Mira", "whole")).toBe(true);
    expect(replyHasTerm("Lena: here you go", "Lena:", "whole")).toBe(true);
  });

  it("separates expected, required, and forbidden term results", () => {
    expect(
      scoreTerms("Lara said she would carry the map.", {
        expectedTerms: ["map", "compass"],
        requiredTerms: ["lara", "volunteer"],
        forbiddenTerms: ["compass", "she"],
      }),
    ).toEqual({
      expectedTermHits: ["map"],
      requiredTermMisses: ["volunteer"],
      forbiddenTermHits: ["she"],
    });
  });

  it("summarizes accepted, repaired, rejected, latency, and input size", () => {
    const base = {
      accepted: true,
      repaired: false,
      mechanicalPass: true,
      latencyMs: 1000,
      estimatedInputTokens: 400,
    };
    const summary = summarizeEval(
      [
        { ...base, latencyMs: 1000, usage: { prompt_tokens: 300 } },
        { ...base, latencyMs: 2000, repaired: true },
        { ...base, latencyMs: 3000, accepted: false, mechanicalPass: false },
        { ...base, latencyMs: 10000, estimatedInputTokens: 600 },
      ],
      5,
      0.8,
    );

    expect(summary).toEqual({
      caseCount: 5,
      executedCount: 4,
      errorCount: 1,
      passedCount: 3,
      passRate: 0.6,
      minPassRate: 0.8,
      acceptedRate: 0.75,
      repairedRate: 0.25,
      rejectedCount: 1,
      medianLatencyMs: 2500,
      p90LatencyMs: 10000,
      avgEstimatedInputTokens: 450,
      avgPromptTokens: 300,
    });
  });

  it("reads the minimum pass rate from the environment with a safe default", () => {
    expect(resolveMinPassRate(undefined)).toBe(DEFAULT_MIN_PASS_RATE);
    expect(resolveMinPassRate("")).toBe(DEFAULT_MIN_PASS_RATE);
    expect(resolveMinPassRate("nonsense")).toBe(DEFAULT_MIN_PASS_RATE);
    expect(resolveMinPassRate("1.5")).toBe(DEFAULT_MIN_PASS_RATE);
    expect(resolveMinPassRate("0.5")).toBe(0.5);
    expect(resolveMinPassRate("1")).toBe(1);
  });
});
