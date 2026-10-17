import { describe, expect, it } from "vitest";
import type { DiagnosticsSnapshot, RuntimeState } from "../../types";
import {
  buildRuntimeRecoveryMessage,
  buildRuntimeRecoveryPlan,
  buildRuntimeSupportSummary,
  countHealthChecks,
  formatRuntimePerformanceMode,
  formatHealthStatus,
  formatIndexingStatus,
  highestPriorityHealthCheck,
  summarizeRuntimePerformanceSettings,
  summarizeDiagnostics,
} from "./diagnostics-domain";

const runtime: RuntimeState = {
  status: "error",
  endpoint: "http://127.0.0.1:8080",
  logFile: "D:/logs/llama.log",
  error: "llama-server exited",
};

const snapshot: DiagnosticsSnapshot = {
  appVersion: "0.1.0",
  platform: "windows-x64",
  runtime,
  startup: {
    checkedAt: "2026-03-09T00:00:00.000Z",
    overallStatus: "warn",
    appDataDir: "D:/data",
    databasePath: "D:/data/glee.sqlite3",
    backupDir: "D:/data/backups",
    runtimeBinaryPath: "D:/runtime/llama-server.exe",
    sqliteVecAvailable: false,
    embeddingAvailable: true,
    indexing: {
      status: "degraded",
      updatedAt: "2026-03-09T00:00:00.000Z",
      lastError: "sqlite-vec missing",
    },
    checks: [
      {
        key: "db",
        label: "Database",
        status: "ok",
        detail: "ready",
        required: true,
        recoverable: true,
      },
      {
        key: "vec",
        label: "sqlite-vec",
        status: "warn",
        detail: "missing",
        required: false,
        recoverable: true,
      },
    ],
  },
  settings: [
    {
      key: "runtime_performance_mode",
      value: "gpu",
      updatedAt: "2026-03-09T00:00:00.000Z",
    },
    {
      key: "runtime_gpu_layers",
      value: "18",
      updatedAt: "2026-03-09T00:00:00.000Z",
    },
  ],
  featureExposure: {
    stable: ["memory"],
    labs: ["semantic vector retrieval"],
  },
  recentErrors: ["Runtime: llama-server exited"],
};

describe("diagnostics-domain", () => {
  it("counts and formats health states", () => {
    expect(countHealthChecks(snapshot.startup.checks)).toEqual({ ok: 1, warn: 1, error: 0 });
    expect(formatHealthStatus("ok")).toBe("Healthy");
    expect(formatHealthStatus("warn")).toBe("Warning");
    expect(formatHealthStatus("error")).toBe("Error");
    expect(formatIndexingStatus("pending")).toBe("Indexing");
  });

  it("builds actionable runtime recovery copy", () => {
    const message = buildRuntimeRecoveryMessage(runtime);
    expect(message).toContain("llama-server exited");
    expect(message).toContain("llama.log");
  });

  it("builds a runtime recovery plan with steps and support summary", () => {
    const plan = buildRuntimeRecoveryPlan(runtime, snapshot, "Phi");
    expect(plan.headline).toContain("exited");
    expect(plan.steps.some((step) => step.includes("different imported model"))).toBe(true);
    expect(plan.supportSummary).toContain("Glee version: 0.1.0");
    expect(plan.supportSummary).toContain("Active model: Phi");
    expect(plan.supportSummary).toContain("Runtime performance: GPU (18 layers)");
  });

  it("prefers actual runtime selection over configured performance settings", () => {
    const summary = buildRuntimeSupportSummary(
      {
        ...runtime,
        selection: {
          performanceMode: "gpu",
          backend: "cpu",
          attemptedBackend: "cuda",
          binaryPath: "D:/runtime/cpu/llama-server.exe",
          requestedGpuLayers: 0,
          actualGpuLayers: 0,
          fallbackReason: "GPU runtime startup failed; fell back to CPU.",
          detectedGpus: [],
        },
      },
      snapshot,
      "Phi",
    );

    expect(summary).toContain("Runtime performance: CPU (CPU execution, actual 0)");
    expect(summary).toContain("fell back to CPU");
  });

  it("reports active MTP speculative decoding", () => {
    const summary = buildRuntimeSupportSummary(
      {
        ...runtime,
        selection: {
          performanceMode: "cpu",
          backend: "cpu",
          binaryPath: "D:/runtime/cpu/llama-server.exe",
          runtimeVersion: "b9587",
          requestedGpuLayers: 0,
          detectedGpus: [],
        },
      },
      snapshot,
      "Ternary Bonsai 2 4B",
    );

    expect(summary).toContain("CPU execution");
  });

  it("builds support summary without optional fields", () => {
    const summary = buildRuntimeSupportSummary(
      { status: "stopped", endpoint: "http://127.0.0.1:8080" },
      null,
      undefined,
    );
    expect(summary).toContain("Runtime status: stopped");
    expect(summary).toContain("Active model: not selected");
  });

  it("summarizes runtime performance settings for support", () => {
    expect(formatRuntimePerformanceMode("auto")).toBe("Auto");
    expect(summarizeRuntimePerformanceSettings(snapshot)).toBe("GPU (18 layers)");
  });

  it("finds the highest-priority failing check", () => {
    expect(highestPriorityHealthCheck(snapshot)?.label).toBe("sqlite-vec");
    expect(summarizeDiagnostics(snapshot)).toBe("1 healthy, 1 warnings, 0 errors");
  });

  it("does not label a healthy check as a priority issue", () => {
    const healthySnapshot = {
      ...snapshot,
      startup: {
        ...snapshot.startup,
        checks: snapshot.startup.checks.map((check) => ({
          ...check,
          status: "ok" as const,
        })),
      },
    };

    expect(highestPriorityHealthCheck(healthySnapshot)).toBeUndefined();
    expect(summarizeDiagnostics(healthySnapshot)).toBe(
      "2 healthy, 0 warnings, 0 errors",
    );
  });
});
