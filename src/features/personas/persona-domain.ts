import type { Persona, UserProfile } from "../../types";

/**
 * The profile characters see when the user plays `persona`: the persona's name
 * and details replace the default profile's, while the user's own boundaries
 * and portrait carry over. Without a persona the profile is returned as is.
 */
export function applyPersona(profile: UserProfile, persona: Persona | undefined): UserProfile {
  if (!persona) {
    return profile;
  }
  return {
    ...profile,
    name: persona.name,
    about: persona.about,
    gender: "",
    traits: [],
    preferences: persona.preferences,
  };
}

export function findPersona(
  personas: Persona[],
  personaId: string | undefined,
): Persona | undefined {
  return personaId ? personas.find((persona) => persona.id === personaId) : undefined;
}
