import { create } from "zustand";
import type { ChatPresetProfile, GenerationPreset } from "../types";
import * as api from "../api/tauri";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

type PresetEditorMode = "create" | "edit";

const DEFAULT_TEMPERATURE = 0.78;
const DEFAULT_TOP_P = 0.94;
const DEFAULT_REPEAT_PENALTY = 1.1;

interface GenerationPresetDraft {
  name: string;
  description: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  repeatPenalty: string;
}

function createEmptyGenerationDraft(): GenerationPresetDraft {
  return {
    name: "",
    description: "",
    temperature: String(DEFAULT_TEMPERATURE),
    topP: String(DEFAULT_TOP_P),
    maxTokens: "",
    repeatPenalty: String(DEFAULT_REPEAT_PENALTY),
  };
}

function draftFromGeneration(preset: GenerationPreset): GenerationPresetDraft {
  return {
    name: preset.name,
    description: preset.description ?? "",
    temperature: String(preset.temperature),
    topP: String(preset.topP),
    maxTokens: preset.maxTokens ? String(preset.maxTokens) : "",
    repeatPenalty: String(preset.repeatPenalty),
  };
}

function resolveActiveId<T extends { id: string }>(
  presetId: string | undefined,
  presets: T[],
): string {
  const normalized = presetId?.trim() || undefined;
  if (normalized && presets.some((preset) => preset.id === normalized)) {
    return normalized;
  }
  return "";
}

interface PresetState {
  generationPresets: GenerationPreset[];
  presetProfileByChat: Record<string, ChatPresetProfile>;
  activeGenerationPresetId: string;
  generationEditorMode: PresetEditorMode;
  editingGenerationPresetId: string | null;
  generationPresetDraft: GenerationPresetDraft;
  savingGenerationPreset: boolean;
  deletingPresetKey: string | null;

  setGenerationPresets: (presets: StateUpdater<GenerationPreset[]>) => void;
  setPresetProfileByChat: (
    profiles: StateUpdater<Record<string, ChatPresetProfile>>,
  ) => void;
  setActiveGenerationPresetId: (id: StateUpdater<string>) => void;
  setGenerationPresetDraft: (draft: StateUpdater<GenerationPresetDraft>) => void;
  updateGenerationPresetDraft: (partial: Partial<GenerationPresetDraft>) => void;
  setSavingGenerationPreset: (value: boolean) => void;
  setDeletingPresetKey: (key: string | null) => void;

  startCreateGeneration: () => void;
  startEditGeneration: (preset: GenerationPreset) => void;
  resolveActiveGenerationId: (profilePresetId?: string) => string;
  saveGenerationPreset: () => Promise<GenerationPreset>;
  deleteGenerationPreset: (id: string) => Promise<void>;
  loadPresetProfile: (chatId: string) => Promise<ChatPresetProfile | null>;
}

export const presetStore = create<PresetState>()((set, get) => ({
  generationPresets: [],
  presetProfileByChat: {},
  activeGenerationPresetId: "",
  generationEditorMode: "create",
  editingGenerationPresetId: null,
  generationPresetDraft: createEmptyGenerationDraft(),
  savingGenerationPreset: false,
  deletingPresetKey: null,

  setGenerationPresets: (presets) =>
    set((state) => ({
      generationPresets: resolveStateUpdate(state.generationPresets, presets),
    })),
  setPresetProfileByChat: (profiles) =>
    set((state) => ({
      presetProfileByChat: resolveStateUpdate(state.presetProfileByChat, profiles),
    })),
  setActiveGenerationPresetId: (id) =>
    set((state) => ({
      activeGenerationPresetId: resolveStateUpdate(state.activeGenerationPresetId, id),
    })),
  setGenerationPresetDraft: (draft) =>
    set((state) => ({
      generationPresetDraft: resolveStateUpdate(state.generationPresetDraft, draft),
    })),
  updateGenerationPresetDraft: (partial) =>
    set((state) => ({
      generationPresetDraft: { ...state.generationPresetDraft, ...partial },
    })),
  setSavingGenerationPreset: (savingGenerationPreset) => set({ savingGenerationPreset }),
  setDeletingPresetKey: (deletingPresetKey) => set({ deletingPresetKey }),

  startCreateGeneration: () =>
    set({
      generationEditorMode: "create",
      editingGenerationPresetId: null,
      generationPresetDraft: createEmptyGenerationDraft(),
    }),
  startEditGeneration: (preset) =>
    set({
      generationEditorMode: "edit",
      editingGenerationPresetId: preset.id,
      generationPresetDraft: draftFromGeneration(preset),
    }),
  resolveActiveGenerationId: (profilePresetId) =>
    resolveActiveId(profilePresetId, get().generationPresets),

  saveGenerationPreset: async () => {
    const { generationEditorMode, editingGenerationPresetId, generationPresetDraft } = get();
    set({ savingGenerationPreset: true });
    try {
      const temperature = Number(generationPresetDraft.temperature) || DEFAULT_TEMPERATURE;
      const topP = Number(generationPresetDraft.topP) || DEFAULT_TOP_P;
      const maxTokens = generationPresetDraft.maxTokens
        ? Math.max(1, Math.round(Number(generationPresetDraft.maxTokens)))
        : undefined;
      const repeatPenalty =
        Number(generationPresetDraft.repeatPenalty) || DEFAULT_REPEAT_PENALTY;

      let preset: GenerationPreset;
      if (generationEditorMode === "edit" && editingGenerationPresetId) {
        preset = await api.updateGenerationPreset({
          id: editingGenerationPresetId,
          name: generationPresetDraft.name,
          description: generationPresetDraft.description || undefined,
          temperature,
          topP,
          maxTokens,
          repeatPenalty,
        });
        set((state) => ({
          generationPresets: state.generationPresets.map((item) =>
            item.id === preset.id ? preset : item,
          ),
          editingGenerationPresetId: null,
          generationPresetDraft: createEmptyGenerationDraft(),
        }));
      } else {
        preset = await api.createGenerationPreset({
          name: generationPresetDraft.name,
          description: generationPresetDraft.description || undefined,
          temperature,
          topP,
          maxTokens,
          repeatPenalty,
        });
        set((state) => ({
          generationPresets: [...state.generationPresets, preset],
          generationPresetDraft: createEmptyGenerationDraft(),
        }));
      }
      return preset;
    } finally {
      set({ savingGenerationPreset: false });
    }
  },

  deleteGenerationPreset: async (id) => {
    set({ deletingPresetKey: `generation-${id}` });
    try {
      await api.deleteGenerationPreset(id);
      set((state) => ({
        generationPresets: state.generationPresets.filter((preset) => preset.id !== id),
        activeGenerationPresetId:
          state.activeGenerationPresetId === id ? "" : state.activeGenerationPresetId,
      }));
    } finally {
      set({ deletingPresetKey: null });
    }
  },

  loadPresetProfile: async (chatId) => {
    const profile = await api.getChatPresetProfile(chatId);
    if (profile) {
      set((state) => ({
        presetProfileByChat: { ...state.presetProfileByChat, [chatId]: profile },
      }));
    }
    return profile;
  },
}));

export const usePresetStore = presetStore;

export {
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  DEFAULT_REPEAT_PENALTY,
  createEmptyGenerationDraft,
  draftFromGeneration,
};

export type { GenerationPresetDraft, PresetEditorMode };
