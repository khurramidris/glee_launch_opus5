import { Registrations } from "./contributions";
import { createContext, type Session } from "./context";
import { EventBus } from "./event-bus";
import { DEFAULT_FAILURE_POLICY, FailureTracker } from "./failure-tracker";
import {
  DEFAULT_HOOK_TIMEOUTS,
  DEFAULT_NOTES_BUDGET,
  DEFAULT_TOTAL_BLOCKING_MS,
  describeError,
  runBeforeSend,
  runIsolated,
  runObservers,
  runTransformNotes,
  type BeforeSendOutcome,
  type HookFailure,
  type HookReporter,
  type HookTimeouts,
  type NotesBudget,
  type NotesOutcome,
  type RunOptions,
} from "./pipeline";
import { isPermission, permissionStatus, type Permission } from "./permissions";
import type {
  CommandView,
  ComposerToolView,
  DisabledBy,
  ExtensionInfo,
  ExtensionStatus,
  HostEffects,
  LogEntry,
  MessageActionView,
  RegisterOptions,
  RegisterResult,
  RegistryOptions,
  RegistrySnapshot,
  SettingsSectionView,
} from "./registry-types";
import { createMemoryStorageAdapter, type StorageAdapter } from "./storage";
import {
  API_VERSION,
  type ActionOutcome,
  type AppEventName,
  type AppEvents,
  type ChatView,
  type Extension,
  type ExtensionLogger,
  type MessageView,
  type NotesContext,
  type ReplyView,
  type SendDraft,
} from "./types";
import { checkApiCompatibility, parseVersion } from "./version";

const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const DISABLED_KEY = "registry:disabled";
const LOG_LIMIT = 100;
const MAX_NOTICE_CHARS = 300;
const MAX_COPY_CHARS = 10_000;

interface Entry {
  extension: Extension;
  builtin: boolean;
  seq: number;
  status: ExtensionStatus;
  disabledBy?: DisabledBy;
  reason?: string;
  session: Session | null;
}

export class ExtensionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly userDisabled = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly logs = new Map<string, LogEntry[]>();
  private readonly registrations: Registrations;
  private readonly bus = new EventBus();
  private readonly tracker: FailureTracker;
  private readonly storage: StorageAdapter;
  private readonly host: HostEffects;
  private readonly now: () => number;
  private readonly apiVersion: string;
  private readonly timeouts: HookTimeouts;
  private readonly budget: NotesBudget;
  private readonly totalBlockingMs: number;
  private readonly activationTimeoutMs: number;
  private readonly logSink?: RegistryOptions["logSink"];
  private seq = 0;
  private version = 0;
  private batch = 0;
  private dirty = false;
  private snapshot: RegistrySnapshot | null = null;
  private prefsLoaded = false;

  constructor(options: RegistryOptions = {}) {
    this.apiVersion = options.apiVersion ?? API_VERSION;
    this.storage = options.storage ?? createMemoryStorageAdapter();
    this.host = options.host ?? {};
    this.now = options.now ?? Date.now;
    this.timeouts = { ...DEFAULT_HOOK_TIMEOUTS, ...options.hookTimeouts };
    this.budget = { ...DEFAULT_NOTES_BUDGET, ...options.notesBudget };
    this.totalBlockingMs = options.totalBlockingMs ?? DEFAULT_TOTAL_BLOCKING_MS;
    this.activationTimeoutMs = options.activationTimeoutMs ?? 2_000;
    this.logSink = options.logSink;
    this.tracker = new FailureTracker({
      maxFailures: options.maxFailures ?? DEFAULT_FAILURE_POLICY.maxFailures,
      windowMs: options.failureWindowMs ?? DEFAULT_FAILURE_POLICY.windowMs,
      now: this.now,
    });
    this.registrations = new Registrations(
      (id) => this.rankOf(id),
      () => this.changed(),
    );
  }

  // ---- lifecycle -----------------------------------------------------------

  register(extension: Extension, options: RegisterOptions = {}): RegisterResult {
    const problem = validateShape(extension);
    if (problem) {
      return { ok: false, reason: problem };
    }
    if (this.entries.has(extension.id)) {
      return { ok: false, reason: `An extension with id "${extension.id}" is already registered.` };
    }
    const entry: Entry = {
      extension,
      builtin: options.builtin ?? false,
      seq: this.seq++,
      status: "inactive",
      session: null,
    };
    const compat = checkApiCompatibility(extension.apiVersion, this.apiVersion);
    const unsupported = extension.permissions.find((p) => permissionStatus(p) === "denied");
    if (!compat.ok) {
      entry.status = "incompatible";
      entry.reason = compat.reason;
    } else if (unsupported) {
      entry.status = "incompatible";
      entry.reason = `Asks for the "${unsupported}" permission, which is not available.`;
    } else if (this.prefsLoaded && this.userDisabled.has(extension.id)) {
      markDisabled(entry, "user", "Turned off by you.");
    }
    this.entries.set(extension.id, entry);
    this.changed();
    return { ok: true };
  }

  async unregister(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    this.batched(() => {
      this.stop(entry, "inactive");
      this.cascade(entry);
      this.entries.delete(id);
      this.tracker.reset(id);
      this.logs.delete(id);
    });
    return true;
  }

  /** Activates every extension that is not turned off. Safe to call again. */
  async start(): Promise<void> {
    await this.loadPreferences();
    for (const entry of this.entries.values()) {
      if (entry.status === "inactive" && this.userDisabled.has(entry.extension.id)) {
        markDisabled(entry, "user", "Turned off by you.");
      }
    }
    this.changed();
    for (const entry of this.activationOrder()) {
      await this.activate(entry);
    }
  }

  async enable(id: string): Promise<RegisterResult> {
    await this.loadPreferences();
    const entry = this.entries.get(id);
    if (!entry) {
      return { ok: false, reason: `No extension with id "${id}".` };
    }
    if (entry.status === "incompatible") {
      return { ok: false, reason: entry.reason ?? "Not compatible with this version of Glee." };
    }
    if (entry.status === "active") {
      return { ok: true };
    }
    this.userDisabled.delete(id);
    await this.savePreferences();
    this.tracker.reset(id);
    entry.status = "inactive";
    delete entry.disabledBy;
    delete entry.reason;
    await this.activate(entry);
    if ((entry.status as ExtensionStatus) !== "active") {
      return { ok: false, reason: entry.reason ?? "Could not start." };
    }
    const waiting = this.activationOrder(
      (e) => e.status === "disabled" && e.disabledBy === "dependency",
    );
    for (const dependent of waiting) {
      dependent.status = "inactive";
      await this.activate(dependent);
    }
    return { ok: true };
  }

  async disable(id: string): Promise<boolean> {
    await this.loadPreferences();
    const entry = this.entries.get(id);
    if (!entry || entry.status === "incompatible") {
      return false;
    }
    this.userDisabled.add(id);
    await this.savePreferences();
    this.batched(() => {
      this.stop(entry, "disabled", "user", "Turned off by you.");
      this.cascade(entry);
    });
    return true;
  }

  async dispose(): Promise<void> {
    this.batched(() => {
      for (const entry of this.entries.values()) {
        this.stop(entry, "inactive");
      }
    });
    this.listeners.clear();
  }

  // ---- hot paths (called by the app) --------------------------------------

  beforeSend(draft: SendDraft): Promise<BeforeSendOutcome> {
    return runBeforeSend(
      this.registrations.hookEntries("beforeSend"),
      draft,
      this.runOptions("beforeSend", true),
    );
  }

  transformPromptNotes(
    notes: readonly string[],
    context: Omit<NotesContext, "remainingChars">,
  ): Promise<NotesOutcome> {
    return runTransformNotes(
      this.registrations.hookEntries("transformPromptNotes"),
      notes,
      context,
      { ...this.runOptions("transformPromptNotes", true), budget: this.budget },
    );
  }

  afterReply(reply: ReplyView): Promise<void> {
    return runObservers(
      this.registrations.hookEntries("afterReply"),
      [reply],
      this.runOptions("afterReply", false),
    );
  }

  chatOpened(chat: ChatView): Promise<void> {
    return runObservers(
      this.registrations.hookEntries("onChatOpened"),
      [{ chat }],
      this.runOptions("onChatOpened", false),
    );
  }

  chatClosed(chat: ChatView): Promise<void> {
    return runObservers(
      this.registrations.hookEntries("onChatClosed"),
      [{ chat }],
      this.runOptions("onChatClosed", false),
    );
  }

  emit<K extends AppEventName>(name: K, payload: AppEvents[K]): Promise<void> {
    const entries = this.bus
      .listenersFor(name)
      .map((listener) => ({
        extensionId: listener.extensionId,
        handler: (value: AppEvents[K]) => listener.handler(value),
      }))
      .sort((a, b) => this.rankOf(a.extensionId) - this.rankOf(b.extensionId));
    return runObservers(entries, [payload], this.runOptions("event", false));
  }

  // ---- snapshots for the UI -----------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): RegistrySnapshot {
    if (!this.snapshot) {
      this.snapshot = this.buildSnapshot();
    }
    return this.snapshot;
  }

  listExtensions(): readonly ExtensionInfo[] {
    return this.getSnapshot().extensions;
  }

  listCommands(): readonly CommandView[] {
    return this.getSnapshot().commands;
  }

  listSettingsSections(): readonly SettingsSectionView[] {
    return this.getSnapshot().settingsSections;
  }

  listComposerTools(): readonly ComposerToolView[] {
    return this.getSnapshot().composerTools;
  }

  /** Buttons for one message; `when` is evaluated here, in extension order. */
  listMessageActions(message: MessageView, chat: ChatView): MessageActionView[] {
    const views: MessageActionView[] = [];
    for (const entry of this.registrations.messageActionEntries()) {
      const { extensionId, spec } = entry;
      if (this.entries.get(extensionId)?.status !== "active") {
        continue;
      }
      if (spec.when) {
        try {
          if (!spec.when(message, chat)) {
            continue;
          }
        } catch (error) {
          this.deferFailure(extensionId, error);
          continue;
        }
      }
      views.push({
        id: `${extensionId}:${spec.id}`,
        extensionId,
        label: spec.label,
        run: () => this.runAction(extensionId, () => spec.run(message, chat)),
      });
    }
    return views;
  }

  getLogs(id: string): readonly LogEntry[] {
    return this.logs.get(id) ?? [];
  }

  /** For UI error boundaries around extension-rendered components. */
  reportFailure(extensionId: string, error: unknown): void {
    this.recordFailure(extensionId, { kind: "error", message: describeError(error) });
  }

  // ---- internals ------------------------------------------------------------

  private rankOf(id: string): number {
    const entry = this.entries.get(id);
    return entry
      ? (entry.extension.priority ?? 100) * 100_000 + entry.seq
      : Number.MAX_SAFE_INTEGER;
  }

  private runOptions(hook: keyof HookTimeouts, blocking: boolean): RunOptions {
    const reporter: HookReporter = {
      failure: (id, failure) => this.recordFailure(id, failure),
      success: () => undefined,
    };
    return {
      timeoutMs: this.timeouts[hook],
      ...(blocking ? { totalBudgetMs: this.totalBlockingMs } : {}),
      now: this.now,
      reporter,
    };
  }

  private changed(): void {
    this.dirty = true;
    if (this.batch === 0) {
      this.flush();
    }
  }

  private flush(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    this.snapshot = null;
    this.version += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  }

  private batched(fn: () => void): void {
    this.batch += 1;
    try {
      fn();
    } finally {
      this.batch -= 1;
      if (this.batch === 0) {
        this.flush();
      }
    }
  }

  private async loadPreferences(): Promise<void> {
    if (this.prefsLoaded) {
      return;
    }
    this.prefsLoaded = true;
    try {
      const raw = await this.storage.get(DISABLED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === "string") {
            this.userDisabled.add(id);
          }
        }
      }
    } catch (error) {
      this.log("registry", "warn", `Could not read extension preferences: ${describeError(error)}`);
    }
  }

  private async savePreferences(): Promise<void> {
    try {
      await this.storage.set(DISABLED_KEY, JSON.stringify([...this.userDisabled].sort()));
    } catch (error) {
      this.log("registry", "warn", `Could not save extension preferences: ${describeError(error)}`);
    }
  }

  /** Dependencies first, then registration order. Only inactive entries are returned. */
  private activationOrder(include: (entry: Entry) => boolean = (e) => e.status === "inactive"): Entry[] {
    const ordered: Entry[] = [];
    const seen = new Set<string>();
    const visit = (entry: Entry): void => {
      if (seen.has(entry.extension.id)) {
        return;
      }
      // Marking before descending also breaks dependency cycles.
      seen.add(entry.extension.id);
      for (const depId of entry.extension.dependencies ?? []) {
        const dep = this.entries.get(depId);
        if (dep) {
          visit(dep);
        }
      }
      ordered.push(entry);
    };
    [...this.entries.values()].sort((a, b) => a.seq - b.seq).forEach(visit);
    return ordered.filter(include);
  }

  private async activate(entry: Entry): Promise<void> {
    if (entry.status !== "inactive") {
      return;
    }
    const { extension } = entry;
    for (const depId of extension.dependencies ?? []) {
      const dep = this.entries.get(depId);
      if (!dep || dep.status !== "active") {
        markDisabled(
          entry,
          "dependency",
          dep
            ? `Needs "${dep.extension.name}", which is not running.`
            : `Needs "${depId}", which is not installed.`,
        );
        this.changed();
        return;
      }
    }

    const session: Session = { alive: true };
    entry.session = session;
    const context = createContext({
      extension,
      granted: new Set<Permission>(extension.permissions),
      session,
      registrations: this.registrations,
      bus: this.bus,
      storage: this.storage,
      logger: this.createLogger(extension.id),
    });

    this.batch += 1;
    try {
      const result = await runIsolated(() => extension.activate(context), this.activationTimeoutMs);
      if (!session.alive) {
        // Turned off while starting: undo whatever it managed to register.
        this.registrations.removeExtension(extension.id);
        this.bus.removeExtension(extension.id);
        if (result.ok) {
          this.runDeactivate(entry);
        }
        return;
      }
      if (result.ok) {
        entry.status = "active";
        this.log(extension.id, "info", "Activated.");
      } else {
        this.stop(entry, "failed", undefined, `Could not start: ${result.failure.message}`);
        this.tracker.record(extension.id, result.failure);
        this.log(extension.id, "error", `Activation failed: ${result.failure.message}`);
      }
    } finally {
      this.batch -= 1;
      this.changed();
    }
  }

  /** Synchronously removes everything an extension contributed. */
  private stop(entry: Entry, status: ExtensionStatus, by?: DisabledBy, reason?: string): void {
    const wasActive = entry.status === "active";
    if (entry.session) {
      entry.session.alive = false;
      entry.session = null;
    }
    this.registrations.removeExtension(entry.extension.id);
    this.bus.removeExtension(entry.extension.id);
    if (wasActive) {
      this.runDeactivate(entry);
    }
    entry.status = status;
    if (by) {
      entry.disabledBy = by;
    } else {
      delete entry.disabledBy;
    }
    if (reason) {
      entry.reason = reason;
    } else if (status === "inactive") {
      delete entry.reason;
    }
    this.changed();
  }

  private runDeactivate(entry: Entry): void {
    try {
      entry.extension.deactivate?.();
    } catch (error) {
      this.log(entry.extension.id, "warn", `deactivate threw: ${describeError(error)}`);
    }
  }

  private cascade(root: Entry): void {
    for (const entry of this.entries.values()) {
      if (
        entry.status === "active" &&
        (entry.extension.dependencies ?? []).includes(root.extension.id)
      ) {
        this.stop(
          entry,
          "disabled",
          "dependency",
          `Needs "${root.extension.name}", which was turned off.`,
        );
        this.cascade(entry);
      }
    }
  }

  private recordFailure(extensionId: string, failure: HookFailure): void {
    const entry = this.entries.get(extensionId);
    if (!entry) {
      return;
    }
    const tripped = this.tracker.record(extensionId, failure);
    this.log(extensionId, "error", `${failure.kind}: ${failure.message}`);
    if (tripped && entry.status === "active") {
      this.batched(() => {
        this.stop(
          entry,
          "disabled",
          "auto",
          `Turned off automatically after repeated problems. Last: ${failure.message}`,
        );
        this.cascade(entry);
      });
      return;
    }
    this.changed();
  }

  // Failures found while rendering must not notify subscribers mid-render.
  private deferFailure(extensionId: string, error: unknown): void {
    queueMicrotask(() => this.reportFailure(extensionId, error));
  }

  private async runAction(extensionId: string, fn: () => ActionOutcome): Promise<void> {
    if (this.entries.get(extensionId)?.status !== "active") {
      return;
    }
    try {
      const outcome = await fn();
      if (outcome && typeof outcome === "object") {
        if (typeof outcome.notice === "string" && outcome.notice) {
          this.host.notify?.({ kind: "info", message: outcome.notice.slice(0, MAX_NOTICE_CHARS) });
        }
        if (typeof outcome.copyText === "string" && outcome.copyText) {
          await this.host.copyText?.(outcome.copyText.slice(0, MAX_COPY_CHARS));
        }
      }
    } catch (error) {
      const name = this.entries.get(extensionId)?.extension.name ?? extensionId;
      this.recordFailure(extensionId, { kind: "error", message: describeError(error) });
      this.host.notify?.({
        kind: "error",
        message: `${name} hit a problem: ${describeError(error)}`.slice(0, MAX_NOTICE_CHARS),
      });
    }
  }

  private createLogger(extensionId: string): ExtensionLogger {
    const make =
      (level: LogEntry["level"]) =>
      (message: string, data?: unknown): void => {
        const suffix = data === undefined ? "" : ` ${safeJson(data)}`;
        this.log(extensionId, level, `${message}${suffix}`);
      };
    return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
  }

  private log(extensionId: string, level: LogEntry["level"], message: string): void {
    const entry: LogEntry = { level, message: message.slice(0, 500), at: this.now() };
    const list = this.logs.get(extensionId) ?? [];
    list.push(entry);
    if (list.length > LOG_LIMIT) {
      list.splice(0, list.length - LOG_LIMIT);
    }
    this.logs.set(extensionId, list);
    try {
      this.logSink?.(extensionId, entry);
    } catch {
      // Logging must never break the caller.
    }
  }

  private buildSnapshot(): RegistrySnapshot {
    const extensions = [...this.entries.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((entry): ExtensionInfo => {
        const { extension } = entry;
        const last = this.tracker.lastFailure(extension.id);
        return {
          id: extension.id,
          name: extension.name,
          version: extension.version,
          description: extension.description ?? "",
          apiVersion: extension.apiVersion,
          permissions: [...extension.permissions],
          dependencies: [...(extension.dependencies ?? [])],
          builtin: entry.builtin,
          status: entry.status,
          ...(entry.disabledBy ? { disabledBy: entry.disabledBy } : {}),
          ...(entry.reason ? { statusReason: entry.reason } : {}),
          failureCount: this.tracker.count(extension.id),
          ...(last ? { lastError: last.message } : {}),
          contributionCount: this.registrations.count(extension.id),
        };
      });

    const safeRender = (extensionId: string, render: () => ReactNodeLike): ReactNodeLike => {
      try {
        return render();
      } catch (error) {
        this.deferFailure(extensionId, error);
        return null;
      }
    };

    const commands = this.registrations.commandEntries().map(
      ({ extensionId, spec }): CommandView => ({
        id: `${extensionId}:${spec.id}`,
        extensionId,
        label: spec.label,
        hint: spec.hint ?? "",
        run: () => this.runAction(extensionId, () => spec.run()),
      }),
    );

    const settingsSections = this.registrations.settingsEntries().map(
      ({ extensionId, order, spec }): SettingsSectionView => ({
        id: `${extensionId}:${spec.id}`,
        extensionId,
        title: spec.title,
        order,
        render: () => safeRender(extensionId, spec.render),
      }),
    );

    const composerTools = this.registrations.composerEntries().map(
      ({ extensionId, order, spec }): ComposerToolView => ({
        id: `${extensionId}:${spec.id}`,
        extensionId,
        order,
        render: () => safeRender(extensionId, spec.render),
      }),
    );

    return { version: this.version, extensions, commands, settingsSections, composerTools };
  }
}

type ReactNodeLike = ReturnType<import("./types").SettingsSectionSpec["render"]>;

function markDisabled(entry: Entry, by: DisabledBy, reason: string): void {
  entry.status = "disabled";
  entry.disabledBy = by;
  entry.reason = reason;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

function validateShape(extension: Extension): string | null {
  if (
    typeof extension.id !== "string" ||
    !ID_PATTERN.test(extension.id) ||
    extension.id.length > 64
  ) {
    return `Extension id "${String(extension.id)}" must be dotted lowercase words, e.g. "glee.word-count".`;
  }
  if (typeof extension.name !== "string" || !extension.name.trim() || extension.name.length > 80) {
    return "Extension name is required (80 characters max).";
  }
  if (typeof extension.version !== "string" || !parseVersion(extension.version)) {
    return `Extension version "${String(extension.version)}" is not a valid version.`;
  }
  if (typeof extension.activate !== "function") {
    return "Extension needs an activate function.";
  }
  if (!Array.isArray(extension.permissions)) {
    return "Extension permissions must be an array.";
  }
  const unknown = extension.permissions.find((p) => !isPermission(p));
  if (unknown !== undefined) {
    return `Unknown permission "${String(unknown)}".`;
  }
  return null;
}
