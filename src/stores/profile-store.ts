import { create } from "zustand";
import type { ChatRelationshipState, UserProfile } from "../types";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

interface UserProfileDraft {
  name: string;
  about: string;
  gender: string;
  avatar: string;
  traits: string;
  preferences: string;
  boundaries: string;
}

interface RelationshipDraft {
  summary: string;
  currentScene: string;
  interactionTone: string;
  characterState: string;
  userState: string;
  userRoleName: string;
  userRoleDescription: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyUserProfile(): UserProfile {
  const timestamp = nowIso();
  return {
    name: "",
    about: "",
    gender: "",
    avatar: "",
    traits: [],
    preferences: "",
    boundaries: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createEmptyRelationshipState(chatId = ""): ChatRelationshipState {
  return {
    chatId,
    summary: "",
    currentScene: "",
    interactionTone: "",
    characterState: "",
    userState: "",
    userRoleName: "",
    userRoleDescription: "",
    updatedAt: nowIso(),
  };
}

function createEmptyUserProfileDraft(): UserProfileDraft {
  return {
    name: "",
    about: "",
    gender: "",
    avatar: "",
    traits: "",
    preferences: "",
    boundaries: "",
  };
}

function createEmptyRelationshipDraft(): RelationshipDraft {
  return {
    summary: "",
    currentScene: "",
    interactionTone: "",
    characterState: "",
    userState: "",
    userRoleName: "",
    userRoleDescription: "",
  };
}

function userProfileDraftFromRecord(profile: UserProfile): UserProfileDraft {
  return {
    name: profile.name,
    about: profile.about,
    gender: profile.gender,
    avatar: profile.avatar,
    traits: profile.traits.join(", "),
    preferences: profile.preferences,
    boundaries: profile.boundaries,
  };
}

function relationshipDraftFromRecord(
  state?: ChatRelationshipState,
): RelationshipDraft {
  if (!state) {
    return createEmptyRelationshipDraft();
  }
  return {
    summary: state.summary,
    currentScene: state.currentScene,
    interactionTone: state.interactionTone,
    characterState: state.characterState,
    userState: state.userState,
    userRoleName: state.userRoleName,
    userRoleDescription: state.userRoleDescription,
  };
}

function parseTraitCsv(value: string): string[] {
  return value
    .split(",")
    .map((trait) => trait.trim())
    .filter(Boolean);
}

interface ProfileState {
  userProfile: UserProfile;
  userProfileDraft: UserProfileDraft;
  relationshipStateByChat: Record<string, ChatRelationshipState>;
  relationshipByChat: Record<string, ChatRelationshipState>;
  activeRelationshipDraftChatId: string | null;
  relationshipDraftChatId: string | null;
  relationshipDraft: RelationshipDraft;
  loadingUserProfile: boolean;
  loadingRelationship: boolean;
  savingUserProfile: boolean;
  savingRelationship: boolean;

  setUserProfile: (profile: StateUpdater<UserProfile>) => void;
  setUserProfileDraft: (draft: StateUpdater<UserProfileDraft>) => void;
  updateUserProfileDraft: (partial: Partial<UserProfileDraft>) => void;
  hydrateUserProfile: (profile: UserProfile) => void;
  setRelationshipStateByChat: (
    state: StateUpdater<Record<string, ChatRelationshipState>>,
  ) => void;
  setRelationshipByChat: (
    state: StateUpdater<Record<string, ChatRelationshipState>>,
  ) => void;
  setRelationshipDraft: (draft: StateUpdater<RelationshipDraft>) => void;
  updateRelationshipDraft: (partial: Partial<RelationshipDraft>) => void;
  hydrateRelationshipDraft: (chatId: string, state?: ChatRelationshipState) => void;
  hydrateRelationshipState: (state: ChatRelationshipState) => void;
  startRelationshipDraft: (chatId: string) => void;
  setLoadingUserProfile: (loading: boolean) => void;
  setLoadingRelationship: (loading: boolean) => void;
  setSavingUserProfile: (saving: boolean) => void;
  setSavingRelationship: (saving: boolean) => void;
}

export const profileStore = create<ProfileState>()((set, get) => ({
  userProfile: createEmptyUserProfile(),
  userProfileDraft: createEmptyUserProfileDraft(),
  relationshipStateByChat: {},
  relationshipByChat: {},
  activeRelationshipDraftChatId: null,
  relationshipDraftChatId: null,
  relationshipDraft: createEmptyRelationshipDraft(),
  loadingUserProfile: false,
  loadingRelationship: false,
  savingUserProfile: false,
  savingRelationship: false,

  setUserProfile: (profile) =>
    set((state) => ({ userProfile: resolveStateUpdate(state.userProfile, profile) })),
  setUserProfileDraft: (draft) =>
    set((state) => ({
      userProfileDraft: resolveStateUpdate(state.userProfileDraft, draft),
    })),
  updateUserProfileDraft: (partial) =>
    set((state) => ({
      userProfileDraft: { ...state.userProfileDraft, ...partial },
    })),
  hydrateUserProfile: (profile) =>
    set({
      userProfile: profile,
      userProfileDraft: userProfileDraftFromRecord(profile),
    }),
  setRelationshipStateByChat: (relationshipStateByChat) =>
    set((state) => {
      const next = resolveStateUpdate(state.relationshipStateByChat, relationshipStateByChat);
      return {
        relationshipStateByChat: next,
        relationshipByChat: next,
      };
    }),
  setRelationshipByChat: (relationshipByChat) =>
    set((state) => {
      const next = resolveStateUpdate(state.relationshipByChat, relationshipByChat);
      return {
        relationshipByChat: next,
        relationshipStateByChat: next,
      };
    }),
  setRelationshipDraft: (draft) =>
    set((state) => ({
      relationshipDraft: resolveStateUpdate(state.relationshipDraft, draft),
    })),
  updateRelationshipDraft: (partial) =>
    set((state) => ({
      relationshipDraft: { ...state.relationshipDraft, ...partial },
    })),
  hydrateRelationshipDraft: (chatId, state) =>
    set({
      activeRelationshipDraftChatId: chatId,
      relationshipDraftChatId: chatId,
      relationshipDraft: relationshipDraftFromRecord(state),
    }),
  hydrateRelationshipState: (state) =>
    set((current) => {
      const next = {
        ...current.relationshipStateByChat,
        [state.chatId]: state,
      };
      return {
        relationshipStateByChat: next,
        relationshipByChat: next,
        relationshipDraft:
          current.relationshipDraftChatId === state.chatId ||
          current.activeRelationshipDraftChatId === state.chatId
            ? relationshipDraftFromRecord(state)
            : current.relationshipDraft,
      };
    }),
  startRelationshipDraft: (chatId) => {
    const state = get().relationshipStateByChat[chatId] ?? createEmptyRelationshipState(chatId);
    set({
      activeRelationshipDraftChatId: chatId,
      relationshipDraftChatId: chatId,
      relationshipDraft: relationshipDraftFromRecord(state),
    });
  },
  setLoadingUserProfile: (loadingUserProfile) => set({ loadingUserProfile }),
  setLoadingRelationship: (loadingRelationship) => set({ loadingRelationship }),
  setSavingUserProfile: (savingUserProfile) => set({ savingUserProfile }),
  setSavingRelationship: (savingRelationship) => set({ savingRelationship }),
}));

export const useProfileStore = profileStore;

export {
  createEmptyRelationshipDraft,
  createEmptyRelationshipState,
  createEmptyUserProfile,
  createEmptyUserProfileDraft,
  parseTraitCsv,
  relationshipDraftFromRecord,
  userProfileDraftFromRecord,
};

export type { RelationshipDraft, UserProfileDraft };
