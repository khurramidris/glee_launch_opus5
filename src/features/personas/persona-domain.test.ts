import { describe, expect, it } from "vitest";
import type { Persona, UserProfile } from "../../types";
import { applyPersona, findPersona } from "./persona-domain";

const profile: UserProfile = {
  name: "Riley",
  about: "Likes maps.",
  gender: "woman",
  avatar: "me.png",
  traits: ["curious"],
  preferences: "Short replies.",
  boundaries: "No spiders.",
  createdAt: "2000-01-01T00:00:00.000Z",
  updatedAt: "2000-01-01T00:00:00.000Z",
};

const persona: Persona = {
  id: "p1",
  name: "Captain Vale",
  about: "A retired starship captain.",
  preferences: "Speak formally.",
  createdAt: "2000-01-01T00:00:00.000Z",
  updatedAt: "2000-01-01T00:00:00.000Z",
};

describe("applyPersona", () => {
  it("keeps the default profile when no persona is chosen", () => {
    expect(applyPersona(profile, undefined)).toBe(profile);
  });

  it("swaps the identity but keeps boundaries and portrait", () => {
    const effective = applyPersona(profile, persona);
    expect(effective).toMatchObject({
      name: "Captain Vale",
      about: "A retired starship captain.",
      preferences: "Speak formally.",
      gender: "",
      traits: [],
      boundaries: "No spiders.",
      avatar: "me.png",
    });
  });

  it("finds personas by id", () => {
    expect(findPersona([persona], "p1")).toBe(persona);
    expect(findPersona([persona], "missing")).toBeUndefined();
    expect(findPersona([persona], undefined)).toBeUndefined();
  });
});
