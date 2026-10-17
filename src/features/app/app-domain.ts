import {
  buildExportSlug as buildExportSlugCore,
  sortByRecent as sortByRecentCore,
} from "../../lib/chat-domain";
import type {
  Character,
  ChatRelationshipState,
  ChatMemory,
  ChatSummary,
  GenerationPreset,
  UserProfile,
} from "../../types";

export const GENERATION_CANCELLED_MESSAGE = "Generation stopped by user.";

export interface CommandAction {
  id: string;
  label: string;
  hint: string;
  run: () => void | Promise<void>;
}

export interface ChatPresetSelection {
  generationPresetId?: string;
}

export interface SamplingProfile {
  name: string;
  temperature: number;
  topP: number;
  maxTokens?: number;
  repeatPenalty: number;
}

export function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const candidate = error as {
      message?: unknown;
      error?: unknown;
      detail?: unknown;
      cause?: unknown;
    };
    for (const value of [
      candidate.message,
      candidate.error,
      candidate.detail,
      candidate.cause,
    ]) {
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // ignore stringify errors
    }
  }
  return "Unexpected error";
}

export function resolveChatCompletionsUrl(
  endpoint: string,
  fallbackEndpoint: string,
): string {
  const safeEndpoint = endpoint.trim() || fallbackEndpoint;
  const normalized = safeEndpoint.replace(/\/+$/, "");
  if (normalized.endsWith("/v1/chat/completions")) {
    return normalized;
  }
  if (normalized.endsWith("/v1")) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

export function sortChatsByRecent(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => {
    const aTime = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
    const bTime = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
    return bTime - aTime;
  });
}

export function buildCharacterRetrievalHints(
  userProfile: UserProfile | undefined,
  speaker: Character | undefined,
  relationshipState: ChatRelationshipState | undefined,
): string | undefined {
  const traitText = userProfile?.traits.length
    ? `User traits: ${userProfile.traits.join(", ")}`
    : "";
  const segments = [
    userProfile?.about ? `User profile: ${userProfile.about}` : "",
    traitText,
    userProfile?.preferences ? `User preferences: ${userProfile.preferences}` : "",
    userProfile?.boundaries ? `User boundaries: ${userProfile.boundaries}` : "",
    speaker?.systemPrompt ? `Character instructions: ${speaker.systemPrompt}` : "",
    speaker?.description ? `Character identity: ${speaker.description}` : "",
    speaker?.tags.length ? `Character traits: ${speaker.tags.join(", ")}` : "",
    relationshipState?.summary ? `Relationship summary: ${relationshipState.summary}` : "",
    relationshipState?.interactionTone
      ? `Interaction tone: ${relationshipState.interactionTone}`
      : "",
    relationshipState?.currentScene ? `Current scene: ${relationshipState.currentScene}` : "",
    relationshipState?.characterState
      ? `Character state: ${relationshipState.characterState}`
      : "",
    relationshipState?.userState ? `User state: ${relationshipState.userState}` : "",
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }
  return segments.join("\n");
}

export function textOr(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function snippetPreview(content: string, maxLength = 220): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function emptyMemory(chatId: string): ChatMemory {
  return {
    chatId,
    summary: "",
    facts: [],
    updatedAt: new Date().toISOString(),
  };
}

export function parseBoundedNumber(
  value: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

export function parseOptionalPositiveInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export function isGenerationCancelledError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message === GENERATION_CANCELLED_MESSAGE;
  }
  return false;
}

export function sortByRecent<T extends { createdAt: string; updatedAt: string }>(
  items: T[],
): T[] {
  return sortByRecentCore(items);
}

export function buildExportSlug(label: string): string {
  return buildExportSlugCore(label);
}

export function normalizePresetId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveActivePresetId<T extends { id: string }>(
  presetId: string | undefined,
  presets: T[],
): string {
  const normalizedId = normalizePresetId(presetId);
  if (normalizedId && presets.some((preset) => preset.id === normalizedId)) {
    return normalizedId;
  }
  return "";
}

export function downloadTextFile(
  filename: string,
  content: string,
  contentType: string,
): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type { GenerationPreset };
