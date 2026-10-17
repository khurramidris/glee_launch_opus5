import { describe, expect, it } from "vitest";
import type { PromptSection } from "../types";
import { clipText, mergePromptSections, mergeTurnNotes } from "./prompt-budget";

describe("prompt budget", () => {
  it("reserves space for identity and profile after an oversized contract", () => {
    const sections: PromptSection[] = [
      {
        key: "system_contract",
        priority: 0,
        content: "contract ".repeat(900),
      },
      { key: "character_identity", priority: 18, content: "Pooja is warm and incisive." },
      { key: "character_rules", priority: 19, content: "Never flatten into generic assistant prose." },
      { key: "user_profile", priority: 20, content: "Name: Sam" },
    ];

    const merged = mergePromptSections(sections, 3000);

    expect(merged.length).toBeLessThanOrEqual(3000);
    expect(merged).toContain("Character identity:\nPooja is warm");
    expect(merged).toContain("Character rules:");
    expect(merged).toContain("User profile:\nName: Sam");
  });

  it("keeps small prompts intact", () => {
    const merged = mergePromptSections([
      { key: "system_contract", priority: 0, content: "Stay in character." },
      { key: "character_identity", priority: 10, content: "Aria is a detective." },
    ]);

    expect(merged).toBe(
      "Core contract:\nStay in character.\n\nCharacter identity:\nAria is a detective.",
    );
  });
});

describe("clipText", () => {
  it("returns short text untouched", () => {
    expect(clipText("  Short line.  ", 40)).toBe("Short line.");
  });

  it("clips at the last whole sentence without an ellipsis", () => {
    const clipped = clipText(
      "The archive is quiet. Nothing moves in the stacks. A lamp flickers over the catalog desk.",
      60,
    );

    expect(clipped).toBe("The archive is quiet. Nothing moves in the stacks.");
  });

  it("never cuts a word in half", () => {
    const clipped = clipText("supercalifragilistic expialidocious wonderful marvelous", 40);

    expect(clipped.endsWith("...")).toBe(true);
    const words = clipped.slice(0, -3).split(" ");
    expect(["supercalifragilistic", "expialidocious", "wonderful", "marvelous"]).toEqual(
      expect.arrayContaining(words),
    );
    expect(clipped.length).toBeLessThanOrEqual(40);
  });
});

describe("mergeTurnNotes", () => {
  it("joins section lines by priority without labels", () => {
    const notes = mergeTurnNotes([
      { key: "memory_summary", priority: 13, content: "Facts about Sam: likes jasmine tea." },
      { key: "latest_user_move", priority: 10, content: "Sam is asking you a question.\nSam's choice: red." },
    ]);

    expect(notes).toBe(
      "Sam is asking you a question.\nSam's choice: red.\nFacts about Sam: likes jasmine tea.",
    );
  });

  it("drops lines that no longer fit instead of cutting them", () => {
    const notes = mergeTurnNotes(
      [
        { key: "latest_user_move", priority: 1, content: "Short line." },
        { key: "memory_summary", priority: 2, content: `${"A very long memory sentence. ".repeat(10)}` },
        { key: "relationship_state", priority: 3, content: "Tone: warm." },
      ],
      60,
    );

    expect(notes).toBe("Short line.\nTone: warm.");
  });
});
