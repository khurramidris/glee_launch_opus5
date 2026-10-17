import { create } from "zustand";
import {
  cancelUpdateDownload,
  checkForUpdate,
  downloadUpdate,
  getUpdateSettings,
  installUpdate,
  setUpdateSettings,
  skipUpdateVersion,
  type UpdateDownloadProgress,
  type UpdateInfo,
  type UpdateSettings,
} from "../api/updates";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

interface UpdateState {
  status: UpdateStatus;
  /** Result of the latest successful check; `available` says whether it is newer. */
  info: UpdateInfo | null;
  progress: UpdateDownloadProgress | null;
  error: string | null;
  settings: UpdateSettings | null;
  /** Epoch milliseconds of the last successful check. */
  lastCheckedAt: number | null;
  installerPath: string | null;
  /** Version the user chose "Remind me later" for during this session. */
  dismissedVersion: string | null;
  /** Set when an install asked the app to quit (Windows installer). */
  quitRequested: boolean;

  loadSettings: () => Promise<void>;
  setAutoCheck: (enabled: boolean) => Promise<void>;
  check: (manual?: boolean) => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
  dismiss: () => void;
  cancel: () => Promise<void>;
  applyProgress: (progress: UpdateDownloadProgress) => void;
}

function describeError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong while updating. Please try again.";
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: "idle",
  info: null,
  progress: null,
  error: null,
  settings: null,
  lastCheckedAt: null,
  installerPath: null,
  dismissedVersion: null,
  quitRequested: false,

  async loadSettings() {
    try {
      set({ settings: await getUpdateSettings() });
    } catch {
      // Settings are optional; defaults apply.
    }
  },

  async setAutoCheck(enabled) {
    try {
      set({ settings: await setUpdateSettings({ autoCheck: enabled }) });
    } catch (error) {
      set({ error: describeError(error) });
    }
  },

  async check(manual = false) {
    const { status, settings } = get();
    if (status === "checking" || status === "downloading" || status === "installing") return;
    if (!manual && settings && (!settings.autoCheck || !settings.updatesEnabled)) return;
    const previous = { status, error: get().error };
    set({ status: "checking", error: null, ...(manual ? { dismissedVersion: null } : {}) });
    try {
      const info = await checkForUpdate(manual);
      const sameReadyVersion =
        previous.status === "ready" && get().info?.latestVersion === info.latestVersion;
      set({
        info,
        lastCheckedAt: Date.now(),
        status: sameReadyVersion ? "ready" : info.available ? "available" : "idle",
        ...(sameReadyVersion ? {} : { progress: null, installerPath: null }),
      });
    } catch (error) {
      // Offline or GitHub unreachable: stay quiet unless the user asked.
      if (manual) {
        set({ status: "error", error: describeError(error) });
      } else {
        set({ status: previous.status === "error" ? "idle" : previous.status, error: previous.error });
      }
    }
  },

  async download() {
    const { info, status } = get();
    if (!info?.available || !info.asset) return;
    if (status === "downloading" || status === "installing") return;
    set({
      status: "downloading",
      error: null,
      progress: { downloadedBytes: 0, totalBytes: info.asset.sizeBytes, phase: "downloading" },
    });
    try {
      const path = await downloadUpdate();
      set({ status: "ready", installerPath: path });
    } catch (error) {
      // A user-initiated cancel moves back to "available" in cancel().
      if (get().status === "downloading") {
        set({ status: "error", error: describeError(error), progress: null });
      }
    }
  },

  async install() {
    const { installerPath, status } = get();
    if (!installerPath || status === "installing") return;
    set({ status: "installing", error: null });
    try {
      const outcome = await installUpdate(installerPath);
      set({ status: "ready", quitRequested: outcome.shouldQuit });
    } catch (error) {
      set({ status: "error", error: describeError(error), installerPath: null });
    }
  },

  async skip() {
    const { info } = get();
    if (!info || info.mandatory) return;
    try {
      set({ settings: await skipUpdateVersion(info.latestVersion) });
    } catch {
      // The banner is still dismissed for this session below.
    }
    set({ status: "idle", progress: null, dismissedVersion: info.latestVersion });
  },

  dismiss() {
    const { info } = get();
    if (!info || info.mandatory) return;
    set({ dismissedVersion: info.latestVersion });
  },

  async cancel() {
    if (get().status !== "downloading") return;
    set({ status: "available", progress: null, error: null });
    try {
      await cancelUpdateDownload();
    } catch {
      // Nothing to cancel.
    }
  },

  applyProgress(progress) {
    if (get().status !== "downloading") return;
    set({ progress });
  },
}));

export const updateStore = useUpdateStore;

export const UPDATE_STARTUP_DELAY_MS = 20_000;
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_FOCUS_MIN_GAP_MS = 6 * 60 * 60 * 1000;

/** Whether a window-focus event should trigger a background check. */
export function shouldCheckOnFocus(
  now: number,
  lastCheckedAt: number | null,
  autoCheck: boolean,
  status: UpdateStatus,
): boolean {
  if (!autoCheck) return false;
  if (status === "checking" || status === "downloading" || status === "installing") return false;
  return lastCheckedAt === null || now - lastCheckedAt >= UPDATE_FOCUS_MIN_GAP_MS;
}

/** The banner shows for available updates (and in-flight installs) the user has not dismissed. */
export function isBannerVisible(
  state: Pick<UpdateState, "status" | "info" | "dismissedVersion">,
): boolean {
  const { status, info, dismissedVersion } = state;
  if (!info?.available || status === "idle") return false;
  if (info.mandatory) return true;
  if (status === "available" || status === "checking") return dismissedVersion !== info.latestVersion;
  return true;
}
