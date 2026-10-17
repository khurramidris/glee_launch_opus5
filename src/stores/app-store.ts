import { create } from "zustand";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

type DetailTab = "overview" | "identity" | "memory" | "diagnostics";

interface NoticeState {
  kind: "info" | "error" | "success";
  message: string;
}

interface AppState {
  booting: boolean;
  notice: NoticeState | null;
  commandPaletteOpen: boolean;
  commandFilter: string;
  detailTab: DetailTab;

  setBooting: (booting: boolean) => void;
  setNotice: (notice: NoticeState | null) => void;
  clearNotice: () => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: StateUpdater<boolean>) => void;
  setCommandFilter: (filter: string) => void;
  setDetailTab: (tab: DetailTab) => void;
}

export const appStore = create<AppState>()((set) => ({
  booting: true,
  notice: null,
  commandPaletteOpen: false,
  commandFilter: "",
  detailTab: "overview",

  setBooting: (booting) => set({ booting }),
  setNotice: (notice) => set({ notice }),
  clearNotice: () => set({ notice: null }),
  toggleCommandPalette: () =>
    set((state) => ({
      commandPaletteOpen: !state.commandPaletteOpen,
      commandFilter: "",
    })),
  setCommandPaletteOpen: (open) =>
    set((state) => {
      const nextOpen = resolveStateUpdate(state.commandPaletteOpen, open);
      return { commandPaletteOpen: nextOpen, commandFilter: "" };
    }),
  setCommandFilter: (filter) => set({ commandFilter: filter }),
  setDetailTab: (tab) => set({ detailTab: tab }),
}));

export const useAppStore = appStore;

export type { DetailTab, NoticeState };
