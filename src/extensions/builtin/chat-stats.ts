import { createElement, useSyncExternalStore, type ReactElement } from "react";
import type { Extension } from "../types";
import { countWords } from "./word-count";

export interface ChatStats {
  messages: number;
  words: number;
}

/** Session-only counters; kept outside React so the event handler can update them. */
export function createStatsStore() {
  let state: ChatStats = { messages: 0, words: 0 };
  const listeners = new Set<() => void>();
  return {
    get: (): ChatStats => state,
    add(content: string): void {
      state = { messages: state.messages + 1, words: state.words + countWords(content) };
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type StatsStore = ReturnType<typeof createStatsStore>;

function StatsPanel(props: { store: StatsStore }): ReactElement {
  const stats = useSyncExternalStore(props.store.subscribe, props.store.get, props.store.get);
  // The host draws the section frame and title; the panel is just content.
  return createElement(
    "p",
    { className: "settings-note" },
    `Since Glee opened: ${stats.messages} messages, ${stats.words} words.`,
  );
}

export function createChatStatsExtension(store: StatsStore = createStatsStore()): Extension {
  return {
    id: "glee.chat-stats",
    name: "Chat stats",
    version: "1.0.0",
    description: "Shows how many messages and words passed through chats this session.",
    apiVersion: "1",
    permissions: ["ui:settings", "chat:read"],
    activate(ctx) {
      ctx.events.on("chat:message-added", ({ message }) => store.add(message.content));
      ctx.settingsSections.register({
        id: "chat-stats",
        title: "Chat stats",
        order: 900,
        render: () => createElement(StatsPanel, { store }),
      });
    },
  };
}
