import type { Permission } from "../permissions";
import type { ChatView, Extension, ExtensionContext, MessageView } from "../types";

export const chat: ChatView = {
  id: "chat-1",
  title: "Harbour talk",
  mode: "single",
  characterId: "char-1",
  participantIds: ["char-1"],
};

export function message(content: string, overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: "m1",
    chatId: "chat-1",
    role: "assistant",
    content,
    createdAt: "2000-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeExtension(
  id: string,
  permissions: Permission[],
  activate: (ctx: ExtensionContext) => void | Promise<void> = () => undefined,
  extra: Partial<Extension> = {},
): Extension {
  return {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: "1",
    permissions,
    activate,
    ...extra,
  };
}
