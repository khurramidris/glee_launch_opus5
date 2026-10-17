import { getMemoryExtractionBatch, storeMemoryExtraction } from "../../api/tauri";
import { runtimeFetch } from "../../lib/runtime-fetch";
import { memoryStore } from "../../stores/memory-store";
import { FALLBACK_RUNTIME_STATE, modelStore } from "../../stores/model-store";
import type {
  ChatMessage,
  LlamaChatCompletionResponse,
  MemoryExtractionAdd,
  MemoryExtractionBatch,
  MemoryExtractionOutcome,
  MemoryExtractionUpdate,
  MemoryItem,
  MemoryKind,
  MemoryScope,
} from "../../types";
import { resolveChatCompletionsUrl } from "../app/app-domain";

/** Least time between two extraction attempts for the same chat. */
export const MEMORY_EXTRACTION_MIN_INTERVAL_MS = 60 * 1000;
/** Items one run may add. */
export const MEMORY_EXTRACTION_MAX_ADDS = 6;
/** Longest memory text kept, in characters. */
export const MEMORY_CONTENT_MAX_CHARS = 200;
/** Existing items one run may archive; losing memory is the costly mistake. */
export const MEMORY_EXTRACTION_MAX_REMOVES = 3;
/** Runs in a row that may produce unreadable output before the window is given up. */
export const MEMORY_EXTRACTION_MAX_UNREADABLE_RUNS = 2;

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 600;
const TEMPERATURE = 0.1;
const MESSAGE_CLIP_CHARS = 1200;
const MIN_CONTENT_CHARS = 8;

const MEMORY_SCOPES: readonly MemoryScope[] = ["user", "character", "chat"];
const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "event",
  "relationship",
  "promise",
];

const EXTRACTION_INSTRUCTIONS = [
  "You keep the long-term memory of a roleplay chat. Read the new messages and decide what is worth remembering in future conversations.",
  'Write every memory as one short third-person statement that uses names, such as "Sam is allergic to peanuts" or "Ada promised to teach Sam chess". 25 words at most, never first person.',
  "Keep only lasting things: facts the user shared about themselves, preferences, promises and plans, important shared events, and how people feel about each other. Skip small talk, scene description, and anything the existing memories already say.",
  'scope: "user" for facts about the user, "character" for what one character knows or did with the user (put that character\'s name in "about"), "chat" for details that only matter in this story.',
  'kind is one of fact, preference, event, relationship, promise. importance runs from 1 (minor) to 5 (essential).',
  'If an existing memory changed, update it by its id. If it is no longer true, remove it by its id. Never repeat an existing memory.',
  'Reply with JSON only, exactly in this shape: {"add":[{"scope":"user","about":"user","kind":"fact","content":"...","importance":3}],"update":[{"id":"M1","content":"...","importance":3}],"remove":[{"id":"M2"}]}. Use empty arrays when nothing changes.',
].join("\n");

export type MemoryExtractionSkipReason =
  | "aborted"
  | "busy"
  | "runtime-not-ready"
  | "throttled"
  | "in-flight"
  | "not-enough-messages"
  | "unreadable-output"
  | "error";

export type MemoryExtractionResult =
  | { status: "stored"; outcome: MemoryExtractionOutcome }
  | { status: "skipped"; reason: MemoryExtractionSkipReason };

export interface MemoryExtractionOptions {
  chatId: string;
  /** Speaker character id to display name, for labelling assistant turns. */
  participantDirectory?: Record<string, string>;
  /** Label for assistant turns that carry no speaker id. */
  characterName?: string;
  /** Label for user turns. */
  userName?: string;
  /** True while a reply is streaming or queued; extraction then waits for the next turn. */
  isBusy?: () => boolean;
  /** Aborted when the user starts a new generation. */
  signal?: AbortSignal;
  /** Minimum gap between attempts for this chat. */
  minIntervalMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

export interface MemoryExtractionContext {
  /** Prompt handle ("M1") to item id, for the existing items shown to the model. */
  handles: Map<string, string>;
  participants: Array<{ id: string; name: string }>;
  userName?: string;
}

export interface ParsedMemoryExtraction {
  add: MemoryExtractionAdd[];
  update: MemoryExtractionUpdate[];
  remove: string[];
}

const lastAttemptByChat = new Map<string, number>();
const unreadableRunsByChat = new Map<string, number>();
const inFlightChats = new Set<string>();
// Whether the server accepted `response_format`; once it refuses, requests stop sending it.
let jsonModeSupported = true;

export function resetMemoryExtractionState(): void {
  lastAttemptByChat.clear();
  unreadableRunsByChat.clear();
  inFlightChats.clear();
  jsonModeSupported = true;
}

function stripThinking(raw: string): string {
  return raw
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    .replace(/<think(?:ing)?>[\s\S]*$/gi, " ")
    .replace(/<\/?think(?:ing)?>/gi, " ");
}

/**
 * Pulls the first JSON object out of model text: reasoning blocks and code
 * fences are ignored, and output cut off mid-way is closed after its last
 * complete value so earlier entries survive.
 */
export function extractJsonObject(raw: string): string | null {
  const text = stripThinking(raw).replace(/```(?:json)?/gi, " ");
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastClosed = -1;
  let closersAtLastClosed: string[] = [];
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if (char === "}" || char === "]") {
      stack.pop();
      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
      lastClosed = index;
      closersAtLastClosed = [...stack].reverse();
    }
  }
  if (lastClosed < 0) {
    return null;
  }
  return text.slice(start, lastClosed + 1) + closersAtLastClosed.join("");
}

function stripTrailingCommas(json: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === ",") {
      const rest = json.slice(index + 1).match(/^\s*([}\]])/);
      if (rest) {
        continue;
      }
    }
    result += char;
  }
  return result;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const block = extractJsonObject(raw);
  if (!block) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(stripTrailingCommas(block));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clipAtBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const head = value.slice(0, maxChars);
  const sentenceEnd = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "));
  if (sentenceEnd >= maxChars * 0.5) {
    return head.slice(0, sentenceEnd).trim();
  }
  const wordEnd = head.lastIndexOf(" ");
  return (wordEnd >= maxChars * 0.5 ? head.slice(0, wordEnd) : head).trim();
}

/**
 * Cleans one memory statement. Returns null for text that is not a usable
 * third-person statement: too short, a question, a placeholder, or first person.
 */
export function sanitizeMemoryContent(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  let text = stripThinking(raw)
    .replace(/[`*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:[-•]|\d+[.)])\s+/, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();
  text = clipAtBoundary(text, MEMORY_CONTENT_MAX_CHARS).replace(/[.\s]+$/, "");
  if (text.length < MIN_CONTENT_CHARS || !/\s/.test(text) || text.endsWith("?")) {
    return null;
  }
  if (/^(?:none|n\/a|nothing|null|unknown|no memories?)\b/i.test(text)) {
    return null;
  }
  // First person is ambiguous once the text leaves the conversation.
  if (/^(?:i|i'm|i’m|i've|i’ve|i'll|i’ll|me|my|we|our|you|your)\b/i.test(text)) {
    return null;
  }
  return text;
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function parseImportance(value: unknown, fallback: number | undefined): number | undefined {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(5, Math.max(1, Math.round(parsed)));
}

type Owner = { kind: "user" } | { kind: "character"; id: string };

function resolveAbout(
  about: unknown,
  context: MemoryExtractionContext,
): Owner | null {
  const name = typeof about === "string" ? normalizeForCompare(about) : "";
  const userName = context.userName ? normalizeForCompare(context.userName) : "";
  if (!name) {
    return null;
  }
  if (name === "user" || name === "the user" || (userName && name === userName)) {
    return { kind: "user" };
  }
  const participants = context.participants.map((participant) => ({
    id: participant.id,
    name: normalizeForCompare(participant.name),
  }));
  const exact = participants.find((participant) => participant.name === name);
  if (exact) {
    return { kind: "character", id: exact.id };
  }
  const partial = participants.filter(
    (participant) =>
      participant.name.split(" ")[0] === name ||
      name.split(" ")[0] === participant.name.split(" ")[0],
  );
  return partial.length === 1 ? { kind: "character", id: partial[0].id } : null;
}

function resolveHandle(value: unknown, context: MemoryExtractionContext): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const cleaned = String(value).trim().replace(/^[[#(]+|[\])]+$/g, "").toLowerCase();
  const numeric = cleaned.match(/^m?(\d+)$/);
  if (numeric) {
    return context.handles.get(`m${Number(numeric[1])}`) ?? null;
  }
  const raw = String(value).trim();
  for (const id of context.handles.values()) {
    if (id === raw) {
      return id;
    }
  }
  return null;
}

function asEntries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Turns the model's reply into validated changes. Anything malformed is
 * dropped on its own: a bad entry never discards the good ones, and the result
 * is capped so a runaway reply cannot flood the store.
 */
export function parseMemoryExtraction(
  raw: string,
  context: MemoryExtractionContext,
): ParsedMemoryExtraction | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }

  const add: MemoryExtractionAdd[] = [];
  const seen = new Set<string>();
  for (const entry of asEntries(parsed.add)) {
    const record = asRecord(entry);
    if (!record || add.length >= MEMORY_EXTRACTION_MAX_ADDS) {
      continue;
    }
    const content = sanitizeMemoryContent(record.content);
    const requestedScope = typeof record.scope === "string" ? record.scope.trim().toLowerCase() : "";
    if (!content || !(MEMORY_SCOPES as readonly string[]).includes(requestedScope)) {
      continue;
    }
    const key = normalizeForCompare(content);
    if (seen.has(key)) {
      continue;
    }

    let scope = requestedScope as MemoryScope;
    let characterId: string | undefined;
    if (scope === "character") {
      const owner = resolveAbout(record.about, context);
      if (owner?.kind === "character") {
        characterId = owner.id;
      } else if (owner?.kind === "user") {
        scope = "user";
      } else if (context.participants.length === 1) {
        characterId = context.participants[0].id;
      } else {
        continue;
      }
    }

    const kind =
      typeof record.kind === "string" &&
      (MEMORY_KINDS as readonly string[]).includes(record.kind.trim().toLowerCase())
        ? (record.kind.trim().toLowerCase() as MemoryKind)
        : "fact";
    seen.add(key);
    add.push({
      scope,
      ...(characterId ? { characterId } : {}),
      kind,
      content,
      importance: parseImportance(record.importance, 3) ?? 3,
    });
  }

  const update: MemoryExtractionUpdate[] = [];
  const touched = new Set<string>();
  for (const entry of asEntries(parsed.update)) {
    const record = asRecord(entry);
    const id = record ? resolveHandle(record.id, context) : null;
    if (!record || !id || touched.has(id) || update.length >= MEMORY_EXTRACTION_MAX_ADDS) {
      continue;
    }
    const content = record.content === undefined ? undefined : sanitizeMemoryContent(record.content);
    const importance = parseImportance(record.importance, undefined);
    if (content === null || (content === undefined && importance === undefined)) {
      continue;
    }
    touched.add(id);
    update.push({
      id,
      ...(content ? { content } : {}),
      ...(importance !== undefined ? { importance } : {}),
    });
  }

  const remove: string[] = [];
  for (const entry of asEntries(parsed.remove)) {
    const record = asRecord(entry);
    const id = resolveHandle(record ? record.id : entry, context);
    if (!id || touched.has(id) || remove.length >= MEMORY_EXTRACTION_MAX_REMOVES) {
      continue;
    }
    touched.add(id);
    remove.push(id);
  }

  return { add, update, remove };
}

function clip(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function mergedParticipants(
  batch: MemoryExtractionBatch,
  options: MemoryExtractionOptions,
): Array<{ id: string; name: string }> {
  const byId = new Map<string, string>();
  for (const [id, name] of Object.entries(options.participantDirectory ?? {})) {
    if (name.trim()) {
      byId.set(id, name.trim());
    }
  }
  for (const participant of batch.participants) {
    if (participant.name.trim() && !byId.has(participant.id)) {
      byId.set(participant.id, participant.name.trim());
    }
  }
  // Only characters that really belong to the chat may own a memory.
  const members = new Set(batch.participants.map((participant) => participant.id));
  return [...byId.entries()]
    .filter(([id]) => members.size === 0 || members.has(id))
    .map(([id, name]) => ({ id, name }));
}

function speakerLabel(
  message: ChatMessage,
  participants: Array<{ id: string; name: string }>,
  options: MemoryExtractionOptions,
): string {
  if (message.role === "user") {
    return options.userName?.trim() || "User";
  }
  const speaker = participants.find((participant) => participant.id === message.speakerCharacterId);
  if (speaker) {
    return speaker.name;
  }
  return options.characterName?.trim() || participants[0]?.name || "Character";
}

function itemOwnerLabel(item: MemoryItem, participants: Array<{ id: string; name: string }>): string {
  if (item.scope === "character") {
    return participants.find((participant) => participant.id === item.characterId)?.name ?? "character";
  }
  return item.scope;
}

export function buildMemoryExtractionPrompt(
  batch: MemoryExtractionBatch,
  options: MemoryExtractionOptions,
): {
  messages: Array<{ role: "system" | "user"; content: string }>;
  context: MemoryExtractionContext;
} {
  const participants = mergedParticipants(batch, options);
  const handles = new Map<string, string>();
  const existing = batch.relatedItems.map((item, index) => {
    const handle = `M${index + 1}`;
    handles.set(handle.toLowerCase(), item.id);
    return `${handle} [${itemOwnerLabel(item, participants)}] ${clip(item.content, MEMORY_CONTENT_MAX_CHARS)}`;
  });

  const transcript = batch.messages
    .map((message) => ({
      label: speakerLabel(message, participants, options),
      text: clip(message.content, MESSAGE_CLIP_CHARS),
    }))
    .filter((line) => Boolean(line.text))
    .map((line) => `${line.label}: ${line.text}`)
    .join("\n");

  const userName = options.userName?.trim();
  const people = [
    participants.length > 0
      ? `Characters: ${participants.map((participant) => participant.name).join(", ")}.`
      : null,
    `The user is called ${userName || "User"}.`,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    messages: [
      { role: "system", content: EXTRACTION_INSTRUCTIONS },
      {
        role: "user",
        content: [
          people,
          `Existing memories:\n${existing.length > 0 ? existing.join("\n") : "(none yet)"}`,
          `New messages:\n${transcript}`,
          "Reply with the JSON now.",
        ].join("\n\n"),
      },
    ],
    context: { handles, participants, userName },
  };
}

function skipped(reason: MemoryExtractionSkipReason): MemoryExtractionResult {
  return { status: "skipped", reason };
}

function runtimeIsReady(): boolean {
  return modelStore.getState().runtime.status === "running";
}

async function requestExtraction(
  messages: Array<{ role: "system" | "user"; content: string }>,
  signal: AbortSignal | undefined,
): Promise<string> {
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
    const send = (jsonMode: boolean) =>
      runtimeFetch(endpoint, {
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
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
    let response = await send(jsonModeSupported);
    if (!response.ok && jsonModeSupported && response.status >= 400 && response.status < 500) {
      // This server build rejects constrained output; the tolerant parser covers plain text.
      jsonModeSupported = false;
      response = await send(false);
    }
    if (!response.ok) {
      throw new Error(`memory extraction request failed with status ${response.status}`);
    }
    const payload = (await response.json()) as LlamaChatCompletionResponse;
    return payload.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromUpstream);
  }
}

function releaseAttempt(chatId: string, previousAttempt: number | undefined): void {
  if (previousAttempt === undefined) {
    lastAttemptByChat.delete(chatId);
  } else {
    lastAttemptByChat.set(chatId, previousAttempt);
  }
}

/**
 * Reads the newest unprocessed messages of a chat and stores what is worth
 * remembering as memory items. Call it after a completed reply, next to the
 * automatic summary; it returns quickly unless enough new messages piled up,
 * and it never throws.
 */
export async function maybeExtractMemories(
  options: MemoryExtractionOptions,
): Promise<MemoryExtractionResult> {
  const { chatId, signal } = options;
  const now = options.now ?? Date.now;
  const minIntervalMs = options.minIntervalMs ?? MEMORY_EXTRACTION_MIN_INTERVAL_MS;
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
    const batch = await getMemoryExtractionBatch(chatId);
    if (!batch.ready || !batch.lastMessageId || batch.messages.length === 0) {
      return skipped("not-enough-messages");
    }
    if (interrupted()) {
      return skipped(signal?.aborted ? "aborted" : "busy");
    }

    lastAttemptByChat.set(chatId, startedAt);
    attemptRecorded = true;
    const prompt = buildMemoryExtractionPrompt(batch, options);
    const reply = await requestExtraction(prompt.messages, signal);
    if (interrupted()) {
      // The user moved on before the answer arrived; retry after the next reply.
      releaseAttempt(chatId, previousAttempt);
      return skipped(signal?.aborted ? "aborted" : "busy");
    }

    const parsed = parseMemoryExtraction(reply, prompt.context);
    if (!parsed) {
      // Unreadable output is retried once more; after that the window is let go
      // so a model that cannot follow the format does not run on every reply.
      const failures = (unreadableRunsByChat.get(chatId) ?? 0) + 1;
      if (failures < MEMORY_EXTRACTION_MAX_UNREADABLE_RUNS) {
        unreadableRunsByChat.set(chatId, failures);
        return skipped("unreadable-output");
      }
    }
    unreadableRunsByChat.delete(chatId);

    const outcome = await storeMemoryExtraction({
      chatId,
      throughMessageId: batch.lastMessageId,
      expectedHistoryEpoch: batch.historyEpoch,
      add: parsed?.add ?? [],
      update: parsed?.update ?? [],
      remove: parsed?.remove ?? [],
    });
    if (outcome.added.length > 0 || outcome.updated.length > 0 || outcome.removed.length > 0) {
      memoryStore.getState().noteExtraction();
    }
    return { status: "stored", outcome };
  } catch (error) {
    if (signal?.aborted && attemptRecorded) {
      releaseAttempt(chatId, previousAttempt);
      return skipped("aborted");
    }
    console.warn("Automatic memory extraction failed.", error);
    return skipped("error");
  } finally {
    inFlightChats.delete(chatId);
  }
}
