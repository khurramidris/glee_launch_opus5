import { describe, expect, it } from "vitest";
import type { PromptSection } from "../types";
import { mergePromptSections } from "./prompt-budget";

describe("prompt budget", () => {
  it("reserves space for identity, voice, and group state after an oversized contract", () => {
    const sections: PromptSection[] = [
      {
        key: "system_contract",
        priority: 0,
        content: "contract ".repeat(900),
      },
      { key: "latest_user_move", priority: 2, content: "Pooja, answer me directly." },
      { key: "turn_frame", priority: 3, content: "Direct question to Pooja." },
      { key: "response_contract", priority: 4, content: "Answer the direct request." },
      { key: "group_round_state", priority: 5, content: "Pooja is directly addressed." },
      { key: "dynamic_scene_state", priority: 6, content: "Everyone is in the same room." },
      { key: "character_identity", priority: 18, content: "You are Pooja, warm and incisive." },
      { key: "identity_guardrails", priority: 19, content: "Never flatten into generic assistant prose." },
      { key: "response_style", priority: 20, content: "Brief, playful, and socially alert." },
    ];

    const merged = mergePromptSections(sections, 3000);

    expect(merged.length).toBeLessThanOrEqual(3000);
    expect(merged).toContain("Character identity:\nYou are Pooja");
    expect(merged).toContain("Identity guardrails:");
    expect(merged).toContain("Response style:");
    expect(merged).toContain("Group round state:");
    expect(merged).toContain("Latest user move:");
  });

  it("keeps small prompts intact", () => {
    const merged = mergePromptSections([
      { key: "system_contract", priority: 0, content: "Stay in character." },
      { key: "character_identity", priority: 10, content: "Character name: Aria" },
    ]);

    expect(merged).toBe(
      "Core contract:\nStay in character.\n\nCharacter identity:\nCharacter name: Aria",
    );
  });
});
