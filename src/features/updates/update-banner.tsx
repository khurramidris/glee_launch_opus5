import { useState } from "react";
import { isBannerVisible, useUpdateStore } from "../../stores/update-store";
import { formatBytes, sanitizeUpdateNotes } from "./update-notes";
import "./updates.css";

const IS_WINDOWS = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

/** Slim banner for the top of the main column. Renders nothing when there is no update to show. */
export function UpdateBanner() {
  const status = useUpdateStore((state) => state.status);
  const info = useUpdateStore((state) => state.info);
  const progress = useUpdateStore((state) => state.progress);
  const error = useUpdateStore((state) => state.error);
  const dismissedVersion = useUpdateStore((state) => state.dismissedVersion);
  const { download, install, skip, dismiss, cancel } = useUpdateStore.getState();
  const [showNotes, setShowNotes] = useState(false);

  if (!info || !isBannerVisible({ status, info, dismissedVersion })) return null;

  const notes = sanitizeUpdateNotes(info.notes);
  const canDownload = Boolean(info.asset);
  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
      : 0;
  const installLabel = IS_WINDOWS ? "Install & restart" : "Open installer";

  return (
    <section className="update-banner" role="status" aria-live="polite" data-status={status}>
      <div className="update-banner-row">
        <p className="update-banner-title">
          <strong>Glee {info.latestVersion} is available</strong>
          {info.mandatory ? <span className="update-banner-tag">Required</span> : null}
        </p>
        <div className="update-banner-actions">
          {notes.length > 0 ? (
            <button type="button" className="ghost" aria-expanded={showNotes} onClick={() => setShowNotes((open) => !open)}>
              What&apos;s new
            </button>
          ) : null}
          {(status === "available" || status === "error") && canDownload ? (
            <button type="button" className="primary" onClick={() => void download()}>
              {status === "error" ? "Try again" : "Download update"}
            </button>
          ) : null}
          {(status === "available" || status === "error") && !canDownload ? (
            <a className="ghost update-banner-link" href={info.pageUrl} target="_blank" rel="noreferrer">
              View release
            </a>
          ) : null}
          {status === "downloading" ? (
            <button type="button" className="ghost" onClick={() => void cancel()}>
              Cancel
            </button>
          ) : null}
          {status === "ready" || status === "installing" ? (
            <button type="button" className="primary" disabled={status === "installing"} onClick={() => void install()}>
              {installLabel}
            </button>
          ) : null}
          {status === "available" || status === "error" ? (
            <>
              {!info.mandatory ? (
                <button type="button" className="ghost" onClick={() => dismiss()}>
                  Remind me later
                </button>
              ) : null}
              {!info.mandatory ? (
                <button type="button" className="ghost" onClick={() => void skip()}>
                  Skip this version
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {status === "downloading" ? (
        <div className="update-banner-progress">
          <progress max={100} value={percent} aria-label="Update download progress" />
          <span>
            {progress?.phase === "verifying"
              ? "Checking the download..."
              : `${formatBytes(progress?.downloadedBytes ?? 0)} of ${formatBytes(progress?.totalBytes ?? 0)}`}
          </span>
        </div>
      ) : null}
      {status === "ready" ? (
        <p className="update-banner-note">
          Downloaded and checked. {IS_WINDOWS ? "Glee closes while the installer runs." : "Drag Glee to Applications to finish."}
        </p>
      ) : null}
      {status === "error" && error ? <p className="update-banner-error" role="alert">{error}</p> : null}
      {showNotes && notes.length > 0 ? (
        <div className="update-banner-notes">
          {notes.map((line, index) =>
            line.bullet ? (
              <p key={index} className="update-note-bullet">{line.text}</p>
            ) : (
              <p key={index}>{line.text}</p>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}
