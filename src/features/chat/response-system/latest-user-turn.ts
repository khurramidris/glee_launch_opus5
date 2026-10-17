import type { ChatMessage } from "../../../types";

export function latestUserTurnText(history: ChatMessage[] | undefined): string | undefined {
  if (!history?.length) {
    return undefined;
  }

  let latestUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return undefined;
  }

  let startIndex = latestUserIndex;
  while (startIndex > 0 && history[startIndex - 1]?.role === "user") {
    startIndex -= 1;
  }

  const parts = history
    .slice(startIndex, latestUserIndex + 1)
    .map((message) => message.content.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
