import { create } from "zustand";
import * as api from "../api/tauri";
import type {
  CreateMemoryItemPayload,
  DeleteMemoryItemsForPayload,
  ListMemoryItemsPayload,
  MemoryItem,
  UpdateMemoryItemPayload,
} from "../types";

/** Editable fields of an item; the optimistic copy applies them before the save returns. */
export type MemoryItemPatch = Partial<
  Pick<MemoryItem, "content" | "importance" | "pinned" | "archived" | "kind" | "scope">
>;

export interface MemoryView {
  items: MemoryItem[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY_VIEW: MemoryView = { items: [], loaded: false, loading: false, error: null };

interface MemoryState {
  /** Item lists by view key (`chat:<id>` or `all`), so several panels can show different slices. */
  views: Record<string, MemoryView>;
  /** Bumped when background extraction stored something, so mounted views reload. */
  revision: number;

  loadView: (key: string, payload: ListMemoryItemsPayload) => Promise<void>;
  createItem: (payload: CreateMemoryItemPayload) => Promise<MemoryItem>;
  updateItem: (id: string, patch: MemoryItemPatch, owner?: Pick<UpdateMemoryItemPayload, "characterId" | "chatId">) => Promise<MemoryItem>;
  deleteItem: (id: string) => Promise<void>;
  forget: (target: DeleteMemoryItemsForPayload) => Promise<number>;
  noteExtraction: () => void;
  reset: () => void;
}

function mapViews(
  views: Record<string, MemoryView>,
  transform: (items: MemoryItem[]) => MemoryItem[],
): Record<string, MemoryView> {
  return Object.fromEntries(
    Object.entries(views).map(([key, view]) => [key, { ...view, items: transform(view.items) }]),
  );
}

function matchesForget(item: MemoryItem, target: DeleteMemoryItemsForPayload): boolean {
  if (target.characterId) {
    return item.scope === "character" && item.characterId === target.characterId;
  }
  if (target.chatId) {
    return item.scope === "chat" && item.chatId === target.chatId;
  }
  return target.scope === "user" && item.scope === "user";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const memoryStore = create<MemoryState>()((set, get) => ({
  views: {},
  revision: 0,

  loadView: async (key, payload) => {
    set((state) => ({
      views: {
        ...state.views,
        [key]: { ...(state.views[key] ?? EMPTY_VIEW), loading: true, error: null },
      },
    }));
    try {
      const items = await api.listMemoryItems(payload);
      set((state) => ({
        views: { ...state.views, [key]: { items, loaded: true, loading: false, error: null } },
      }));
    } catch (error) {
      set((state) => ({
        views: {
          ...state.views,
          [key]: {
            ...(state.views[key] ?? EMPTY_VIEW),
            loading: false,
            error: errorMessage(error),
          },
        },
      }));
    }
  },

  createItem: async (payload) => {
    const item = await api.createMemoryItem(payload);
    // Which views the new item belongs to depends on chat membership, so mounted views reload.
    set((state) => ({ revision: state.revision + 1 }));
    return item;
  },

  updateItem: async (id, patch, owner = {}) => {
    const previous = get().views;
    set((state) => ({
      views: mapViews(state.views, (items) =>
        items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      ),
    }));
    try {
      const saved = await api.updateMemoryItem({ id, ...patch, ...owner });
      set((state) => ({
        views: mapViews(state.views, (items) =>
          items.map((item) => (item.id === saved.id ? saved : item)),
        ),
      }));
      // Moving an item to another scope changes which views list it.
      if (patch.scope || patch.archived !== undefined) {
        set((state) => ({ revision: state.revision + 1 }));
      }
      return saved;
    } catch (error) {
      set({ views: previous });
      throw error;
    }
  },

  deleteItem: async (id) => {
    const previous = get().views;
    set((state) => ({
      views: mapViews(state.views, (items) => items.filter((item) => item.id !== id)),
    }));
    try {
      await api.deleteMemoryItem(id);
    } catch (error) {
      set({ views: previous });
      throw error;
    }
  },

  forget: async (target) => {
    const previous = get().views;
    set((state) => ({
      views: mapViews(state.views, (items) => items.filter((item) => !matchesForget(item, target))),
    }));
    try {
      return await api.deleteMemoryItemsFor(target);
    } catch (error) {
      set({ views: previous });
      throw error;
    }
  },

  noteExtraction: () => set((state) => ({ revision: state.revision + 1 })),

  reset: () => set({ views: {}, revision: 0 }),
}));

export const useMemoryStore = memoryStore;
