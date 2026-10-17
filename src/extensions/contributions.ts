// Where registrations live. Keeping them in one removable-by-owner store is what
// makes hot disable work: deactivating an extension is a single filter.
import type {
  ChatLifecycleInfo,
  ComposerToolSpec,
  CommandSpec,
  MessageActionSpec,
  NotesContext,
  NotesContribution,
  ReplyView,
  SendDraft,
  BeforeSendResult,
  SettingsSectionSpec,
  Unsubscribe,
} from "./types";
import type { HookEntry } from "./pipeline";

export const DEFAULT_ORDER = 100;

export interface Ranked {
  extensionId: string;
}

export interface UiEntry<S> extends Ranked {
  localId: string;
  order: number;
  spec: S;
}

export type BeforeSendHandler = (draft: SendDraft) => BeforeSendResult | Promise<BeforeSendResult>;
export type NotesHandler = (
  notes: readonly string[],
  ctx: NotesContext,
) => NotesContribution | void | Promise<NotesContribution | void>;
export type ReplyHandler = (reply: ReplyView) => void | Promise<void>;
export type LifecycleHandler = (info: ChatLifecycleInfo) => void | Promise<void>;

interface HookKinds {
  beforeSend: BeforeSendHandler;
  transformPromptNotes: NotesHandler;
  afterReply: ReplyHandler;
  onChatOpened: LifecycleHandler;
  onChatClosed: LifecycleHandler;
}

export type HookKind = keyof HookKinds;
export type RankFn = (extensionId: string) => number;

export class Registrations {
  private commands: UiEntry<CommandSpec>[] = [];
  private settings: UiEntry<SettingsSectionSpec>[] = [];
  private messageActions: UiEntry<MessageActionSpec>[] = [];
  private composer: UiEntry<ComposerToolSpec>[] = [];
  private hooks: { [K in HookKind]: HookEntry<HookKinds[K]>[] } = {
    beforeSend: [],
    transformPromptNotes: [],
    afterReply: [],
    onChatOpened: [],
    onChatClosed: [],
  };

  constructor(
    private readonly rank: RankFn,
    private readonly onChange: () => void,
  ) {}

  private sortedUi<S>(entries: UiEntry<S>[]): UiEntry<S>[] {
    return [...entries].sort(
      (a, b) =>
        a.order - b.order ||
        this.rank(a.extensionId) - this.rank(b.extensionId) ||
        a.localId.localeCompare(b.localId),
    );
  }

  private addUi<S>(
    list: UiEntry<S>[],
    entry: UiEntry<S>,
    kind: string,
  ): Unsubscribe {
    if (list.some((e) => e.extensionId === entry.extensionId && e.localId === entry.localId)) {
      throw new Error(`${kind} "${entry.localId}" is already registered by this extension.`);
    }
    list.push(entry);
    this.onChange();
    return () => {
      const index = list.indexOf(entry);
      if (index >= 0) {
        list.splice(index, 1);
        this.onChange();
      }
    };
  }

  addCommand(entry: UiEntry<CommandSpec>): Unsubscribe {
    return this.addUi(this.commands, entry, "Command");
  }

  addSettings(entry: UiEntry<SettingsSectionSpec>): Unsubscribe {
    return this.addUi(this.settings, entry, "Settings section");
  }

  addMessageAction(entry: UiEntry<MessageActionSpec>): Unsubscribe {
    return this.addUi(this.messageActions, entry, "Message action");
  }

  addComposerTool(entry: UiEntry<ComposerToolSpec>): Unsubscribe {
    return this.addUi(this.composer, entry, "Composer tool");
  }

  addHook<K extends HookKind>(kind: K, entry: HookEntry<HookKinds[K]>): Unsubscribe {
    const list = this.hooks[kind] as HookEntry<HookKinds[K]>[];
    list.push(entry);
    return () => {
      const index = list.indexOf(entry);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  commandEntries(): UiEntry<CommandSpec>[] {
    return this.sortedUi(this.commands);
  }

  settingsEntries(): UiEntry<SettingsSectionSpec>[] {
    return this.sortedUi(this.settings);
  }

  messageActionEntries(): UiEntry<MessageActionSpec>[] {
    return this.sortedUi(this.messageActions);
  }

  composerEntries(): UiEntry<ComposerToolSpec>[] {
    return this.sortedUi(this.composer);
  }

  hookEntries<K extends HookKind>(kind: K): HookEntry<HookKinds[K]>[] {
    return [...(this.hooks[kind] as HookEntry<HookKinds[K]>[])].sort(
      (a, b) => this.rank(a.extensionId) - this.rank(b.extensionId),
    );
  }

  count(extensionId: string): number {
    const ui = [this.commands, this.settings, this.messageActions, this.composer];
    const uiCount = ui.reduce(
      (sum, list) => sum + list.filter((e) => e.extensionId === extensionId).length,
      0,
    );
    const hookCount = Object.values(this.hooks).reduce(
      (sum, list) => sum + list.filter((e) => e.extensionId === extensionId).length,
      0,
    );
    return uiCount + hookCount;
  }

  removeExtension(extensionId: string): void {
    const keep = <T extends Ranked>(list: T[]): T[] =>
      list.filter((entry) => entry.extensionId !== extensionId);
    this.commands = keep(this.commands);
    this.settings = keep(this.settings);
    this.messageActions = keep(this.messageActions);
    this.composer = keep(this.composer);
    const hooks = this.hooks as unknown as Record<HookKind, HookEntry<unknown>[]>;
    for (const kind of Object.keys(hooks) as HookKind[]) {
      hooks[kind] = keep(hooks[kind]);
    }
    this.onChange();
  }
}
