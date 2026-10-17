import type { ExtensionStorage } from "./types";

/**
 * What the host provides. Production can back it with the app settings table;
 * tests use `createMemoryStorageAdapter`. Keys are flat strings.
 */
export interface StorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export function createMemoryStorageAdapter(
  initial: Record<string, string> = {},
): StorageAdapter & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
    async keys(prefix) {
      return [...data.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    dump() {
      return Object.fromEntries(data);
    },
  };
}

export const STORAGE_LIMITS = {
  maxKeyLength: 64,
  maxValueChars: 32_768,
  maxKeys: 64,
} as const;

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export function extensionStoragePrefix(extensionId: string): string {
  return `ext:${extensionId}:`;
}

/** A per-extension view: keys are namespaced and sizes are capped. */
export function createExtensionStorage(
  extensionId: string,
  adapter: StorageAdapter,
): ExtensionStorage {
  const prefix = extensionStoragePrefix(extensionId);

  function fullKey(key: string): string {
    if (key.length === 0 || key.length > STORAGE_LIMITS.maxKeyLength || !KEY_PATTERN.test(key)) {
      throw new Error(
        `Storage keys use letters, digits, ".", "_" or "-" and at most ${STORAGE_LIMITS.maxKeyLength} characters.`,
      );
    }
    return prefix + key;
  }

  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      const raw = await adapter.get(fullKey(key));
      if (raw === null) {
        return undefined;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      const full = fullKey(key);
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new Error("Storage values must be JSON-serializable.");
      }
      if (serialized.length > STORAGE_LIMITS.maxValueChars) {
        throw new Error(`Storage values are limited to ${STORAGE_LIMITS.maxValueChars} characters.`);
      }
      const existing = await adapter.keys(prefix);
      if (!existing.includes(full) && existing.length >= STORAGE_LIMITS.maxKeys) {
        throw new Error(`Extensions may store at most ${STORAGE_LIMITS.maxKeys} keys.`);
      }
      await adapter.set(full, serialized);
    },
    async remove(key) {
      await adapter.remove(fullKey(key));
    },
    async keys() {
      return (await adapter.keys(prefix)).map((key) => key.slice(prefix.length));
    },
  };
}

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/**
 * Interim production adapter: the webview's localStorage under a fixed prefix.
 * Every call is wrapped because storage can be blocked or full; a failure
 * degrades to "nothing saved" instead of breaking an extension.
 */
export function createBrowserStorageAdapter(
  storage: BrowserStorage | null = typeof window === "undefined" ? null : window.localStorage,
  prefix = "glee.ext.",
): StorageAdapter {
  return {
    async get(key) {
      try {
        return storage?.getItem(prefix + key) ?? null;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      storage?.setItem(prefix + key, value);
    },
    async remove(key) {
      try {
        storage?.removeItem(prefix + key);
      } catch {
        // Nothing to remove if storage is unavailable.
      }
    },
    async keys(keyPrefix) {
      const found: string[] = [];
      try {
        for (let index = 0; storage && index < storage.length; index += 1) {
          const full = storage.key(index);
          if (full?.startsWith(prefix + keyPrefix)) {
            found.push(full.slice(prefix.length));
          }
        }
      } catch {
        return [];
      }
      return found.sort();
    },
  };
}
