import type { ChatMessage } from "../../types";

export const GENERATION_FAILURE_PREFIX = "[Glee reply failed]";

export function buildGenerationFailureMessage(speakerName?: string): string {
  const name = speakerName?.trim();
  return name
    ? `${GENERATION_FAILURE_PREFIX} ${name} could not complete this reply after an automatic retry. Select Regenerate to try again.`
    : `${GENERATION_FAILURE_PREFIX} This reply could not be completed after an automatic retry. Select Regenerate to try again.`;
}

export function isGenerationFailureContent(content?: string): boolean {
  return (content ?? "").trim().startsWith(GENERATION_FAILURE_PREFIX);
}

export function generationFailureDisplayText(content?: string): string {
  const normalized = (content ?? "").trim();
  if (!isGenerationFailureContent(normalized)) {
    return normalized;
  }
  return (
    normalized.slice(GENERATION_FAILURE_PREFIX.length).trim() ||
    "The character could not complete this reply."
  );
}

export function filterGenerationFailureMessages<T extends Pick<ChatMessage, "role" | "content">>(
  history: T[],
): T[] {
  return history.filter(
    (message) =>
      !(message.role === "assistant" && isGenerationFailureContent(message.content)),
  );
}
