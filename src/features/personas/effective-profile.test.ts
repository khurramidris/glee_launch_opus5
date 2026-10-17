import { beforeEach, describe, expect, it } from "vitest";
import type { Persona, UserProfile } from "../../types";
import { personaStore } from "../../stores/persona-store";
import { presetStore } from "../../stores/preset-store";
import { profileStore } from "../../stores/profile-store";
import { effectiveUserProfile } from "./effective-profile";

const profile: UserProfile = {
  name: "Riley",
  about: "",
  gender: "",
  avatar: "",
  traits: [],
  preferences: "",
  boundaries: "No spiders.",
  createdAt: "2000-01-01T00:00:00.000Z",
  updatedAt: "2000-01-01T00:00:00.000Z",
};

const persona: Persona = {
  id: "p1",
  name: "Captain Vale",
  about: "A retired captain.",
  preferences: "",
  createdAt: "2000-01-01T00:00:00.000Z",
  updatedAt: "2000-01-01T00:00:00.000Z",
};

describe("effectiveUserProfile", () => {
  beforeEach(() => {
    profileStore.setState({ userProfile: profile });
    personaStore.setState({ personas: [persona] });
    presetStore.setState({
      presetProfileByChat: {
        withPersona: { chatId: "withPersona", personaPresetId: "p1", updatedAt: "" },
        withoutPersona: { chatId: "withoutPersona", updatedAt: "" },
      },
    });
  });

  it("uses the persona chosen for the chat", () => {
    expect(effectiveUserProfile("withPersona")?.name).toBe("Captain Vale");
  });

  it("falls back to the default profile", () => {
    expect(effectiveUserProfile("withoutPersona")).toBe(profile);
    expect(effectiveUserProfile("unknown-chat")).toBe(profile);
    expect(effectiveUserProfile(null)).toBe(profile);
  });
});
