import { create } from "zustand";
import type {
  AppSettingEntry,
  RuntimeLaunchSettings,
  RuntimePerformanceMode,
  RuntimeStartupSettings,
} from "../types";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

const DEFAULT_RUNTIME_CONTEXT_SIZE = 8192;
export const RUNTIME_SETTING_KEYS = {
  warmupEnabled: "runtime.warmup.enabled",
  performanceMode: "runtime.performance.mode",
  gpuLayers: "runtime.gpu.layers",
} as const;

const RUNTIME_SETTING_KEY_ALIASES = {
  warmupEnabled: [RUNTIME_SETTING_KEYS.warmupEnabled, "runtime_warmup_enabled"],
  performanceMode: [RUNTIME_SETTING_KEYS.performanceMode, "runtime_performance_mode"],
  gpuLayers: [RUNTIME_SETTING_KEYS.gpuLayers, "runtime_gpu_layers"],
} as const;

function createDefaultRuntimeSettings(): RuntimeStartupSettings {
  return {
    warmupEnabled: true,
    performanceMode: "auto",
    gpuLayers: 0,
  };
}

function normalizeGpuLayers(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizePerformanceMode(
  value: RuntimePerformanceMode | string | null | undefined,
  fallback: RuntimePerformanceMode = "auto",
): RuntimePerformanceMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "auto" || normalized === "cpu" || normalized === "gpu") {
    return normalized;
  }
  return fallback;
}

function inferPerformanceModeFromGpuLayers(
  gpuLayers: number,
  fallback: RuntimePerformanceMode = "auto",
): RuntimePerformanceMode {
  return normalizeGpuLayers(gpuLayers) > 0 ? "gpu" : fallback;
}

function normalizeRuntimeSettings(value: RuntimeStartupSettings): RuntimeStartupSettings {
  const gpuLayers = normalizeGpuLayers(value.gpuLayers);
  return {
    warmupEnabled: Boolean(value.warmupEnabled),
    performanceMode: normalizePerformanceMode(
      value.performanceMode,
      inferPerformanceModeFromGpuLayers(gpuLayers),
    ),
    gpuLayers,
  };
}

function runtimeSettingsEqual(
  a: RuntimeStartupSettings,
  b: RuntimeStartupSettings,
): boolean {
  return (
    a.warmupEnabled === b.warmupEnabled &&
    a.performanceMode === b.performanceMode &&
    a.gpuLayers === b.gpuLayers
  );
}

function parseBoolean(value: string | null | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parsePerformanceMode(value: string | null | undefined): RuntimePerformanceMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "auto" || normalized === "cpu" || normalized === "gpu") {
    return normalized;
  }
  return undefined;
}

function parseGpuLayers(value: string | null | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return normalizeGpuLayers(parsed);
}

function matchesRuntimeSettingKey(
  entry: AppSettingEntry,
  keys: readonly string[],
): boolean {
  return keys.includes(entry.key);
}

export function parseRuntimeSettingsFromEntries(
  entries: AppSettingEntry[],
): Partial<RuntimeStartupSettings> | null {
  let warmupEnabled: boolean | undefined;
  let performanceMode: RuntimePerformanceMode | undefined;
  let gpuLayers: number | undefined;

  for (const entry of entries) {
    if (matchesRuntimeSettingKey(entry, RUNTIME_SETTING_KEY_ALIASES.warmupEnabled)) {
      warmupEnabled = parseBoolean(entry.value);
    }
    if (matchesRuntimeSettingKey(entry, RUNTIME_SETTING_KEY_ALIASES.performanceMode)) {
      performanceMode = parsePerformanceMode(entry.value);
    }
    if (matchesRuntimeSettingKey(entry, RUNTIME_SETTING_KEY_ALIASES.gpuLayers)) {
      gpuLayers = parseGpuLayers(entry.value);
    }
  }

  if (
    warmupEnabled === undefined &&
    performanceMode === undefined &&
    gpuLayers === undefined
  ) {
    return null;
  }

  return {
    ...(warmupEnabled === undefined ? {} : { warmupEnabled }),
    ...(performanceMode === undefined
      ? gpuLayers === undefined
        ? {}
        : { performanceMode: inferPerformanceModeFromGpuLayers(gpuLayers) }
      : { performanceMode }),
    ...(gpuLayers === undefined ? {} : { gpuLayers }),
  };
}

export function runtimeGpuLayersForMode(settings: RuntimeStartupSettings): number {
  const normalized = normalizeRuntimeSettings(settings);
  return normalized.performanceMode === "gpu" ? normalized.gpuLayers : 0;
}

export function buildRuntimeStartArgs(settings: RuntimeStartupSettings): string[] {
  const normalized = normalizeRuntimeSettings(settings);
  const args = ["--ctx-size", String(DEFAULT_RUNTIME_CONTEXT_SIZE)];
  const gpuLayers = runtimeGpuLayersForMode(normalized);

  if (!normalized.warmupEnabled) {
    args.push("--no-warmup");
  }
  if (gpuLayers > 0) {
    args.push("-ngl", String(gpuLayers));
  }

  return args;
}

function toStartupSettings(record: RuntimeLaunchSettings): RuntimeStartupSettings {
  return normalizeRuntimeSettings({
    warmupEnabled: record.warmupEnabled,
    performanceMode: record.performanceMode,
    gpuLayers: record.gpuLayers,
  });
}

interface RuntimeSettingsState {
  runtimeSettings: RuntimeStartupSettings;

  setRuntimeSettings: (state: StateUpdater<RuntimeStartupSettings>) => void;
  updateRuntimeSettings: (partial: Partial<RuntimeStartupSettings>) => void;
  setWarmupEnabled: (warmupEnabled: boolean) => void;
  setPerformanceMode: (performanceMode: RuntimePerformanceMode) => void;
  setGpuLayers: (gpuLayers: number) => void;
  hydrateFromLaunchSettings: (settings: RuntimeLaunchSettings) => void;
}

export const runtimeSettingsStore = create<RuntimeSettingsState>()((set) => ({
  runtimeSettings: createDefaultRuntimeSettings(),

  setRuntimeSettings: (state) =>
    set((current) => {
      const next = normalizeRuntimeSettings(
        resolveStateUpdate(current.runtimeSettings, state),
      );
      if (runtimeSettingsEqual(next, current.runtimeSettings)) {
        return current;
      }
      return { runtimeSettings: next };
    }),
  updateRuntimeSettings: (partial) =>
    set((current) => {
      const next = normalizeRuntimeSettings({
        ...current.runtimeSettings,
        ...partial,
      });
      if (runtimeSettingsEqual(next, current.runtimeSettings)) {
        return current;
      }
      return { runtimeSettings: next };
    }),
  setWarmupEnabled: (warmupEnabled) =>
    set((current) => {
      const next = normalizeRuntimeSettings({
        ...current.runtimeSettings,
        warmupEnabled,
      });
      if (runtimeSettingsEqual(next, current.runtimeSettings)) {
        return current;
      }
      return { runtimeSettings: next };
    }),
  setPerformanceMode: (performanceMode) =>
    set((current) => {
      const next = normalizeRuntimeSettings({
        ...current.runtimeSettings,
        performanceMode,
      });
      if (runtimeSettingsEqual(next, current.runtimeSettings)) {
        return current;
      }
      return { runtimeSettings: next };
    }),
  setGpuLayers: (gpuLayers) =>
    set((current) => {
      const next = normalizeRuntimeSettings({
        ...current.runtimeSettings,
        gpuLayers,
      });
      if (runtimeSettingsEqual(next, current.runtimeSettings)) {
        return current;
      }
      return { runtimeSettings: next };
    }),
  hydrateFromLaunchSettings: (settings) =>
    set((current) => {
      const next = toStartupSettings(settings);
      if (runtimeSettingsEqual(next, current.runtimeSettings)) {
        return current;
      }
      return { runtimeSettings: next };
    }),
}));

export const useRuntimeSettingsStore = runtimeSettingsStore;

export {
  createDefaultRuntimeSettings,
  normalizeGpuLayers,
  normalizePerformanceMode,
  normalizeRuntimeSettings,
  inferPerformanceModeFromGpuLayers,
  toStartupSettings,
};

export type { RuntimeSettingsState };
