// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../api/updates", () => ({
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  cancelUpdateDownload: vi.fn(),
  installUpdate: vi.fn(),
  skipUpdateVersion: vi.fn(),
  getUpdateSettings: vi.fn(),
  setUpdateSettings: vi.fn(),
}));

import { useUpdateStore } from "../../stores/update-store";
import { UpdateBanner } from "./update-banner";
import { UpdateSettingsSection } from "./update-settings-section";
import { formatBytes, sanitizeUpdateNotes } from "./update-notes";

const baseInfo = {
  available: true,
  currentVersion: "0.1.0",
  latestVersion: "0.2.0",
  notes: "",
  pageUrl: "https://github.com/example/glee/releases/tag/v0.2.0",
  asset: { fileName: "Glee_0.2.0_x64-setup.exe", sizeBytes: 5 * 1024 * 1024 },
  releaseDate: null,
  mandatory: false,
  skipped: false,
};

beforeEach(() => {
  useUpdateStore.setState({
    status: "available",
    info: baseInfo,
    progress: null,
    error: null,
    settings: { autoCheck: true, skippedVersion: null, currentVersion: "0.1.0", updatesEnabled: true },
    lastCheckedAt: null,
    installerPath: null,
    dismissedVersion: null,
    quitRequested: false,
  });
});

afterEach(cleanup);

describe("sanitizeUpdateNotes", () => {
  it("keeps plain text, marks bullets, and drops markup markers and control characters", () => {
    expect(sanitizeUpdateNotes("## New\r\n- **Faster** [replies](https://example.com)\n\n\u0007Bug fixes")).toEqual([
      { bullet: false, text: "New" },
      { bullet: true, text: "Faster replies" },
      { bullet: false, text: "Bug fixes" },
    ]);
    expect(sanitizeUpdateNotes(null)).toEqual([]);
  });

  it("caps long input", () => {
    const lines = sanitizeUpdateNotes(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
    expect(lines).toHaveLength(40);
    expect(sanitizeUpdateNotes("x".repeat(1000))[0].text.length).toBe(280);
  });

  it("formats sizes", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(0)).toBe("0 MB");
  });
});

describe("UpdateBanner", () => {
  it("renders notes as text, never as HTML", async () => {
    useUpdateStore.setState({ info: { ...baseInfo, notes: "- <img src=x onerror=alert(1)> <b>bold</b>" } });
    const { container } = render(<UpdateBanner />);
    await userEvent.click(screen.getByRole("button", { name: /what's new/i }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> <b>bold<\/b>/)).toBeTruthy();
  });

  it("offers download, remind me later and skip for optional updates", () => {
    render(<UpdateBanner />);
    expect(screen.getByText("Glee 0.2.0 is available")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download update" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remind me later" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip this version" })).toBeTruthy();
  });

  it("cannot skip a mandatory update", () => {
    useUpdateStore.setState({ info: { ...baseInfo, mandatory: true } });
    render(<UpdateBanner />);
    expect(screen.queryByRole("button", { name: "Skip this version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remind me later" })).toBeNull();
  });

  it("shows progress with cancel while downloading", () => {
    useUpdateStore.setState({
      status: "downloading",
      progress: { downloadedBytes: 1024 * 1024, totalBytes: 5 * 1024 * 1024, phase: "downloading" },
    });
    render(<UpdateBanner />);
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("20");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("renders nothing when dismissed", () => {
    useUpdateStore.setState({ dismissedVersion: "0.2.0" });
    const { container } = render(<UpdateBanner />);
    expect(container.firstChild).toBeNull();
  });
});

describe("UpdateSettingsSection", () => {
  it("shows the version, the privacy disclosure, and the auto-check toggle", () => {
    render(<UpdateSettingsSection />);
    expect(screen.getByText(/Glee 0\.1\.0/)).toBeTruthy();
    expect(
      screen.getByText("Glee checks GitHub for new versions. Nothing about you or your chats is sent."),
    ).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  });
});
