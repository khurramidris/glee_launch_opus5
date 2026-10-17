export interface SnippetEntry {
  id: string;
  name: string;
  text: string;
  enabled: boolean;
}

/** A pack's snippet, namespaced so two packs can both ship an id like "tone". */
export function snippetKey(packName: string, snippetId: string): string {
  return `${packName}/${snippetId}`;
}

export interface SnippetLibrary {
  list(): readonly SnippetEntry[];
  add(entry: { key: string; name: string; text: string; enabled: boolean }): void;
  setEnabled(key: string, enabled: boolean): void;
  /** Turn on exactly these keys (used to restore saved choices). */
  restoreEnabled(keys: readonly string[]): void;
  subscribe(listener: () => void): () => void;
}

export function createSnippetLibrary(): SnippetLibrary {
  const items = new Map<string, SnippetEntry>();
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((listener) => listener());

  return {
    list: () => [...items.values()],
    add(entry) {
      items.set(entry.key, {
        id: entry.key,
        name: entry.name,
        text: entry.text,
        enabled: entry.enabled,
      });
      notify();
    },
    setEnabled(key, enabled) {
      const item = items.get(key);
      if (item && item.enabled !== enabled) {
        items.set(key, { ...item, enabled });
        notify();
      }
    },
    restoreEnabled(keys) {
      const on = new Set(keys);
      for (const [key, item] of items) {
        items.set(key, { ...item, enabled: on.has(key) });
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
