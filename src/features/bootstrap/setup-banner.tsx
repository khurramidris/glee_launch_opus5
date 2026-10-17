import { formatBytes } from "../../lib/download-progress";
import type { ResourceSetupState } from "./use-resource-setup";

interface SetupBannerProps {
  setup: ResourceSetupState;
  onStart: () => void;
  onCancel: () => void;
}

/** Shown while the AI files are missing; resumes interrupted downloads. */
export function SetupBanner({ setup, onStart, onCancel }: SetupBannerProps) {
  if (!setup.needsSetup && !setup.running) {
    return null;
  }
  const resuming = setup.partialBytes > 0;
  const alreadyPercent =
    setup.totalBytes > 0 ? Math.min(99, Math.round((setup.partialBytes / setup.totalBytes) * 100)) : 0;

  return (
    <div className="app-banner" role="status" aria-live="polite">
      <div className="app-banner-copy">
        {setup.running ? (
          <>
            <strong>{resuming ? "Resuming the AI download" : "Downloading the AI"}</strong>
            <span>{setup.detail}</span>
            <progress max={100} value={setup.percent} aria-label="Download progress" />
          </>
        ) : (
          <>
            <strong>Glee&apos;s AI isn&apos;t fully installed yet</strong>
            <span>
              {setup.error
                ? setup.error
                : resuming
                  ? `Your earlier download is ${alreadyPercent}% done. Resume to finish it (about ${formatBytes(
                      Math.max(0, setup.totalBytes - setup.partialBytes),
                    )} left).`
                  : `Characters can't reply until it is downloaded once (about ${formatBytes(setup.totalBytes)}).`}
            </span>
          </>
        )}
      </div>
      <div className="app-banner-actions">
        {setup.running ? (
          <button type="button" className="ghost" onClick={onCancel}>
            Pause
          </button>
        ) : (
          <button type="button" className="primary" onClick={onStart}>
            {setup.error ? "Try again" : resuming ? "Resume download" : "Download now"}
          </button>
        )}
      </div>
    </div>
  );
}
