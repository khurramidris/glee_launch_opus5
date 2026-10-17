import { useCallback, useEffect } from "react";
import {
  getChatRelationshipState,
  upsertChatRelationshipState,
  upsertUserProfile,
} from "../../api/tauri";
import { useAppStore, useChatStore, useProfileStore } from "../../stores";
import { parseTraitCsv } from "../../stores/profile-store";
import { normalizeError } from "../app/app-domain";

export function useProfileManagement() {
  const { setNotice } = useAppStore();
  const { activeChatId, chats } = useChatStore();
  const {
    userProfile,
    userProfileDraft,
    relationshipDraft,
    relationshipStateByChat,
    loadingRelationship,
    savingUserProfile,
    savingRelationship,
    setUserProfileDraft,
    setRelationshipDraft,
    setLoadingRelationship,
    setSavingRelationship,
    setSavingUserProfile,
    hydrateUserProfile,
    hydrateRelationshipState,
    startRelationshipDraft,
  } = useProfileStore();

  useEffect(() => {
    if (!activeChatId) {
      return;
    }
    startRelationshipDraft(activeChatId);
    let cancelled = false;

    async function loadRelationship(chatId: string): Promise<void> {
      try {
        setLoadingRelationship(true);
        const state = await getChatRelationshipState(chatId);
        if (!cancelled) {
          hydrateRelationshipState(state);
          startRelationshipDraft(chatId);
        }
      } catch (error) {
        if (!cancelled) {
          setNotice({ kind: "error", message: normalizeError(error) });
        }
      } finally {
        if (!cancelled) {
          setLoadingRelationship(false);
        }
      }
    }

    void loadRelationship(activeChatId);
    return () => {
      cancelled = true;
    };
  }, [
    activeChatId,
    hydrateRelationshipState,
    setLoadingRelationship,
    setNotice,
    startRelationshipDraft,
  ]);

  const saveUserProfile = useCallback(async () => {
    try {
      setSavingUserProfile(true);
      const saved = await upsertUserProfile({
        name: userProfileDraft.name.trim() || undefined,
        about: userProfileDraft.about.trim() || undefined,
        gender: userProfileDraft.gender.trim() || undefined,
        avatar: userProfileDraft.avatar.trim() || undefined,
        traits: parseTraitCsv(userProfileDraft.traits),
        preferences: userProfileDraft.preferences.trim() || undefined,
        boundaries: userProfileDraft.boundaries.trim() || undefined,
      });
      hydrateUserProfile(saved);
      setNotice({ kind: "info", message: "User profile saved." });
      return saved;
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
      throw error;
    } finally {
      setSavingUserProfile(false);
    }
  }, [
    hydrateUserProfile,
    setNotice,
    setSavingUserProfile,
    userProfileDraft.about,
    userProfileDraft.avatar,
    userProfileDraft.boundaries,
    userProfileDraft.gender,
    userProfileDraft.name,
    userProfileDraft.preferences,
    userProfileDraft.traits,
  ]);

  const saveActiveRelationshipState = useCallback(async () => {
    if (!activeChatId) {
      return null;
    }
    try {
      setSavingRelationship(true);
      const activeChat = chats.find((chat) => chat.id === activeChatId);
      const saved = await upsertChatRelationshipState({
        chatId: activeChatId,
        summary: relationshipDraft.summary.trim() || undefined,
        currentScene: relationshipDraft.currentScene.trim() || undefined,
        interactionTone: relationshipDraft.interactionTone.trim() || undefined,
        characterState: relationshipDraft.characterState.trim() || undefined,
        userState: relationshipDraft.userState.trim() || undefined,
        userRoleName: relationshipDraft.userRoleName.trim() || undefined,
        userRoleDescription: relationshipDraft.userRoleDescription.trim() || undefined,
        expectedHistoryEpoch: activeChat?.historyEpoch,
      });
      hydrateRelationshipState(saved);
      startRelationshipDraft(activeChatId);
      setNotice({ kind: "info", message: "Relationship state saved." });
      return saved;
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
      throw error;
    } finally {
      setSavingRelationship(false);
    }
  }, [
    activeChatId,
    chats,
    hydrateRelationshipState,
    relationshipDraft.characterState,
    relationshipDraft.currentScene,
    relationshipDraft.interactionTone,
    relationshipDraft.summary,
    relationshipDraft.userRoleDescription,
    relationshipDraft.userRoleName,
    relationshipDraft.userState,
    setNotice,
    setSavingRelationship,
    startRelationshipDraft,
  ]);

  return {
    userProfile,
    userProfileDraft,
    relationshipDraft,
    activeRelationshipState: activeChatId
      ? relationshipStateByChat[activeChatId]
      : undefined,
    loadingRelationship,
    savingUserProfile,
    savingRelationship,
    setUserProfileDraft,
    setRelationshipDraft,
    saveUserProfile,
    saveRelationshipState: saveActiveRelationshipState,
  };
}
