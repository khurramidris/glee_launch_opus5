// Hook runner. Every extension callback that sits on the chat path goes through
// here so a slow or broken one costs the user a bounded delay, never a hang or
// a lost message. Failures fail open: the app continues as if the hook were absent.
import {
  isCancel,
  type BeforeSendResult,
  type NotesContribution,
  type NotesContext,
  type SendDraft,
} from "./types";

export const DEFAULT_HOOK_TIMEOUTS = {
  beforeSend: 250,
  transformPromptNotes: 250,
  afterReply: 2_000,
  onChatOpened: 1_000,
  onChatClosed: 1_000,
  event: 1_000,
} as const;

export type HookName = keyof typeof DEFAULT_HOOK_TIMEOUTS;
export type HookTimeouts = Record<HookName, number>;

export const DEFAULT_NOTES_BUDGET = {
  /** Across all extensions; the built-in notes keep their own 700 characters. */
  totalChars: 320,
  perExtensionChars: 160,
  maxLineChars: 160,
} as const;

export type NotesBudget = { -readonly [K in keyof typeof DEFAULT_NOTES_BUDGET]: number };

/** Blocking hooks share this wall-clock allowance per run. */
export const DEFAULT_TOTAL_BLOCKING_MS = 750;
export const MAX_DRAFT_CHARS = 20_000;

export type FailureKind = "error" | "timeout" | "budget" | "invalid";

export interface HookFailure {
  kind: FailureKind;
  message: string;
}

export interface HookReporter {
  failure(extensionId: string, failure: HookFailure): void;
  success(extensionId: string): void;
}

export interface HookEntry<H> {
  extensionId: string;
  handler: H;
}

export type IsolatedResult<T> =
  | { ok: true; value: T }
  | { ok: false; failure: HookFailure };

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return typeof error === "string" ? error : "Unknown error";
}

export async function runIsolated<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
): Promise<IsolatedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<IsolatedResult<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, failure: { kind: "timeout", message: `Took longer than ${timeoutMs} ms.` } }),
      timeoutMs,
    );
  });
  const run = (async (): Promise<IsolatedResult<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, failure: { kind: "error", message: describeError(error) } };
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RunOptions {
  timeoutMs: number;
  totalBudgetMs?: number;
  now?: () => number;
  reporter: HookReporter;
}

function outOfTime(options: RunOptions, startedAt: number): boolean {
  if (options.totalBudgetMs === undefined) {
    return false;
  }
  return (options.now ?? Date.now)() - startedAt >= options.totalBudgetMs;
}

export interface BeforeSendOutcome {
  draft: SendDraft;
  cancelled?: { extensionId: string; reason?: string };
}

export async function runBeforeSend(
  entries: readonly HookEntry<(draft: SendDraft) => BeforeSendResult | Promise<BeforeSendResult>>[],
  initial: SendDraft,
  options: RunOptions,
): Promise<BeforeSendOutcome> {
  const startedAt = (options.now ?? Date.now)();
  let draft = initial;
  for (const entry of entries) {
    if (outOfTime(options, startedAt)) {
      break;
    }
    const current = draft;
    const result = await runIsolated(() => entry.handler(current), options.timeoutMs);
    if (!result.ok) {
      options.reporter.failure(entry.extensionId, result.failure);
      continue;
    }
    const value = result.value;
    if (value === undefined) {
      options.reporter.success(entry.extensionId);
      continue;
    }
    if (isCancel(value)) {
      options.reporter.success(entry.extensionId);
      return {
        draft,
        cancelled: {
          extensionId: entry.extensionId,
          ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 200) } : {}),
        },
      };
    }
    const text = (value as { text?: unknown }).text;
    if (typeof text !== "string" || text.trim() === "" || text.length > MAX_DRAFT_CHARS) {
      options.reporter.failure(entry.extensionId, {
        kind: "invalid",
        message: "beforeSend must return a draft with non-empty text, or a cancel.",
      });
      continue;
    }
    options.reporter.success(entry.extensionId);
    // chatId is not extension-writable: a hook cannot redirect a message.
    draft = { chatId: initial.chatId, text };
  }
  return { draft };
}

// Notes are prompt text, so strip anything that could close the notes block or
// smuggle in control characters; collapse to one visible line.
export function sanitizeNoteLine(line: string, maxChars: number): string {
  const cleaned = line
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/<\/?\s*reply notes\s*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxChars ? "" : cleaned;
}

export interface NotesRunOptions extends RunOptions {
  budget: NotesBudget;
}

export interface NotesOutcome {
  notes: string[];
  added: string[];
}

type NotesHandler = (
  notes: readonly string[],
  ctx: NotesContext,
) => NotesContribution | void | Promise<NotesContribution | void>;

function collectLines(value: unknown): string[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value as string[];
}

export async function runTransformNotes(
  entries: readonly HookEntry<NotesHandler>[],
  baseNotes: readonly string[],
  context: Omit<NotesContext, "remainingChars">,
  options: NotesRunOptions,
): Promise<NotesOutcome> {
  const startedAt = (options.now ?? Date.now)();
  const prepended: string[] = [];
  const appended: string[] = [];
  let totalRemaining = options.budget.totalChars;

  for (const entry of entries) {
    if (outOfTime(options, startedAt) || totalRemaining <= 0) {
      break;
    }
    let allowance = Math.min(options.budget.perExtensionChars, totalRemaining);
    const snapshot = Object.freeze([...baseNotes, ...prepended, ...appended]);
    const result = await runIsolated(
      () => entry.handler(snapshot, { ...context, remainingChars: allowance }),
      options.timeoutMs,
    );
    if (!result.ok) {
      options.reporter.failure(entry.extensionId, result.failure);
      continue;
    }
    const raw = result.value;
    if (raw === undefined || raw === null) {
      options.reporter.success(entry.extensionId);
      continue;
    }
    const pre = collectLines((raw as NotesContribution).prepend);
    const post = collectLines((raw as NotesContribution).append);
    if (pre === null || post === null) {
      options.reporter.failure(entry.extensionId, {
        kind: "invalid",
        message: "transformPromptNotes must return { prepend?: string[], append?: string[] }.",
      });
      continue;
    }

    let dropped = 0;
    const accept = (lines: string[], into: string[]): void => {
      for (const original of lines) {
        const line = sanitizeNoteLine(original, options.budget.maxLineChars);
        if (!line) {
          if (original.trim()) {
            dropped += 1;
          }
          continue;
        }
        // The joining newline counts, matching how the notes are rendered.
        const cost = line.length + 1;
        if (cost > allowance) {
          dropped += 1;
          continue;
        }
        into.push(line);
        allowance -= cost;
        totalRemaining -= cost;
      }
    };
    accept(pre, prepended);
    accept(post, appended);

    if (dropped > 0) {
      options.reporter.failure(entry.extensionId, {
        kind: "budget",
        message: `Dropped ${dropped} note line(s) over the prompt-note budget.`,
      });
    } else {
      options.reporter.success(entry.extensionId);
    }
  }

  return {
    notes: [...prepended, ...baseNotes, ...appended],
    added: [...prepended, ...appended],
  };
}

/** Observer hooks: run in order, each isolated, results ignored. */
export async function runObservers<A extends unknown[]>(
  entries: readonly HookEntry<(...args: A) => void | Promise<void>>[],
  args: A,
  options: RunOptions,
): Promise<void> {
  const startedAt = (options.now ?? Date.now)();
  for (const entry of entries) {
    if (outOfTime(options, startedAt)) {
      return;
    }
    const result = await runIsolated(() => entry.handler(...args), options.timeoutMs);
    if (result.ok) {
      options.reporter.success(entry.extensionId);
    } else {
      options.reporter.failure(entry.extensionId, result.failure);
    }
  }
}
