import { create } from "zustand";
import type { ContextEntry, MemorySnippet } from "../types";
import * as api from "../api/tauri";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

interface ContextDraft {
  scope: "global" | "character";
  title: string;
  keywords: string;
  content: string;
  enabled: boolean;
}

function createEmptyContextDraft(): ContextDraft {
  return {
    scope: "global",
    title: "",
    keywords: "",
    content: "",
    enabled: true,
  };
}

function parseKeywordCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

interface ContextState {
  contextEntries: ContextEntry[];
  activeContextHits: ContextEntry[];
  activeMemoryHits: MemorySnippet[];
  contextDraft: ContextDraft;
  savingContext: boolean;

  setContextEntries: (entries: StateUpdater<ContextEntry[]>) => void;
  setActiveContextHits: (hits: StateUpdater<ContextEntry[]>) => void;
  setActiveMemoryHits: (hits: StateUpdater<MemorySnippet[]>) => void;
  setContextDraft: (draft: StateUpdater<ContextDraft>) => void;
  updateContextDraft: (partial: Partial<ContextDraft>) => void;
  resetContextDraft: () => void;
  setSavingContext: (v: boolean) => void;

  loadContextEntries: (characterId?: string) => Promise<ContextEntry[]>;
  createEntry: (characterId?: string) => Promise<ContextEntry>;
  toggleEntry: (entry: ContextEntry) => Promise<ContextEntry>;
}

export const contextStore = create<ContextState>()((set, get) => ({
  contextEntries: [],
  activeContextHits: [],
  activeMemoryHits: [],
  contextDraft: createEmptyContextDraft(),
  savingContext: false,

  setContextEntries: (entries) =>
    set((state) => ({ contextEntries: resolveStateUpdate(state.contextEntries, entries) })),
  setActiveContextHits: (hits) =>
    set((state) => ({ activeContextHits: resolveStateUpdate(state.activeContextHits, hits) })),
  setActiveMemoryHits: (hits) =>
    set((state) => ({ activeMemoryHits: resolveStateUpdate(state.activeMemoryHits, hits) })),
  setContextDraft: (draft) =>
    set((state) => ({ contextDraft: resolveStateUpdate(state.contextDraft, draft) })),
  updateContextDraft: (partial) =>
    set((s) => ({ contextDraft: { ...s.contextDraft, ...partial } })),
  resetContextDraft: () => set({ contextDraft: createEmptyContextDraft() }),
  setSavingContext: (v) => set({ savingContext: v }),

  loadContextEntries: async (characterId) => {
    const entries = await api.listContextEntries(characterId);
    set({ contextEntries: entries });
    return entries;
  },

  createEntry: async (characterId) => {
    const { contextDraft } = get();
    set({ savingContext: true });
    try {
      const entry = await api.createContextEntry({
        scope: contextDraft.scope,
        characterId: contextDraft.scope === "character" ? characterId : undefined,
        title: contextDraft.title,
        keywords: parseKeywordCsv(contextDraft.keywords),
        content: contextDraft.content,
        enabled: contextDraft.enabled,
      });
      set((s) => ({
        contextEntries: [...s.contextEntries, entry],
        contextDraft: createEmptyContextDraft(),
      }));
      return entry;
    } finally {
      set({ savingContext: false });
    }
  },

  toggleEntry: async (entry) => {
    const updated = await api.updateContextEntry({
      id: entry.id,
      enabled: !entry.enabled,
    });
    set((s) => ({
      contextEntries: s.contextEntries.map((e) => (e.id === updated.id ? updated : e)),
    }));
    return updated;
  },
}));

export const useContextStore = contextStore;

export { createEmptyContextDraft, parseKeywordCsv };
export type { ContextDraft };
