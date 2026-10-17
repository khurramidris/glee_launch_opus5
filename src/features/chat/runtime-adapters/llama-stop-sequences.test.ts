import { describe, expect, it } from "vitest";

import type { CompiledCharacterPrompt } from "../response-system/types";
import { toLlamaChatRequest } from "./llama";

const compiledPrompt: CompiledCharacterPrompt = {
  systemSections: [{ key: "system_contract", priority: 0, content: "Stay in character." }],
  exampleMessages: [],
  historyMessages: [{ role: "user" as const, content: "Everyone, say hi." }],
};

const sampling = { temperature: 0.7, topP: 0.8, maxTokens: 300, repeatPenalty: 1 };

describe("llama request stop sequences", () => {
  it("stops on the other participants' names in group chats", () => {
    const request = toLlamaChatRequest({
      model: "m",
      compiledPrompt,
      sampling,
      stream: true,
      userName: "Riley",
      speakerName: "Lara",
      participantNames: ["Lara", "Yulian", "Zoë"],
    });

    expect(request.stop).toEqual([
      "\nUser:",
      "\nHuman:",
      "\nYou:",
      "\nMe:",
      "\nRiley:",
      "\nYulian:",
      "\nZoë:",
    ]);
  });

  it("keeps the single-chat stop strings unchanged", () => {
    const request = toLlamaChatRequest({
      model: "m",
      compiledPrompt,
      sampling,
      stream: true,
      userName: "Riley",
    });

    expect(request.stop).toEqual(["\nUser:", "\nHuman:", "\nYou:", "\nMe:", "\nRiley:"]);
  });
});
