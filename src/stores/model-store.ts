import { create } from "zustand";
import type { ModelDownloadProgress, ModelInfo, RuntimeState } from "../types";
import * as api from "../api/tauri";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

const FALLBACK_RUNTIME_STATE: RuntimeState = {
  status: "stopped",
  endpoint: "http://127.0.0.1:8080",
};

function upsertInList(prev: ModelInfo[], next: ModelInfo): ModelInfo[] {
  const without = prev.filter((m) => m.id !== next.id);
  return [next, ...without].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

interface ModelState {
  models: ModelInfo[];
  runtime: RuntimeState;
  importingModel: boolean;
  downloadingModel: boolean;
  modelDownloadProgress: ModelDownloadProgress | null;
  startingRuntime: boolean;
  stoppingRuntime: boolean;

  setModels: (models: StateUpdater<ModelInfo[]>) => void;
  setRuntime: (runtime: RuntimeState) => void;
  upsertModel: (model: ModelInfo) => void;
  setImportingModel: (v: boolean) => void;
  setDownloadingModel: (v: boolean) => void;
  setModelDownloadProgress: (progress: ModelDownloadProgress | null) => void;
  setStartingRuntime: (v: boolean) => void;
  setStoppingRuntime: (v: boolean) => void;

  activateModel: (modelId: string) => Promise<ModelInfo>;
  pollRuntime: () => Promise<RuntimeState>;
}

export const modelStore = create<ModelState>()((set) => ({
  models: [],
  runtime: FALLBACK_RUNTIME_STATE,
  importingModel: false,
  downloadingModel: false,
  modelDownloadProgress: null,
  startingRuntime: false,
  stoppingRuntime: false,

  setModels: (models) => set((state) => ({ models: resolveStateUpdate(state.models, models) })),
  setRuntime: (runtime) => set({ runtime }),
  upsertModel: (model) => set((s) => ({ models: upsertInList(s.models, model) })),
  setImportingModel: (v) => set({ importingModel: v }),
  setDownloadingModel: (v) => set({ downloadingModel: v }),
  setModelDownloadProgress: (progress) => set({ modelDownloadProgress: progress }),
  setStartingRuntime: (v) => set({ startingRuntime: v }),
  setStoppingRuntime: (v) => set({ stoppingRuntime: v }),

  activateModel: async (modelId) => {
    const updated = await api.setActiveModel(modelId);
    set((s) => ({
      models: s.models.map((m) => ({
        ...m,
        isActive: m.id === updated.id,
      })),
    }));
    return updated;
  },

  pollRuntime: async () => {
    const state = await api.getRuntimeState();
    set({ runtime: state });
    return state;
  },
}));

export const useModelStore = modelStore;

export { FALLBACK_RUNTIME_STATE };
