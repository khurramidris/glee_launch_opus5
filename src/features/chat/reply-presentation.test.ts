import { describe, expect, it } from "vitest";
import { resolveReplyPresentation } from "./reply-presentation";

describe("reply presentation", () => {
  it("shows an empty thinking reply for a second chat queued behind an active stream", () => {
    const streamingChat = resolveReplyPresentation(
      "streaming",
      { speakerCharacterId: "character-a", content: "Replying" },
      "character-a",
    );
    const queuedChat = resolveReplyPresentation(
      "queued",
      null,
      "character-b",
    );

    expect(streamingChat).toEqual({
      speakerCharacterId: "character-a",
      content: "Replying",
    });
    expect(queuedChat).toEqual({
      speakerCharacterId: "character-b",
      content: "",
    });
  });

  it("does not invent a new bubble for an unrelated streaming state", () => {
    expect(resolveReplyPresentation("streaming", null, "character-a")).toBeNull();
    expect(resolveReplyPresentation(null, null, "character-a")).toBeNull();
  });
});
