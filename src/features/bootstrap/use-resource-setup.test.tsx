// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceStatus } from "../../types";

const mocks = vi.hoisted(() => ({
  resourceStatus: vi.fn(),
  prepareFirstRunResources: vi.fn(),
  cancelFirstRunProvisioning: vi.fn(),
}));

vi.mock("../../api/tauri", () => mocks);
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { useResourceSetup } from "./use-resource-setup";

function status(overrides: Partial<ResourceStatus>): ResourceStatus {
  return {
    ready: false,
    platform: "windows-x64",
    platformSupported: true,
    missingRequiredBytes: 1_000,
    partialRequiredBytes: 400,
    items: [],
    ...overrides,
  };
}

describe("useResourceSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports an interrupted download and finishes it on request", async () => {
    mocks.resourceStatus
      .mockResolvedValueOnce(status({}))
      .mockResolvedValue(status({ ready: true, missingRequiredBytes: 0, partialRequiredBytes: 0 }));
    mocks.prepareFirstRunResources.mockResolvedValue({});
    const onInstalled = vi.fn();
    const { result } = renderHook(() => useResourceSetup(onInstalled));

    await waitFor(() => expect(result.current.needsSetup).toBe(true));
    expect(result.current.partialBytes).toBe(400);

    await act(async () => {
      await result.current.start();
    });
    expect(mocks.prepareFirstRunResources).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(result.current.needsSetup).toBe(false);
    expect(result.current.running).toBe(false);
  });

  it("keeps the partial download and shows a friendly error when the network drops", async () => {
    mocks.resourceStatus.mockResolvedValue(status({}));
    mocks.prepareFirstRunResources.mockRejectedValue(
      new Error("Glee couldn't download a file it needs (model). Check your internet connection. Details: timeout"),
    );
    const onInstalled = vi.fn();
    const { result } = renderHook(() => useResourceSetup(onInstalled));
    await waitFor(() => expect(result.current.needsSetup).toBe(true));

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toBe(
      "Glee couldn't download a file it needs (model). Check your internet connection.",
    );
    expect(result.current.needsSetup).toBe(true);
    expect(onInstalled).not.toHaveBeenCalled();
  });
});
