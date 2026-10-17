import type { Extension } from "../types";
import { createChatStatsExtension } from "./chat-stats";
import { createPromptSnippetsExtension } from "./prompt-snippets";
import type { SnippetLibrary } from "./snippet-library";
import { wordCountExtension } from "./word-count";

export { createChatStatsExtension, createStatsStore } from "./chat-stats";
export { createPromptSnippetsExtension } from "./prompt-snippets";
export { createSnippetLibrary, snippetKey } from "./snippet-library";
export type { SnippetEntry, SnippetLibrary } from "./snippet-library";
export { countWords, wordCountExtension } from "./word-count";

export function createBuiltinExtensions(snippets: SnippetLibrary): Extension[] {
  return [wordCountExtension, createPromptSnippetsExtension(snippets), createChatStatsExtension()];
}
