import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resolveMemorySnippetsBatch } from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("batched memory retrieval", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("uses one native request and preserves each speaker's ranking", async () => {
    const raw = (id: string) => ({
      message_id: id, chat_id: "chat", role: "user", content: `passage ${id}`,
      speaker_character_id: null, created_at: "2026-10-08T00:00:00Z", score: 100,
    });
    vi.mocked(invoke).mockResolvedValue([[raw("a")], [raw("b")]]);
    const result = await resolveMemorySnippetsBatch([
      { chatId: "chat", query: "cats", limit: 6, speakerCharacterId: "one", retrievalHints: "gentle" },
      { chatId: "chat", query: "cats", limit: 6, speakerCharacterId: "two", retrievalHints: "curious" },
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("resolve_memory_snippets_batch", {
      inputs: [
        { chat_id: "chat", query: "cats", limit: 6, speaker_character_id: "one", retrieval_hints: "gentle" },
        { chat_id: "chat", query: "cats", limit: 6, speaker_character_id: "two", retrieval_hints: "curious" },
      ],
    });
    expect(result.map((hits) => hits[0].messageId)).toEqual(["a", "b"]);
    expect(result[0][0].content).toBe("passage a");
  });

  it("does not invoke the runtime when there are no responders", async () => {
    expect(await resolveMemorySnippetsBatch([])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("preserves empty speaker results without shifting later results", async () => {
    vi.mocked(invoke).mockResolvedValue([[], []]);
    expect(await resolveMemorySnippetsBatch([
      { chatId: "chat", query: "cats", speakerCharacterId: "one" },
      { chatId: "chat", query: "cats", speakerCharacterId: "two" },
    ])).toEqual([[], []]);
  });
});
