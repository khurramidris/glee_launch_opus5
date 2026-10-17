import { describe, expect, it } from "vitest";
import {
  buildRuntimeStartArgs,
  parseRuntimeSettingsFromEntries,
  runtimeGpuLayersForMode,
  toStartupSettings,
} from "./runtime-settings-store";

describe("runtime-settings-store helpers", () => {
  it("builds runtime args without forcing no-warmup by default", () => {
    expect(
      buildRuntimeStartArgs({
        warmupEnabled: true,
        performanceMode: "auto",
        gpuLayers: 0,
      }),
    ).toEqual(["--ctx-size", "8192"]);
  });

  it("adds no-warmup and GPU layers only in GPU mode", () => {
    expect(
      buildRuntimeStartArgs({
        warmupEnabled: false,
        performanceMode: "gpu",
        gpuLayers: 12,
      }),
    ).toEqual(["--ctx-size", "8192", "--no-warmup", "-ngl", "12"]);

    expect(
      buildRuntimeStartArgs({
        warmupEnabled: false,
        performanceMode: "cpu",
        gpuLayers: 12,
      }),
    ).toEqual(["--ctx-size", "8192", "--no-warmup"]);
  });

  it("keeps manual GPU layers separate from the selected performance mode", () => {
    expect(
      runtimeGpuLayersForMode({
        warmupEnabled: true,
        performanceMode: "auto",
        gpuLayers: 24,
      }),
    ).toBe(0);
    expect(
      runtimeGpuLayersForMode({
        warmupEnabled: true,
        performanceMode: "gpu",
        gpuLayers: 24,
      }),
    ).toBe(24);
  });

  it("normalizes launch settings records into runtime startup settings", () => {
    expect(
      toStartupSettings({
        warmupEnabled: false,
        performanceMode: "gpu",
        gpuLayers: 24,
        updatedAt: "2026-04-06T00:00:00.000Z",
      }),
    ).toEqual({
      warmupEnabled: false,
      performanceMode: "gpu",
      gpuLayers: 24,
    });
  });

  it("parses diagnostics settings keys including legacy runtime keys", () => {
    expect(
      parseRuntimeSettingsFromEntries([
        {
          key: "runtime_warmup_enabled",
          value: "false",
          updatedAt: "2026-04-06T00:00:00.000Z",
        },
        {
          key: "runtime_performance_mode",
          value: "cpu",
          updatedAt: "2026-04-06T00:00:00.000Z",
        },
        {
          key: "runtime_gpu_layers",
          value: "18",
          updatedAt: "2026-04-06T00:00:00.000Z",
        },
      ]),
    ).toEqual({
      warmupEnabled: false,
      performanceMode: "cpu",
      gpuLayers: 18,
    });
  });
});
