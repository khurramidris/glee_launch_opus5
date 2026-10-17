import { create } from "zustand";
import type { Persona, PersonaDraft } from "../types";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

export function createEmptyPersonaDraft(): PersonaDraft {
  return { name: "", about: "", preferences: "" };
}

interface PersonaState {
  personas: Persona[];
  loaded: boolean;
  editingPersonaId: string | null;
  personaDraft: PersonaDraft;
  savingPersona: boolean;

  setPersonas: (personas: StateUpdater<Persona[]>) => void;
  setLoaded: (loaded: boolean) => void;
  setPersonaDraft: (draft: StateUpdater<PersonaDraft>) => void;
  startCreatePersona: () => void;
  startEditPersona: (persona: Persona) => void;
  setSavingPersona: (saving: boolean) => void;
}

export const personaStore = create<PersonaState>()((set) => ({
  personas: [],
  loaded: false,
  editingPersonaId: null,
  personaDraft: createEmptyPersonaDraft(),
  savingPersona: false,

  setPersonas: (personas) =>
    set((state) => ({ personas: resolveStateUpdate(state.personas, personas) })),
  setLoaded: (loaded) => set({ loaded }),
  setPersonaDraft: (draft) =>
    set((state) => ({ personaDraft: resolveStateUpdate(state.personaDraft, draft) })),
  startCreatePersona: () =>
    set({ editingPersonaId: null, personaDraft: createEmptyPersonaDraft() }),
  startEditPersona: (persona) =>
    set({
      editingPersonaId: persona.id,
      personaDraft: {
        name: persona.name,
        about: persona.about,
        preferences: persona.preferences,
      },
    }),
  setSavingPersona: (savingPersona) => set({ savingPersona }),
}));

export const usePersonaStore = personaStore;
