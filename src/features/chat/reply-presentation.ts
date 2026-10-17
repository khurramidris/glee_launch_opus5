export interface ReplyPresentation {
  speakerCharacterId?: string;
  targetMessageId?: string;
  content: string;
}

export function resolveReplyPresentation(
  replyState: "queued" | "streaming" | null | undefined,
  streaming: ReplyPresentation | null | undefined,
  fallbackSpeakerCharacterId?: string,
): ReplyPresentation | null {
  if (streaming) {
    return streaming;
  }
  if (replyState !== "queued") {
    return null;
  }
  return {
    speakerCharacterId: fallbackSpeakerCharacterId,
    content: "",
  };
}
