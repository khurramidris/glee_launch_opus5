import { useCallback } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as api from "../../api/tauri";
import type { Character } from "../../types";
import { useAppStore, useCharacterStore } from "../../stores";
import { normalizeError } from "../app/app-domain";
import { clearCharacterPortraitCache } from "./use-character-portrait";

function fileBaseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

export const CHARACTER_CARD_IMPORT_EXTENSIONS = ["png", "json"] as const;
export const CHARACTER_CARD_EXPORT_EXTENSIONS = ["json", "png"] as const;
export const CHARACTER_PORTRAIT_EXTENSIONS = ["png"] as const;

function extensionOfPath(path: string | undefined): string {
  return path?.split(".").pop()?.trim().toLowerCase() ?? "";
}

export function isPngPath(path: string | undefined): boolean {
  return extensionOfPath(path) === "png";
}

export function canExportCharacterCardAsPng(character: Character | null | undefined): boolean {
  return !!character?.avatar && isPngPath(character.avatar);
}

export function useCharacterManagement() {
  const { setNotice } = useAppStore();
  const {
    activeCharacterId,
    characters,
    draft,
    importingCard,
    saveCharacter,
    importCard,
    setActiveCharacterId,
    setCharacters,
  } = useCharacterStore();

  const saveCurrentCharacter = useCallback(async () => {
    const name = draft.name.trim();
    if (!name) {
      setNotice({ kind: "error", message: "Character name is required." });
      return;
    }
    try {
      const previousAvatar =
        activeCharacterId != null
          ? characters.find((character) => character.id === activeCharacterId)?.avatar
          : undefined;
      const saved = await saveCharacter();
      clearCharacterPortraitCache(previousAvatar);
      clearCharacterPortraitCache(saved.avatar);
      setNotice({ kind: "info", message: "Character saved." });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }, [activeCharacterId, characters, draft.name, saveCharacter, setNotice]);

  const importCharacterCard = useCallback(async () => {
    if (importingCard) {
      return;
    }
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Character Card", extensions: [...CHARACTER_CARD_IMPORT_EXTENSIONS] }],
      });
      if (typeof selected !== "string") {
        return;
      }
      const imported = await importCard(selected);
      clearCharacterPortraitCache(imported.avatar);
      setNotice({
        kind: "info",
        message: `Imported ${imported.name} from ${fileBaseName(selected)}`,
      });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }, [importCard, importingCard, setNotice]);

  const chooseCharacterPortrait = useCallback(async (): Promise<string | undefined> => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Portrait PNG", extensions: [...CHARACTER_PORTRAIT_EXTENSIONS] }],
    });
    if (typeof selected !== "string") {
      return undefined;
    }
    return selected;
  }, []);

  const exportCharacterCardJson = useCallback(
    async (character: Character | null | undefined) => {
      if (!character) {
        setNotice({ kind: "error", message: "Select a character first." });
        return;
      }
      try {
        const selected = await save({
          defaultPath: `${character.name}.json`,
          filters: [
            { name: "Character Card JSON", extensions: ["json"] },
          ],
        });
        if (typeof selected !== "string") {
          return;
        }
        const exported = await api.exportCharacterCardJson({
          characterId: character.id,
          path: selected.endsWith(".json") ? selected : `${selected}.json`,
        });
        setNotice({
          kind: "info",
          message: `Exported ${character.name} as JSON to ${fileBaseName(exported.path)}`,
        });
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [setNotice],
  );

  const exportCharacterCardPng = useCallback(
    async (character: Character | null | undefined) => {
      if (!character) {
        setNotice({ kind: "error", message: "Select a character first." });
        return;
      }
      if (!canExportCharacterCardAsPng(character)) {
        setNotice({
          kind: "error",
          message:
            "PNG export requires a portrait PNG. Add one in Character Studio before exporting as PNG.",
        });
        return;
      }
      try {
        const selected = await save({
          defaultPath: `${character.name}.png`,
          filters: [{ name: "Character Card PNG", extensions: ["png"] }],
        });
        if (typeof selected !== "string") {
          return;
        }
        const exported = await api.exportCharacterCardPng({
          characterId: character.id,
          path: selected.endsWith(".png") ? selected : `${selected}.png`,
        });
        setNotice({
          kind: "info",
          message: `Exported ${character.name} as PNG to ${fileBaseName(exported.path)}`,
        });
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [setNotice],
  );

  const deleteCharacter = useCallback(
    async (character: Character | null | undefined) => {
      if (!character) {
        setNotice({ kind: "error", message: "Select a character first." });
        return false;
      }
      try {
        await api.deleteCharacter(character.id);
        clearCharacterPortraitCache(character.avatar);
        const remaining = characters.filter((entry) => entry.id !== character.id);
        setCharacters(remaining);
        setActiveCharacterId(remaining[0]?.id ?? null);
        setNotice({ kind: "info", message: `Deleted ${character.name}.` });
        return true;
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
        return false;
      }
    },
    [characters, setActiveCharacterId, setCharacters, setNotice],
  );

  return {
    saveCurrentCharacter,
    importCharacterCard,
    chooseCharacterPortrait,
    exportCharacterCardJson,
    exportCharacterCardPng,
    deleteCharacter,
  };
}
