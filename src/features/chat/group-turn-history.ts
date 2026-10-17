import type { ChatMessage } from "../../types";
import { clipText } from "./response-system/compile/prompt-budget";
import { sanitizeAssistantHistoryContent } from "./response-sanitizer";

const MAX_SAME_ROUND_REPLY_CHARS = 180;
const MAX_SAME_ROUND_TOTAL_CHARS = 720;

function stripLeadingSpeakerLabel(text: string): string {
  return text.replace(/^[A-Za-z][^:\n]{0,60}:\s*/, "").trim();
}

function shapeSameRoundGroupHistory(messages: ChatMessage[]): ChatMessage[] {
  const shaped: ChatMessage[] = [];
  let usedAssistantChars = 0;

  for (const message of messages) {
    if (message.role !== "assistant") {
      shaped.push(message);
      continue;
    }

    const sanitized = stripLeadingSpeakerLabel(
      sanitizeAssistantHistoryContent(message.content),
    );
    if (!sanitized) {
      continue;
    }

    const remainingBudget = MAX_SAME_ROUND_TOTAL_CHARS - usedAssistantChars;
    if (remainingBudget <= 24) {
      break;
    }

    const clipped = clipText(
      sanitized,
      Math.min(MAX_SAME_ROUND_REPLY_CHARS, remainingBudget),
    );
    if (!clipped) {
      continue;
    }

    shaped.push({
      ...message,
      content: clipped,
    });
    usedAssistantChars += clipped.length;
  }

  return shaped;
}

export function historyForQueuedSpeakerTurn(input: {
  groupMode: boolean;
  roundHistoryBase: ChatMessage[];
  currentHistory: ChatMessage[];
}): ChatMessage[] {
  if (!input.groupMode) {
    return input.currentHistory;
  }

  const baseLength = input.roundHistoryBase.length;
  const sameRoundMessages = input.currentHistory.slice(baseLength);
  if (sameRoundMessages.length === 0) {
    return input.roundHistoryBase;
  }

  const shapedSameRoundHistory = shapeSameRoundGroupHistory(sameRoundMessages);
  if (shapedSameRoundHistory.length === 0) {
    return input.roundHistoryBase;
  }

  return [...input.roundHistoryBase, ...shapedSameRoundHistory];
}
