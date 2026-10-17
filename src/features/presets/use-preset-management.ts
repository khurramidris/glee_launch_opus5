import { useCallback, useEffect, useRef } from "react";
import {
  createGenerationPreset,
  deleteGenerationPreset,
  getChatPresetProfile,
  updateGenerationPreset,
  upsertChatPresetProfile,
} from "../../api/tauri";
import { useAppStore, useChatStore, usePresetStore } from "../../stores";
import {
  DEFAULT_REPEAT_PENALTY,
  DEFAULT_TEMPERATURE,
  DEFAULT_TOP_P,
  draftFromGeneration,
} from "../../stores/preset-store";
import {
  type ChatPresetSelection,
  normalizeError,
  parseBoundedNumber,
  parseOptionalPositiveInt,
  resolveActivePresetId,
  sortByRecent,
} from "../app/app-domain";

export function usePresetManagement() {
  const { setNotice } = useAppStore();
  const { activeChatId } = useChatStore();
  const {
    generationPresets,
    presetProfileByChat,
    activeGenerationPresetId,
    generationEditorMode,
    editingGenerationPresetId,
    generationPresetDraft,
    setGenerationPresets,
    setPresetProfileByChat,
    setActiveGenerationPresetId,
    setSavingGenerationPreset,
    setDeletingPresetKey,
    startCreateGeneration,
    startEditGeneration,
  } = usePresetStore();

  const presetProfileByChatRef = useRef(presetProfileByChat);
  const presetProfileLoadedByChatRef = useRef<Record<string, boolean>>({});
  const pendingPresetSelectionByChatRef = useRef<Record<string, ChatPresetSelection>>({});
  const presetProfilePersistSeqByChatRef = useRef<Record<string, number>>({});

  useEffect(() => {
    presetProfileByChatRef.current = presetProfileByChat;
  }, [presetProfileByChat]);

  const persistPresetProfileSelection = useCallback(
    async (chatId: string, selection: ChatPresetSelection): Promise<void> => {
      const generationPresetId = selection.generationPresetId?.trim() || undefined;
      if (!presetProfileLoadedByChatRef.current[chatId]) {
        pendingPresetSelectionByChatRef.current[chatId] = { generationPresetId };
        return;
      }
      delete pendingPresetSelectionByChatRef.current[chatId];
      const existing = presetProfileByChatRef.current[chatId];
      if (existing?.generationPresetId === generationPresetId) {
        return;
      }
      const nextSeq = (presetProfilePersistSeqByChatRef.current[chatId] ?? 0) + 1;
      presetProfilePersistSeqByChatRef.current[chatId] = nextSeq;
      try {
        const saved = await upsertChatPresetProfile({
          chatId,
          generationPresetId,
        });
        if (presetProfilePersistSeqByChatRef.current[chatId] !== nextSeq) {
          return;
        }
        setPresetProfileByChat((prev) => ({ ...prev, [chatId]: saved }));
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [setNotice, setPresetProfileByChat],
  );

  useEffect(() => {
    if (!activeChatId) {
      return;
    }
    const chatId = activeChatId;
    presetProfileLoadedByChatRef.current[chatId] = false;
    const cachedProfile = presetProfileByChatRef.current[chatId];
    setActiveGenerationPresetId(
      resolveActivePresetId(cachedProfile?.generationPresetId, generationPresets),
    );

    let cancelled = false;

    async function hydratePresetProfile(targetChatId: string): Promise<void> {
      try {
        const profile = await getChatPresetProfile(targetChatId);
        if (cancelled) {
          return;
        }
        setPresetProfileByChat((prev) => {
          const next = { ...prev };
          if (profile) {
            next[targetChatId] = profile;
          } else {
            delete next[targetChatId];
          }
          return next;
        });

        const pendingSelection = pendingPresetSelectionByChatRef.current[targetChatId];
        if (pendingSelection) {
          delete pendingPresetSelectionByChatRef.current[targetChatId];
          const nextGenerationPresetId = resolveActivePresetId(
            pendingSelection.generationPresetId,
            generationPresets,
          );
          setActiveGenerationPresetId(nextGenerationPresetId);
          presetProfileLoadedByChatRef.current[targetChatId] = true;
          void persistPresetProfileSelection(targetChatId, {
            generationPresetId: nextGenerationPresetId,
          });
          return;
        }

        setActiveGenerationPresetId(
          resolveActivePresetId(profile?.generationPresetId, generationPresets),
        );
      } catch (error) {
        if (!cancelled) {
          setNotice({ kind: "error", message: normalizeError(error) });
          setActiveGenerationPresetId((prev) =>
            resolveActivePresetId(prev, generationPresets),
          );
        }
      } finally {
        if (!cancelled) {
          presetProfileLoadedByChatRef.current[targetChatId] = true;
        }
      }
    }

    void hydratePresetProfile(chatId);
    return () => {
      cancelled = true;
    };
  }, [
    activeChatId,
    generationPresets,
    persistPresetProfileSelection,
    setActiveGenerationPresetId,
    setNotice,
    setPresetProfileByChat,
  ]);

  useEffect(() => {
    if (!activeChatId) {
      return;
    }
    setActiveGenerationPresetId((prev) =>
      resolveActivePresetId(prev, generationPresets),
    );
  }, [activeChatId, generationPresets, setActiveGenerationPresetId]);

  const selectGenerationPreset = useCallback(
    (presetId: string) => {
      setActiveGenerationPresetId(presetId);
      if (!activeChatId) {
        return;
      }
      void persistPresetProfileSelection(activeChatId, {
        generationPresetId: presetId,
      });
    },
    [activeChatId, persistPresetProfileSelection, setActiveGenerationPresetId],
  );

  const startCreateGenerationPreset = useCallback(() => {
    startCreateGeneration();
  }, [startCreateGeneration]);

  const startEditGenerationPreset = useCallback(
    (preset: Parameters<typeof draftFromGeneration>[0]) => {
      startEditGeneration(preset);
    },
    [startEditGeneration],
  );

  const saveGenerationPreset = useCallback(async () => {
    const name = generationPresetDraft.name.trim();
    if (!name) {
      setNotice({
        kind: "error",
        message: "Generation preset name is required.",
      });
      return;
    }

    const temperature = parseBoundedNumber(
      generationPresetDraft.temperature,
      DEFAULT_TEMPERATURE,
      0.01,
      2,
    );
    const topP = parseBoundedNumber(
      generationPresetDraft.topP,
      DEFAULT_TOP_P,
      0.01,
      1,
    );
    const maxTokens = parseOptionalPositiveInt(generationPresetDraft.maxTokens);
    const repeatPenalty = parseBoundedNumber(
      generationPresetDraft.repeatPenalty,
      DEFAULT_REPEAT_PENALTY,
      0.01,
      3,
    );

    setSavingGenerationPreset(true);
    try {
      const payload = {
        name,
        description: generationPresetDraft.description.trim() || undefined,
        temperature,
        topP,
        maxTokens,
        repeatPenalty,
      };
      const nextPreset =
        generationEditorMode === "edit" && editingGenerationPresetId
          ? await updateGenerationPreset({ id: editingGenerationPresetId, ...payload })
          : await createGenerationPreset(payload);

      setGenerationPresets((prev) =>
        sortByRecent([
          nextPreset,
          ...prev.filter((preset) => preset.id !== nextPreset.id),
        ]),
      );
      selectGenerationPreset(nextPreset.id);
      startCreateGenerationPreset();
      setNotice({ kind: "info", message: "Generation preset saved." });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    } finally {
      setSavingGenerationPreset(false);
    }
  }, [
    editingGenerationPresetId,
    generationEditorMode,
    generationPresetDraft.description,
    generationPresetDraft.maxTokens,
    generationPresetDraft.name,
    generationPresetDraft.repeatPenalty,
    generationPresetDraft.temperature,
    generationPresetDraft.topP,
    selectGenerationPreset,
    setGenerationPresets,
    setNotice,
    setSavingGenerationPreset,
    startCreateGenerationPreset,
  ]);

  const deleteGenerationPresetById = useCallback(
    async (preset: Parameters<typeof draftFromGeneration>[0]) => {
      if (!window.confirm(`Delete generation preset "${preset.name}"?`)) {
        return;
      }
      const key = `generation:${preset.id}`;
      setDeletingPresetKey(key);
      try {
        await deleteGenerationPreset(preset.id);
        setGenerationPresets((prev) => prev.filter((item) => item.id !== preset.id));
        if (activeGenerationPresetId === preset.id) {
          selectGenerationPreset("");
        }
        if (editingGenerationPresetId === preset.id) {
          startCreateGenerationPreset();
        }
        setNotice({ kind: "info", message: "Generation preset deleted." });
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      } finally {
        setDeletingPresetKey(null);
      }
    },
    [
      activeGenerationPresetId,
      editingGenerationPresetId,
      selectGenerationPreset,
      setDeletingPresetKey,
      setGenerationPresets,
      setNotice,
      startCreateGenerationPreset,
    ],
  );

  return {
    selectGenerationPreset,
    startCreateGenerationPreset,
    startEditGenerationPreset,
    saveGenerationPreset,
    deleteGenerationPresetById,
  };
}
