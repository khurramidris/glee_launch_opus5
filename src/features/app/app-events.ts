import type { ExtensionRegistry } from "../../extensions";
import type { ChatView } from "../../extensions";
import { characterStore, chatStore, modelStore } from "../../stores";
import type { ChatSummary } from "../../types";

function chatView(chat: ChatSummary, participantIds: readonly string[]): ChatView {
  return {
    id: chat.id,
    title: chat.title,
    mode: chat.chatMode === "group" ? "group" : "single",
    characterId: chat.characterId ?? undefined,
    participantIds,
  };
}

/**
 * Forwards app activity to extensions from one place, so feature code never
 * needs to know extensions exist. Returns a function that stops listening.
 */
export function connectAppEvents(registry: ExtensionRegistry): () => void {
  let previousChatId = chatStore.getState().activeChatId;
  let previousMessageCounts = new Map<string, number>(
    Object.entries(chatStore.getState().messagesByChat).map(([id, list]) => [id, list.length]),
  );
  let previousRuntimeStatus = modelStore.getState().runtime.status;
  let previousCharacterId = characterStore.getState().activeCharacterId;

  const viewFor = (chatId: string | null): ChatView | null => {
    if (!chatId) {
      return null;
    }
    const state = chatStore.getState();
    const chat = state.chats.find((item) => item.id === chatId);
    return chat ? chatView(chat, state.participantsByChat[chatId] ?? []) : null;
  };

  const stopChat = chatStore.subscribe((state) => {
    if (state.activeChatId !== previousChatId) {
      const closed = viewFor(previousChatId);
      previousChatId = state.activeChatId;
      const opened = viewFor(state.activeChatId);
      if (closed) {
        void registry.chatClosed(closed);
      }
      if (opened) {
        void registry.chatOpened(opened);
      }
    }
    const nextCounts = new Map<string, number>();
    for (const [chatId, messages] of Object.entries(state.messagesByChat)) {
      nextCounts.set(chatId, messages.length);
      const before = previousMessageCounts.get(chatId) ?? messages.length;
      if (messages.length === before + 1) {
        const message = messages[messages.length - 1];
        registry.emit("chat:message-added", {
          chatId,
          message: {
            id: message.id,
            chatId: message.chatId,
            role: message.role,
            content: message.content,
            speakerCharacterId: message.speakerCharacterId,
            createdAt: message.createdAt,
          },
        });
      }
    }
    previousMessageCounts = nextCounts;
  });

  const stopModel = modelStore.subscribe((state) => {
    if (state.runtime.status !== previousRuntimeStatus) {
      previousRuntimeStatus = state.runtime.status;
      registry.emit("runtime:status-changed", { status: state.runtime.status });
    }
  });

  const stopCharacter = characterStore.subscribe((state) => {
    if (state.activeCharacterId !== previousCharacterId) {
      previousCharacterId = state.activeCharacterId;
      registry.emit("character:changed", { characterId: state.activeCharacterId });
    }
  });

  return () => {
    stopChat();
    stopModel();
    stopCharacter();
  };
}
