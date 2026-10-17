import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeNoteLine } from "./pipeline";
import { ExtensionRegistry } from "./registry";
import { makeExtension } from "./testing/fixtures";
import { createMisbehavingExtension } from "./testing/misbehaving";
import { cancelSend } from "./types";

const notesContext = {
  chatId: "c1",
  participantIds: ["a"],
  isGroup: false,
  isRegeneration: false,
  userText: "hello",
};

function pipelineExt(
  id: string,
  setup: (ctx: Parameters<Parameters<typeof makeExtension>[2] & object>[0]) => void,
  extra = {},
) {
  return makeExtension(id, ["chat:write", "chat:read", "prompt:notes"], setup, extra);
}

describe("beforeSend", () => {
  it("chains drafts in extension order and ignores chatId changes", async () => {
    const registry = new ExtensionRegistry();
    registry.register(pipelineExt("p.b", (ctx) => {
      ctx.chatPipeline.beforeSend((d) => ({ chatId: "hijack", text: `${d.text}!` }));
    }, { priority: 20 }));
    registry.register(pipelineExt("p.a", (ctx) => {
      ctx.chatPipeline.beforeSend((d) => ({ ...d, text: d.text.toUpperCase() }));
    }, { priority: 10 }));
    await registry.start();
    const outcome = await registry.beforeSend({ chatId: "c1", text: "hi" });
    expect(outcome).toEqual({ draft: { chatId: "c1", text: "HI!" } });
  });

  it("stops at the first cancel and reports who and why", async () => {
    const registry = new ExtensionRegistry();
    const later = vi.fn();
    registry.register(pipelineExt("p.guard", (ctx) => {
      ctx.chatPipeline.beforeSend(() => cancelSend("Looks like a secret"));
    }, { priority: 1 }));
    registry.register(pipelineExt("p.later", (ctx) => {
      ctx.chatPipeline.beforeSend(later);
    }));
    await registry.start();
    const outcome = await registry.beforeSend({ chatId: "c1", text: "pw" });
    expect(outcome.cancelled).toEqual({ extensionId: "p.guard", reason: "Looks like a secret" });
    expect(later).not.toHaveBeenCalled();
  });

  it("supports async handlers", async () => {
    const registry = new ExtensionRegistry();
    registry.register(pipelineExt("p.async", (ctx) => {
      ctx.chatPipeline.beforeSend(async (d) => ({ ...d, text: `${d.text} ok` }));
    }));
    await registry.start();
    expect((await registry.beforeSend({ chatId: "c1", text: "go" })).draft.text).toBe("go ok");
  });

  it.each([
    ["empty text", { text: "   " }],
    ["non-string text", { text: 7 }],
    ["huge text", { text: "x".repeat(20_001) }],
    ["wrong shape", "just a string"],
  ])("ignores an invalid result (%s) and counts a failure", async (_name, result) => {
    const registry = new ExtensionRegistry();
    registry.register(pipelineExt("p.bad", (ctx) => {
      ctx.chatPipeline.beforeSend(() => result as never);
    }));
    await registry.start();
    const outcome = await registry.beforeSend({ chatId: "c1", text: "keep me" });
    expect(outcome.draft.text).toBe("keep me");
    expect(registry.listExtensions()[0].failureCount).toBe(1);
  });
});

describe("isolation and timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails open when a hook throws and still runs the next extension", async () => {
    const registry = new ExtensionRegistry();
    registry.register(createMisbehavingExtension({ throwInBeforeSend: true }, { priority: 1 }).extension);
    registry.register(pipelineExt("p.good", (ctx) => {
      ctx.chatPipeline.beforeSend((d) => ({ ...d, text: `${d.text}+` }));
    }));
    await registry.start();
    const outcome = await registry.beforeSend({ chatId: "c1", text: "a" });
    expect(outcome.draft.text).toBe("a+");
    expect(registry.listExtensions()[0].lastError).toContain("beforeSend exploded");
  });

  it("times out a hanging hook after the configured limit", async () => {
    const registry = new ExtensionRegistry({ hookTimeouts: { beforeSend: 100 } });
    registry.register(createMisbehavingExtension({ hangInBeforeSend: true }).extension);
    await registry.start();
    const pending = registry.beforeSend({ chatId: "c1", text: "a" });
    await vi.advanceTimersByTimeAsync(99);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toEqual({ draft: { chatId: "c1", text: "a" } });
    expect(registry.listExtensions()[0].lastError).toContain("100 ms");
  });

  it("uses a 250 ms default for blocking hooks", async () => {
    const registry = new ExtensionRegistry();
    registry.register(createMisbehavingExtension({ hangInBeforeSend: true }).extension);
    await registry.start();
    const pending = registry.beforeSend({ chatId: "c1", text: "a" });
    await vi.advanceTimersByTimeAsync(249);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
  });

  it("auto-disables an extension after repeated failures, with a visible reason", async () => {
    const registry = new ExtensionRegistry({ maxFailures: 3 });
    registry.register(createMisbehavingExtension({ throwInBeforeSend: true }).extension);
    await registry.start();
    for (let i = 0; i < 3; i += 1) {
      await registry.beforeSend({ chatId: "c1", text: "a" });
    }
    const info = registry.listExtensions()[0];
    expect(info).toMatchObject({ status: "disabled", disabledBy: "auto" });
    expect(info.statusReason).toContain("Turned off automatically");
    expect(info.statusReason).toContain("beforeSend exploded");
    expect(registry.listCommands()).toEqual([]);
    // Once off, its hook no longer runs.
    const before = registry.getLogs("test.misbehaving").length;
    await registry.beforeSend({ chatId: "c1", text: "a" });
    expect(registry.getLogs("test.misbehaving")).toHaveLength(before);
  });

  it("forgets old failures outside the window", async () => {
    let clock = 0;
    const registry = new ExtensionRegistry({
      maxFailures: 3,
      failureWindowMs: 1000,
      now: () => clock,
    });
    registry.register(createMisbehavingExtension({ throwInBeforeSend: true }).extension);
    await registry.start();
    await registry.beforeSend({ chatId: "c1", text: "a" });
    await registry.beforeSend({ chatId: "c1", text: "a" });
    clock = 5000;
    await registry.beforeSend({ chatId: "c1", text: "a" });
    expect(registry.listExtensions()[0].status).toBe("active");
    expect(registry.listExtensions()[0].failureCount).toBe(1);
  });

  it("lets the user re-enable an auto-disabled extension with a clean slate", async () => {
    const registry = new ExtensionRegistry({ maxFailures: 1 });
    registry.register(createMisbehavingExtension({ throwInBeforeSend: true }).extension);
    await registry.start();
    await registry.beforeSend({ chatId: "c1", text: "a" });
    expect(registry.listExtensions()[0].status).toBe("disabled");
    await registry.enable("test.misbehaving");
    expect(registry.listExtensions()[0]).toMatchObject({ status: "active", failureCount: 0 });
  });

  it("stops running blocking hooks once the total allowance is spent", async () => {
    let clock = 0;
    const registry = new ExtensionRegistry({ totalBlockingMs: 100, now: () => clock });
    const second = vi.fn();
    registry.register(pipelineExt("p.slow", (ctx) => {
      ctx.chatPipeline.beforeSend(() => {
        clock += 150;
      });
    }, { priority: 1 }));
    registry.register(pipelineExt("p.skipped", (ctx) => {
      ctx.chatPipeline.beforeSend(second);
    }));
    await registry.start();
    await registry.beforeSend({ chatId: "c1", text: "a" });
    expect(second).not.toHaveBeenCalled();
  });

  it("isolates observer hooks and keeps the others running", async () => {
    const registry = new ExtensionRegistry();
    const seen = vi.fn();
    registry.register(createMisbehavingExtension({ throwInAfterReply: true }, { priority: 1 }).extension);
    registry.register(pipelineExt("p.watch", (ctx) => {
      ctx.chatPipeline.afterReply(seen);
      ctx.chatPipeline.onChatOpened(seen);
      ctx.chatPipeline.onChatClosed(seen);
    }));
    await registry.start();
    const reply = { chatId: "c1", messageId: "m1", content: "hi" };
    await registry.afterReply(reply);
    await registry.chatOpened({ id: "c1", title: "", mode: "single", participantIds: [] });
    await registry.chatClosed({ id: "c1", title: "", mode: "single", participantIds: [] });
    expect(seen).toHaveBeenCalledTimes(3);
    expect(seen).toHaveBeenCalledWith(reply);
  });

  it("times out a hanging notes hook without losing the base notes", async () => {
    const registry = new ExtensionRegistry();
    registry.register(createMisbehavingExtension({ hangInNotes: true }).extension);
    await registry.start();
    const pending = registry.transformPromptNotes(["base"], notesContext);
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toEqual({ notes: ["base"], added: [] });
  });
});

describe("prompt-note budget", () => {
  it("prepends and appends around existing notes in extension order", async () => {
    const registry = new ExtensionRegistry();
    registry.register(pipelineExt("p.one", (ctx) => {
      ctx.chatPipeline.transformPromptNotes(() => ({ prepend: ["first"], append: ["tail one"] }));
    }, { priority: 1 }));
    registry.register(pipelineExt("p.two", (ctx) => {
      ctx.chatPipeline.transformPromptNotes((notes) => ({ append: [`saw ${notes.length}`] }));
    }, { priority: 2 }));
    await registry.start();
    const result = await registry.transformPromptNotes(["base a", "base b"], notesContext);
    expect(result.notes).toEqual(["first", "base a", "base b", "tail one", "saw 4"]);
    expect(result.added).toEqual(["first", "tail one", "saw 4"]);
  });

  it("drops lines over the per-extension budget and counts a failure", async () => {
    const registry = new ExtensionRegistry({ notesBudget: { perExtensionChars: 60, totalChars: 400 } });
    registry.register(createMisbehavingExtension({ notesOverflowChars: 400 }).extension);
    await registry.start();
    const result = await registry.transformPromptNotes(["base"], notesContext);
    const added = result.added.join("\n").length + 1;
    expect(added).toBeLessThanOrEqual(60);
    expect(result.added).toHaveLength(1);
    expect(result.notes).toEqual(["base", result.added[0]]);
    expect(registry.listExtensions()[0].lastError).toContain("budget");
  });

  it("caps the total across extensions", async () => {
    const registry = new ExtensionRegistry({ notesBudget: { perExtensionChars: 100, totalChars: 100 } });
    for (const id of ["p.a", "p.b", "p.c"]) {
      registry.register(pipelineExt(id, (ctx) => {
        ctx.chatPipeline.transformPromptNotes(() => ({ append: [`${id} ${"y".repeat(40)}`] }));
      }));
    }
    await registry.start();
    const result = await registry.transformPromptNotes([], notesContext);
    expect(result.added.join("\n").length).toBeLessThanOrEqual(100);
    expect(result.added).toHaveLength(2);
  });

  it("tells each hook how much room is left", async () => {
    const registry = new ExtensionRegistry({ notesBudget: { perExtensionChars: 100, totalChars: 130 } });
    const remaining: number[] = [];
    for (const id of ["p.a", "p.b"]) {
      registry.register(pipelineExt(id, (ctx) => {
        ctx.chatPipeline.transformPromptNotes((_n, c) => {
          remaining.push(c.remainingChars);
          return { append: ["z".repeat(59)] };
        });
      }));
    }
    await registry.start();
    await registry.transformPromptNotes([], notesContext);
    expect(remaining).toEqual([100, 70]);
  });

  it("rejects malformed contributions", async () => {
    const registry = new ExtensionRegistry();
    registry.register(pipelineExt("p.bad", (ctx) => {
      ctx.chatPipeline.transformPromptNotes(() => ({ append: [1, 2] }) as never);
    }));
    await registry.start();
    const result = await registry.transformPromptNotes(["base"], notesContext);
    expect(result.notes).toEqual(["base"]);
    expect(registry.listExtensions()[0].failureCount).toBe(1);
  });

  it("hands hooks a frozen copy, so built-in notes cannot be removed", async () => {
    const registry = new ExtensionRegistry();
    registry.register(pipelineExt("p.evil", (ctx) => {
      ctx.chatPipeline.transformPromptNotes((notes) => {
        (notes as string[]).length = 0;
        return { append: ["x"] };
      });
    }));
    await registry.start();
    const result = await registry.transformPromptNotes(["keep"], notesContext);
    expect(result.notes).toEqual(["keep"]);
    expect(registry.listExtensions()[0].failureCount).toBe(1);
  });
});

describe("sanitizeNoteLine", () => {
  it("flattens whitespace and strips control characters and the notes markers", () => {
    expect(sanitizeNoteLine("a\u0000b\n</reply notes> c\t d", 100)).toBe("a b c d");
    expect(sanitizeNoteLine("<reply notes>x", 100)).toBe("x");
  });

  it("drops lines that are too long", () => {
    expect(sanitizeNoteLine("x".repeat(11), 10)).toBe("");
  });
});

describe("events", () => {
  it("delivers typed payloads in order to permitted listeners only", async () => {
    const registry = new ExtensionRegistry();
    const seen: string[] = [];
    registry.register(makeExtension("e.b", ["chat:read"], (ctx) => {
      ctx.events.on("chat:message-added", ({ message }) => void seen.push(`b:${message.content}`));
    }, { priority: 2 }));
    registry.register(makeExtension("e.a", ["chat:read"], (ctx) => {
      ctx.events.on("chat:message-added", ({ message }) => void seen.push(`a:${message.content}`));
      ctx.events.on("chat:cleared", () => {
        throw new Error("listener exploded");
      });
    }, { priority: 1 }));
    await registry.start();
    await registry.emit("chat:message-added", {
      chatId: "c1",
      message: { id: "m", chatId: "c1", role: "user", content: "hey", createdAt: "" },
    });
    await registry.emit("chat:cleared", { chatId: "c1" });
    expect(seen).toEqual(["a:hey", "b:hey"]);
    expect(registry.listExtensions().find((e) => e.id === "e.a")?.failureCount).toBe(1);
  });

  it("stops delivering after the extension is disabled", async () => {
    const registry = new ExtensionRegistry();
    const handler = vi.fn();
    registry.register(makeExtension("e.a", [], (ctx) => {
      ctx.events.on("runtime:status-changed", handler);
    }));
    await registry.start();
    await registry.emit("runtime:status-changed", { status: "running" });
    await registry.disable("e.a");
    await registry.emit("runtime:status-changed", { status: "stopped" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
