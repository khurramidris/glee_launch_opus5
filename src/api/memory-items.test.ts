import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  __testing,
  createMemoryItem,
  deleteMemoryItem,
  deleteMemoryItemsFor,
  getMemoryExtractionBatch,
  listMemoryItems,
  storeMemoryExtraction,
  updateMemoryItem,
} from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const rawItem = {
  id: "item-1",
  scope: "character" as const,
  character_id: "char-1",
  chat_id: null,
  kind: "promise" as const,
  content: "Ada promised to teach Sam chess",
  importance: 4,
  pinned: 1,
  source_message_id: "msg-1",
  created_at: "2000-01-01T00:00:00.000Z",
  updated_at: "2000-01-02T00:00:00.000Z",
  last_recalled_at: null,
  recall_count: 2,
  archived: 0,
};

describe("memory item api", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("maps native records to memory items", () => {
    expect(__testing.mapMemoryItem(rawItem)).toEqual({
      id: "item-1",
      scope: "character",
      characterId: "char-1",
      chatId: undefined,
      kind: "promise",
      content: "Ada promised to teach Sam chess",
      importance: 4,
      pinned: true,
      sourceMessageId: "msg-1",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-02T00:00:00.000Z",
      lastRecalledAt: undefined,
      recallCount: 2,
      archived: false,
    });
    expect(
      __testing.mapMemoryItem({ ...rawItem, pinned: false, archived: true, recall_count: null }),
    ).toMatchObject({ pinned: false, archived: true, recallCount: 0 });
  });

  it("marks recalled memory items so the prompt can label them", () => {
    const recalled = __testing.mapMemorySnippet(
      {
        message_id: "memory-item:item-1",
        chat_id: "chat-1",
        role: "memory" as never,
        content: "Sam is allergic to peanuts",
        speaker_character_id: null,
        created_at: "2000-01-01T00:00:00.000Z",
        score: 120,
      },
      "chat-1",
    );
    expect(recalled).toMatchObject({
      messageId: "memory-item:item-1",
      source: "memory-item",
      role: "system",
    });
    const message = __testing.mapMemorySnippet({
      message_id: "msg-1",
      chat_id: "chat-1",
      role: "user",
      content: "hello",
      created_at: "2000-01-01T00:00:00.000Z",
      score: 10,
    });
    expect(message.source).toBeUndefined();
    expect(message.role).toBe("user");
  });

  it("maps extraction batches and outcomes", () => {
    const batch = __testing.mapMemoryExtractionBatch({
      chat_id: "chat-1",
      history_epoch: 3,
      ready: true,
      pending_count: 7,
      last_message_id: "msg-9",
      participants: [{ id: "char-1", name: "Ada" }],
      messages: [
        {
          id: "msg-9",
          chat_id: "chat-1",
          role: "user",
          content: "hello",
          speaker_character_id: null,
          created_at: "2000-01-01T00:00:00.000Z",
        },
      ],
      related_items: [rawItem],
    });
    expect(batch).toMatchObject({
      chatId: "chat-1",
      historyEpoch: 3,
      ready: true,
      pendingCount: 7,
      lastMessageId: "msg-9",
      participants: [{ id: "char-1", name: "Ada" }],
    });
    expect(batch.messages[0].content).toBe("hello");
    expect(batch.relatedItems[0].id).toBe("item-1");

    expect(__testing.mapMemoryExtractionBatch({ ...{ chat_id: "c", history_epoch: 0, ready: false, pending_count: 0 } }))
      .toMatchObject({ messages: [], relatedItems: [], participants: [] });

    const outcome = __testing.mapMemoryExtractionOutcome({
      added: [rawItem],
      removed: ["x"],
      skipped: 2,
    });
    expect(outcome.added).toHaveLength(1);
    expect(outcome.updated).toEqual([]);
    expect(outcome).toMatchObject({ removed: ["x"], skipped: 2 });
  });

  it("sends snake_case inputs to the native commands", async () => {
    vi.mocked(invoke).mockResolvedValue([rawItem]);
    const listed = await listMemoryItems({ visibleInChat: "chat-1" });
    expect(invoke).toHaveBeenLastCalledWith("list_memory_items", {
      input: {
        scope: undefined,
        character_id: undefined,
        chat_id: undefined,
        include_archived: false,
        visible_in_chat: "chat-1",
      },
    });
    expect(listed[0].pinned).toBe(true);

    vi.mocked(invoke).mockResolvedValue(rawItem);
    await createMemoryItem({ scope: "character", characterId: "char-1", content: "x y z", importance: 2 });
    expect(invoke).toHaveBeenLastCalledWith("create_memory_item", {
      input: expect.objectContaining({
        scope: "character",
        character_id: "char-1",
        content: "x y z",
        importance: 2,
      }),
    });

    await updateMemoryItem({ id: "item-1", pinned: false, archived: true });
    expect(invoke).toHaveBeenLastCalledWith("update_memory_item", {
      input: expect.objectContaining({ id: "item-1", pinned: false, archived: true }),
    });

    await deleteMemoryItem("item-1");
    expect(invoke).toHaveBeenLastCalledWith("delete_memory_item", { memoryItemId: "item-1" });

    vi.mocked(invoke).mockResolvedValue(3);
    expect(await deleteMemoryItemsFor({ characterId: "char-1" })).toBe(3);
    expect(invoke).toHaveBeenLastCalledWith("delete_memory_items_for", {
      input: { scope: undefined, character_id: "char-1", chat_id: undefined },
    });
  });

  it("round-trips an extraction batch and its result", async () => {
    vi.mocked(invoke).mockResolvedValue({
      chat_id: "chat-1",
      history_epoch: 1,
      ready: false,
      pending_count: 2,
    });
    expect((await getMemoryExtractionBatch("chat-1")).ready).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("get_memory_extraction_batch", { chatId: "chat-1" });

    vi.mocked(invoke).mockResolvedValue({ added: [rawItem], updated: [], removed: [], skipped: 0 });
    const outcome = await storeMemoryExtraction({
      chatId: "chat-1",
      throughMessageId: "msg-9",
      expectedHistoryEpoch: 1,
      add: [{ scope: "user", kind: "fact", content: "Sam is allergic to peanuts", importance: 5 }],
      update: [{ id: "item-1", content: "Updated text" }],
      remove: ["item-2"],
    });
    expect(outcome.added).toHaveLength(1);
    expect(invoke).toHaveBeenLastCalledWith("store_memory_extraction", {
      input: {
        chat_id: "chat-1",
        through_message_id: "msg-9",
        expected_history_epoch: 1,
        add: [
          {
            scope: "user",
            character_id: undefined,
            kind: "fact",
            content: "Sam is allergic to peanuts",
            importance: 5,
          },
        ],
        update: [{ id: "item-1", content: "Updated text", importance: undefined }],
        remove: ["item-2"],
      },
    });
  });
});
