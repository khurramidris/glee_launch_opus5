import type { Extension } from "../types";
import type { SnippetLibrary } from "./snippet-library";

const ENABLED_KEY = "enabled";

/**
 * Feeds the lines of enabled snippet packs into the per-turn notes. Lines are
 * appended whole and only while they fit the allowance the pipeline grants, so
 * the extension never trips the budget check.
 */
export function createPromptSnippetsExtension(library: SnippetLibrary): Extension {
  let stopSaving: (() => void) | undefined;
  return {
    id: "glee.prompt-snippets",
    name: "Prompt snippets",
    version: "1.0.0",
    description: "Adds the text of the snippets you switched on to every reply's notes.",
    apiVersion: "1",
    permissions: ["prompt:notes", "storage"],
    async activate(ctx) {
      const saved = await ctx.storage.get<string[]>(ENABLED_KEY);
      if (Array.isArray(saved)) {
        library.restoreEnabled(saved.filter((key) => typeof key === "string"));
      }
      stopSaving = library.subscribe(() => {
        const keys = library.list().filter((item) => item.enabled).map((item) => item.id);
        void ctx.storage.set(ENABLED_KEY, keys).catch((error: unknown) => {
          ctx.logger.warn("Could not save snippet choices", String(error));
        });
      });

      ctx.chatPipeline.transformPromptNotes((notes, context) => {
        const present = new Set(notes);
        let remaining = context.remainingChars;
        const append: string[] = [];
        for (const snippet of library.list()) {
          if (!snippet.enabled) {
            continue;
          }
          for (const raw of snippet.text.split("\n")) {
            const line = raw.trim();
            if (!line || present.has(line) || line.length + 1 > remaining) {
              continue;
            }
            append.push(line);
            present.add(line);
            remaining -= line.length + 1;
          }
        }
        return append.length > 0 ? { append } : undefined;
      });
    },
    deactivate() {
      stopSaving?.();
      stopSaving = undefined;
    },
  };
}
