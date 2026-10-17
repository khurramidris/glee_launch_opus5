import type { LlamaChatMessage } from "../../../types";

// Matches the --ctx-size the desktop backend gives llama-server.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 8192;
export const DEFAULT_OUTPUT_TOKENS = 512;
export const MAX_OUTPUT_TOKENS = 1024;
const CONTEXT_SAFETY_RESERVE_TOKENS = 128;
const CHAT_TEMPLATE_BASE_TOKENS = 8;
const CHAT_MESSAGE_OVERHEAD_TOKENS = 6;

export interface FittedChatMessages {
  messages: LlamaChatMessage[];
  contextWindowTokens: number;
  inputTokenBudget: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  droppedMessages: number;
  systemPromptClipped: boolean;
  latestUserMessageClipped: boolean;
}

export function estimateTextTokens(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }

  const segments = normalized.match(/[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
  const segmentedEstimate = segments.reduce((total, segment) => {
    if (/^[\x00-\x7F]+$/.test(segment) && /^[A-Za-z0-9_]+$/.test(segment)) {
      return total + Math.max(1, Math.ceil(segment.length / 4));
    }
    if (/^[\p{L}\p{N}_]+$/u.test(segment)) {
      return total + Math.max(1, Math.ceil([...segment].length / 2));
    }
    return total + 1;
  }, 0);
  const characterFloor = Math.ceil([...normalized].length / 4);
  return Math.max(segmentedEstimate, characterFloor);
}

export function estimateChatMessagesTokens(messages: LlamaChatMessage[]): number {
  return messages.reduce(
    (total, message) =>
      total + CHAT_MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content),
    CHAT_TEMPLATE_BASE_TOKENS,
  );
}

export function clampOutputTokens(
  requested: number | undefined,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
): number {
  const candidate = Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested as number))
    : DEFAULT_OUTPUT_TOKENS;
  return Math.min(
    candidate,
    MAX_OUTPUT_TOKENS,
    Math.max(1, Math.floor(contextWindowTokens / 2)),
  );
}

function clipTextToTokenBudget(
  value: string,
  maxTokens: number,
  preserveEnd: boolean,
): string {
  const normalized = value.trim();
  if (estimateTextTokens(normalized) <= maxTokens) {
    return normalized;
  }
  if (maxTokens <= 0) {
    return "";
  }

  const marker = "\n...[earlier content clipped]...\n";
  let low = 1;
  let high = normalized.length;
  let best = "";
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = preserveEnd
      ? (() => {
          const headLength = Math.floor(length * 0.38);
          const tailLength = Math.max(1, length - headLength);
          return `${normalized.slice(0, headLength).trimEnd()}${marker}${normalized
            .slice(-tailLength)
            .trimStart()}`;
        })()
      : `${normalized.slice(0, length).trimEnd()}...`;
    if (estimateTextTokens(candidate) <= maxTokens) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

function removeOldestConversationTurn(messages: LlamaChatMessage[]): number {
  const start = messages[0]?.role === "system" ? 1 : 0;
  const protectedLastIndex = messages.length - 1;
  if (start >= protectedLastIndex) {
    return 0;
  }

  let end = start + 1;
  if (messages[start]?.role === "user") {
    while (end < protectedLastIndex && messages[end]?.role !== "user") {
      end += 1;
    }
  }
  const count = Math.max(1, end - start);
  messages.splice(start, count);
  return count;
}

export function fitChatMessagesToContextWindow(
  inputMessages: LlamaChatMessage[],
  options: {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
  } = {},
): FittedChatMessages {
  const contextWindowTokens = Math.max(
    512,
    Math.floor(options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
  );
  const maxOutputTokens = clampOutputTokens(
    options.maxOutputTokens,
    contextWindowTokens,
  );
  const inputTokenBudget = Math.max(
    256,
    contextWindowTokens - maxOutputTokens - CONTEXT_SAFETY_RESERVE_TOKENS,
  );
  const messages = inputMessages.map((message) => ({ ...message }));
  let droppedMessages = 0;
  let systemPromptClipped = false;
  let latestUserMessageClipped = false;

  while (
    estimateChatMessagesTokens(messages) > inputTokenBudget &&
    messages.length > (messages[0]?.role === "system" ? 2 : 1)
  ) {
    const removed = removeOldestConversationTurn(messages);
    if (removed === 0) {
      break;
    }
    droppedMessages += removed;
  }

  if (estimateChatMessagesTokens(messages) > inputTokenBudget) {
    const systemIndex = messages[0]?.role === "system" ? 0 : -1;
    if (systemIndex >= 0) {
      const otherMessages = messages.filter((_, index) => index !== systemIndex);
      const available = Math.max(
        64,
        inputTokenBudget - estimateChatMessagesTokens(otherMessages) - CHAT_MESSAGE_OVERHEAD_TOKENS,
      );
      const clipped = clipTextToTokenBudget(messages[systemIndex].content, available, false);
      systemPromptClipped = clipped !== messages[systemIndex].content;
      messages[systemIndex] = { ...messages[systemIndex], content: clipped };
    }
  }

  if (estimateChatMessagesTokens(messages) > inputTokenBudget) {
    let latestUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        latestUserIndex = index;
        break;
      }
    }
    if (latestUserIndex >= 0) {
      const otherMessages = messages.filter((_, index) => index !== latestUserIndex);
      const available = Math.max(
        32,
        inputTokenBudget - estimateChatMessagesTokens(otherMessages) - CHAT_MESSAGE_OVERHEAD_TOKENS,
      );
      const clipped = clipTextToTokenBudget(
        messages[latestUserIndex].content,
        available,
        true,
      );
      latestUserMessageClipped = clipped !== messages[latestUserIndex].content;
      messages[latestUserIndex] = {
        ...messages[latestUserIndex],
        content: clipped,
      };
    }
  }

  return {
    messages,
    contextWindowTokens,
    inputTokenBudget,
    estimatedInputTokens: estimateChatMessagesTokens(messages),
    maxOutputTokens,
    droppedMessages,
    systemPromptClipped,
    latestUserMessageClipped,
  };
}
