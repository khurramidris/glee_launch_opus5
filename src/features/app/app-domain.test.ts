import { describe, expect, it } from "vitest";
import type { Character, ChatRelationshipState, UserProfile } from "../../types";
import {
  buildCharacterRetrievalHints,
  emptyMemory,
  normalizeError,
  normalizePresetId,
  parseBoundedNumber,
  parseOptionalPositiveInt,
  resolveActivePresetId,
  resolveChatCompletionsUrl,
  snippetPreview,
  textOr,
} from "./app-domain";

const character: Character = {
  id: "char-1",
  name: "Aria",
  description: "Helpful companion",
  backstory: "",
  scenario: "",
  systemPrompt: "Stay practical.",
  speechStyle: "",
  tags: ["supportive", "observant"],
  greeting: "Hi there.",
  alternateGreetings: [],
  likes: [],
  dislikes: [],
  boundaries: "",
  creatorNotes: "",
  exampleDialogue: "User: Hello\\nAria: Hi there.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

  const userProfile: UserProfile = {
    name: "Sam",
    about: "A thoughtful user who likes immersive roleplay.",
    gender: "",
    avatar: "",
    traits: ["curious", "direct"],
    preferences: "Prefers emotionally grounded responses.",
    boundaries: "Avoids condescension.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const relationshipState: ChatRelationshipState = {
  chatId: "chat-1",
  summary: "Aria trusts Sam and speaks openly with them.",
  currentScene: "Late-night conversation in a quiet apartment.",
  interactionTone: "Warm and candid.",
  characterState: "Protective but calm.",
  userState: "Reflective and a little tired.",
  userRoleName: "",
  userRoleDescription: "",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("app-domain", () => {
  it("normalizes runtime completion URLs", () => {
    expect(resolveChatCompletionsUrl("http://127.0.0.1:8080", "http://fallback"))
      .toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(resolveChatCompletionsUrl("http://127.0.0.1:8080/v1", "http://fallback"))
      .toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(
      resolveChatCompletionsUrl(
        "http://127.0.0.1:8080/v1/chat/completions",
        "http://fallback",
      ),
    ).toBe("http://127.0.0.1:8080/v1/chat/completions");
  });

  it("builds character retrieval hints from user, character, and relationship context", () => {
    const prompt = buildCharacterRetrievalHints(userProfile, character, relationshipState);
    expect(prompt).toContain("User profile");
    expect(prompt).toContain("curious");
    expect(prompt).toContain("Stay practical.");
    expect(prompt).toContain("Helpful companion");
    expect(prompt).toContain("Late-night conversation");
  });

  it("resolves active preset ids defensively", () => {
    expect(resolveActivePresetId(" preset-1 ", [{ id: "preset-1" }])).toBe("preset-1");
    expect(resolveActivePresetId("missing", [{ id: "preset-1" }])).toBe("");
    expect(resolveActivePresetId(undefined, [])).toBe("");
    expect(normalizePresetId("   ")).toBeUndefined();
  });

  it("handles bounded numeric parsing", () => {
    expect(parseBoundedNumber("3.5", 0.5, 0, 2)).toBe(2);
    expect(parseBoundedNumber("oops", 0.5, 0, 2)).toBe(0.5);
    expect(parseOptionalPositiveInt("32")).toBe(32);
    expect(parseOptionalPositiveInt("")).toBeUndefined();
    expect(parseOptionalPositiveInt("-4")).toBeUndefined();
  });

  it("provides utility fallbacks", () => {
    expect(textOr("  value  ", "fallback")).toBe("value");
    expect(textOr("  ", "fallback")).toBe("fallback");
    expect(snippetPreview("a ".repeat(200), 40)).toHaveLength(40);
    expect(emptyMemory("chat-1").chatId).toBe("chat-1");
  });

  it("normalizes unknown errors", () => {
    expect(normalizeError(new Error("boom"))).toBe("boom");
    expect(normalizeError("boom")).toBe("boom");
  });
});
