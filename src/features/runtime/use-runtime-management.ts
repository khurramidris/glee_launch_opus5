import { useCallback, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  cancelModelDownload,
  downloadModel,
  getDiagnosticsSnapshot,
  getRuntimeLaunchSettings,
  getRuntimeState,
  importModel,
  listModels,
  setActiveModel,
  setRuntimeLaunchSettings,
  startRuntime,
  stopRuntime,
} from "../../api/tauri";
import {
  useAppStore,
  useDiagnosticsStore,
  useModelStore,
  useRuntimeSettingsStore,
} from "../../stores";
import { normalizeError } from "../app/app-domain";
import { getRecommendedModelConfig } from "./recommended-model";
import type { ModelDownloadProgress, RuntimePerformanceMode, RuntimeStartupSettings } from "../../types";

function normalizeModelDownloadProgress(payload: unknown): ModelDownloadProgress | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const phase = record.phase;
  if (phase !== "starting" && phase !== "downloading" && phase !== "retrying" && phase !== "ready") {
    return null;
  }
  const downloadedBytes = Number(record.downloadedBytes ?? 0);
  const rawTotalBytes = record.totalBytes == null ? undefined : Number(record.totalBytes);
  const totalBytes =
    rawTotalBytes !== undefined && Number.isFinite(rawTotalBytes) && rawTotalBytes > 0
      ? rawTotalBytes
      : undefined;
  const attempt = Number(record.attempt ?? 1);
  const maxAttempts = Number(record.maxAttempts ?? 1);
  return {
    phase,
    fileName: typeof record.fileName === "string" && record.fileName.trim() ? record.fileName : "model.gguf",
    downloadedBytes: Number.isFinite(downloadedBytes) && downloadedBytes > 0 ? downloadedBytes : 0,
    totalBytes,
    attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1,
  };
}

export function useRuntimeManagement() {
  const {
    models,
    runtime,
    importingModel,
    downloadingModel,
    startingRuntime,
    stoppingRuntime,
    setModels,
    setRuntime,
    setImportingModel,
    setDownloadingModel,
    setModelDownloadProgress,
    setStartingRuntime,
    setStoppingRuntime,
  } = useModelStore();
  const {
    runtimeSettings,
    setRuntimeSettings: setRuntimeSettingsLocal,
    hydrateFromLaunchSettings,
  } = useRuntimeSettingsStore();
  const { setNotice, setDetailTab } = useAppStore();
  const { setSnapshot } = useDiagnosticsStore();
  const lastRuntimeStatusRef = useRef(runtime.status);
  const lastRuntimeErrorRef = useRef(runtime.error);
  const autoStartAttemptedModelIdRef = useRef<string | null>(null);
  const manualStopRequestedRef = useRef(false);

  const activeModel = useMemo(
    () => models.find((model) => model.isActive) ?? null,
    [models],
  );
  const recommendedModel = useMemo(() => getRecommendedModelConfig(), []);
  const syncDiagnosticsSnapshot = useCallback(async () => {
    const snapshot = await getDiagnosticsSnapshot();
    setSnapshot(snapshot);
    return snapshot;
  }, [setSnapshot]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen("model-download-progress", (event) => {
      if (disposed) {
        return;
      }
      const progress = normalizeModelDownloadProgress(event.payload);
      if (progress) {
        setModelDownloadProgress(progress);
      }
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setModelDownloadProgress]);

  const saveRuntimeLaunchSettings = useCallback(
    async (patch: Partial<RuntimeStartupSettings>) => {
      const currentSettings = useRuntimeSettingsStore.getState().runtimeSettings;
      const nextSettings = {
        ...currentSettings,
        ...patch,
      };
      setRuntimeSettingsLocal(nextSettings);
      try {
        const saved = await setRuntimeLaunchSettings(nextSettings);
        hydrateFromLaunchSettings({
          ...saved,
          performanceMode: nextSettings.performanceMode,
          gpuLayers:
            nextSettings.performanceMode === "gpu"
              ? saved.gpuLayers
              : nextSettings.gpuLayers,
        });
        void syncDiagnosticsSnapshot();
        return saved;
      } catch (error) {
        setRuntimeSettingsLocal(currentSettings);
        throw error;
      }
    },
    [hydrateFromLaunchSettings, setRuntimeSettingsLocal, syncDiagnosticsSnapshot],
  );

  const surfaceRuntimeFailure = useCallback(
    async (error: unknown, actionLabel: string, openDiagnostics = true) => {
      try {
        const [latestRuntime] = await Promise.all([
          getRuntimeState(),
          syncDiagnosticsSnapshot(),
        ]);
        setRuntime(latestRuntime);
      } catch {
        // Keep the original failure message if follow-up inspection fails.
      }

      if (openDiagnostics) {
        setDetailTab("diagnostics");
      }

      const message = normalizeError(error);
      setNotice({
        kind: "error",
        message: `${actionLabel} failed. ${message} Open Diagnostics for the health check and runtime log, or export a diagnostics bundle for support.`,
      });
    },
    [setDetailTab, setNotice, setRuntime, syncDiagnosticsSnapshot],
  );

  const refreshModelLibrary = useCallback(async () => {
    const latestModels = await listModels();
    setModels(
      latestModels.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      ),
    );
    return latestModels;
  }, [setModels]);

  useEffect(() => {
    lastRuntimeStatusRef.current = runtime.status;
    lastRuntimeErrorRef.current = runtime.error;
  }, [runtime.error, runtime.status]);

  useEffect(() => {
    let cancelled = false;

    async function loadLaunchSettings(): Promise<void> {
      try {
        const settings = await getRuntimeLaunchSettings();
        if (!cancelled) {
          hydrateFromLaunchSettings(settings);
        }
      } catch {
        // Keep safe defaults until diagnostics or a later retry refreshes the persisted settings.
      }
    }

    void loadLaunchSettings();
    return () => {
      cancelled = true;
    };
  }, [hydrateFromLaunchSettings]);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const latest = await getRuntimeState();
        if (!cancelled) {
          const previousStatus = lastRuntimeStatusRef.current;
          const previousError = lastRuntimeErrorRef.current;
          setRuntime(latest);
          lastRuntimeStatusRef.current = latest.status;
          lastRuntimeErrorRef.current = latest.error;
          if (
            latest.status === "error" &&
            (previousStatus === "running" || previousStatus === "starting") &&
            latest.error !== previousError
          ) {
            setDetailTab("diagnostics");
            setNotice({
              kind: "error",
              message: latest.logFile
                ? `${latest.error ?? "Runtime failed unexpectedly."} Log: ${latest.logFile}`
                : (latest.error ?? "Runtime failed unexpectedly."),
            });
          }
        }
        const diagnostics = await getDiagnosticsSnapshot();
        if (!cancelled) {
          setSnapshot(diagnostics);
        }
      } catch {
        // Polling is best-effort; runtime controls surface explicit failures.
      }
    }

    const id = window.setInterval(() => void poll(), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [setDetailTab, setNotice, setRuntime, setSnapshot]);

  const importSelectedModelPath = useCallback(async (selected: string) => {
    const normalizedPath = selected.trim();
    if (!normalizedPath.toLowerCase().endsWith(".gguf")) {
      throw new Error("Select a .gguf model file.");
    }
    const mustRestartRuntime =
      runtime.status === "running" || runtime.status === "starting";
    if (mustRestartRuntime) {
      const latest = await stopRuntime();
      setRuntime(latest);
    }
    const imported = await importModel({ path: normalizedPath });
    const active = await setActiveModel(imported.id);
    const latestModels = await refreshModelLibrary();
    await syncDiagnosticsSnapshot();
    setNotice({
      kind: "info",
      message: mustRestartRuntime
        ? `Model ready: ${active.name}. Runtime stopped; start again to load it.`
        : `Model ready: ${active.name}`,
    });
    return latestModels.find((model) => model.id === active.id) ?? active;
  }, [
    refreshModelLibrary,
    runtime.status,
    setNotice,
    setRuntime,
    syncDiagnosticsSnapshot,
  ]);

  const importModelFile = useCallback(async () => {
    if (importingModel) {
      return;
    }
    setImportingModel(true);
    try {
      const selected = await open({
        multiple: false,
        directory: false,
      });
      if (typeof selected !== "string") {
        return;
      }
      await importSelectedModelPath(selected);
    } catch (error) {
      await surfaceRuntimeFailure(error, "Model import");
    } finally {
      setImportingModel(false);
    }
  }, [
    importSelectedModelPath,
    importingModel,
    setImportingModel,
    surfaceRuntimeFailure,
  ]);

  const importModelPath = useCallback(
    async (path: string) => {
      if (importingModel) {
        return null;
      }
      setImportingModel(true);
      try {
        return await importSelectedModelPath(path);
      } catch (error) {
        await surfaceRuntimeFailure(error, "Model import");
        return null;
      } finally {
        setImportingModel(false);
      }
    },
    [importSelectedModelPath, importingModel, setImportingModel, surfaceRuntimeFailure],
  );

  const downloadModelFromUrl = useCallback(
    async (url: string, name?: string, sha256?: string) => {
      if (downloadingModel) {
        return null;
      }
      setDownloadingModel(true);
      setModelDownloadProgress(null);
      try {
        const mustRestartRuntime =
          runtime.status === "running" || runtime.status === "starting";
        if (mustRestartRuntime) {
          const latest = await stopRuntime();
          setRuntime(latest);
        }
        const downloaded = await downloadModel({ url, name, sha256 });
        const active = downloaded.isActive ? downloaded : await setActiveModel(downloaded.id);
        const latestModels = await refreshModelLibrary();
        await syncDiagnosticsSnapshot();
        setNotice({
          kind: "info",
          message: mustRestartRuntime
            ? `Model ready: ${active.name}. Runtime stopped; start again to load it.`
            : `Model ready: ${active.name}`,
        });
        return latestModels.find((model) => model.id === active.id) ?? active;
      } catch (error) {
        await surfaceRuntimeFailure(error, "Model download");
        return null;
      } finally {
        setDownloadingModel(false);
      }
    },
    [
      downloadingModel,
      refreshModelLibrary,
      runtime.status,
      setDownloadingModel,
      setModelDownloadProgress,
      setNotice,
      setRuntime,
      syncDiagnosticsSnapshot,
      surfaceRuntimeFailure,
    ],
  );

  const activateModel = useCallback(
    async (modelId: string) => {
      try {
        const mustRestartRuntime =
          runtime.status === "running" || runtime.status === "starting";
        if (mustRestartRuntime) {
          const latest = await stopRuntime();
          setRuntime(latest);
        }
        const active = await setActiveModel(modelId);
        setModels((prev) =>
          prev
            .map((model) => (model.id === active.id ? active : { ...model, isActive: false }))
            .sort(
              (a, b) =>
                new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
            ),
        );
        await refreshModelLibrary();
        await syncDiagnosticsSnapshot();
        setNotice({
          kind: "info",
          message: mustRestartRuntime
            ? `Active model: ${active.name}. Runtime stopped; start again to load it.`
            : `Active model: ${active.name}`,
        });
      } catch (error) {
        await surfaceRuntimeFailure(error, "Model activation");
      }
    },
    [
      refreshModelLibrary,
      runtime.status,
      setModels,
      setNotice,
      setRuntime,
      syncDiagnosticsSnapshot,
      surfaceRuntimeFailure,
    ],
  );

  const startSelectedRuntime = useCallback(async (reason: "manual" | "auto" = "manual") => {
    if (!activeModel) {
      setNotice({ kind: "error", message: "Import/select a model first." });
      return;
    }
    manualStopRequestedRef.current = false;
    setStartingRuntime(true);
    setRuntime({
      ...runtime,
      status: "starting",
      activeModelId: activeModel.id,
      error: undefined,
    });
    setNotice({
      kind: "info",
      message:
        reason === "auto"
          ? `Preparing ${activeModel.name}. Glee is choosing the best local runtime automatically.`
          : `Starting runtime for ${activeModel.name}. Large models can take a minute before chat is ready.`,
    });
    try {
      const latest = await startRuntime({
        modelId: activeModel.id,
      });
      setRuntime(latest);
      await syncDiagnosticsSnapshot();
      setNotice({
        kind: "info",
        message: reason === "auto" ? "Local model ready." : "Runtime started.",
      });
    } catch (error) {
      await surfaceRuntimeFailure(error, "Runtime start");
    } finally {
      setStartingRuntime(false);
    }
  }, [
    activeModel,
    runtime,
    setNotice,
    setRuntime,
    setStartingRuntime,
    syncDiagnosticsSnapshot,
    surfaceRuntimeFailure,
  ]);

  useEffect(() => {
    if (!activeModel) {
      return;
    }
    if (manualStopRequestedRef.current) {
      return;
    }
    if (runtime.status !== "stopped" || startingRuntime || stoppingRuntime) {
      return;
    }
    if (autoStartAttemptedModelIdRef.current === activeModel.id) {
      return;
    }

    autoStartAttemptedModelIdRef.current = activeModel.id;
    void startSelectedRuntime("auto");
  }, [
    activeModel,
    runtime.status,
    startSelectedRuntime,
    startingRuntime,
    stoppingRuntime,
  ]);

  const stopSelectedRuntime = useCallback(async () => {
    manualStopRequestedRef.current = true;
    setStoppingRuntime(true);
    try {
      const latest = await stopRuntime();
      setRuntime(latest);
      await syncDiagnosticsSnapshot();
      setNotice({ kind: "info", message: "Runtime stopped." });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    } finally {
      setStoppingRuntime(false);
    }
  }, [setNotice, setRuntime, setStoppingRuntime, syncDiagnosticsSnapshot]);

  const setWarmupEnabled = useCallback(
    async (warmupEnabled: boolean) => {
      try {
        await saveRuntimeLaunchSettings({ warmupEnabled });
      } catch (error) {
        setNotice({
          kind: "error",
          message: `Saving runtime warmup setting failed. ${normalizeError(error)}`,
        });
      }
    },
    [saveRuntimeLaunchSettings, setNotice],
  );

  const setPerformanceMode = useCallback(
    async (performanceMode: RuntimePerformanceMode) => {
      try {
        await saveRuntimeLaunchSettings({ performanceMode });
      } catch (error) {
        setNotice({
          kind: "error",
          message: `Saving runtime performance mode failed. ${normalizeError(error)}`,
        });
      }
    },
    [saveRuntimeLaunchSettings, setNotice],
  );

  const setGpuLayers = useCallback(
    async (gpuLayers: number) => {
      try {
        await saveRuntimeLaunchSettings({ gpuLayers });
      } catch (error) {
        setNotice({
          kind: "error",
          message: `Saving GPU offload setting failed. ${normalizeError(error)}`,
        });
      }
    },
    [saveRuntimeLaunchSettings, setNotice],
  );

  const cancelModelDownloadRequest = useCallback(async () => {
    try {
      const cancelled = await cancelModelDownload();
      if (cancelled) {
        setNotice({ kind: "info", message: "Model download cancellation requested." });
      }
    } catch (error) {
      setNotice({
        kind: "error",
        message: `Cancelling model download failed. ${normalizeError(error)}`,
      });
    }
  }, [setNotice]);

  return {
    activeModel,
    runtime,
    importingModel,
    downloadingModel,
    startingRuntime,
    stoppingRuntime,
    runtimeSettings,
    setWarmupEnabled,
    setPerformanceMode,
    setGpuLayers,
    recommendedModel,
    importModelFile,
    importModelPath,
    downloadModelFromUrl,
    cancelModelDownload: cancelModelDownloadRequest,
    refreshModelLibrary,
    activateModel,
    startSelectedRuntime,
    stopSelectedRuntime,
  };
}
