// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { MemoryItem } from "../../types";

const mocks = vi.hoisted(() => ({
  listMemoryItems: vi.fn(),
  createMemoryItem: vi.fn(),
  updateMemoryItem: vi.fn(),
  deleteMemoryItem: vi.fn(),
  deleteMemoryItemsFor: vi.fn(),
}));

vi.mock("../../api/tauri", () => mocks);

import { memoryStore } from "../../stores/memory-store";
import { memoryViewKey, useMemoryItems } from "./use-memory-items";

function item(id: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    scope: "user",
    kind: "fact",
    content: `Memory ${id}`,
    importance: 3,
    pinned: false,
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    recallCount: 0,
    archived: false,
    ...overrides,
  };
}

describe("useMemoryItems", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    memoryStore.getState().reset();
    mocks.listMemoryItems.mockResolvedValue([item("a"), item("b", { pinned: true })]);
  });
  afterEach(cleanup);

  it("loads what a chat can recall and reloads after extraction stored something", async () => {
    const { result } = renderHook(() => useMemoryItems({ chatId: "chat-1" }));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(mocks.listMemoryItems).toHaveBeenCalledWith({
      visibleInChat: "chat-1",
      includeArchived: false,
    });

    mocks.listMemoryItems.mockResolvedValue([item("a"), item("b"), item("c")]);
    act(() => memoryStore.getState().noteExtraction());
    await waitFor(() => expect(result.current.items).toHaveLength(3));
  });

  it("loads every memory without a chat and waits while disabled", async () => {
    const hidden = renderHook(() => useMemoryItems({ enabled: false }));
    expect(mocks.listMemoryItems).not.toHaveBeenCalled();
    hidden.unmount();

    const { result } = renderHook(() => useMemoryItems({ includeArchived: true }));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(mocks.listMemoryItems).toHaveBeenCalledWith({ includeArchived: true });
    expect(memoryViewKey({ includeArchived: true })).toBe("all:archived");
  });

  it("shows changes at once and keeps the saved record", async () => {
    const { result } = renderHook(() => useMemoryItems({ chatId: "chat-1" }));
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    let resolveSave: (value: MemoryItem) => void = () => undefined;
    mocks.updateMemoryItem.mockReturnValue(new Promise((resolve) => (resolveSave = resolve)));
    let pending: Promise<MemoryItem | null> = Promise.resolve(null);
    act(() => {
      pending = result.current.updateItem("a", { pinned: true });
    });
    expect(result.current.items.find((entry) => entry.id === "a")?.pinned).toBe(true);

    await act(async () => {
      resolveSave(item("a", { pinned: true, content: "Saved text" }));
      await pending;
    });
    expect(result.current.items.find((entry) => entry.id === "a")?.content).toBe("Saved text");
    expect(result.current.error).toBeNull();
  });

  it("rolls back a failed change and reports it", async () => {
    const { result } = renderHook(() => useMemoryItems({ chatId: "chat-1" }));
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    mocks.updateMemoryItem.mockRejectedValue(new Error("write failed"));
    await act(async () => {
      expect(await result.current.updateItem("a", { pinned: true })).toBeNull();
    });
    expect(result.current.items.find((entry) => entry.id === "a")?.pinned).toBe(false);
    expect(result.current.error).toBe("write failed");
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("deletes optimistically and restores the row when the delete fails", async () => {
    const { result } = renderHook(() => useMemoryItems({ chatId: "chat-1" }));
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    mocks.deleteMemoryItem.mockResolvedValue(undefined);
    await act(async () => {
      expect(await result.current.deleteItem("a")).toBe(true);
    });
    expect(result.current.items.map((entry) => entry.id)).toEqual(["b"]);

    mocks.deleteMemoryItem.mockRejectedValue(new Error("locked"));
    await act(async () => {
      expect(await result.current.deleteItem("b")).toBe(false);
    });
    expect(result.current.items.map((entry) => entry.id)).toEqual(["b"]);
    expect(result.current.error).toBe("locked");
  });

  it("forgets a character's memories and removes them from the list", async () => {
    mocks.listMemoryItems.mockResolvedValue([
      item("u"),
      item("c1", { scope: "character", characterId: "ada" }),
      item("c2", { scope: "character", characterId: "bea" }),
      item("t", { scope: "chat", chatId: "chat-1" }),
    ]);
    const { result } = renderHook(() => useMemoryItems({ chatId: "chat-1" }));
    await waitFor(() => expect(result.current.items).toHaveLength(4));

    mocks.deleteMemoryItemsFor.mockResolvedValue(1);
    await act(async () => {
      expect(await result.current.forget({ characterId: "ada" })).toBe(1);
    });
    expect(result.current.items.map((entry) => entry.id)).toEqual(["u", "c2", "t"]);
    expect(mocks.deleteMemoryItemsFor).toHaveBeenCalledWith({ characterId: "ada" });

    await act(async () => {
      await result.current.forget({ chatId: "chat-1" });
    });
    expect(result.current.items.map((entry) => entry.id)).toEqual(["u", "c2"]);
  });

  it("reloads views after creating a memory", async () => {
    const { result } = renderHook(() => useMemoryItems());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    mocks.createMemoryItem.mockResolvedValue(item("new"));
    mocks.listMemoryItems.mockResolvedValue([item("a"), item("b"), item("new")]);
    await act(async () => {
      await result.current.createItem({ scope: "user", content: "Sam plays the cello" });
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
  });
});
