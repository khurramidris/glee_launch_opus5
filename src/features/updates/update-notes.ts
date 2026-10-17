export interface UpdateNoteLine {
  bullet: boolean;
  text: string;
}

const MAX_LINES = 40;
const MAX_LINE_LENGTH = 280;

/**
 * Turns release notes into plain lines for display. The text is only ever
 * rendered as React text nodes, never as HTML; this just removes control
 * characters and the most common Markdown markers so it reads cleanly.
 */
export function sanitizeUpdateNotes(notes: string | null | undefined): UpdateNoteLine[] {
  if (!notes) return [];
  const lines: UpdateNoteLine[] = [];
  const controlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
  for (const rawLine of notes.replace(/\r\n?/g, "\n").replace(controlCharacters, "").split("\n")) {
    let text = rawLine.trim();
    if (!text) continue;
    const bullet = /^[-*+]\s+/.test(text);
    text = text
      .replace(/^[-*+]\s+/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|`)/g, "")
      .trim();
    if (!text) continue;
    lines.push({ bullet, text: text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…` : text });
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 100 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`;
}
