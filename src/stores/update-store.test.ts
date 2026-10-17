import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateInfo, UpdateSettings } from "../api/updates";

const api = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  cancelUpdateDownload: vi.fn(),
  installUpdate: vi.fn(),
  skipUpdateVersion: vi.fn(),
  getUpdateSettings: vi.fn(),
  setUpdateSettings: vi.fn(),
}));
vi.mock("../api/updates", () => api);

import { isBannerVisible, shouldCheckOnFocus, useUpdateStore } from "./update-store";

const HOUR = 60 * 60 * 1000;

function info(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    available: true,
    currentVersion: "0.1.0",
    latestVersion: "0.2.0",
    notes: "- Faster replies",
    pageUrl: "https://github.com/example/glee/releases/tag/v0.2.0",
    asset: { fileName: "Glee_0.2.0_x64-setup.exe", sizeBytes: 1000 },
    releaseDate: "2000-01-01T00:00:00Z",
    mandatory: false,
    skipped: false,
    ...overrides,
  };
}

function settings(overrides: Partial<UpdateSettings> = {}): UpdateSettings {
  return { autoCheck: true, skippedVersion: null, currentVersion: "0.1.0", updatesEnabled: true, ...overrides };
}

function reset() {
  useUpdateStore.setState({
    status: "idle",
    info: null,
    progress: null,
    error: null,
    settings: null,
    lastCheckedAt: null,
    installerPath: null,
    dismissedVersion: null,
    quitRequested: false,
  });
}

describe("update store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  it("moves from checking to available when a newer version exists", async () => {
    api.checkForUpdate.mockResolvedValue(info());
    const pending = useUpdateStore.getState().check();
    expect(useUpdateStore.getState().status).toBe("checking");
    await pending;
    const state = useUpdateStore.getState();
    expect(state.status).toBe("available");
    expect(state.info?.latestVersion).toBe("0.2.0");
    expect(state.lastCheckedAt).not.toBeNull();
    expect(api.checkForUpdate).toHaveBeenCalledWith(false);
  });

  it("returns to idle when up to date", async () => {
    api.checkForUpdate.mockResolvedValue(info({ available: false, latestVersion: "0.1.0" }));
    await useUpdateStore.getState().check(true);
    expect(useUpdateStore.getState().status).toBe("idle");
    expect(api.checkForUpdate).toHaveBeenCalledWith(true);
  });

  it("stays silent when a background check fails but reports a manual failure", async () => {
    api.checkForUpdate.mockRejectedValue("The update server could not be reached.");
    await useUpdateStore.getState().check(false);
    expect(useUpdateStore.getState().status).toBe("idle");
    expect(useUpdateStore.getState().error).toBeNull();
    await useUpdateStore.getState().check(true);
    expect(useUpdateStore.getState().status).toBe("error");
    expect(useUpdateStore.getState().error).toBe("The update server could not be reached.");
  });

  it("does not run background checks when auto-check is off or updates are disabled", async () => {
    useUpdateStore.setState({ settings: settings({ autoCheck: false }) });
    await useUpdateStore.getState().check(false);
    useUpdateStore.setState({ settings: settings({ updatesEnabled: false }) });
    await useUpdateStore.getState().check(false);
    expect(api.checkForUpdate).not.toHaveBeenCalled();
    await useUpdateStore.getState().check(true);
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("downloads, then installs, and records a quit request", async () => {
    api.checkForUpdate.mockResolvedValue(info());
    api.downloadUpdate.mockResolvedValue("/downloads/Glee_0.2.0_x64-setup.exe");
    api.installUpdate.mockResolvedValue({ shouldQuit: true });
    await useUpdateStore.getState().check();
    const download = useUpdateStore.getState().download();
    expect(useUpdateStore.getState().status).toBe("downloading");
    expect(useUpdateStore.getState().progress?.totalBytes).toBe(1000);
    useUpdateStore.getState().applyProgress({ downloadedBytes: 400, totalBytes: 1000, phase: "downloading" });
    expect(useUpdateStore.getState().progress?.downloadedBytes).toBe(400);
    await download;
    expect(useUpdateStore.getState().status).toBe("ready");
    await useUpdateStore.getState().install();
    expect(api.installUpdate).toHaveBeenCalledWith("/downloads/Glee_0.2.0_x64-setup.exe");
    expect(useUpdateStore.getState().quitRequested).toBe(true);
    expect(useUpdateStore.getState().status).toBe("ready");
  });

  it("reports a failed download and lets the user retry", async () => {
    api.checkForUpdate.mockResolvedValue(info());
    api.downloadUpdate.mockRejectedValueOnce("The downloaded update failed its integrity check.");
    await useUpdateStore.getState().check();
    await useUpdateStore.getState().download();
    expect(useUpdateStore.getState().status).toBe("error");
    expect(useUpdateStore.getState().error).toContain("integrity");
    api.downloadUpdate.mockResolvedValueOnce("/downloads/x.exe");
    await useUpdateStore.getState().download();
    expect(useUpdateStore.getState().status).toBe("ready");
    expect(useUpdateStore.getState().error).toBeNull();
  });

  it("cancels a download without showing an error", async () => {
    api.checkForUpdate.mockResolvedValue(info());
    let rejectDownload: (reason: string) => void = () => undefined;
    api.downloadUpdate.mockReturnValue(new Promise((_, reject) => (rejectDownload = reject)));
    api.cancelUpdateDownload.mockResolvedValue(true);
    await useUpdateStore.getState().check();
    const download = useUpdateStore.getState().download();
    await useUpdateStore.getState().cancel();
    rejectDownload("The update download was cancelled.");
    await download;
    expect(useUpdateStore.getState().status).toBe("available");
    expect(useUpdateStore.getState().error).toBeNull();
    expect(api.cancelUpdateDownload).toHaveBeenCalled();
  });

  it("skips a version, but never a mandatory one", async () => {
    api.skipUpdateVersion.mockResolvedValue(settings({ skippedVersion: "0.2.0" }));
    useUpdateStore.setState({ status: "available", info: info({ mandatory: true }) });
    await useUpdateStore.getState().skip();
    expect(api.skipUpdateVersion).not.toHaveBeenCalled();
    useUpdateStore.getState().dismiss();
    expect(useUpdateStore.getState().dismissedVersion).toBeNull();

    useUpdateStore.setState({ status: "available", info: info() });
    await useUpdateStore.getState().skip();
    expect(api.skipUpdateVersion).toHaveBeenCalledWith("0.2.0");
    expect(useUpdateStore.getState().settings?.skippedVersion).toBe("0.2.0");
    expect(useUpdateStore.getState().status).toBe("idle");
  });

  it("remembers the auto-check preference", async () => {
    api.setUpdateSettings.mockResolvedValue(settings({ autoCheck: false }));
    await useUpdateStore.getState().setAutoCheck(false);
    expect(api.setUpdateSettings).toHaveBeenCalledWith({ autoCheck: false });
    expect(useUpdateStore.getState().settings?.autoCheck).toBe(false);
  });
});

describe("update scheduling and banner visibility", () => {
  it("checks on focus at most once every six hours", () => {
    const now = 100 * HOUR;
    expect(shouldCheckOnFocus(now, null, true, "idle")).toBe(true);
    expect(shouldCheckOnFocus(now, now - 5 * HOUR, true, "idle")).toBe(false);
    expect(shouldCheckOnFocus(now, now - 6 * HOUR, true, "idle")).toBe(true);
    expect(shouldCheckOnFocus(now, null, false, "idle")).toBe(false);
    expect(shouldCheckOnFocus(now, null, true, "downloading")).toBe(false);
  });

  it("hides dismissed updates unless they are mandatory or in progress", () => {
    const available = { status: "available" as const, info: info(), dismissedVersion: null };
    expect(isBannerVisible(available)).toBe(true);
    expect(isBannerVisible({ ...available, dismissedVersion: "0.2.0" })).toBe(false);
    expect(isBannerVisible({ ...available, dismissedVersion: "0.1.5" })).toBe(true);
    expect(isBannerVisible({ ...available, info: info({ mandatory: true }), dismissedVersion: "0.2.0" })).toBe(true);
    expect(isBannerVisible({ ...available, status: "downloading", dismissedVersion: "0.2.0" })).toBe(true);
    expect(isBannerVisible({ ...available, status: "idle" })).toBe(false);
    expect(isBannerVisible({ ...available, info: info({ available: false }) })).toBe(false);
  });
});
