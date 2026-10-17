// @vitest-environment jsdom
import { act, render, renderHook, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ExtensionProvider,
  lazyRender,
  useComposerTools,
  useExtensionRegistry,
  useExtensions,
  useMessageActions,
  useRegisteredCommands,
  useSettingsSections,
} from "./react";
import { ExtensionRegistry } from "./registry";
import { chat, makeExtension, message } from "./testing/fixtures";
import { createMisbehavingExtension } from "./testing/misbehaving";

function wrapperFor(registry: ExtensionRegistry) {
  return ({ children }: { children?: ReactNode }) => createElement(ExtensionProvider, { registry }, children);
}

function commandExtension(id: string) {
  return makeExtension(id, ["ui:commands"], (ctx) => {
    ctx.commands.register({ id: "go", label: `Go ${id}`, hint: "Hint", run: () => undefined });
  });
}

describe("hooks", () => {
  it("throws outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useExtensionRegistry())).toThrow(/ExtensionProvider/);
    spy.mockRestore();
  });

  it("useRegisteredCommands follows enable and disable", async () => {
    const registry = new ExtensionRegistry();
    registry.register(commandExtension("r.one"));
    await registry.start();
    const { result } = renderHook(() => useRegisteredCommands(), { wrapper: wrapperFor(registry) });
    expect(result.current.map((c) => c.label)).toEqual(["Go r.one"]);

    await act(async () => {
      await registry.disable("r.one");
    });
    expect(result.current).toEqual([]);

    await act(async () => {
      await registry.enable("r.one");
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ hint: "Hint" });
  });

  it("returns a referentially stable value between unrelated renders", async () => {
    const registry = new ExtensionRegistry();
    registry.register(commandExtension("r.one"));
    await registry.start();
    const { result, rerender } = renderHook(() => useRegisteredCommands(), {
      wrapper: wrapperFor(registry),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("useExtensions reports status changes including auto-disable", async () => {
    const registry = new ExtensionRegistry({ maxFailures: 1 });
    registry.register(createMisbehavingExtension({ throwInBeforeSend: true }).extension);
    await registry.start();
    const { result } = renderHook(() => useExtensions(), { wrapper: wrapperFor(registry) });
    expect(result.current[0].status).toBe("active");
    await act(async () => {
      await registry.beforeSend({ chatId: "c", text: "x" });
    });
    expect(result.current[0]).toMatchObject({ status: "disabled", disabledBy: "auto" });
  });

  it("useMessageActions filters per message and refreshes on registry changes", async () => {
    const registry = new ExtensionRegistry();
    registry.register(
      makeExtension("r.msg", ["ui:message-actions", "chat:read"], (ctx) => {
        ctx.messageActions.register({
          id: "a",
          label: "Only assistant",
          when: (m) => m.role === "assistant",
          run: () => undefined,
        });
      }),
    );
    await registry.start();
    const assistant = message("hi");
    const user = message("hi", { role: "user" });
    const { result, rerender } = renderHook(
      ({ m }) => useMessageActions(m, chat),
      { wrapper: wrapperFor(registry), initialProps: { m: assistant } },
    );
    expect(result.current.map((a) => a.label)).toEqual(["Only assistant"]);
    rerender({ m: user });
    expect(result.current).toEqual([]);
    rerender({ m: assistant });
    await act(async () => {
      await registry.disable("r.msg");
    });
    expect(result.current).toEqual([]);
  });

  it("useSettingsSections and useComposerTools render extension components inside boundaries", async () => {
    const registry = new ExtensionRegistry();
    registry.register(
      makeExtension("r.ui", ["ui:settings", "ui:composer"], (ctx) => {
        ctx.settingsSections.register({
          id: "s",
          title: "Mine",
          render: () => createElement("p", null, "settings body"),
        });
        ctx.composerTools.register({
          id: "c",
          order: 5,
          render: () => createElement("span", null, "composer body"),
        });
      }),
    );
    await registry.start();
    const wrapper = wrapperFor(registry);
    const sections = renderHook(() => useSettingsSections(), { wrapper });
    const tools = renderHook(() => useComposerTools(), { wrapper });
    expect(sections.result.current.map((s) => s.title)).toEqual(["Mine"]);
    render(createElement("div", null, sections.result.current[0].node, tools.result.current[0].node));
    expect(screen.getByText("settings body")).toBeTruthy();
    expect(screen.getByText("composer body")).toBeTruthy();
  });

  it("contains a component that crashes while rendering and reports it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = new ExtensionRegistry();
    function Crash(): ReactNode {
      throw new Error("component exploded");
    }
    registry.register(
      makeExtension("r.crash", ["ui:composer"], (ctx) => {
        ctx.composerTools.register({ id: "c", render: () => createElement(Crash) });
      }),
    );
    await registry.start();
    const tools = renderHook(() => useComposerTools(), { wrapper: wrapperFor(registry) });
    render(createElement("div", { "data-testid": "host" }, tools.result.current[0].node, "still here"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("host").textContent).toBe("still here");
    expect(registry.listExtensions()[0].lastError).toContain("component exploded");
    spy.mockRestore();
  });

  it("lazyRender loads a component on demand", async () => {
    const registry = new ExtensionRegistry();
    registry.register(
      makeExtension("r.lazy", ["ui:settings"], (ctx) => {
        ctx.settingsSections.register({
          id: "s",
          title: "Lazy",
          render: lazyRender(async () => ({ default: (p: { text: string }) => createElement("p", null, p.text) }), {
            text: "loaded later",
          }),
        });
      }),
    );
    await registry.start();
    const sections = renderHook(() => useSettingsSections(), { wrapper: wrapperFor(registry) });
    render(createElement("div", null, sections.result.current[0].node));
    expect(await screen.findByText("loaded later")).toBeTruthy();
  });
});
