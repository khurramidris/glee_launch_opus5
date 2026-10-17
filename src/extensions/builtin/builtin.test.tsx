// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDefaultRegistry } from "../index";
import { ExtensionRegistry } from "../registry";
import { createMemoryStorageAdapter } from "../storage";
import { chat, message } from "../testing/fixtures";
import { createChatStatsExtension, createStatsStore } from "./chat-stats";
import { createPromptSnippetsExtension } from "./prompt-snippets";
import { createSnippetLibrary, snippetKey } from "./snippet-library";
import { countWords, wordCountExtension } from "./word-count";

const notesContext = {
  chatId: "c1",
  participantIds: [],
  isGroup: false,
  isRegeneration: false,
  userText: "",
};

describe("word-count", () => {
  it("counts words across whitespace", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("  one   two\nthree ")).toBe(3);
  });

  it("offers Copy word count on non-empty messages and asks the host to copy", async () => {
    const copyText = vi.fn();
    const notify = vi.fn();
    const registry = new ExtensionRegistry({ host: { copyText, notify } });
    registry.register(wordCountExtension);
    await registry.start();
    expect(registry.listMessageActions(message("   "), chat)).toEqual([]);
    const [action] = registry.listMessageActions(message("a b c"), chat);
    expect(action.label).toBe("Copy word count");
    await action.run();
    expect(copyText).toHaveBeenCalledWith("3");
    expect(notify).toHaveBeenCalledWith({ kind: "info", message: "3 words copied." });
  });

  it("declares exactly the permissions it uses", () => {
    expect([...wordCountExtension.permissions].sort()).toEqual(["chat:read", "ui:message-actions"]);
  });
});

describe("prompt-snippets", () => {
  function setup() {
    const library = createSnippetLibrary();
    library.add({ key: snippetKey("Pack", "tone"), name: "Tone", text: "Keep a calm tone.\nUse short sentences.", enabled: true });
    library.add({ key: snippetKey("Pack", "off"), name: "Off", text: "Never shown.", enabled: false });
    const storage = createMemoryStorageAdapter();
    const registry = new ExtensionRegistry({ storage });
    registry.register(createPromptSnippetsExtension(library));
    return { library, storage, registry };
  }

  it("appends enabled snippet lines only", async () => {
    const { registry } = setup();
    await registry.start();
    const result = await registry.transformPromptNotes(["scene note"], notesContext);
    expect(result.notes).toEqual(["scene note", "Keep a calm tone.", "Use short sentences."]);
  });

  it("stays inside the allowance it is given and never trips the budget failure", async () => {
    const tight = new ExtensionRegistry({ notesBudget: { perExtensionChars: 25, totalChars: 25 } });
    const library = createSnippetLibrary();
    library.add({ key: "p/a", name: "A", text: "Keep a calm tone.\nUse short sentences.", enabled: true });
    tight.register(createPromptSnippetsExtension(library));
    await tight.start();
    const result = await tight.transformPromptNotes([], notesContext);
    expect(result.added).toEqual(["Keep a calm tone."]);
    expect(tight.listExtensions()[0].failureCount).toBe(0);
  });

  it("skips lines already present in the notes", async () => {
    const { registry } = setup();
    await registry.start();
    const result = await registry.transformPromptNotes(["Keep a calm tone."], notesContext);
    expect(result.added).toEqual(["Use short sentences."]);
  });

  it("persists toggles through extension storage and restores them", async () => {
    const { library, storage, registry } = setup();
    await registry.start();
    library.setEnabled(snippetKey("Pack", "off"), true);
    library.setEnabled(snippetKey("Pack", "tone"), false);
    await vi.waitFor(() => {
      expect(JSON.parse(storage.dump()["ext:glee.prompt-snippets:enabled"])).toEqual(["Pack/off"]);
    });

    const fresh = createSnippetLibrary();
    fresh.add({ key: "Pack/tone", name: "Tone", text: "t", enabled: true });
    fresh.add({ key: "Pack/off", name: "Off", text: "o", enabled: false });
    const second = new ExtensionRegistry({ storage });
    second.register(createPromptSnippetsExtension(fresh));
    await second.start();
    expect(fresh.list().map((s) => [s.id, s.enabled])).toEqual([
      ["Pack/tone", false],
      ["Pack/off", true],
    ]);
  });

  it("stops saving after it is disabled", async () => {
    const { library, storage, registry } = setup();
    await registry.start();
    await registry.disable("glee.prompt-snippets");
    library.setEnabled(snippetKey("Pack", "off"), true);
    await Promise.resolve();
    expect(storage.dump()["ext:glee.prompt-snippets:enabled"]).toBeUndefined();
  });
});

describe("chat-stats", () => {
  it("counts messages from events and renders them in a settings section", async () => {
    const store = createStatsStore();
    const registry = new ExtensionRegistry();
    registry.register(createChatStatsExtension(store));
    await registry.start();
    const [section] = registry.listSettingsSections();
    expect(section.title).toBe("Chat stats");
    render(<>{section.render()}</>);
    expect(screen.getByText(/0 messages, 0 words/)).toBeTruthy();
    await act(async () => {
      await registry.emit("chat:message-added", {
        chatId: "c1",
        message: message("two words"),
      });
    });
    expect(screen.getByText(/1 messages, 2 words/)).toBeTruthy();
  });
});

describe("createDefaultRegistry", () => {
  it("registers the built-ins as built-in and starts them cleanly", async () => {
    const registry = createDefaultRegistry();
    await registry.start();
    const infos = registry.listExtensions();
    expect(infos.map((i) => i.id)).toEqual([
      "glee.word-count",
      "glee.prompt-snippets",
      "glee.chat-stats",
    ]);
    expect(infos.every((i) => i.builtin && i.status === "active")).toBe(true);
  });
});
