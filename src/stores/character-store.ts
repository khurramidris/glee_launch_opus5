import { create } from "zustand";
import type { Character } from "../types";
import * as api from "../api/tauri";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

type CharacterEditorMode = "edit" | "create";

interface CharacterDraft {
  name: string;
  description: string;
  personality: string;
  backstory: string;
  scenario: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  speechStyle: string;
  greeting: string;
  alternateGreetings: string;
  avatar: string;
  tags: string;
  likes: string;
  dislikes: string;
  boundaries: string;
  creatorNotes: string;
  creator: string;
  characterVersion: string;
  exampleDialogue: string;
}

function createEmptyDraft(): CharacterDraft {
  return {
    name: "",
    description: "",
    personality: "",
    backstory: "",
    scenario: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    speechStyle: "",
    greeting: "",
    alternateGreetings: "",
    avatar: "",
    tags: "",
    likes: "",
    dislikes: "",
    boundaries: "",
    creatorNotes: "",
    creator: "",
    characterVersion: "",
    exampleDialogue: "",
  };
}

function draftFromCharacter(character: Character): CharacterDraft {
  return {
    name: character.name,
    description: character.description,
    personality: character.personality ?? "",
    backstory: character.backstory ?? "",
    scenario: character.scenario ?? "",
    systemPrompt: character.systemPrompt,
    postHistoryInstructions: character.postHistoryInstructions ?? "",
    speechStyle: character.speechStyle ?? "",
    greeting: character.greeting ?? "",
    alternateGreetings: (character.alternateGreetings ?? []).join("\n\n---\n\n"),
    avatar: character.avatar ?? "",
    tags: (character.tags ?? []).join(", "),
    likes: (character.likes ?? []).join(", "),
    dislikes: (character.dislikes ?? []).join(", "),
    boundaries: character.boundaries ?? "",
    creatorNotes: character.creatorNotes ?? "",
    creator: character.creator ?? "",
    characterVersion: character.characterVersion ?? "",
    exampleDialogue: character.exampleDialogue ?? "",
  };
}

function parseTagCsv(csv: string): string[] {
  return csv
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseAlternateGreetings(value: string): string[] {
  return value
    .split(/^\s*---\s*$/m)
    .map((greeting) => greeting.trim())
    .filter(Boolean);
}

function upsertInList(prev: Character[], next: Character): Character[] {
  const without = prev.filter((c) => c.id !== next.id);
  return [next, ...without].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

interface CharacterState {
  characters: Character[];
  activeCharacterId: string | null;
  editingCharacterId: string | null;
  searchInput: string;
  editorMode: CharacterEditorMode | null;
  draft: CharacterDraft;
  savingCharacter: boolean;
  importingCard: boolean;

  setCharacters: (characters: StateUpdater<Character[]>) => void;
  setActiveCharacterId: (id: string | null) => void;
  setSearchInput: (input: string) => void;
  setEditorMode: (mode: CharacterEditorMode | null) => void;
  setDraft: (draft: StateUpdater<CharacterDraft>) => void;
  updateDraft: (partial: Partial<CharacterDraft>) => void;
  setSavingCharacter: (v: boolean) => void;
  setImportingCard: (v: boolean) => void;
  upsertCharacter: (character: Character) => void;

  startCreate: () => void;
  startEdit: (character: Character) => void;
  cancelEditor: () => void;

  saveCharacter: () => Promise<Character>;
  importCard: (path: string) => Promise<Character>;
}

export const characterStore = create<CharacterState>()((set, get) => ({
  characters: [],
  activeCharacterId: null,
  editingCharacterId: null,
  searchInput: "",
  editorMode: null,
  draft: createEmptyDraft(),
  savingCharacter: false,
  importingCard: false,

  setCharacters: (characters) =>
    set((state) => ({ characters: resolveStateUpdate(state.characters, characters) })),
  setActiveCharacterId: (id) => set({ activeCharacterId: id }),
  setSearchInput: (input) => set({ searchInput: input }),
  setEditorMode: (mode) => set({ editorMode: mode }),
  setDraft: (draft) => set((state) => ({ draft: resolveStateUpdate(state.draft, draft) })),
  updateDraft: (partial) => set((s) => ({ draft: { ...s.draft, ...partial } })),
  setSavingCharacter: (v) => set({ savingCharacter: v }),
  setImportingCard: (v) => set({ importingCard: v }),
  upsertCharacter: (character) =>
    set((s) => ({ characters: upsertInList(s.characters, character) })),

  startCreate: () =>
    set({ editorMode: "create", editingCharacterId: null, draft: createEmptyDraft() }),
  startEdit: (character) =>
    set({
      editorMode: "edit",
      editingCharacterId: character.id,
      draft: draftFromCharacter(character),
    }),
  cancelEditor: () => set({ editorMode: null, editingCharacterId: null, draft: createEmptyDraft() }),

  saveCharacter: async () => {
    const { draft, editorMode, editingCharacterId } = get();
    set({ savingCharacter: true });
      try {
        const tags = parseTagCsv(draft.tags);
        const likes = parseTagCsv(draft.likes);
        const dislikes = parseTagCsv(draft.dislikes);
        const alternateGreetings = parseAlternateGreetings(draft.alternateGreetings);
        let character: Character;
        if (editorMode === "edit" && editingCharacterId) {
          character = await api.updateCharacter({
            id: editingCharacterId,
            name: draft.name,
            description: draft.description,
            personality: draft.personality || undefined,
            backstory: draft.backstory || undefined,
            scenario: draft.scenario || undefined,
            systemPrompt: draft.systemPrompt,
            postHistoryInstructions: draft.postHistoryInstructions || undefined,
            speechStyle: draft.speechStyle || undefined,
            greeting: draft.greeting || undefined,
            alternateGreetings,
            avatar: draft.avatar || undefined,
            tags,
            likes,
            dislikes,
            boundaries: draft.boundaries || undefined,
            creatorNotes: draft.creatorNotes || undefined,
            creator: draft.creator || undefined,
            characterVersion: draft.characterVersion || undefined,
            exampleDialogue: draft.exampleDialogue || undefined,
          });
        } else {
          character = await api.createCharacter({
            name: draft.name,
            description: draft.description,
            personality: draft.personality || undefined,
            backstory: draft.backstory || undefined,
            scenario: draft.scenario || undefined,
            systemPrompt: draft.systemPrompt,
            postHistoryInstructions: draft.postHistoryInstructions || undefined,
            speechStyle: draft.speechStyle || undefined,
            greeting: draft.greeting || undefined,
            alternateGreetings,
            avatar: draft.avatar || undefined,
            tags,
            likes,
            dislikes,
            boundaries: draft.boundaries || undefined,
            creatorNotes: draft.creatorNotes || undefined,
            creator: draft.creator || undefined,
            characterVersion: draft.characterVersion || undefined,
            exampleDialogue: draft.exampleDialogue || undefined,
          });
        }
      set((s) => ({
        characters: upsertInList(s.characters, character),
        editorMode: null,
        editingCharacterId: null,
        draft: createEmptyDraft(),
        activeCharacterId: character.id,
      }));
      return character;
    } finally {
      set({ savingCharacter: false });
    }
  },

  importCard: async (path) => {
    set({ importingCard: true });
    try {
      const character = await api.importCharacterCard({ path });
      set((s) => ({
        characters: upsertInList(s.characters, character),
        activeCharacterId: character.id,
      }));
      return character;
    } finally {
      set({ importingCard: false });
    }
  },
}));

export const useCharacterStore = characterStore;

export { createEmptyDraft, draftFromCharacter, parseAlternateGreetings, parseTagCsv };
export type { CharacterDraft, CharacterEditorMode };
