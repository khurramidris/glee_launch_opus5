// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ChatMessage } from "../../types";
import { GenerationFailureEvent } from "./generation-failure-event";

const failureMessage: ChatMessage = {
  id: "failure-1",
  chatId: "chat-1",
  role: "assistant",
  content:
    "[Glee reply failed] Pooja could not complete this reply after an automatic retry. Select Regenerate to try again.",
  speakerCharacterId: "pooja",
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(cleanup);

describe("GenerationFailureEvent", () => {
  it("renders recovery controls instead of pretending the failure is character speech", async () => {
    const onRetry = vi.fn();
    const onBranch = vi.fn();
    const user = userEvent.setup();
    render(
      <GenerationFailureEvent
        message={failureMessage}
        timeLabel="10:15"
        busy={false}
        sending={false}
        onRetry={onRetry}
        onBranch={onBranch}
      />,
    );

    expect(screen.getByLabelText("Reply recovery").textContent).toContain(
      "Reply interrupted",
    );
    expect(screen.getByLabelText("Reply recovery").textContent).not.toContain(
      "[Glee reply failed]",
    );
    await user.click(screen.getByRole("button", { name: /retry reply/i }));
    await user.click(screen.getByRole("button", { name: /branch here/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onBranch).toHaveBeenCalledTimes(1);
  });

  it("has no automatically detectable accessibility violations", async () => {
    const { container } = render(
      <GenerationFailureEvent
        message={failureMessage}
        timeLabel="10:15"
        busy={false}
        sending={false}
        onRetry={() => undefined}
        onBranch={() => undefined}
      />,
    );

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
