import { create } from "zustand";
import type { ChatMemory, ChatMessage, ChatSummary } from "../types";
import * as api from "../api/tauri";
import { resolveStateUpdate, type StateUpdater } from "./store-utils";

interface StreamingState {
  speakerCharacterId?: string;
  targetMessageId?: string;
  content: string;
}

type ChatReplyState = "queued" | "streaming";

function sortChatsByRecent(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function upsertInList(prev: ChatSummary[], next: ChatSummary): ChatSummary[] {
  return sortChatsByRecent([next, ...prev.filter((c) => c.id !== next.id)]);
}

interface ChatState {
  chats: ChatSummary[];
  activeChatId: string | null;
  messagesByChat: Record<string, ChatMessage[]>;
  participantsByChat: Record<string, string[]>;
  memoryByChat: Record<string, ChatMemory>;
  composerInput: string;
  replyStateByChat: Record<string, ChatReplyState | undefined>;
  streamingByChat: Record<string, StreamingState | null | undefined>;
  editingMessageId: string | null;
  editingMessageDraft: string;
  messageActionBusyId: string | null;
  savingMemory: boolean;

  groupBuilderOpen: boolean;
  groupTitle: string;
  groupSelection: string[];
  creatingGroup: boolean;

  setChats: (chats: StateUpdater<ChatSummary[]>) => void;
  setActiveChatId: (id: StateUpdater<string | null>) => void;
  upsertChat: (chat: ChatSummary) => void;
  setComposerInput: (input: string) => void;
  setReplyState: (chatId: string, state: ChatReplyState | null) => void;
  setStreaming: (chatId: string, streaming: StreamingState | null) => void;
  setMessagesByChat: (
    updater: StateUpdater<Record<string, ChatMessage[]>>,
  ) => void;
  setParticipantsByChat: (
    updater: StateUpdater<Record<string, string[]>>,
  ) => void;
  setMemoryByChat: (updater: StateUpdater<Record<string, ChatMemory>>) => void;
  setMessages: (chatId: string, messages: ChatMessage[]) => void;
  appendLocalMessage: (chatId: string, message: ChatMessage) => void;
  updateLocalMessage: (chatId: string, messageId: string, content: string) => void;
  setParticipants: (chatId: string, ids: string[]) => void;
  setMemory: (chatId: string, memory: ChatMemory) => void;
  setEditingMessageId: (id: string | null) => void;
  setEditingMessageDraft: (draft: string) => void;
  setMessageActionBusyId: (id: string | null) => void;
  setSavingMemory: (v: boolean) => void;

  setGroupBuilderOpen: (open: StateUpdater<boolean>) => void;
  setGroupTitle: (title: string) => void;
  setGroupSelection: (ids: StateUpdater<string[]>) => void;
  setCreatingGroup: (v: boolean) => void;
  resetGroupBuilder: () => void;

  startEditMessage: (messageId: string, content: string) => void;
  cancelEditMessage: () => void;

  loadMessages: (chatId: string) => Promise<ChatMessage[]>;
  loadParticipants: (chatId: string) => Promise<string[]>;
  loadMemory: (chatId: string) => Promise<ChatMemory>;
}

export const chatStore = create<ChatState>()((set) => ({
  chats: [],
  activeChatId: null,
  messagesByChat: {},
  participantsByChat: {},
  memoryByChat: {},
  composerInput: "",
  replyStateByChat: {},
  streamingByChat: {},
  editingMessageId: null,
  editingMessageDraft: "",
  messageActionBusyId: null,
  savingMemory: false,

  groupBuilderOpen: false,
  groupTitle: "",
  groupSelection: [],
  creatingGroup: false,

  setChats: (chats) => set((state) => ({ chats: resolveStateUpdate(state.chats, chats) })),
  setActiveChatId: (id) =>
    set((state) => ({ activeChatId: resolveStateUpdate(state.activeChatId, id) })),
  upsertChat: (chat) => set((s) => ({ chats: upsertInList(s.chats, chat) })),
  setComposerInput: (input) => set({ composerInput: input }),
  setReplyState: (chatId, state) =>
    set((s) => ({
      replyStateByChat: state
        ? { ...s.replyStateByChat, [chatId]: state }
        : Object.fromEntries(
            Object.entries(s.replyStateByChat).filter(([id]) => id !== chatId),
          ),
    })),
  setStreaming: (chatId, streaming) =>
    set((s) => ({
      streamingByChat: streaming
        ? { ...s.streamingByChat, [chatId]: streaming }
        : Object.fromEntries(
            Object.entries(s.streamingByChat).filter(([id]) => id !== chatId),
          ),
    })),
  setMessagesByChat: (updater) =>
    set((state) => ({
      messagesByChat: resolveStateUpdate(state.messagesByChat, updater),
    })),
  setParticipantsByChat: (updater) =>
    set((state) => ({
      participantsByChat: resolveStateUpdate(state.participantsByChat, updater),
    })),
  setMemoryByChat: (updater) =>
    set((state) => ({ memoryByChat: resolveStateUpdate(state.memoryByChat, updater) })),
  setMessages: (chatId, messages) =>
    set((s) => ({ messagesByChat: { ...s.messagesByChat, [chatId]: messages } })),
  appendLocalMessage: (chatId, message) =>
    set((s) => ({
      messagesByChat: {
        ...s.messagesByChat,
        [chatId]: [...(s.messagesByChat[chatId] ?? []), message],
      },
    })),
  updateLocalMessage: (chatId, messageId, content) =>
    set((s) => ({
      messagesByChat: {
        ...s.messagesByChat,
        [chatId]: (s.messagesByChat[chatId] ?? []).map((m) =>
          m.id === messageId ? { ...m, content } : m,
        ),
      },
    })),
  setParticipants: (chatId, ids) =>
    set((s) => ({ participantsByChat: { ...s.participantsByChat, [chatId]: ids } })),
  setMemory: (chatId, memory) =>
    set((s) => ({ memoryByChat: { ...s.memoryByChat, [chatId]: memory } })),
  setEditingMessageId: (id) => set({ editingMessageId: id }),
  setEditingMessageDraft: (draft) => set({ editingMessageDraft: draft }),
  setMessageActionBusyId: (id) => set({ messageActionBusyId: id }),
  setSavingMemory: (v) => set({ savingMemory: v }),

  setGroupBuilderOpen: (open) =>
    set((state) => ({ groupBuilderOpen: resolveStateUpdate(state.groupBuilderOpen, open) })),
  setGroupTitle: (title) => set({ groupTitle: title }),
  setGroupSelection: (ids) =>
    set((state) => ({ groupSelection: resolveStateUpdate(state.groupSelection, ids) })),
  setCreatingGroup: (v) => set({ creatingGroup: v }),
  resetGroupBuilder: () =>
    set({ groupBuilderOpen: false, groupTitle: "", groupSelection: [], creatingGroup: false }),

  startEditMessage: (messageId, content) =>
    set({ editingMessageId: messageId, editingMessageDraft: content }),
  cancelEditMessage: () =>
    set({ editingMessageId: null, editingMessageDraft: "" }),

  loadMessages: async (chatId) => {
    const messages = await api.getChatMessages(chatId);
    set((s) => ({ messagesByChat: { ...s.messagesByChat, [chatId]: messages } }));
    return messages;
  },

  loadParticipants: async (chatId) => {
    const ids = await api.listChatParticipants(chatId);
    set((s) => ({ participantsByChat: { ...s.participantsByChat, [chatId]: ids } }));
    return ids;
  },

  loadMemory: async (chatId) => {
    const memory = await api.getChatMemory(chatId);
    set((s) => ({ memoryByChat: { ...s.memoryByChat, [chatId]: memory } }));
    return memory;
  },
}));

export const useChatStore = chatStore;

export type { ChatReplyState, StreamingState };
