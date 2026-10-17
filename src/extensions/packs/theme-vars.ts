// The appearance variables a theme pack may set. They are the colour, shadow,
// font and motion tokens declared in the :root and html[data-theme] blocks of
// src/App.css; layout variables (rail widths, radii) are intentionally left out
// so a pack cannot break the shell. A test keeps this list in sync with the CSS.
export type ThemeVarKind = "paint" | "shadow" | "font" | "duration" | "easing";

const PAINT = [
  "--bg",
  "--bg-elevated",
  "--surface",
  "--surface-2",
  "--surface-3",
  "--surface-strong",
  "--surface-tint",
  "--surface-shell",
  "--surface-shell-strong",
  "--surface-card",
  "--surface-card-soft",
  "--surface-chat",
  "--surface-overlay",
  "--glass-panel",
  "--glass-panel-strong",
  "--glass-stroke",
  "--border",
  "--border-strong",
  "--text",
  "--text-strong",
  "--text-soft",
  "--muted",
  "--muted-strong",
  "--yellow",
  "--yellow-dark",
  "--yellow-soft",
  "--success",
  "--success-bg",
  "--danger",
  "--danger-bg",
  "--ring",
  "--app-background",
  "--body-glow-left",
  "--body-glow-right",
  "--window-control-bg",
  "--titlebar-bg",
  "--titlebar-border",
  "--titlebar-control-bg",
  "--titlebar-control-border",
  "--titlebar-control-color",
  "--wordmark-color",
  "--control-bg",
  "--input-bg",
  "--hover-bg",
  "--active-bg",
  "--active-edge",
  "--accent-button-start",
  "--accent-button-end",
  "--accent-button-text",
  "--user-bubble-start",
  "--user-bubble-end",
  "--user-bubble-text",
  "--overlay-bg",
  "--scrollbar-thumb",
  "--placeholder",
] as const;

const SHADOW = [
  "--shadow-xs",
  "--shadow-sm",
  "--shadow",
  "--shadow-lg",
  "--shadow-inner",
] as const;

const FONT = ["--font-body", "--font-heading", "--font-mono"] as const;
const DURATION = ["--trans-fast", "--trans-base", "--trans-slow"] as const;
const EASING = ["--ease-standard", "--ease-emph"] as const;

export const THEME_VARIABLES: Readonly<Record<string, ThemeVarKind>> = Object.freeze({
  ...Object.fromEntries(PAINT.map((name) => [name, "paint" as const])),
  ...Object.fromEntries(SHADOW.map((name) => [name, "shadow" as const])),
  ...Object.fromEntries(FONT.map((name) => [name, "font" as const])),
  ...Object.fromEntries(DURATION.map((name) => [name, "duration" as const])),
  ...Object.fromEntries(EASING.map((name) => [name, "easing" as const])),
});

export function isThemeVariable(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(THEME_VARIABLES, name);
}
