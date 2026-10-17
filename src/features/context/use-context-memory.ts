import { useCallback, useEffect, useMemo } from "react";
import {
  createContextEntry,
  deleteContextEntry,
  getChatMemory,
  listContextEntries,
  updateContextEntry,
  upsertChatMemory,
} from "../../api/tauri";
import { extractMemoryFacts } from "../../lib/chat-domain";
import {
  useAppStore,
  useCharacterStore,
  useChatStore,
  useContextStore,
} from "../../stores";
import type { ChatMessage, ContextEntry } from "../../types";
import {
  createEmptyContextDraft,
  parseKeywordCsv,
} from "../../stores/context-store";
import { normalizeError } from "../app/app-domain";

export function useContextMemory() {
  const { setNotice } = useAppStore();
  const { characters, activeCharacterId } = useCharacterStore();
  const {
    activeChatId,
    messagesByChat,
    setMemoryByChat,
    setSavingMemory,
  } = useChatStore();
  const {
    contextDraft,
    setContextEntries,
    setContextDraft,
    setSavingContext,
  } = useContextStore();

  const activeCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId),
    [activeCharacterId, characters],
  );

  const loadContextEntries = useCallback(async () => {
    const entries = await listContextEntries(activeCharacter?.id);
    setContextEntries(entries);
  }, [activeCharacter?.id, setContextEntries]);

  const persistMemory = useCallback(
    async (
      chatId: string,
      history: ChatMessage[] = [],
      expectedHistoryEpoch?: number,
    ) => {
      // The summary is owned by the background summariser (or the user); this
      // refresh only maintains the extracted facts.
      const facts = extractMemoryFacts(history);
      try {
        setSavingMemory(true);
        const updated = await upsertChatMemory({
          chatId,
          facts,
          expectedHistoryEpoch,
        });
        setMemoryByChat((prev) => ({ ...prev, [chatId]: updated }));
      } finally {
        setSavingMemory(false);
      }
    },
    [setMemoryByChat, setSavingMemory],
  );

  const refreshMemory = useCallback(async () => {
    if (!activeChatId) {
      return;
    }
    const history = messagesByChat[activeChatId] ?? [];
    if (history.length === 0) {
      setNotice({ kind: "info", message: "No messages yet to build memory." });
      return;
    }
    try {
      await persistMemory(activeChatId, history);
      setNotice({ kind: "info", message: "Memory refreshed." });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }, [activeChatId, messagesByChat, persistMemory, setNotice]);

  const createEntry = useCallback(async () => {
    const title = contextDraft.title.trim();
    const content = contextDraft.content.trim();
    if (!title || !content) {
      setNotice({ kind: "error", message: "Context title and content are required." });
      return;
    }
    if (contextDraft.scope === "character" && !activeCharacter?.id) {
      setNotice({
        kind: "error",
        message: "Select a character for character-scoped context.",
      });
      return;
    }
    try {
      setSavingContext(true);
      const created = await createContextEntry({
        scope: contextDraft.scope,
        characterId:
          contextDraft.scope === "character" ? activeCharacter?.id : undefined,
        title,
        keywords: parseKeywordCsv(contextDraft.keywords),
        content,
        enabled: contextDraft.enabled,
      });
      setContextEntries((prev) => [
        created,
        ...prev.filter((entry) => entry.id !== created.id),
      ]);
      await loadContextEntries();
      setContextDraft(createEmptyContextDraft());
      setNotice({ kind: "info", message: "Context entry created." });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    } finally {
      setSavingContext(false);
    }
  }, [
    activeCharacter?.id,
    contextDraft,
    loadContextEntries,
    setContextDraft,
    setContextEntries,
    setNotice,
    setSavingContext,
  ]);

  const toggleEntry = useCallback(
    async (entry: ContextEntry) => {
      try {
        const updated = await updateContextEntry({
          id: entry.id,
          enabled: !entry.enabled,
        });
        setContextEntries((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        );
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [setContextEntries, setNotice],
  );

  const deleteEntry = useCallback(
    async (entry: ContextEntry) => {
      const confirmed = window.confirm(
        `Delete the context entry “${entry.title}”? This cannot be undone.`,
      );
      if (!confirmed) {
        return;
      }
      try {
        setSavingContext(true);
        await deleteContextEntry(entry.id);
        setContextEntries((prev) => prev.filter((item) => item.id !== entry.id));
        setNotice({ kind: "info", message: "Context entry deleted." });
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      } finally {
        setSavingContext(false);
      }
    },
    [setContextEntries, setNotice, setSavingContext],
  );

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const entries = await listContextEntries(activeCharacter?.id);
        if (!cancelled) {
          setContextEntries(entries);
        }
      } catch (error) {
        if (!cancelled) {
          setNotice({ kind: "error", message: normalizeError(error) });
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [activeCharacter?.id, setContextEntries, setNotice]);

  useEffect(() => {
    if (!activeChatId) {
      return;
    }
    let cancelled = false;

    async function load(chatId: string): Promise<void> {
      try {
        const memory = await getChatMemory(chatId);
        if (!cancelled) {
          setMemoryByChat((prev) => ({ ...prev, [chatId]: memory }));
        }
      } catch (error) {
        if (!cancelled) {
          setNotice({ kind: "error", message: normalizeError(error) });
        }
      }
    }

    void load(activeChatId);
    return () => {
      cancelled = true;
    };
  }, [activeChatId, setMemoryByChat, setNotice]);

  return {
    persistMemory,
    refreshMemory,
    createEntry,
    toggleEntry,
    deleteEntry,
  };
}
