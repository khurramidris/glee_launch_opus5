import type {
  ChatCompletionDelta,
  LlamaChatCompletionChunk,
  LlamaTokenUsage,
} from "../types";

const DONE_SENTINEL = "[DONE]";
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 45_000;
const DEFAULT_INACTIVITY_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 240_000;

export interface LlamaSseStreamOptions {
  signal?: AbortSignal;
  firstTokenTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  totalTimeoutMs?: number;
}

type DecodedEvent = {
  deltas: ChatCompletionDelta[];
  done: boolean;
};

function normalizePositiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function tokenUsage(chunk: LlamaChatCompletionChunk): LlamaTokenUsage | undefined {
  const usage = chunk.usage;
  if (!usage) {
    return undefined;
  }
  const normalized: LlamaTokenUsage = {
    promptTokens:
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    completionTokens:
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined,
    totalTokens:
      typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
  };
  return Object.values(normalized).some((value) => value !== undefined)
    ? normalized
    : undefined;
}

function decodeEvent(raw: string): DecodedEvent {
  const payloads = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  const deltas: ChatCompletionDelta[] = [];
  let done = false;
  for (const payload of payloads) {
    if (payload === DONE_SENTINEL) {
      done = true;
      continue;
    }

    let chunk: LlamaChatCompletionChunk;
    try {
      chunk = JSON.parse(payload) as LlamaChatCompletionChunk;
    } catch {
      throw new Error("The local model returned a malformed streaming response.");
    }

    if (chunk.error?.message) {
      throw new Error(chunk.error.message);
    }

    const choice = chunk.choices?.[0];
    const content = choice?.delta?.content;
    const finishReason = choice?.finish_reason;
    const usage = tokenUsage(chunk);
    if (
      (typeof content === "string" && content.length > 0) ||
      finishReason !== undefined ||
      usage
    ) {
      deltas.push({
        content: typeof content === "string" ? content : "",
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(usage ? { usage } : {}),
      });
    }
  }

  return { deltas, done };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      callback: (value: ReadableStreamReadResult<Uint8Array>) => void,
      value: ReadableStreamReadResult<Uint8Array>,
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => fail(abortError());
    const timeoutId = setTimeout(
      () => fail(new Error(timeoutMessage)),
      Math.max(1, timeoutMs),
    );

    if (signal?.aborted) {
      fail(abortError());
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => finish(resolve, result),
      (error) => fail(error),
    );
  });
}

function nextReadDeadline(input: {
  now: number;
  startedAt: number;
  lastActivityAt: number;
  receivedContent: boolean;
  firstTokenTimeoutMs: number;
  inactivityTimeoutMs: number;
  totalTimeoutMs: number;
}): { timeoutMs: number; message: string } {
  const totalRemaining = input.totalTimeoutMs - (input.now - input.startedAt);
  const phaseRemaining = input.receivedContent
    ? input.inactivityTimeoutMs - (input.now - input.lastActivityAt)
    : input.firstTokenTimeoutMs - (input.now - input.startedAt);
  if (totalRemaining <= phaseRemaining) {
    return {
      timeoutMs: totalRemaining,
      message: "The local model response exceeded the total time limit.",
    };
  }
  return {
    timeoutMs: phaseRemaining,
    message: input.receivedContent
      ? "The local model stopped sending response data."
      : "The local model did not begin responding in time.",
  };
}

export async function* parseLlamaSseStream(
  stream: ReadableStream<Uint8Array>,
  options: LlamaSseStreamOptions = {},
): AsyncGenerator<ChatCompletionDelta> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const firstTokenTimeoutMs = normalizePositiveTimeout(
    options.firstTokenTimeoutMs,
    DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
  );
  const inactivityTimeoutMs = normalizePositiveTimeout(
    options.inactivityTimeoutMs,
    DEFAULT_INACTIVITY_TIMEOUT_MS,
  );
  const totalTimeoutMs = normalizePositiveTimeout(
    options.totalTimeoutMs,
    DEFAULT_TOTAL_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let receivedContent = false;
  let buffer = "";
  let completedNaturally = false;

  try {
    while (true) {
      const deadline = nextReadDeadline({
        now: Date.now(),
        startedAt,
        lastActivityAt,
        receivedContent,
        firstTokenTimeoutMs,
        inactivityTimeoutMs,
        totalTimeoutMs,
      });
      const { value, done } = await readWithDeadline(
        reader,
        deadline.timeoutMs,
        deadline.message,
        options.signal,
      );
      if (done) {
        completedNaturally = true;
        break;
      }

      lastActivityAt = Date.now();
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";

      for (const event of events) {
        const decoded = decodeEvent(event);
        for (const delta of decoded.deltas) {
          if (delta.content) {
            receivedContent = true;
          }
          yield delta;
        }
        if (decoded.done) {
          completedNaturally = true;
          return;
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const decoded = decodeEvent(buffer);
      for (const delta of decoded.deltas) {
        if (delta.content) {
          receivedContent = true;
        }
        yield delta;
      }
    }
  } finally {
    if (!completedNaturally) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be aborted by the upstream request signal.
      }
    }
    reader.releaseLock();
  }
}
