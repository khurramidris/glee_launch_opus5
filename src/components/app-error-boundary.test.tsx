// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { AppErrorBoundary } from "./app-error-boundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function BrokenWorkspace(): never {
  throw new Error("synthetic sensitive render detail");
}

describe("AppErrorBoundary", () => {
  it("shows a safe recovery screen without exposing the thrown error", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <BrokenWorkspace />
      </AppErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Something unexpected interrupted");
    expect(alert.textContent).not.toContain("synthetic sensitive render detail");
    expect(screen.getByRole("button", { name: "Reload Glee" })).toBeTruthy();
  });

  it("keeps the recovery screen free of automatic accessibility violations", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(
      <AppErrorBoundary>
        <BrokenWorkspace />
      </AppErrorBoundary>,
    );

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
