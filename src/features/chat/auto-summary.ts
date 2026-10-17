import { getAutoSummaryBatch, storeAutoSummary } from "../../api/tauri";
import { runtimeFetch } from "../../lib/runtime-fetch";
import { chatStore } from "../../stores/chat-store";
import { FALLBACK_RUNTIME_STATE, modelStore } from "../../stores/model-store";
import type { ChatMemory, ChatMessage, LlamaChatCompletionResponse } from "../../types";
import { resolveChatCompletionsUrl } from "../app/app-domain";

/** Older, not yet summarised messages needed before a summary call is worth its CPU time. */
export const AUTO_SUMMARY_MIN_PENDING_MESSAGES = 12;
/** Least time between two summary attempts for the same chat. */
export const AUTO_SUMMARY_MIN_INTERVAL_MS = 5 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 220;
const TEMPERATURE = 0.2;
const MESSAGE_CLIP_CHARS = 1500;
const SUMMARY_MAX_CHARS = 1200;
const SUMMARY_MIN_CHARS = 20;

const SUMMARY_INSTRUCTIONS =
  "Update the running summary of this roleplay conversation. Keep names, relationships, promises, facts the user shared, unresolved plot threads, current situation. 120 words max, plain prose, no lists.";

export type AutoSummarySkipReason =
  | "aborted"
  | "busy"
  | "runtime-not-ready"
  | "throttled"
  | "in-flight"
  | "not-enough-messages"
  | "manual-summary"
  | "empty-output"
  | "not-stored"
  | "error";

export type AutoSummaryResult =
  | { status: "updated"; memory: ChatMemory }
  | { status: "skipped"; reason: AutoSummarySkipReason };

export interface AutoSummaryOptions {
  chatId: string;
  /** Speaker character id to display name, for labelling assistant turns. */
  participantDirectory?: Record<string, string>;
  /** Label for assistant turns that carry no speaker id. */
  characterName?: string;
  /** Label for user turns. */
  userName?: string;
  /** True while a reply is streaming or queued; the summary then waits for the next turn. */
  isBusy?: () => boolean;
  /** Aborted when the user starts a new generation. */
  signal?: AbortSignal;
  /** Minimum gap between attempts for this chat. */
  minIntervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

const lastAttemptByChat = new Map<string, number>();
const inFlightChats = new Set<string>();

export function resetAutoSummaryState(): void {
  lastAttemptByChat.clear();
  inFlightChats.clear();
}

/**
 * Cleans the model's summary into a single plain paragraph: no reasoning
 * blocks, markdown, list markers, or wrapping quotes.
 */
export function sanitizeAutoSummary(raw: string, options: { truncated?: boolean } = {}): string {
  let text = raw
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    .replace(/<think(?:ing)?>[\s\S]*$/gi, " ")
    .replace(/<\/?think(?:ing)?>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`+/g, "")
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, " ")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

  text = stripWrappingQuotes(text);
  text = stripWrappingQuotes(text.replace(/^(?:updated\s+)?(?:running\s+)?summary\s*:\s*/i, ""));

  if (text.length > SUMMARY_MAX_CHARS || options.truncated) {
    text = trimToLastSentence(text.slice(0, SUMMARY_MAX_CHARS), options.truncated === true);
  }
  return text.length >= SUMMARY_MIN_CHARS ? text : "";
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ];
  let text = value.trim();
  for (let pass = 0; pass < 2; pass += 1) {
    const pair = pairs.find(
      ([open, close]) =>
        text.length >= 2 &&
        text.startsWith(open) &&
        text.endsWith(close) &&
        !text.slice(1, -1).includes(open),
    );
    if (!pair) {
      break;
    }
    text = text.slice(1, -1).trim();
  }
  return text;
}

function trimToLastSentence(value: string, keepPartial: boolean): string {
  const lastEnd = Math.max(
    value.lastIndexOf("."),
    value.lastIndexOf("!"),
    value.lastIndexOf("?"),
  );
  if (lastEnd >= SUMMARY_MIN_CHARS) {
    return value.slice(0, lastEnd + 1).trim();
  }
  return keepPartial ? value.trim() : `${value.trimEnd()}...`;
}

function speakerLabel(message: ChatMessage, options: AutoSummaryOptions): string {
  if (message.role === "user") {
    return options.userName?.trim() || "User";
  }
  const speaker = message.speakerCharacterId
    ? options.participantDirectory?.[message.speakerCharacterId]?.trim()
    : undefined;
  return speaker || options.characterName?.trim() || "Character";
}

function clip(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

export function buildAutoSummaryPrompt(
  previousSummary: string,
  messages: ChatMessage[],
  options: AutoSummaryOptions,
): Array<{ role: "system" | "user"; content: string }> {
  const transcript = messages
    .map((message) => ({
      label: speakerLabel(message, options),
      text: clip(message.content, MESSAGE_CLIP_CHARS),
    }))
    .filter((line) => Boolean(line.text))
    .map((line) => `${line.label}: ${line.text}`)
    .join("\n");

  return [
    { role: "system", content: SUMMARY_INSTRUCTIONS },
    {
      role: "user",
      content: [
        `Previous summary:\n${previousSummary.trim() || "(none yet)"}`,
        `New messages:\n${transcript}`,
        "Write the updated summary now.",
      ].join("\n\n"),
    },
  ];
}

function skipped(reason: AutoSummarySkipReason): AutoSummaryResult {
  return { status: "skipped", reason };
}

function runtimeIsReady(): boolean {
  return modelStore.getState().runtime.status === "running";
}

async function requestSummary(
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal | undefined,
): Promise<{ text: string; truncated: boolean }> {
  const { runtime, models } = modelStore.getState();
  const endpoint = resolveChatCompletionsUrl(runtime.endpoint, FALLBACK_RUNTIME_STATE.endpoint);
  const model = models.find((item) => item.isActive)?.name ?? "local-model";

  const controller = new AbortController();
  const abortFromUpstream = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abortFromUpstream, { once: true });
  }
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await runtimeFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        cache_prompt: true,
        chat_template_kwargs: { enable_thinking: false },
        temperature: TEMPERATURE,
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`summary request failed with status ${response.status}`);
    }
    const payload = (await response.json()) as LlamaChatCompletionResponse;
    const choice = payload.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      truncated: choice?.finish_reason === "length",
    };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromUpstream);
  }
}

/**
 * Folds chat messages that scrolled out of the recent window into the chat's
 * running summary using the local model. Call it after a completed reply; it
 * returns quickly unless a summary is due, and it never throws.
 */
export async function maybeUpdateAutoSummary(
  options: AutoSummaryOptions,
): Promise<AutoSummaryResult> {
  const { chatId, signal } = options;
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? AUTO_SUMMARY_MIN_INTERVAL_MS;
  const interrupted = () => signal?.aborted === true || options.isBusy?.() === true;

  if (signal?.aborted) {
    return skipped("aborted");
  }
  if (options.isBusy?.()) {
    return skipped("busy");
  }
  if (!runtimeIsReady()) {
    return skipped("runtime-not-ready");
  }
  if (inFlightChats.has(chatId)) {
    return skipped("in-flight");
  }
  const previousAttempt = lastAttemptByChat.get(chatId);
  const startedAt = now();
  if (previousAttempt !== undefined && startedAt - previousAttempt < minIntervalMs) {
    return skipped("throttled");
  }

  inFlightChats.add(chatId);
  let attemptRecorded = false;
  try {
    const batch = await getAutoSummaryBatch(chatId);
    if (!batch.writable) {
      return skipped("manual-summary");
    }
    const lastMessage = batch.messages[batch.messages.length - 1];
    if (batch.pendingCount < AUTO_SUMMARY_MIN_PENDING_MESSAGES || !lastMessage) {
      return skipped("not-enough-messages");
    }
    if (interrupted()) {
      return skipped(signal?.aborted ? "aborted" : "busy");
    }

    lastAttemptByChat.set(chatId, startedAt);
    attemptRecorded = true;
    const reply = await requestSummary(
      buildAutoSummaryPrompt(batch.previousSummary, batch.messages, options),
      signal,
    );
    if (interrupted()) {
      // The user moved on before the summary finished; retry after the next reply.
      releaseAttempt(chatId, previousAttempt);
      return skipped(signal?.aborted ? "aborted" : "busy");
    }

    const summary = sanitizeAutoSummary(reply.text, { truncated: reply.truncated });
    if (!summary) {
      return skipped("empty-output");
    }
    const memory = await storeAutoSummary({
      chatId,
      summary,
      throughMessageId: lastMessage.id,
      expectedHistoryEpoch: batch.historyEpoch,
    });
    if (!memory) {
      return skipped("not-stored");
    }
    chatStore.getState().setMemory(chatId, memory);
    return { status: "updated", memory };
  } catch (error) {
    if (signal?.aborted && attemptRecorded) {
      releaseAttempt(chatId, previousAttempt);
      return skipped("aborted");
    }
    console.warn("Automatic chat summary failed.", error);
    return skipped("error");
  } finally {
    inFlightChats.delete(chatId);
  }
}

function releaseAttempt(chatId: string, previousAttempt: number | undefined): void {
  if (previousAttempt === undefined) {
    lastAttemptByChat.delete(chatId);
  } else {
    lastAttemptByChat.set(chatId, previousAttempt);
  }
}
