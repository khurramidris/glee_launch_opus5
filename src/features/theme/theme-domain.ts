export const THEME_STORAGE_KEY = "glee.ui.theme";

export const THEME_OPTIONS = [
  {
    id: "glee",
    label: "Glee",
    description: "Warm cream surfaces with the signature yellow accent.",
  },
  {
    id: "sunshine",
    label: "Glee Sunshine",
    description: "Clean warm-white surfaces with bold, joyful yellow branding.",
  },
  {
    id: "white",
    label: "White",
    description: "Clean white and soft gray surfaces with graphite controls.",
  },
  {
    id: "black",
    label: "Black",
    description: "Deep charcoal surfaces with warm yellow highlights.",
  },
  {
    id: "purple",
    label: "Purple",
    description: "Soft lavender surfaces with rich violet accents.",
  },
] as const;

export type ThemeId = (typeof THEME_OPTIONS)[number]["id"];

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
type ThemeRoot = Pick<HTMLElement, "dataset" | "style">;

export function isThemeId(value: unknown): value is ThemeId {
  return THEME_OPTIONS.some((option) => option.id === value);
}

export function normalizeTheme(value: unknown): ThemeId {
  return isThemeId(value) ? value : "glee";
}

function browserStorage(): ThemeStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredTheme(storage: ThemeStorage | null = browserStorage()): ThemeId {
  if (!storage) {
    return "glee";
  }
  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "glee";
  }
}

export function persistTheme(
  value: unknown,
  storage: ThemeStorage | null = browserStorage(),
): ThemeId {
  const theme = normalizeTheme(value);
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A blocked storage backend should not prevent appearance changes this session.
  }
  return theme;
}

export function applyTheme(
  value: unknown,
  root: ThemeRoot | null = typeof document === "undefined" ? null : document.documentElement,
): ThemeId {
  const theme = normalizeTheme(value);
  if (root) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme === "black" ? "dark" : "light";
  }
  return theme;
}

export function initializeTheme(): ThemeId {
  return applyTheme(readStoredTheme());
}
