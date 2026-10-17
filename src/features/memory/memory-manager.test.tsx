// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MemoryItem } from "../../types";
import {
  MemoryManager,
  groupMemoryItems,
  type MemoryManagerProps,
} from "./memory-manager";

afterEach(cleanup);

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

const characters = [
  { id: "ada", name: "Ada" },
  { id: "bea", name: "Bea" },
];

const sample = [
  item("peanuts", { content: "Sam is allergic to peanuts", importance: 5, pinned: true }),
  item("chess", {
    scope: "character",
    characterId: "ada",
    kind: "promise",
    content: "Ada promised to teach Sam chess",
  }),
  item("bees", { scope: "character", characterId: "bea", content: "Bea keeps bees" }),
  item("trip", { scope: "chat", chatId: "chat-1", content: "The trip is planned for spring" }),
];

function setup(overrides: Partial<MemoryManagerProps> = {}) {
  const props: MemoryManagerProps = {
    items: sample,
    characters,
    chatId: "chat-1",
    createItem: vi.fn(async () => item("new")),
    updateItem: vi.fn(async (id: string) => item(id)),
    deleteItem: vi.fn(async () => true),
    forget: vi.fn(async () => 1),
    ...overrides,
  };
  render(<MemoryManager {...props} />);
  return props;
}

describe("groupMemoryItems", () => {
  it("orders the user, then characters by name, then chats", () => {
    const groups = groupMemoryItems([...sample].reverse(), characters, { "chat-1": "Harbor" });
    expect(groups.map((group) => group.title)).toEqual([
      "About you",
      "Ada",
      "Bea",
      "Chat: Harbor",
    ]);
    expect(groups.map((group) => group.forgetTarget)).toEqual([
      { scope: "user" },
      { characterId: "ada" },
      { characterId: "bea" },
      { chatId: "chat-1" },
    ]);
  });
});

describe("MemoryManager", () => {
  it("lists memories grouped with kind badges", () => {
    setup();
    const ada = screen.getByRole("region", { name: "Ada" });
    expect(within(ada).getByText("Ada promised to teach Sam chess")).toBeTruthy();
    expect(within(ada).getByText("Promise")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "About you" })).getByText("Pinned")).toBeTruthy();
    expect(screen.getByRole("region", { name: "This chat" })).toBeTruthy();
  });

  it("filters by search text, owner kind, and character", async () => {
    const user = userEvent.setup();
    setup({ showCharacterFilter: true });
    await user.type(screen.getByLabelText("Search memories"), "bees");
    expect(screen.queryByText("Sam is allergic to peanuts")).toBeNull();
    expect(screen.getByText("Bea keeps bees")).toBeTruthy();
    await user.clear(screen.getByLabelText("Search memories"));

    await user.selectOptions(screen.getByLabelText("Filter by character"), "ada");
    expect(screen.getByText("Ada promised to teach Sam chess")).toBeTruthy();
    expect(screen.queryByText("Bea keeps bees")).toBeNull();
    expect(screen.queryByText("The trip is planned for spring")).toBeNull();
    // The user's memories stay: every character can recall them.
    expect(screen.getByText("Sam is allergic to peanuts")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Filter by character"), "all");
    await user.selectOptions(screen.getByLabelText("Filter by kind of owner"), "chat");
    expect(screen.getByText("The trip is planned for spring")).toBeTruthy();
    expect(screen.queryByText("Bea keeps bees")).toBeNull();
  });

  it("says when nothing matches or nothing is stored", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(screen.getByLabelText("Search memories"), "zebra");
    expect(screen.getByText("No memories match.")).toBeTruthy();
    cleanup();
    setup({ items: [] });
    expect(screen.getByText(/Nothing remembered yet/)).toBeTruthy();
  });

  it("edits text inline and saves it", async () => {
    const user = userEvent.setup();
    const props = setup();
    const region = screen.getByRole("region", { name: "Bea" });
    await user.click(within(region).getByRole("button", { name: "Edit" }));
    const box = within(region).getByLabelText("Memory text");
    await user.clear(box);
    await user.type(box, "Bea keeps wasps");
    await user.click(within(region).getByRole("button", { name: "Save" }));
    expect(props.updateItem).toHaveBeenCalledWith("bees", { content: "Bea keeps wasps", kind: "fact" });
    expect(within(region).queryByLabelText("Memory text")).toBeNull();
  });

  it("keeps the editor open when saving fails", async () => {
    const user = userEvent.setup();
    const props = setup({ updateItem: vi.fn(async () => null) });
    const region = screen.getByRole("region", { name: "Bea" });
    await user.click(within(region).getByRole("button", { name: "Edit" }));
    await user.click(within(region).getByRole("button", { name: "Save" }));
    expect(props.updateItem).toHaveBeenCalled();
    expect(within(region).getByLabelText("Memory text")).toBeTruthy();
  });

  it("toggles pin and changes importance", async () => {
    const user = userEvent.setup();
    const props = setup();
    const ada = screen.getByRole("region", { name: "Ada" });
    await user.click(within(ada).getByRole("button", { name: "Pin" }));
    expect(props.updateItem).toHaveBeenCalledWith("chess", { pinned: true });

    const user_ = screen.getByRole("region", { name: "About you" });
    await user.click(within(user_).getByRole("button", { name: "Pinned" }));
    expect(props.updateItem).toHaveBeenCalledWith("peanuts", { pinned: false });

    await user.selectOptions(
      within(ada).getByLabelText("Importance of: Ada promised to teach Sam chess"),
      "5",
    );
    expect(props.updateItem).toHaveBeenCalledWith("chess", { importance: 5 });
  });

  it("asks before deleting one memory", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Delete: Bea keeps bees" }));
    expect(props.deleteItem).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "No" }));
    expect(props.deleteItem).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete: Bea keeps bees" }));
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(props.deleteItem).toHaveBeenCalledWith("bees");
  });

  it("asks before forgetting a whole group", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Forget all: Ada" }));
    expect(props.forget).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("group", { name: "Confirm forget all for Ada" })).getByRole("button", {
        name: "Yes",
      }),
    );
    expect(props.forget).toHaveBeenCalledWith({ characterId: "ada" });

    await user.click(screen.getByRole("button", { name: "Forget all: About you" }));
    await user.click(screen.getByRole("button", { name: "Yes" }));
    expect(props.forget).toHaveBeenLastCalledWith({ scope: "user" });
  });

  it("adds a memory for a character", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Add a memory" }));
    const save = screen.getByRole("button", { name: "Save memory" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await user.type(screen.getByLabelText("New memory"), "Bea fears thunder");
    await user.selectOptions(screen.getByLabelText("Who remembers it"), "character");
    await user.selectOptions(screen.getByLabelText("Character"), "bea");
    await user.selectOptions(screen.getByLabelText("New memory type"), "relationship");
    await user.selectOptions(screen.getByLabelText("New memory importance"), "4");
    await user.click(screen.getByLabelText("Always remember this"));
    await user.click(save);

    expect(props.createItem).toHaveBeenCalledWith({
      scope: "character",
      characterId: "bea",
      kind: "relationship",
      content: "Bea fears thunder",
      importance: 4,
      pinned: true,
    });
    expect(screen.queryByLabelText("New memory")).toBeNull();
  });

  it("offers chat memories only when a chat is open", async () => {
    const user = userEvent.setup();
    setup({ chatId: null });
    await user.click(screen.getByRole("button", { name: "Add a memory" }));
    const options = within(screen.getByLabelText("Who remembers it")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).not.toContain("Only this chat");
  });

  it("shows errors and lets archived memories be restored", async () => {
    const user = userEvent.setup();
    const clearError = vi.fn();
    const props = setup({
      items: [item("old", { archived: true, content: "Sam used to live inland" })],
      error: "Could not save",
      clearError,
    });
    expect(screen.getByRole("alert").textContent).toContain("Could not save");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(clearError).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(props.updateItem).toHaveBeenCalledWith("old", { archived: false });
  });
});
