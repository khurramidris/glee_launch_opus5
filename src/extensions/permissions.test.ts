import { describe, expect, it } from "vitest";
import { PERMISSIONS, PERMISSION_INFO, PermissionDeniedError, isPermission, permissionStatus } from "./permissions";
import { ExtensionRegistry } from "./registry";
import { createMemoryStorageAdapter } from "./storage";
import { chat, makeExtension, message } from "./testing/fixtures";
import { createMisbehavingExtension } from "./testing/misbehaving";
import type { ExtensionContext } from "./types";

async function activeContext(permissions: Parameters<typeof makeExtension>[1], storage = createMemoryStorageAdapter()) {
  const registry = new ExtensionRegistry({ storage });
  let captured: ExtensionContext | undefined;
  registry.register(
    makeExtension("t.perm", permissions, (ctx) => {
      captured = ctx;
    }),
  );
  await registry.start();
  return { registry, ctx: captured as ExtensionContext, storage };
}

describe("permission table", () => {
  it("describes every permission exactly once", () => {
    expect(PERMISSION_INFO.map((p) => p.permission).sort()).toEqual([...PERMISSIONS].sort());
    expect(isPermission("chat:read")).toBe(true);
    expect(isPermission("root")).toBe(false);
    expect(permissionStatus("network")).toBe("denied");
    expect(permissionStatus("memory:read")).toBe("reserved");
  });
});

describe("enforcement", () => {
  const noop = () => undefined;
  const cases: [string, (ctx: ExtensionContext) => unknown, string][] = [
    ["commands", (c) => c.commands.register({ id: "a", label: "A", run: noop }), "ui:commands"],
    ["settings", (c) => c.settingsSections.register({ id: "a", title: "A", render: () => null }), "ui:settings"],
    ["message actions", (c) => c.messageActions.register({ id: "a", label: "A", run: noop }), "ui:message-actions"],
    ["composer", (c) => c.composerTools.register({ id: "a", render: () => null }), "ui:composer"],
    ["beforeSend", (c) => c.chatPipeline.beforeSend(noop), "chat:write"],
    ["notes", (c) => c.chatPipeline.transformPromptNotes(noop), "prompt:notes"],
    ["afterReply", (c) => c.chatPipeline.afterReply(noop), "chat:read"],
    ["opened", (c) => c.chatPipeline.onChatOpened(noop), "chat:read"],
    ["closed", (c) => c.chatPipeline.onChatClosed(noop), "chat:read"],
    ["message event", (c) => c.events.on("chat:message-added", noop), "chat:read"],
    ["character event", (c) => c.events.on("character:changed", noop), "chat:read"],
  ];

  it.each(cases)("%s throws without the %s permission", async (_name, call, permission) => {
    const { ctx } = await activeContext([]);
    expect(() => call(ctx)).toThrow(PermissionDeniedError);
    expect(() => call(ctx)).toThrow(permission);
  });

  it.each(cases)("%s works with its permission", async (_name, call, permission) => {
    const { ctx } = await activeContext([permission as never]);
    expect(() => call(ctx)).not.toThrow();
  });

  it("lets any extension watch the runtime status event", async () => {
    const { ctx } = await activeContext([]);
    expect(() => ctx.events.on("runtime:status-changed", () => undefined)).not.toThrow();
  });

  it("rejects an unknown event name", async () => {
    const { ctx } = await activeContext([]);
    expect(() => ctx.events.on("nope" as never, () => undefined)).toThrow(/Unknown event/);
  });

  it("denies every storage call without the storage permission", async () => {
    const { ctx } = await activeContext([]);
    await expect(ctx.storage.get("a")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(ctx.storage.set("a", 1)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(ctx.storage.remove("a")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(ctx.storage.keys()).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("fails activation of an extension that uses an undeclared permission", async () => {
    const registry = new ExtensionRegistry();
    registry.register(createMisbehavingExtension({ useUndeclaredPermission: true }).extension);
    await registry.start();
    const info = registry.listExtensions()[0];
    expect(info.status).toBe("failed");
    expect(info.statusReason).toContain("ui:message-actions");
    expect(registry.listMessageActions(message("x"), chat)).toEqual([]);
  });
});

describe("storage isolation", () => {
  it("namespaces keys per extension", async () => {
    const storage = createMemoryStorageAdapter();
    const registry = new ExtensionRegistry({ storage });
    const contexts: ExtensionContext[] = [];
    for (const id of ["t.a", "t.b"]) {
      registry.register(makeExtension(id, ["storage"], (ctx) => void contexts.push(ctx)));
    }
    await registry.start();
    await contexts[0].storage.set("token", "alpha");
    await expect(contexts[1].storage.get("token")).resolves.toBeUndefined();
    await expect(contexts[0].storage.keys()).resolves.toEqual(["token"]);
    expect(Object.keys(storage.dump())).toContain("ext:t.a:token");
  });
});

describe("redaction without chat:read", () => {
  it("hides message text and chat titles from message actions", async () => {
    const registry = new ExtensionRegistry();
    const seen: string[] = [];
    registry.register(
      makeExtension("t.blind", ["ui:message-actions"], (ctx) => {
        ctx.messageActions.register({
          id: "peek",
          label: "Peek",
          when: (m, c) => {
            seen.push(`when:${m.content}|${c.title}`);
            return true;
          },
          run: (m, c) => void seen.push(`run:${m.content}|${c.title}`),
        });
      }),
    );
    await registry.start();
    const [action] = registry.listMessageActions(message("secret"), chat);
    await action.run();
    expect(seen).toEqual(["when:|", "run:|"]);
  });

  it("passes real text when chat:read is declared", async () => {
    const registry = new ExtensionRegistry();
    const seen: string[] = [];
    registry.register(
      makeExtension("t.sighted", ["ui:message-actions", "chat:read"], (ctx) => {
        ctx.messageActions.register({
          id: "peek",
          label: "Peek",
          run: (m, c) => void seen.push(`${m.content}|${c.title}`),
        });
      }),
    );
    await registry.start();
    await registry.listMessageActions(message("secret"), chat)[0].run();
    expect(seen).toEqual(["secret|Harbour talk"]);
  });

  it("hides the user's text from prompt-note hooks and the draft from beforeSend", async () => {
    const registry = new ExtensionRegistry();
    const seen: string[] = [];
    registry.register(
      makeExtension("t.blind", ["prompt:notes", "chat:write"], (ctx) => {
        ctx.chatPipeline.transformPromptNotes((_n, c) => void seen.push(`notes:${c.userText}`));
        ctx.chatPipeline.beforeSend((d) => void seen.push(`draft:${d.text}`));
      }),
    );
    await registry.start();
    await registry.transformPromptNotes([], {
      chatId: "c", participantIds: [], isGroup: false, isRegeneration: false, userText: "private",
    });
    await registry.beforeSend({ chatId: "c", text: "private" });
    expect(seen).toEqual(["notes:", "draft:"]);
  });
});
