import type {
  AppSettingEntry,
  DiagnosticsSnapshot,
  HealthCheckRecord,
  HealthCheckStatus,
  IndexingHealthStatus,
  RuntimePerformanceMode,
  RuntimeState,
} from "../../types";

export interface RuntimeRecoveryPlan {
  headline: string;
  message: string;
  steps: string[];
  supportSummary: string;
}

export function countHealthChecks(
  checks: HealthCheckRecord[],
): Record<HealthCheckStatus, number> {
  return checks.reduce(
    (counts, check) => {
      counts[check.status] += 1;
      return counts;
    },
    { ok: 0, warn: 0, error: 0 } as Record<HealthCheckStatus, number>,
  );
}

export function formatHealthStatus(status: HealthCheckStatus): string {
  if (status === "ok") {
    return "Healthy";
  }
  if (status === "warn") {
    return "Warning";
  }
  return "Error";
}

export function formatIndexingStatus(status: IndexingHealthStatus): string {
  if (status === "healthy") {
    return "Healthy";
  }
  if (status === "pending") {
    return "Indexing";
  }
  if (status === "degraded") {
    return "Degraded";
  }
  return "Unavailable";
}

export function buildRuntimeRecoveryMessage(runtime: RuntimeState): string {
  if (runtime.status === "running") {
    return "Runtime is healthy.";
  }
  if (runtime.status === "starting") {
    return "Runtime is starting. Wait for readiness before sending messages.";
  }
  if (runtime.status === "error") {
    if (runtime.error?.trim()) {
      const suffix =
        runtime.logFile && !runtime.error.includes(runtime.logFile)
          ? ` Check runtime log: ${runtime.logFile}`
          : "";
      return `${runtime.error}${suffix}`;
    }
    const suffix = runtime.logFile ? ` Check runtime log: ${runtime.logFile}` : "";
    return `Runtime failed. Retry start after checking the active model and runtime binary.${suffix}`;
  }
  return "Runtime is stopped. Start it after selecting a valid model.";
}

function compactWhitespace(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized ? normalized : undefined;
}

function dedupeSteps(steps: string[]): string[] {
  return [...new Set(steps.map((step) => step.trim()).filter(Boolean))];
}

const RUNTIME_PERFORMANCE_MODE_SETTING_KEYS = [
  "runtime.performance.mode",
  "runtime_performance_mode",
] as const;
const RUNTIME_GPU_LAYERS_SETTING_KEYS = [
  "runtime.gpu.layers",
  "runtime_gpu_layers",
] as const;

function findSettingValue(
  settings: AppSettingEntry[],
  keys: readonly string[],
): string | undefined {
  return settings.find((setting) => keys.includes(setting.key))?.value;
}

function parseRuntimePerformanceMode(
  value: string | undefined,
): RuntimePerformanceMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "auto" || normalized === "cpu" || normalized === "gpu") {
    return normalized;
  }
  return undefined;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(0, Math.floor(parsed));
}

export function formatRuntimePerformanceMode(
  mode: RuntimePerformanceMode,
  gpuLayers?: number,
): string {
  if (mode === "cpu") {
    return "CPU";
  }
  if (mode === "gpu") {
    return gpuLayers && gpuLayers > 0 ? `GPU (${gpuLayers} layers)` : "GPU";
  }
  return "Auto";
}

export function summarizeRuntimePerformanceSettings(
  snapshot: DiagnosticsSnapshot | null,
): string | undefined {
  if (!snapshot) {
    return undefined;
  }

  const gpuLayers = parseNonNegativeInteger(
    findSettingValue(snapshot.settings, RUNTIME_GPU_LAYERS_SETTING_KEYS),
  );
  const mode =
    parseRuntimePerformanceMode(
      findSettingValue(snapshot.settings, RUNTIME_PERFORMANCE_MODE_SETTING_KEYS),
    ) ?? (gpuLayers && gpuLayers > 0 ? "gpu" : undefined);

  return mode ? formatRuntimePerformanceMode(mode, gpuLayers) : undefined;
}

function summarizeRuntimeSelection(runtime: RuntimeState): string | undefined {
  const selection = runtime.selection;
  if (!selection) {
    return undefined;
  }
  const backend = selection.backend.toUpperCase();
  const requested =
    selection.requestedGpuLayers > 0
      ? `requested ${selection.requestedGpuLayers} GPU layers`
      : selection.requestedGpuLayers < 0
        ? "automatic GPU offload"
        : "CPU execution";
  const actual =
    selection.actualGpuLayers === undefined
      ? ""
      : `, actual ${selection.actualGpuLayers}`;
  const fallback = selection.fallbackReason
    ? `; ${selection.fallbackReason}`
    : "";

  return `${backend} (${requested}${actual})${fallback}`;
}

function runtimeIssueHeadline(
  runtime: RuntimeState,
  snapshot: DiagnosticsSnapshot | null,
  activeModelName?: string,
): { headline: string; message: string; steps: string[] } {
  if (runtime.status === "running") {
    return {
      headline: "Runtime is healthy",
      message: "The local runtime is up and ready for replies.",
      steps: [],
    };
  }

  if (runtime.status === "starting") {
    return {
      headline: "Runtime is still starting",
      message: "Wait for the health check to finish before sending a message.",
      steps: [
        "Give the local model a little longer to finish loading.",
        "If startup stalls or fails, open Diagnostics and export a bundle before retrying.",
      ],
    };
  }

  if (!activeModelName) {
    return {
      headline: "No active model is ready",
      message: "Glee cannot start the runtime until a valid GGUF model is imported and selected.",
      steps: [
        "Import a GGUF model or choose a different model in Settings.",
        "Start the runtime again after selecting the model.",
        "If model import keeps failing, export diagnostics and attach the bundle when reporting the beta issue.",
      ],
    };
  }

  if (runtime.status === "stopped") {
    return {
      headline: "Runtime is stopped",
      message: "The active model is selected, but the local runtime is not running yet.",
      steps: [
        "Start the runtime once before sending messages.",
        "If startup fails, open Diagnostics and export a bundle before retrying.",
      ],
    };
  }

  const errorText = compactWhitespace(runtime.error)?.toLowerCase() ?? "";
  const priorityCheck = highestPriorityHealthCheck(snapshot);
  const priorityDetail =
    priorityCheck && priorityCheck.status !== "ok"
      ? `${priorityCheck.label}: ${priorityCheck.detail}`
      : undefined;

  if (
    errorText.includes("model path is invalid") ||
    errorText.includes("active model path") ||
    errorText.includes(".gguf")
  ) {
    return {
      headline: "Selected model is missing or invalid",
      message:
        "The active GGUF file could not be opened. Pick a different model or re-import the one you want to use.",
      steps: dedupeSteps([
        "Open Settings and switch to another imported model, or re-import the GGUF file.",
        "Start the runtime again after the model path is valid.",
        priorityDetail ?? "",
        "If the same model keeps failing, export diagnostics and attach the bundle when reporting the issue.",
      ]),
    };
  }

  if (
    errorText.includes("failed to spawn") ||
    errorText.includes("runtime binary") ||
    errorText.includes("llama-server process handle is missing")
  ) {
    return {
      headline: "Runtime binary could not launch",
      message:
        "Glee could not start the bundled or configured llama.cpp runtime binary.",
      steps: dedupeSteps([
        "Check Diagnostics to confirm the runtime binary path is present and valid.",
        "Retry startup once after verifying the runtime binary exists.",
        priorityDetail ?? "",
        "If startup still cannot launch the binary, export diagnostics and report the issue with the bundle attached.",
      ]),
    };
  }

  if (errorText.includes("timed out") || errorText.includes("/health")) {
    return {
      headline: "Runtime did not become ready in time",
      message:
        "The local runtime launched, but it did not pass its health check before the startup timeout.",
      steps: dedupeSteps([
        "Retry startup once in case the previous launch was transient.",
        "If this keeps happening, switch to a smaller or known-good GGUF model.",
        runtime.logFile ? `Check the runtime log at ${runtime.logFile}.` : "",
        priorityDetail ?? "",
        "If the timeout repeats, export diagnostics and attach the bundle when reporting the issue.",
      ]),
    };
  }

  if (
    errorText.includes("exited") ||
    errorText.includes("exit status") ||
    errorText.includes("crash")
  ) {
    return {
      headline: "Runtime exited before it was ready",
      message:
        "The local runtime started and then exited. This is usually a model/runtime mismatch or another local environment failure.",
      steps: dedupeSteps([
        "Retry startup once to rule out a transient launch failure.",
        "If it exits again, try a different imported model.",
        runtime.logFile ? `Check the runtime log at ${runtime.logFile}.` : "",
        priorityDetail ?? "",
        "Export diagnostics and attach the bundle when reporting the issue if the crash repeats.",
      ]),
    };
  }

  return {
    headline: "Runtime start failed",
    message:
      "Glee could not bring the local runtime into a healthy state. Use Diagnostics to confirm what failed before retrying.",
    steps: dedupeSteps([
      "Open Diagnostics and inspect the top health warning or error.",
      "Retry startup after checking the active model and runtime binary.",
      priorityDetail ?? "",
      "If the failure repeats, export diagnostics and attach the bundle when reporting the issue.",
    ]),
  };
}

export function buildRuntimeSupportSummary(
  runtime: RuntimeState,
  snapshot: DiagnosticsSnapshot | null,
  activeModelName?: string,
): string {
  const priorityCheck = highestPriorityHealthCheck(snapshot);
  const lines = [
    `Glee version: ${snapshot?.appVersion ?? "unknown"}`,
    `Platform: ${snapshot?.platform ?? "unknown"}`,
    `Runtime status: ${runtime.status}`,
    `Active model: ${activeModelName ?? "not selected"}`,
  ];
  const performanceSettings =
    summarizeRuntimeSelection(runtime) ?? summarizeRuntimePerformanceSettings(snapshot);
  if (performanceSettings) {
    lines.push(`Runtime performance: ${performanceSettings}`);
  }

  const compactError = compactWhitespace(runtime.error);
  if (compactError) {
    lines.push(`Runtime error: ${compactError}`);
  }
  if (runtime.logFile) {
    lines.push(`Runtime log: ${runtime.logFile}`);
  }
  if (priorityCheck && priorityCheck.status !== "ok") {
    lines.push(`Top health issue: ${priorityCheck.label} - ${priorityCheck.detail}`);
  }

  return lines.join("\n");
}

export function buildRuntimeRecoveryPlan(
  runtime: RuntimeState,
  snapshot: DiagnosticsSnapshot | null,
  activeModelName?: string,
): RuntimeRecoveryPlan {
  const issue = runtimeIssueHeadline(runtime, snapshot, activeModelName);
  return {
    headline: issue.headline,
    message: issue.message,
    steps: issue.steps,
    supportSummary: buildRuntimeSupportSummary(runtime, snapshot, activeModelName),
  };
}

export function highestPriorityHealthCheck(
  snapshot: DiagnosticsSnapshot | null,
): HealthCheckRecord | undefined {
  if (!snapshot) {
    return undefined;
  }
  return (
    snapshot.startup.checks.find((check) => check.required && check.status === "error") ??
    snapshot.startup.checks.find((check) => check.status === "error") ??
    snapshot.startup.checks.find((check) => check.status === "warn")
  );
}

export function summarizeDiagnostics(snapshot: DiagnosticsSnapshot | null): string {
  if (!snapshot) {
    return "Diagnostics unavailable.";
  }
  const counts = countHealthChecks(snapshot.startup.checks);
  return `${counts.ok} healthy, ${counts.warn} warnings, ${counts.error} errors`;
}
