import type { Extension } from "../types";

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Smallest useful extension: one message button, only the permissions it needs. */
export const wordCountExtension: Extension = {
  id: "glee.word-count",
  name: "Word count",
  version: "1.0.0",
  description: "Adds a message button that copies the word count of that message.",
  apiVersion: "1",
  permissions: ["ui:message-actions", "chat:read"],
  activate(ctx) {
    ctx.messageActions.register({
      id: "copy-word-count",
      label: "Copy word count",
      when: (message) => message.content.trim().length > 0,
      run: (message) => {
        const words = countWords(message.content);
        return {
          copyText: String(words),
          notice: `${words} ${words === 1 ? "word" : "words"} copied.`,
        };
      },
    });
  },
};
