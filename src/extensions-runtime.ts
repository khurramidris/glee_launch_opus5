import { createBrowserStorageAdapter, createDefaultRegistry, createSnippetLibrary } from "./extensions";
import { connectAppEvents } from "./features/app/app-events";
import { appStore } from "./stores/app-store";

/** Snippets that installed packs contribute to the per-turn prompt notes. */
export const snippetLibrary = createSnippetLibrary();

/**
 * The app-wide extension registry. Built-in features register here, and future
 * extensions and packs plug into the same places (see docs/EXTENSIONS.md).
 */
export const extensionRegistry = createDefaultRegistry({
  snippetLibrary,
  storage: createBrowserStorageAdapter(),
  host: {
    notify: ({ kind, message }) => appStore.getState().setNotice({ kind, message }),
    copyText: async (text) => {
      await navigator.clipboard.writeText(text);
    },
  },
});

void extensionRegistry.start();
connectAppEvents(extensionRegistry);
