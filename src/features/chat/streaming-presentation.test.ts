import { describe, expect, it } from "vitest";

import {
  nextStreamingTextFrame,
  retainVisibleStreamingPreview,
} from "./streaming-presentation";

describe("streaming presentation", () => {
  it("reveals a small token burst one character at a time", () => {
    expect(nextStreamingTextFrame("Hel", "Hello")).toBe("Hell");
  });

  it("catches up faster when the visible stream falls far behind", () => {
    const target = "A".repeat(100);
    const next = nextStreamingTextFrame("", target);

    expect(next.length).toBeGreaterThan(4);
    expect(next.length).toBeLessThan(target.length);
    expect(target.startsWith(next)).toBe(true);
  });

  it("adopts sanitizer rewrites immediately instead of showing stale text", () => {
    expect(
      nextStreamingTextFrame("Yulian: Hello", "Hello there."),
    ).toBe("Hello there.");
  });

  it("does not split emoji code points during reveal", () => {
    expect(nextStreamingTextFrame("Hi ", "Hi 🌿 there")).toBe("Hi 🌿");
  });

  it("keeps the last safe preview during a transient empty assessment", () => {
    expect(
      retainVisibleStreamingPreview(
        "Do not mistake my composure",
        "",
      ),
    ).toBe("Do not mistake my composure");
  });

  it("adopts the next visible safe preview", () => {
    expect(
      retainVisibleStreamingPreview(
        "Do not mistake my composure",
        "Do not mistake my composure for indifference.",
      ),
    ).toBe("Do not mistake my composure for indifference.");
  });
});
