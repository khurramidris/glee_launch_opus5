import { describe, expect, it } from "vitest";
import {
  STORAGE_LIMITS,
  createBrowserStorageAdapter,
  createExtensionStorage,
  createMemoryStorageAdapter,
} from "./storage";
import { checkApiCompatibility, parseVersion } from "./version";

describe("extension storage", () => {
  it("round-trips JSON values and lists keys", async () => {
    const store = createExtensionStorage("x.y", createMemoryStorageAdapter());
    await store.set("a", { n: [1, 2] });
    await store.set("b", "text");
    await expect(store.get("a")).resolves.toEqual({ n: [1, 2] });
    await expect(store.keys()).resolves.toEqual(["a", "b"]);
    await store.remove("a");
    await expect(store.get("a")).resolves.toBeUndefined();
  });

  it("treats corrupt stored JSON as missing", async () => {
    const adapter = createMemoryStorageAdapter({ "ext:x.y:bad": "{nope" });
    await expect(createExtensionStorage("x.y", adapter).get("bad")).resolves.toBeUndefined();
  });

  it.each(["", "has space", "a/b", "../x", "x".repeat(65)])("rejects key %j", async (key) => {
    const store = createExtensionStorage("x.y", createMemoryStorageAdapter());
    await expect(store.set(key, 1)).rejects.toThrow(/Storage keys/);
  });

  it("rejects oversized and unserializable values", async () => {
    const store = createExtensionStorage("x.y", createMemoryStorageAdapter());
    await expect(store.set("big", "x".repeat(STORAGE_LIMITS.maxValueChars))).rejects.toThrow(/limited/);
    await expect(store.set("u", undefined)).rejects.toThrow(/JSON/);
  });

  it("caps the number of keys but still allows overwriting", async () => {
    const store = createExtensionStorage("x.y", createMemoryStorageAdapter());
    for (let i = 0; i < STORAGE_LIMITS.maxKeys; i += 1) {
      await store.set(`k${i}`, i);
    }
    await expect(store.set("extra", 1)).rejects.toThrow(/at most/);
    await expect(store.set("k0", 99)).resolves.toBeUndefined();
  });
});

describe("version compatibility", () => {
  it("parses partial versions", () => {
    expect(parseVersion("1")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("1.x")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("requires the same major and no newer minor", () => {
    expect(checkApiCompatibility("1", "1.0.0").ok).toBe(true);
    expect(checkApiCompatibility("1.0", "1.2.0").ok).toBe(true);
    expect(checkApiCompatibility("1.3", "1.2.0")).toMatchObject({ ok: false });
    expect(checkApiCompatibility("2", "1.2.0")).toMatchObject({ ok: false });
    expect(checkApiCompatibility("x", "1.0.0")).toMatchObject({ ok: false });
    expect(checkApiCompatibility("1", "bad")).toMatchObject({ ok: false });
  });
});

describe("browser storage adapter", () => {
  function fakeStorage() {
    const data = new Map<string, string>();
    return {
      data,
      get length() {
        return data.size;
      },
      key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
  }

  it("prefixes keys and lists by prefix", async () => {
    const backing = fakeStorage();
    backing.data.set("unrelated", "x");
    const adapter = createBrowserStorageAdapter(backing, "t.");
    await adapter.set("ext:a:k", "1");
    await adapter.set("ext:b:k", "2");
    await expect(adapter.get("ext:a:k")).resolves.toBe("1");
    await expect(adapter.keys("ext:a:")).resolves.toEqual(["ext:a:k"]);
    await adapter.remove("ext:a:k");
    await expect(adapter.get("ext:a:k")).resolves.toBeNull();
    expect([...backing.data.keys()].sort()).toEqual(["t.ext:b:k", "unrelated"]);
  });

  it("degrades quietly when storage throws or is missing", async () => {
    const broken = {
      length: 1,
      key: () => {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const adapter = createBrowserStorageAdapter(broken);
    await expect(adapter.get("k")).resolves.toBeNull();
    await expect(adapter.keys("")).resolves.toEqual([]);
    await expect(adapter.remove("k")).resolves.toBeUndefined();
    await expect(adapter.set("k", "v")).rejects.toThrow("full");
    const none = createBrowserStorageAdapter(null);
    await expect(none.get("k")).resolves.toBeNull();
    await expect(none.keys("")).resolves.toEqual([]);
  });
});
