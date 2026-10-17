import { useCallback, useEffect, useMemo, useState } from "react";
import { memoryStore, useMemoryStore, type MemoryItemPatch } from "../../stores/memory-store";
import type {
  CreateMemoryItemPayload,
  DeleteMemoryItemsForPayload,
  ListMemoryItemsPayload,
  MemoryItem,
} from "../../types";

export interface UseMemoryItemsOptions {
  /** Show what this chat can recall (user, its characters', its own); omit for every memory. */
  chatId?: string | null;
  /** Also list items that were archived (for example by the background extractor). */
  includeArchived?: boolean;
  /** Hold off loading, for example while the panel is hidden. Defaults to true. */
  enabled?: boolean;
}

export interface UseMemoryItemsResult {
  items: MemoryItem[];
  loading: boolean;
  /** Load failure, or the failure of the last change. */
  error: string | null;
  reload: () => Promise<void>;
  clearError: () => void;
  createItem: (payload: CreateMemoryItemPayload) => Promise<MemoryItem | null>;
  updateItem: (id: string, patch: MemoryItemPatch) => Promise<MemoryItem | null>;
  deleteItem: (id: string) => Promise<boolean>;
  /** Forgets everything for one character, one chat, or the user scope; resolves to the count removed. */
  forget: (target: DeleteMemoryItemsForPayload) => Promise<number | null>;
}

const NO_ITEMS: MemoryItem[] = [];

export function memoryViewKey(options: Pick<UseMemoryItemsOptions, "chatId" | "includeArchived">): string {
  return `${options.chatId ? `chat:${options.chatId}` : "all"}${options.includeArchived ? ":archived" : ""}`;
}

function listPayload(options: UseMemoryItemsOptions): ListMemoryItemsPayload {
  return {
    ...(options.chatId ? { visibleInChat: options.chatId } : {}),
    includeArchived: options.includeArchived ?? false,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads memory items for a chat (or all of them) and exposes the actions the
 * memory manager needs. Changes show up at once and roll back if the save
 * fails; views reload when background extraction stores something.
 */
export function useMemoryItems(options: UseMemoryItemsOptions = {}): UseMemoryItemsResult {
  const { chatId, includeArchived, enabled = true } = options;
  const key = memoryViewKey({ chatId, includeArchived });
  const view = useMemoryStore((state) => state.views[key]);
  const revision = useMemoryStore((state) => state.revision);
  const [actionError, setActionError] = useState<string | null>(null);

  const payload = useMemo(
    () => listPayload({ chatId, includeArchived }),
    [chatId, includeArchived],
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void memoryStore.getState().loadView(key, payload);
    // `revision` is a refresh signal, not a value read here.
  }, [enabled, key, payload, revision]);

  const reload = useCallback(
    () => memoryStore.getState().loadView(key, payload),
    [key, payload],
  );

  const guarded = useCallback(async <T,>(run: () => Promise<T>, failure: T): Promise<T> => {
    setActionError(null);
    try {
      return await run();
    } catch (error) {
      setActionError(messageOf(error));
      return failure;
    }
  }, []);

  const createItem = useCallback(
    (item: CreateMemoryItemPayload) =>
      guarded(() => memoryStore.getState().createItem(item), null),
    [guarded],
  );
  const updateItem = useCallback(
    (id: string, patch: MemoryItemPatch) =>
      guarded(() => memoryStore.getState().updateItem(id, patch), null),
    [guarded],
  );
  const deleteItem = useCallback(
    (id: string) =>
      guarded(async () => {
        await memoryStore.getState().deleteItem(id);
        return true;
      }, false),
    [guarded],
  );
  const forget = useCallback(
    (target: DeleteMemoryItemsForPayload) =>
      guarded<number | null>(() => memoryStore.getState().forget(target), null),
    [guarded],
  );
  const clearError = useCallback(() => setActionError(null), []);

  return {
    items: view?.items ?? NO_ITEMS,
    loading: view ? view.loading : enabled,
    error: actionError ?? view?.error ?? null,
    reload,
    clearError,
    createItem,
    updateItem,
    deleteItem,
    forget,
  };
}
