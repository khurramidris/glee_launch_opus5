import type { ChatMessage } from "../../types";
import { GleeIcon } from "../../components/glee-icon";
import { generationFailureDisplayText } from "./generation-failure";

export function GenerationFailureEvent({
  message,
  timeLabel,
  busy,
  sending,
  onRetry,
  onBranch,
}: {
  message: ChatMessage;
  timeLabel: string;
  busy: boolean;
  sending: boolean;
  onRetry: () => void;
  onBranch: () => void;
}) {
  return (
    <article
      className={`generation-failure-event${busy ? " busy" : ""}`}
      aria-label="Reply recovery"
    >
      <div className="generation-failure-copy">
        <div className="generation-failure-heading">
          <strong>Reply interrupted</strong>
          <time>{timeLabel}</time>
        </div>
        <p>{generationFailureDisplayText(message.content)}</p>
      </div>
      <div className="generation-failure-actions">
        <button
          type="button"
          className="ghost"
          disabled={busy || sending}
          onClick={onRetry}
        >
          <span className="glee-icon-label">
            <GleeIcon name="regenerate" size={13} />
            <span>{busy ? "Retrying..." : "Retry reply"}</span>
          </span>
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || sending}
          onClick={onBranch}
        >
          <span className="glee-icon-label">
            <GleeIcon name="branch" size={13} />
            <span>Branch here</span>
          </span>
        </button>
      </div>
    </article>
  );
}
