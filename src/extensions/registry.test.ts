import { describe, expect, it, vi } from "vitest";
import { ExtensionRegistry } from "./registry";
import { createMemoryStorageAdapter } from "./storage";
import { chat, makeExtension, message } from "./testing/fixtures";
import { createMisbehavingExtension } from "./testing/misbehaving";

describe("registration", () => {
  it("rejects malformed extensions with a readable reason", () => {
    const registry = new ExtensionRegistry();
    const bad = [
      makeExtension("Bad Id", []),
      makeExtension("ok.id", [], undefined, { name: "  " }),
      makeExtension("ok.id", [], undefined, { version: "one" }),
      makeExtension("ok.id", ["telepathy" as never]),
    ];
    for (const extension of bad) {
      const result = registry.register(extension);
      expect(result.ok).toBe(false);
    }
    expect(registry.listExtensions()).toHaveLength(0);
  });

  it("rejects a duplicate id", () => {
    const registry = new ExtensionRegistry();
    expect(registry.register(makeExtension("a.one", [])).ok).toBe(true);
    const second = registry.register(makeExtension("a.one", []));
    expect(second).toEqual({ ok: false, reason: expect.stringContaining("already registered") });
  });

  it("marks a different API major as incompatible and never activates it", async () => {
    const registry = new ExtensionRegistry();
    const activate = vi.fn();
    registry.register(makeExtension("a.old", [], activate, { apiVersion: "2" }));
    registry.register(makeExtension("a.newer-minor", [], activate, { apiVersion: "1.9" }));
    await registry.start();
    const [old, newer] = registry.listExtensions();
    expect(old.status).toBe("incompatible");
    expect(old.statusReason).toContain("extension API 2");
    expect(newer.status).toBe("incompatible");
    expect(activate).not.toHaveBeenCalled();
    expect((await registry.enable("a.old")).ok).toBe(false);
  });

  it("accepts an older minor of the same major", async () => {
    const registry = new ExtensionRegistry({ apiVersion: "1.4.0" });
    registry.register(makeExtension("a.ok", [], undefined, { apiVersion: "1.2" }));
    await registry.start();
    expect(registry.listExtensions()[0].status).toBe("active");
  });

  it("refuses extensions that ask for the network", async () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a.net", ["network"]));
    await registry.start();
    expect(registry.listExtensions()[0]).toMatchObject({ status: "incompatible" });
    expect(registry.listExtensions()[0].statusReason).toContain("network");
  });

  it("accepts the reserved memory:read permission without granting anything", async () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a.mem", ["memory:read"]));
    await registry.start();
    expect(registry.listExtensions()[0].status).toBe("active");
  });
});

describe("lifecycle", () => {
  it("activates on start, calls deactivate on disable and removes registrations", async () => {
    const registry = new ExtensionRegistry();
    const deactivate = vi.fn();
    registry.register(
      makeExtension(
        "a.cmd",
        ["ui:commands"],
        (ctx) => {
          ctx.commands.register({ id: "hi", label: "Hi", hint: "Say hi", run: () => undefined });
        },
        { deactivate },
      ),
    );
    await registry.start();
    expect(registry.listCommands().map((c) => c.id)).toEqual(["a.cmd:hi"]);
    expect(registry.listExtensions()[0].contributionCount).toBe(1);

    await registry.disable("a.cmd");
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(registry.listCommands()).toEqual([]);
    expect(registry.listExtensions()[0]).toMatchObject({
      status: "disabled",
      disabledBy: "user",
    });

    expect((await registry.enable("a.cmd")).ok).toBe(true);
    expect(registry.listCommands()).toHaveLength(1);
  });

  it("remembers user-disabled extensions across registries via the storage adapter", async () => {
    const storage = createMemoryStorageAdapter();
    const first = new ExtensionRegistry({ storage });
    first.register(makeExtension("a.one", []));
    await first.start();
    await first.disable("a.one");

    const second = new ExtensionRegistry({ storage });
    const activate = vi.fn();
    second.register(makeExtension("a.one", [], activate));
    await second.start();
    expect(activate).not.toHaveBeenCalled();
    expect(second.listExtensions()[0]).toMatchObject({ status: "disabled", disabledBy: "user" });
  });

  it("does not activate a registration made after preferences loaded if the user disabled it", async () => {
    const storage = createMemoryStorageAdapter({ "registry:disabled": '["a.late"]' });
    const registry = new ExtensionRegistry({ storage });
    await registry.start();
    const activate = vi.fn();
    registry.register(makeExtension("a.late", [], activate));
    await registry.start();
    expect(activate).not.toHaveBeenCalled();
  });

  it("start is idempotent and picks up later registrations", async () => {
    const registry = new ExtensionRegistry();
    const first = vi.fn();
    const second = vi.fn();
    registry.register(makeExtension("a.one", [], first));
    await registry.start();
    registry.register(makeExtension("a.two", [], second));
    await registry.start();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("marks a throwing activate as failed and leaves nothing registered", async () => {
    const registry = new ExtensionRegistry();
    const { extension } = createMisbehavingExtension({ throwOnActivate: true });
    registry.register(extension);
    await registry.start();
    const info = registry.listExtensions()[0];
    expect(info.status).toBe("failed");
    expect(info.statusReason).toContain("activation exploded");
    expect(registry.listCommands()).toEqual([]);
  });

  it("cleans up partial registrations when activate fails midway", async () => {
    const registry = new ExtensionRegistry();
    registry.register(
      makeExtension("a.half", ["ui:commands"], (ctx) => {
        ctx.commands.register({ id: "one", label: "One", run: () => undefined });
        throw new Error("nope");
      }),
    );
    await registry.start();
    expect(registry.listCommands()).toEqual([]);
  });

  it("gives up on an activate that never finishes", async () => {
    const registry = new ExtensionRegistry({ activationTimeoutMs: 20 });
    registry.register(createMisbehavingExtension({ hangOnActivate: true }).extension);
    await registry.start();
    expect(registry.listExtensions()[0].status).toBe("failed");
    expect(registry.listExtensions()[0].statusReason).toContain("longer than");
  });

  it("undoes registrations when disabled while still activating", async () => {
    const registry = new ExtensionRegistry();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deactivate = vi.fn();
    registry.register(
      makeExtension(
        "a.slow",
        ["ui:commands"],
        async (ctx) => {
          ctx.commands.register({ id: "x", label: "X", run: () => undefined });
          await gate;
        },
        { deactivate },
      ),
    );
    const starting = registry.start();
    await Promise.resolve();
    await registry.disable("a.slow");
    release();
    await starting;
    expect(registry.listCommands()).toEqual([]);
    expect(registry.listExtensions()[0].status).toBe("disabled");
    expect(deactivate).toHaveBeenCalled();
  });

  it("makes a leaked context inert after deactivation", async () => {
    const registry = new ExtensionRegistry();
    const handle = createMisbehavingExtension({ leakContext: true });
    registry.register(handle.extension);
    await registry.start();
    const ctx = handle.leaked();
    await registry.disable(handle.extension.id);
    expect(() =>
      ctx?.commands.register({ id: "late", label: "Late", run: () => undefined }),
    ).toThrow(/no longer active/);
    await expect(ctx?.storage.get("k")).rejects.toThrow();
    expect(registry.listCommands()).toEqual([]);
  });

  it("survives a deactivate that throws", async () => {
    const registry = new ExtensionRegistry();
    registry.register(
      makeExtension("a.bad", [], undefined, {
        deactivate() {
          throw new Error("cleanup failed");
        },
      }),
    );
    await registry.start();
    await expect(registry.disable("a.bad")).resolves.toBe(true);
    expect(registry.getLogs("a.bad").some((l) => l.message.includes("cleanup failed"))).toBe(true);
  });

  it("unregister removes the extension entirely", async () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a.one", ["ui:commands"], (ctx) => {
      ctx.commands.register({ id: "c", label: "C", run: () => undefined });
    }));
    await registry.start();
    await expect(registry.unregister("a.one")).resolves.toBe(true);
    await expect(registry.unregister("a.one")).resolves.toBe(false);
    expect(registry.listExtensions()).toEqual([]);
    expect(registry.listCommands()).toEqual([]);
  });

  it("returns an error result when enabling an unknown id and false when disabling one", async () => {
    const registry = new ExtensionRegistry();
    expect((await registry.enable("nope.nope")).ok).toBe(false);
    expect(await registry.disable("nope.nope")).toBe(false);
  });
});

describe("dependencies", () => {
  it("activates dependencies first regardless of registration order", async () => {
    const registry = new ExtensionRegistry();
    const order: string[] = [];
    registry.register(makeExtension("a.child", [], () => void order.push("child"), { dependencies: ["a.base"] }));
    registry.register(makeExtension("a.base", [], () => void order.push("base")));
    await registry.start();
    expect(order).toEqual(["base", "child"]);
  });

  it("disables dependents when a dependency is turned off and restores them on enable", async () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a.base", []));
    registry.register(makeExtension("a.child", [], undefined, { dependencies: ["a.base"] }));
    await registry.start();
    await registry.disable("a.base");
    const child = registry.listExtensions().find((e) => e.id === "a.child");
    expect(child).toMatchObject({ status: "disabled", disabledBy: "dependency" });
    await registry.enable("a.base");
    expect(registry.listExtensions().every((e) => e.status === "active")).toBe(true);
  });

  it("keeps an extension with a missing dependency disabled with a reason", async () => {
    const registry = new ExtensionRegistry();
    const activate = vi.fn();
    registry.register(makeExtension("a.child", [], activate, { dependencies: ["a.ghost"] }));
    await registry.start();
    expect(activate).not.toHaveBeenCalled();
    expect(registry.listExtensions()[0].statusReason).toContain("a.ghost");
  });

  it("does not loop forever on a dependency cycle", async () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a.x", [], undefined, { dependencies: ["a.y"] }));
    registry.register(makeExtension("a.y", [], undefined, { dependencies: ["a.x"] }));
    await registry.start();
    expect(registry.listExtensions().every((e) => e.status === "disabled")).toBe(true);
  });
});

describe("ordering", () => {
  it("sorts contributions by order, then extension priority, then registration order", async () => {
    const registry = new ExtensionRegistry();
    const make = (id: string, order: number, priority?: number) =>
      makeExtension(
        id,
        ["ui:settings"],
        (ctx) => {
          ctx.settingsSections.register({ id: "s", title: id, order, render: () => null });
        },
        priority === undefined ? {} : { priority },
      );
    registry.register(make("a.third", 100));
    registry.register(make("a.first", 10));
    registry.register(make("a.prio", 100, 1));
    registry.register(make("a.fourth", 100));
    await registry.start();
    expect(registry.listSettingsSections().map((s) => s.title)).toEqual([
      "a.first",
      "a.prio",
      "a.third",
      "a.fourth",
    ]);
  });

  it("rejects duplicate local ids within one extension", async () => {
    const registry = new ExtensionRegistry();
    registry.register(
      makeExtension("a.dup", ["ui:commands"], (ctx) => {
        ctx.commands.register({ id: "same", label: "A", run: () => undefined });
        ctx.commands.register({ id: "same", label: "B", run: () => undefined });
      }),
    );
    await registry.start();
    expect(registry.listExtensions()[0].status).toBe("failed");
  });

  it("rejects ids that could collide with namespacing", async () => {
    const registry = new ExtensionRegistry();
    registry.register(
      makeExtension("a.id", ["ui:commands"], (ctx) => {
        ctx.commands.register({ id: "Bad:Id", label: "A", run: () => undefined });
      }),
    );
    await registry.start();
    expect(registry.listExtensions()[0].status).toBe("failed");
  });

  it("allows the same local id in different extensions", async () => {
    const registry = new ExtensionRegistry();
    for (const id of ["a.one", "a.two"]) {
      registry.register(
        makeExtension(id, ["ui:commands"], (ctx) => {
          ctx.commands.register({ id: "run", label: id, run: () => undefined });
        }),
      );
    }
    await registry.start();
    expect(registry.listCommands().map((c) => c.id)).toEqual(["a.one:run", "a.two:run"]);
  });
});

describe("snapshots and subscriptions", () => {
  it("returns a stable snapshot until something changes", async () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a.one", []));
    const a = registry.getSnapshot();
    expect(registry.getSnapshot()).toBe(a);
    await registry.start();
    expect(registry.getSnapshot()).not.toBe(a);
  });

  it("notifies subscribers once per lifecycle step and supports unsubscribe", async () => {
    const registry = new ExtensionRegistry();
    registry.register(makeExtension("a.one", []));
    const listener = vi.fn();
    const off = registry.subscribe(listener);
    await registry.start();
    const afterStart = listener.mock.calls.length;
    expect(afterStart).toBeGreaterThan(0);
    off();
    await registry.disable("a.one");
    expect(listener).toHaveBeenCalledTimes(afterStart);
  });

  it("keeps notifying other subscribers when one throws", async () => {
    const registry = new ExtensionRegistry();
    registry.subscribe(() => {
      throw new Error("bad subscriber");
    });
    const good = vi.fn();
    registry.subscribe(good);
    registry.register(makeExtension("a.one", []));
    expect(good).toHaveBeenCalled();
  });

  it("dispose deactivates everything", async () => {
    const registry = new ExtensionRegistry();
    const deactivate = vi.fn();
    registry.register(makeExtension("a.one", [], undefined, { deactivate }));
    await registry.start();
    await registry.dispose();
    expect(deactivate).toHaveBeenCalled();
  });
});

describe("actions", () => {
  it("applies host effects for returned notices and copy text", async () => {
    const notify = vi.fn();
    const copyText = vi.fn();
    const registry = new ExtensionRegistry({ host: { notify, copyText } });
    registry.register(
      makeExtension("a.act", ["ui:commands", "ui:message-actions", "chat:read"], (ctx) => {
        ctx.commands.register({ id: "go", label: "Go", run: () => ({ notice: "done" }) });
        ctx.messageActions.register({
          id: "copy",
          label: "Copy",
          run: (m) => ({ copyText: m.content }),
        });
      }),
    );
    await registry.start();
    await registry.listCommands()[0].run();
    expect(notify).toHaveBeenCalledWith({ kind: "info", message: "done" });
    const actions = registry.listMessageActions(message("hello"), chat);
    await actions[0].run();
    expect(copyText).toHaveBeenCalledWith("hello");
  });

  it("caps notice and clipboard sizes", async () => {
    const notify = vi.fn();
    const copyText = vi.fn();
    const registry = new ExtensionRegistry({ host: { notify, copyText } });
    registry.register(
      makeExtension("a.big", ["ui:commands"], (ctx) => {
        ctx.commands.register({
          id: "go",
          label: "Go",
          run: () => ({ notice: "n".repeat(5000), copyText: "c".repeat(50_000) }),
        });
      }),
    );
    await registry.start();
    await registry.listCommands()[0].run();
    expect(notify.mock.calls[0][0].message).toHaveLength(300);
    expect(copyText.mock.calls[0][0]).toHaveLength(10_000);
  });

  it("turns a throwing command into a notice and a counted failure, never a rejection", async () => {
    const notify = vi.fn();
    const registry = new ExtensionRegistry({ host: { notify } });
    registry.register(createMisbehavingExtension({ throwInCommand: true }).extension);
    await registry.start();
    await expect(registry.listCommands()[0].run()).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error", message: expect.stringContaining("command exploded") }),
    );
    expect(registry.listExtensions()[0].failureCount).toBe(1);
  });

  it("filters message actions with when() and treats a throwing when() as false", async () => {
    const registry = new ExtensionRegistry();
    registry.register(
      makeExtension("a.when", ["ui:message-actions", "chat:read"], (ctx) => {
        ctx.messageActions.register({
          id: "assistant-only",
          label: "A",
          when: (m) => m.role === "assistant",
          run: () => undefined,
        });
        ctx.messageActions.register({
          id: "broken",
          label: "B",
          when: () => {
            throw new Error("when exploded");
          },
          run: () => undefined,
        });
      }),
    );
    await registry.start();
    expect(registry.listMessageActions(message("x"), chat).map((a) => a.label)).toEqual(["A"]);
    expect(registry.listMessageActions(message("x", { role: "user" }), chat)).toEqual([]);
    await Promise.resolve();
    expect(registry.listExtensions()[0].failureCount).toBeGreaterThan(0);
  });

  it("stale action views do nothing once the extension is disabled", async () => {
    const registry = new ExtensionRegistry();
    const run = vi.fn();
    registry.register(
      makeExtension("a.stale", ["ui:commands"], (ctx) => {
        ctx.commands.register({ id: "go", label: "Go", run });
      }),
    );
    await registry.start();
    const view = registry.listCommands()[0];
    await registry.disable("a.stale");
    await view.run();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns null from a throwing settings render and counts it", async () => {
    const registry = new ExtensionRegistry();
    registry.register(createMisbehavingExtension({ throwInRender: true }).extension);
    await registry.start();
    expect(registry.listSettingsSections()[0].render()).toBeNull();
    await Promise.resolve();
    expect(registry.listExtensions()[0].failureCount).toBe(1);
  });
});

describe("logging", () => {
  it("scopes logger output to the extension and forwards it to the sink", async () => {
    const sink = vi.fn();
    const registry = new ExtensionRegistry({ logSink: sink });
    registry.register(
      makeExtension("a.log", [], (ctx) => {
        ctx.logger.info("hello", { n: 1 });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        ctx.logger.warn("cycle", cyclic);
      }),
    );
    await registry.start();
    expect(sink).toHaveBeenCalledWith("a.log", expect.objectContaining({ message: 'hello {"n":1}' }));
    expect(registry.getLogs("a.log").some((l) => l.message.includes("[unserializable]"))).toBe(true);
    expect(registry.getLogs("other")).toEqual([]);
  });

  it("keeps only the latest log lines and survives a throwing sink", async () => {
    const registry = new ExtensionRegistry({
      logSink: () => {
        throw new Error("sink down");
      },
    });
    registry.register(
      makeExtension("a.chatty", [], (ctx) => {
        for (let i = 0; i < 150; i += 1) {
          ctx.logger.debug(`line ${i}`);
        }
      }),
    );
    await registry.start();
    const logs = registry.getLogs("a.chatty");
    expect(logs.length).toBe(100);
    expect(logs[logs.length - 1]?.message).toBe("Activated.");
  });
});

describe("unsubscribing individual registrations", () => {
  it("removes just that contribution and its hook", async () => {
    const registry = new ExtensionRegistry();
    const seen = vi.fn();
    registry.register(
      makeExtension("a.unsub", ["ui:commands", "ui:settings", "ui:message-actions", "ui:composer", "chat:read"], (ctx) => {
        const offCommand = ctx.commands.register({ id: "one", label: "One", run: () => undefined });
        ctx.commands.register({ id: "two", label: "Two", run: () => undefined });
        const offSection = ctx.settingsSections.register({ id: "s", title: "S", render: () => null });
        const offAction = ctx.messageActions.register({ id: "m", label: "M", run: () => undefined });
        const offTool = ctx.composerTools.register({ id: "t", render: () => null });
        const offHook = ctx.chatPipeline.afterReply(seen);
        const offEvent = ctx.events.on("chat:cleared", seen);
        offCommand();
        offCommand();
        offSection();
        offAction();
        offTool();
        offHook();
        offEvent();
      }),
    );
    await registry.start();
    expect(registry.listCommands().map((c) => c.label)).toEqual(["Two"]);
    expect(registry.listSettingsSections()).toEqual([]);
    expect(registry.listComposerTools()).toEqual([]);
    expect(registry.listMessageActions(message("x"), chat)).toEqual([]);
    await registry.afterReply({ chatId: "c", messageId: "m", content: "x" });
    await registry.emit("chat:cleared", { chatId: "c" });
    expect(seen).not.toHaveBeenCalled();
  });
});
