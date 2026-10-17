import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// All update traffic happens in Rust (src-tauri/src/updates.rs). If the app
// later moves to tauri-plugin-updater, only this file has to change.

export interface UpdateAssetInfo {
  fileName: string;
  sizeBytes: number;
}

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  notes: string;
  pageUrl: string;
  asset: UpdateAssetInfo | null;
  releaseDate: string | null;
  /** The running version is older than the release's minimum supported version. */
  mandatory: boolean;
  /** A newer release exists but the user chose to skip it. */
  skipped: boolean;
}

export interface UpdateSettings {
  autoCheck: boolean;
  skippedVersion: string | null;
  currentVersion: string;
  /** False in builds without an update source (development). */
  updatesEnabled: boolean;
}

export interface UpdateDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  phase: "downloading" | "verifying" | "done" | "cancelled";
}

export interface InstallOutcome {
  shouldQuit: boolean;
}

export const UPDATE_PROGRESS_EVENT = "update-download-progress";

export function checkForUpdate(manual: boolean): Promise<UpdateInfo> {
  return invoke<UpdateInfo>("check_for_update", { manual });
}

/** Downloads and verifies the installer; resolves with its path on disk. */
export function downloadUpdate(): Promise<string> {
  return invoke<string>("download_update");
}

export function cancelUpdateDownload(): Promise<boolean> {
  return invoke<boolean>("cancel_update_download");
}

export function installUpdate(path: string): Promise<InstallOutcome> {
  return invoke<InstallOutcome>("install_update", { path });
}

export function skipUpdateVersion(version: string): Promise<UpdateSettings> {
  return invoke<UpdateSettings>("skip_update_version", { version });
}

export function getUpdateSettings(): Promise<UpdateSettings> {
  return invoke<UpdateSettings>("get_update_settings");
}

export function setUpdateSettings(input: { autoCheck?: boolean }): Promise<UpdateSettings> {
  return invoke<UpdateSettings>("set_update_settings", { input });
}

/** Resolves with an unsubscribe function. */
export function onUpdateDownloadProgress(
  handler: (progress: UpdateDownloadProgress) => void,
): Promise<() => void> {
  return listen<UpdateDownloadProgress>(UPDATE_PROGRESS_EVENT, (event) => handler(event.payload));
}
