import type { UserProfile } from "../../types";
import { personaStore } from "../../stores/persona-store";
import { presetStore } from "../../stores/preset-store";
import { profileStore } from "../../stores/profile-store";
import { applyPersona, findPersona } from "./persona-domain";

/**
 * The profile characters see in `chatId`: the persona chosen for that chat if
 * there is one, otherwise the user's default profile.
 */
export function effectiveUserProfile(chatId: string | null | undefined): UserProfile | undefined {
  const profile = profileStore.getState().userProfile;
  if (!profile || !chatId) {
    return profile ?? undefined;
  }
  const personaId = presetStore.getState().presetProfileByChat[chatId]?.personaPresetId;
  const persona = findPersona(personaStore.getState().personas, personaId);
  return applyPersona(profile, persona);
}
