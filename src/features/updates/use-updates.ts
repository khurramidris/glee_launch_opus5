import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onUpdateDownloadProgress } from "../../api/updates";
import {
  UPDATE_INTERVAL_MS,
  UPDATE_STARTUP_DELAY_MS,
  shouldCheckOnFocus,
  useUpdateStore,
} from "../../stores/update-store";

const QUIT_DELAY_MS = 1500;

/**
 * Starts the background update schedule: a check 20 seconds after launch,
 * then every 24 hours and on window focus (at most once per 6 hours). Failures
 * are silent. Call once from the app shell; read state with `useUpdateStore`.
 */
export function useUpdates(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const store = useUpdateStore;

    void store.getState().loadSettings();
    onUpdateDownloadProgress((progress) => store.getState().applyProgress(progress))
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Without progress events the download still completes.
      });

    const startup = window.setTimeout(() => void store.getState().check(false), UPDATE_STARTUP_DELAY_MS);
    const daily = window.setInterval(() => void store.getState().check(false), UPDATE_INTERVAL_MS);
    const onFocus = () => {
      const { lastCheckedAt, settings, status } = store.getState();
      if (shouldCheckOnFocus(Date.now(), lastCheckedAt, settings?.autoCheck ?? true, status)) {
        void store.getState().check(false);
      }
    };
    window.addEventListener("focus", onFocus);

    // The Windows installer replaces files that are in use, so quit once it is open.
    let quitTimer: number | undefined;
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.quitRequested && !previous.quitRequested) {
        quitTimer = window.setTimeout(() => {
          void getCurrentWindow().close().catch(() => undefined);
        }, QUIT_DELAY_MS);
      }
    });

    return () => {
      disposed = true;
      unlisten?.();
      unsubscribe();
      window.clearTimeout(startup);
      window.clearInterval(daily);
      window.clearTimeout(quitTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
