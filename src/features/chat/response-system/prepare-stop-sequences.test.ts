import { describe, expect, it } from "vitest";

import type { Character, ChatMessage } from "../../../types";
import { prepareResponseRequest } from "./prepare";

const speaker = {
  id: "char-1",
  name: "Julian",
  description: "A guarded courtier.",
  backstory: "",
  scenario: "",
  systemPrompt: "",
  speechStyle: "",
  greeting: "",
  alternateGreetings: [],
  avatar: "",
  tags: [],
  likes: [],
  dislikes: [],
  boundaries: "",
  creatorNotes: "",
  exampleDialogue: "",
  createdAt: "",
  updatedAt: "",
} as Character;

const history: ChatMessage[] = [
  { id: "m1", chatId: "chat-1", role: "user", content: "Hello everyone.", createdAt: "" },
];

function prepare(mode: "single" | "group") {
  return prepareResponseRequest({
    speaker,
    contextEntries: [],
    history,
    sampling: {},
    runtime: { model: "test-model", stream: true },
    mode,
    participantNames: ["Julian", "Mira Voss"],
    participantDirectory: { "char-1": "Julian", "char-2": "Mira Voss" },
  });
}

describe("prepareResponseRequest stop sequences", () => {
  it("stops a group reply on the other participants' name labels", () => {
    const stop = prepare("group").runtimeRequest.stop;

    expect(stop).toContain("\nMira Voss:");
    expect(stop).toContain("\nMira:");
    expect(stop).not.toContain("\nJulian:");
  });

  it("adds no participant stop sequences to a single chat", () => {
    const stop = prepare("single").runtimeRequest.stop ?? [];

    expect(stop.some((entry) => entry.includes("Mira"))).toBe(false);
  });
});
