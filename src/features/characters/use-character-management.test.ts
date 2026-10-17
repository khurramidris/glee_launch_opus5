import { describe, expect, it } from "vitest";

import {
  canExportCharacterCardAsPng,
  CHARACTER_CARD_EXPORT_EXTENSIONS,
  CHARACTER_CARD_IMPORT_EXTENSIONS,
  CHARACTER_PORTRAIT_EXTENSIONS,
  isPngPath,
} from "./use-character-management";
import type { Character } from "../../types";

function fixtureCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: "char-1",
    name: "Nia",
    description: "Launch analyst",
    systemPrompt: "",
    alternateGreetings: [],
    tags: [],
    likes: [],
    dislikes: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("character card import formats", () => {
  it("only advertises formats the backend currently supports", () => {
    expect(CHARACTER_CARD_IMPORT_EXTENSIONS).toEqual(["png", "json"]);
  });

  it("advertises both json and png export formats", () => {
    expect(CHARACTER_CARD_EXPORT_EXTENSIONS).toEqual(["json", "png"]);
  });

  it("limits portrait picking to png for lossless card export compatibility", () => {
    expect(CHARACTER_PORTRAIT_EXTENSIONS).toEqual(["png"]);
  });

  it("detects png portrait paths case-insensitively", () => {
    expect(isPngPath("D:\\Cards\\nia.PNG")).toBe(true);
    expect(isPngPath("D:\\Cards\\nia.jpg")).toBe(false);
    expect(isPngPath(undefined)).toBe(false);
  });

  it("only allows png card export when a portrait png exists", () => {
    expect(canExportCharacterCardAsPng(fixtureCharacter({ avatar: "D:\\Cards\\nia.png" }))).toBe(
      true,
    );
    expect(canExportCharacterCardAsPng(fixtureCharacter({ avatar: "D:\\Cards\\nia.webp" }))).toBe(
      false,
    );
    expect(canExportCharacterCardAsPng(fixtureCharacter())).toBe(false);
  });
});
