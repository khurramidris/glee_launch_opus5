import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelFirstRunProvisioning,
  prepareFirstRunResources,
  resourceStatus,
} from "../../api/tauri";
import { describeTransfer, TransferRateMeter } from "../../lib/download-progress";
import type { ProvisioningProgress, ResourceStatus } from "../../types";
import { normalizeError } from "../app/app-domain";

const PROVISIONING_PROGRESS_EVENT = "provisioning-progress";

export interface ResourceSetupState {
  /** True when the AI files are missing and Glee can download them. */
  needsSetup: boolean;
  running: boolean;
  /** Bytes of the unfinished download already on disk, from an earlier session. */
  partialBytes: number;
  totalBytes: number;
  percent: number;
  detail: string;
  error: string | null;
}

/**
 * Lets the user finish (or resume) the one-time AI download from inside the app,
 * for example after choosing "continue without AI" at startup or losing the
 * connection. Interrupted downloads continue from the bytes already on disk.
 */
export function useResourceSetup(onInstalled: () => void | Promise<void>) {
  const [status, setStatus] = useState<ResourceStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [detail, setDetail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const onInstalledRef = useRef(onInstalled);
  useEffect(() => {
    onInstalledRef.current = onInstalled;
  }, [onInstalled]);

  const refresh = useCallback(async () => {
    try {
      const latest = await resourceStatus();
      setStatus(latest);
      return latest;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = useCallback(async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setPercent(0);
    setDetail("Connecting...");
    const meter = new TransferRateMeter();
    const dispose = await listen<ProvisioningProgress>(PROVISIONING_PROGRESS_EVENT, (event) => {
      const progress = event.payload;
      jobIdRef.current = progress.jobId;
      const total = progress.aggregateTotalBytes ?? 0;
      if (progress.phase === "downloading" && total > 0) {
        setPercent(Math.min(100, (progress.aggregateBytes / total) * 100));
        setDetail(describeTransfer(progress.aggregateBytes, total, meter.update(progress.aggregateBytes)));
      } else if (progress.phase === "verifying") {
        setDetail("Checking the download...");
      } else if (progress.phase === "installing") {
        setDetail("Installing...");
      }
    }).catch(() => undefined);
    try {
      await prepareFirstRunResources();
      const latest = await refresh();
      setPercent(100);
      if (latest?.ready) {
        await onInstalledRef.current();
      }
    } catch (failure) {
      const message = normalizeError(failure);
      const details = message.indexOf(" Details:");
      setError(details > 0 ? message.slice(0, details) : message);
      await refresh();
    } finally {
      dispose?.();
      jobIdRef.current = null;
      runningRef.current = false;
      setRunning(false);
      setDetail("");
    }
  }, [refresh]);

  const cancel = useCallback(() => {
    void cancelFirstRunProvisioning(jobIdRef.current).catch(() => undefined);
  }, []);

  const state: ResourceSetupState = {
    needsSetup: Boolean(status && status.platformSupported && !status.ready),
    running,
    partialBytes: status?.partialRequiredBytes ?? 0,
    totalBytes: status?.missingRequiredBytes ?? 0,
    percent,
    detail,
    error,
  };
  return { ...state, start, cancel, refresh };
}
