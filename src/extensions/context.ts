// Builds the object an extension receives. Every function checks its permission
// first and every callback is wrapped so (a) it goes inert once the extension is
// deactivated and (b) data the extension is not entitled to is redacted.
import type { Registrations, UiEntry } from "./contributions";
import type { EventBus } from "./event-bus";
import {
  PermissionDeniedError,
  type Permission,
} from "./permissions";
import { createExtensionStorage, type StorageAdapter } from "./storage";
import type {
  AppEventName,
  ChatView,
  Extension,
  ExtensionContext,
  ExtensionLogger,
  MessageView,
  NotesContext,
  ReplyView,
} from "./types";
import { DEFAULT_ORDER } from "./contributions";

export interface Session {
  alive: boolean;
}

export interface ContextDeps {
  extension: Extension;
  granted: ReadonlySet<Permission>;
  session: Session;
  registrations: Registrations;
  bus: EventBus;
  storage: StorageAdapter;
  logger: ExtensionLogger;
}

const LOCAL_ID_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;

/** Which permission each app event needs; `null` means any extension may listen. */
export const EVENT_PERMISSIONS: Record<AppEventName, Permission | null> = {
  "chat:message-added": "chat:read",
  "chat:message-deleted": "chat:read",
  "chat:cleared": "chat:read",
  "runtime:status-changed": null,
  "character:changed": "chat:read",
  "persona:changed": "chat:read",
};

export function redactMessage(message: MessageView): MessageView {
  return { ...message, content: "" };
}

export function redactChat(chat: ChatView): ChatView {
  return { ...chat, title: "" };
}

export function createContext(deps: ContextDeps): ExtensionContext {
  const { extension, granted, session, registrations, bus } = deps;
  const id = extension.id;

  function requireAlive(): void {
    if (!session.alive) {
      throw new Error(`Extension "${id}" is no longer active.`);
    }
  }

  function needs(permission: Permission, action: string): void {
    if (!granted.has(permission)) {
      throw new PermissionDeniedError(id, permission, action);
    }
    requireAlive();
  }

  function localId(value: string): string {
    if (!LOCAL_ID_PATTERN.test(value)) {
      throw new Error(
        `Registration id "${value}" must be lowercase letters, digits, "-" or "_" (max 48).`,
      );
    }
    return value;
  }

  function order(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_ORDER;
  }

  const canRead = granted.has("chat:read");
  const message = (value: MessageView): MessageView => (canRead ? value : redactMessage(value));
  const chat = (value: ChatView): ChatView => (canRead ? value : redactChat(value));

  const ui = <S>(entry: Omit<UiEntry<S>, "extensionId">): UiEntry<S> => ({
    ...entry,
    extensionId: id,
  });

  return {
    extensionId: id,
    commands: {
      register(spec) {
        needs("ui:commands", "add command palette entries");
        const lid = localId(spec.id);
        return registrations.addCommand(
          ui({ localId: lid, order: DEFAULT_ORDER, spec: { ...spec, id: lid } }),
        );
      },
    },
    settingsSections: {
      register(spec) {
        needs("ui:settings", "add a Settings section");
        const lid = localId(spec.id);
        return registrations.addSettings(
          ui({ localId: lid, order: order(spec.order), spec: { ...spec, id: lid } }),
        );
      },
    },
    messageActions: {
      register(spec) {
        needs("ui:message-actions", "add message toolbar buttons");
        const lid = localId(spec.id);
        const { when, run } = spec;
        return registrations.addMessageAction(
          ui({
            localId: lid,
            order: DEFAULT_ORDER,
            spec: {
              ...spec,
              id: lid,
              ...(when ? { when: (m, c) => when(message(m), chat(c)) } : {}),
              run: (m, c) => run(message(m), chat(c)),
            },
          }),
        );
      },
    },
    composerTools: {
      register(spec) {
        needs("ui:composer", "add composer controls");
        const lid = localId(spec.id);
        return registrations.addComposerTool(
          ui({ localId: lid, order: order(spec.order), spec: { ...spec, id: lid } }),
        );
      },
    },
    chatPipeline: {
      beforeSend(handler) {
        needs("chat:write", "change or cancel outgoing messages");
        return registrations.addHook("beforeSend", {
          extensionId: id,
          handler: (draft) =>
            session.alive
              ? handler(canRead ? draft : { chatId: draft.chatId, text: "" })
              : undefined,
        });
      },
      transformPromptNotes(handler) {
        needs("prompt:notes", "add lines to the prompt notes");
        return registrations.addHook("transformPromptNotes", {
          extensionId: id,
          handler: (notes, ctx: NotesContext) =>
            session.alive
              ? handler(notes, canRead ? ctx : { ...ctx, userText: "" })
              : undefined,
        });
      },
      afterReply(handler) {
        needs("chat:read", "observe replies");
        return registrations.addHook("afterReply", {
          extensionId: id,
          handler: (reply: ReplyView) => (session.alive ? handler(reply) : undefined),
        });
      },
      onChatOpened(handler) {
        needs("chat:read", "observe chats opening");
        return registrations.addHook("onChatOpened", {
          extensionId: id,
          handler: (info) => (session.alive ? handler(info) : undefined),
        });
      },
      onChatClosed(handler) {
        needs("chat:read", "observe chats closing");
        return registrations.addHook("onChatClosed", {
          extensionId: id,
          handler: (info) => (session.alive ? handler(info) : undefined),
        });
      },
    },
    storage: guardedStorage(),
    events: {
      on(name, handler) {
        const needed = EVENT_PERMISSIONS[name];
        if (needed === undefined) {
          throw new Error(`Unknown event "${String(name)}".`);
        }
        if (needed) {
          needs(needed, `listen to "${name}"`);
        } else {
          requireAlive();
        }
        return bus.on({
          extensionId: id,
          name,
          handler: (payload) => (session.alive ? handler(payload) : undefined),
        });
      },
    },
    logger: deps.logger,
  };

  function guardedStorage(): ExtensionContext["storage"] {
    const store = createExtensionStorage(id, deps.storage);
    const gate = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        needs("storage", "use extension storage");
        return fn(...args);
      };
    return {
      get: gate(store.get) as ExtensionContext["storage"]["get"],
      set: gate(store.set),
      remove: gate(store.remove),
      keys: gate(store.keys),
    };
  }
}
