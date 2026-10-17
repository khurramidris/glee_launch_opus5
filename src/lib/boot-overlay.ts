const BOOT_OVERLAY_ID = "glee-boot-overlay";
const BOOT_STATUS_ID = "glee-boot-status";
const BOOT_PROGRESS_ID = "glee-boot-progress";
const BOOT_CANCEL_ID = "glee-boot-cancel";
const BOOT_RETRY_ID = "glee-boot-retry";
const BOOT_CONTINUE_ID = "glee-boot-continue";
const BOOT_SUBTITLE_ID = "glee-boot-subtitle";
const BOOT_DETAIL_ID = "glee-boot-detail";

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getBootOverlay(): HTMLElement | null {
  return document.getElementById(BOOT_OVERLAY_ID);
}

export function setBootOverlayProgress(input: {
  progress: number;
  status?: string;
}): void {
  const overlay = getBootOverlay();
  if (!overlay || overlay.dataset.dismissed === "true") {
    return;
  }

  const progress = clampProgress(input.progress);
  const progressBar = document.getElementById(BOOT_PROGRESS_ID);
  const status = document.getElementById(BOOT_STATUS_ID);

  overlay.style.setProperty("--boot-progress", `${progress}%`);
  if (progressBar instanceof HTMLElement) {
    progressBar.style.setProperty("--boot-progress", `${progress}%`);
    progressBar.setAttribute("aria-valuenow", progress.toString());
  }
  if (status && input.status?.trim()) {
    status.textContent = input.status.trim();
  }
}

export function setBootOverlayCancelAction(
  action: (() => void) | null,
  label = "Cancel setup",
): void {
  const button = document.getElementById(BOOT_CANCEL_ID);
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }
  button.textContent = label;
  button.hidden = !action;
  button.disabled = false;
  button.onclick = action
    ? () => {
        button.disabled = true;
        action();
      }
    : null;
}

export function setBootOverlayText(input: { subtitle?: string; detail?: string }): void {
  if (input.subtitle !== undefined) {
    const subtitle = document.getElementById(BOOT_SUBTITLE_ID);
    if (subtitle) {
      subtitle.textContent = input.subtitle;
    }
  }
  if (input.detail !== undefined) {
    const detail = document.getElementById(BOOT_DETAIL_ID);
    if (detail) {
      detail.textContent = input.detail;
    }
  }
}

export function setBootOverlayError(isError: boolean): void {
  const overlay = getBootOverlay();
  if (overlay) {
    overlay.dataset.state = isError ? "error" : "loading";
  }
}

/**
 * Shows "Try again" and "Continue without AI" and resolves with the choice.
 * Resolves to "continue" immediately when the overlay is not on the page.
 */
export function waitForBootOverlayChoice(): Promise<"retry" | "continue"> {
  const retry = document.getElementById(BOOT_RETRY_ID);
  const proceed = document.getElementById(BOOT_CONTINUE_ID);
  if (!(retry instanceof HTMLButtonElement) || !(proceed instanceof HTMLButtonElement)) {
    return Promise.resolve("continue");
  }
  return new Promise((resolve) => {
    const finish = (choice: "retry" | "continue") => {
      retry.hidden = true;
      proceed.hidden = true;
      retry.onclick = null;
      proceed.onclick = null;
      resolve(choice);
    };
    retry.hidden = false;
    proceed.hidden = false;
    retry.onclick = () => finish("retry");
    proceed.onclick = () => finish("continue");
    retry.focus();
  });
}

export function dismissBootOverlay(): void {
  const overlay = getBootOverlay();
  if (!overlay || overlay.dataset.dismissed === "true") {
    return;
  }
  setBootOverlayCancelAction(null);
  setBootOverlayProgress({ progress: 100, status: "Workspace ready" });
  overlay.dataset.dismissed = "true";
  overlay.classList.add("boot-hidden");
  window.setTimeout(() => {
    overlay.remove();
  }, 220);
}
