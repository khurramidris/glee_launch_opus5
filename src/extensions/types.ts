// Public contract between Glee and extensions. Everything an extension can see
// or do is declared here; nothing in this file imports app stores or IPC.
//
// React types are imported as types only: the core never loads React at runtime.
import type { ReactNode } from "react";
import type { Permission } from "./permissions";

export const API_VERSION = "1.0.0";

/** Read-only snapshot of a message. `content` is empty without `chat:read`. */
export interface MessageView {
  readonly id: string;
  readonly chatId: string;
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly speakerCharacterId?: string;
  readonly createdAt: string;
}

export interface ChatView {
  readonly id: string;
  readonly title: string;
  readonly mode: "single" | "group";
  readonly characterId?: string;
  readonly participantIds: readonly string[];
}

/** Effects an action may ask for; the host performs them, never the extension. */
export interface ActionResult {
  readonly notice?: string;
  readonly copyText?: string;
}

export type ActionOutcome = void | ActionResult | Promise<void | ActionResult>;

export interface CommandSpec {
  id: string;
  label: string;
  hint?: string;
  run: () => ActionOutcome;
}

export interface SettingsSectionSpec {
  id: string;
  title: string;
  order?: number;
  /** Return an element that wraps a component; do not call hooks in here. */
  render: () => ReactNode;
}

export interface MessageActionSpec {
  id: string;
  label: string;
  when?: (message: MessageView, chat: ChatView) => boolean;
  run: (message: MessageView, chat: ChatView) => ActionOutcome;
}

export interface ComposerToolSpec {
  id: string;
  order?: number;
  render: () => ReactNode;
}

export interface SendDraft {
  readonly chatId: string;
  readonly text: string;
}

export interface BeforeSendCancel {
  readonly cancel: true;
  readonly reason?: string;
}

export type BeforeSendResult = SendDraft | BeforeSendCancel | void;

export interface NotesContext {
  readonly chatId: string;
  readonly characterId?: string;
  readonly participantIds: readonly string[];
  readonly isGroup: boolean;
  readonly isRegeneration: boolean;
  /** Latest user text; empty without `chat:read`. */
  readonly userText: string;
  /** Characters this extension may still add in this turn. */
  readonly remainingChars: number;
}

/** Lines are added around the built-in notes; existing notes cannot be removed. */
export interface NotesContribution {
  readonly prepend?: readonly string[];
  readonly append?: readonly string[];
}

export interface ReplyView {
  readonly chatId: string;
  readonly messageId: string;
  readonly speakerCharacterId?: string;
  readonly content: string;
}

export interface ChatLifecycleInfo {
  readonly chat: ChatView;
}

export interface AppEvents {
  "chat:message-added": { chatId: string; message: MessageView };
  "chat:message-deleted": { chatId: string; messageId: string };
  "chat:cleared": { chatId: string };
  "runtime:status-changed": {
    status: "stopped" | "starting" | "running" | "error";
  };
  "character:changed": { characterId: string | null };
  "persona:changed": { chatId: string; personaId: string | null };
}

export type AppEventName = keyof AppEvents;
export type Unsubscribe = () => void;

export interface ExtensionStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface ExtensionLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface ChatPipelineApi {
  beforeSend(handler: (draft: SendDraft) => BeforeSendResult | Promise<BeforeSendResult>): Unsubscribe;
  transformPromptNotes(
    handler: (
      notes: readonly string[],
      ctx: NotesContext,
    ) => NotesContribution | void | Promise<NotesContribution | void>,
  ): Unsubscribe;
  afterReply(handler: (reply: ReplyView) => void | Promise<void>): Unsubscribe;
  onChatOpened(handler: (info: ChatLifecycleInfo) => void | Promise<void>): Unsubscribe;
  onChatClosed(handler: (info: ChatLifecycleInfo) => void | Promise<void>): Unsubscribe;
}

/** The only object an extension ever receives: registration functions. */
export interface ExtensionContext {
  readonly extensionId: string;
  readonly commands: { register(spec: CommandSpec): Unsubscribe };
  readonly settingsSections: { register(spec: SettingsSectionSpec): Unsubscribe };
  readonly messageActions: { register(spec: MessageActionSpec): Unsubscribe };
  readonly composerTools: { register(spec: ComposerToolSpec): Unsubscribe };
  readonly chatPipeline: ChatPipelineApi;
  readonly storage: ExtensionStorage;
  readonly events: {
    on<K extends AppEventName>(name: K, handler: (payload: AppEvents[K]) => void | Promise<void>): Unsubscribe;
  };
  readonly logger: ExtensionLogger;
}

export interface Extension {
  /** Dotted lowercase id, e.g. `glee.word-count`. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Contract version the extension was written against, e.g. `1` or `1.0.0`. */
  apiVersion: string;
  permissions: readonly Permission[];
  /** Ids of extensions that must be active first. */
  dependencies?: readonly string[];
  /** Lower runs first in pipeline hooks (default 100). */
  priority?: number;
  activate(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void;
}

export function cancelSend(reason?: string): BeforeSendCancel {
  return reason === undefined ? { cancel: true } : { cancel: true, reason };
}

export function isCancel(value: unknown): value is BeforeSendCancel {
  return (
    typeof value === "object" && value !== null && (value as { cancel?: unknown }).cancel === true
  );
}
