import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  normalizeTheme,
  persistTheme,
  readStoredTheme,
} from "./theme-domain";

function createStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(THEME_STORAGE_KEY, initial);
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: () => values.get(THEME_STORAGE_KEY),
  };
}

describe("theme domain", () => {
  it("accepts supported themes and falls back to Glee", () => {
    expect(normalizeTheme("white")).toBe("white");
    expect(normalizeTheme("black")).toBe("black");
    expect(normalizeTheme("purple")).toBe("purple");
    expect(normalizeTheme("sunshine")).toBe("sunshine");
    expect(normalizeTheme("system")).toBe("glee");
    expect(normalizeTheme(null)).toBe("glee");
  });

  it("reads and writes the persisted theme", () => {
    const storage = createStorage("purple");
    expect(readStoredTheme(storage)).toBe("purple");
    expect(persistTheme("black", storage)).toBe("black");
    expect(storage.value()).toBe("black");
  });

  it("recovers from invalid or unavailable storage", () => {
    expect(readStoredTheme(createStorage("sepia"))).toBe("glee");
    const unavailable = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredTheme(unavailable)).toBe("glee");
    expect(persistTheme("purple", unavailable)).toBe("purple");
  });

  it("applies the theme and native color scheme to the root", () => {
    const root = {
      dataset: {} as DOMStringMap,
      style: { colorScheme: "" } as CSSStyleDeclaration,
    };
    expect(applyTheme("black", root)).toBe("black");
    expect(root.dataset.theme).toBe("black");
    expect(root.style.colorScheme).toBe("dark");

    applyTheme("white", root);
    expect(root.style.colorScheme).toBe("light");
  });
});
