import { describe, expect, it } from "vitest";

import type { Character } from "../../types";
import { suggestUserRole } from "./suggest-user-role";

const baseCharacter: Character = {
  id: "char-1",
  name: "Yulian",
  description: "",
  personality: "",
  backstory: "",
  scenario: "",
  systemPrompt: "",
  postHistoryInstructions: "",
  speechStyle: "",
  greeting: "",
  alternateGreetings: [],
  avatar: "",
  tags: [],
  likes: [],
  dislikes: [],
  boundaries: "",
  creatorNotes: "",
  creator: "",
  characterVersion: "",
  cardExtensions: {},
  exampleDialogue: "",
  createdAt: "",
  updatedAt: "",
};

describe("suggestUserRole", () => {
  it("extracts an explicit user role from a relationship-style line", () => {
    const role = suggestUserRole({
      ...baseCharacter,
      description:
        "Relationships:\n- you (Knight): His secret lover, a knight of the imperial guard.",
    });

    expect(role).toEqual({
      name: "Knight",
      description: "His secret lover, a knight of the imperial guard.",
      sourceField: "description",
    });
  });

  it("returns null when the card does not define a strong explicit user role", () => {
    const role = suggestUserRole({
      ...baseCharacter,
      description: "A gentle prince trapped in imperial politics.",
      scenario: "A wedding scene with nobles and priests.",
    });

    expect(role).toBeNull();
  });
});
