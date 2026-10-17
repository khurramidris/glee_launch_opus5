import { useCallback, useEffect } from "react";
import * as api from "../../api/tauri";
import { normalizeError } from "../app/app-domain";
import { useAppStore } from "../../stores/app-store";
import { usePersonaStore } from "../../stores/persona-store";
import { usePresetStore } from "../../stores/preset-store";

export function usePersonas() {
  const { setNotice } = useAppStore();
  const {
    personas,
    loaded,
    editingPersonaId,
    personaDraft,
    savingPersona,
    setPersonas,
    setLoaded,
    setPersonaDraft,
    startCreatePersona,
    startEditPersona,
    setSavingPersona,
  } = usePersonaStore();
  const { setPresetProfileByChat } = usePresetStore();

  useEffect(() => {
    if (loaded) {
      return;
    }
    let cancelled = false;
    api
      .listPersonas()
      .then((items) => {
        if (!cancelled) {
          setPersonas(items);
          setLoaded(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice({ kind: "error", message: normalizeError(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, setLoaded, setNotice, setPersonas]);

  const savePersona = useCallback(async () => {
    const draft = {
      name: personaDraft.name.trim(),
      about: personaDraft.about.trim(),
      preferences: personaDraft.preferences.trim(),
    };
    if (!draft.name) {
      setNotice({ kind: "error", message: "Give the persona a name." });
      return;
    }
    setSavingPersona(true);
    try {
      const saved = editingPersonaId
        ? await api.updatePersona(editingPersonaId, draft)
        : await api.createPersona(draft);
      setPersonas((prev) => [saved, ...prev.filter((persona) => persona.id !== saved.id)]);
      startCreatePersona();
      setNotice({ kind: "info", message: `Saved persona ${saved.name}.` });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    } finally {
      setSavingPersona(false);
    }
  }, [
    editingPersonaId,
    personaDraft,
    setNotice,
    setPersonas,
    setSavingPersona,
    startCreatePersona,
  ]);

  const removePersona = useCallback(
    async (personaId: string) => {
      try {
        await api.deletePersona(personaId);
        setPersonas((prev) => prev.filter((persona) => persona.id !== personaId));
        // Chats that used this persona fall back to the default profile.
        setPresetProfileByChat((prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([chatId, profile]) => [
              chatId,
              profile.personaPresetId === personaId
                ? { ...profile, personaPresetId: undefined }
                : profile,
            ]),
          ),
        );
        if (editingPersonaId === personaId) {
          startCreatePersona();
        }
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [editingPersonaId, setNotice, setPersonas, setPresetProfileByChat, startCreatePersona],
  );

  const choosePersonaForChat = useCallback(
    async (chatId: string, personaId: string | null) => {
      try {
        const saved = await api.setChatPersona(chatId, personaId);
        setPresetProfileByChat((prev) => ({ ...prev, [chatId]: saved }));
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [setNotice, setPresetProfileByChat],
  );

  return {
    personas,
    editingPersonaId,
    personaDraft,
    savingPersona,
    setPersonaDraft,
    startCreatePersona,
    startEditPersona,
    savePersona,
    removePersona,
    choosePersonaForChat,
  };
}
