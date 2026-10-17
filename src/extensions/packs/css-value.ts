// A tiny allow-list parser for CSS values. Rather than trying to spot every bad
// construct (url(), @import, expression(), escapes ...), it accepts only the
// shapes the built-in themes use and rejects everything else.
import { isThemeVariable, type ThemeVarKind } from "./theme-vars";

const COLOR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla"]);
const GRADIENT_FUNCTIONS = new Set(["linear-gradient", "radial-gradient"]);
const KEYWORDS = new Set([
  "transparent",
  "currentcolor",
  "inset",
  "none",
  "to",
  "top",
  "bottom",
  "left",
  "right",
  "center",
  "circle",
  "ellipse",
  "at",
  "closest-side",
  "farthest-side",
  "closest-corner",
  "farthest-corner",
]);
const UNITS = new Set(["px", "rem", "em", "%", "deg", "turn"]);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)/;
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z])/;
const IDENT = /^[a-zA-Z][a-zA-Z-]*/;
const VAR_CALL = /^var\(\s*(--[a-z0-9-]+)\s*\)/;
const FONT_FAMILY = /^(?:"[A-Za-z0-9 .-]{1,60}"|'[A-Za-z0-9 .-]{1,60}'|[A-Za-z][A-Za-z0-9-]{0,40})$/;
const EASING_KEYWORD = /^(?:ease|ease-in|ease-out|ease-in-out|linear)$/;
const CUBIC = /^cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/;
const DURATION = /^\d{1,4}(?:\.\d+)?(?:ms|s)$/;
const MAX_DEPTH = 4;

// Friendly messages for the attacks people actually try; the parser below is
// the real gate, this only makes the error clearer.
const KNOWN_BAD: [RegExp, string][] = [
  [/url\s*\(/i, "url() is not allowed."],
  [/@\s*import/i, "@import is not allowed."],
  [/expression\s*\(/i, "expression() is not allowed."],
  [/javascript\s*:/i, "Script URLs are not allowed."],
  [/image-set|image\s*\(|element\s*\(|paint\s*\(/i, "Image functions are not allowed."],
  [/[\\;{}<>]|\/\*|\*\//, "Contains characters that are not allowed in a value."],
  [/!\s*important/i, "!important is not allowed."],
];

export type CssCheck = { ok: true } | { ok: false; message: string };

const fail = (message: string): CssCheck => ({ ok: false, message });

function checkTokens(value: string, allowGradients: boolean, allowVar: boolean): CssCheck {
  let index = 0;
  const stack: string[] = [];
  while (index < value.length) {
    const rest = value.slice(index);
    const char = rest[0];
    if (/\s/.test(char) || char === "," || char === "/") {
      index += 1;
      continue;
    }
    if (char === ")") {
      if (stack.length === 0) {
        return fail("Unbalanced parentheses.");
      }
      stack.pop();
      index += 1;
      continue;
    }
    if (char === "#") {
      const hex = HEX.exec(rest);
      if (!hex) {
        return fail("Invalid hex colour.");
      }
      index += hex[0].length;
      continue;
    }
    if (/[0-9.+-]/.test(char)) {
      const num = NUMBER.exec(rest);
      if (!num) {
        return fail("Unexpected character.");
      }
      let length = num[0].length;
      const unit = /^(?:%|[a-z]+)/i.exec(rest.slice(length));
      if (unit) {
        if (!UNITS.has(unit[0].toLowerCase())) {
          return fail(`Unit "${unit[0]}" is not allowed.`);
        }
        length += unit[0].length;
      }
      index += length;
      continue;
    }
    const ident = IDENT.exec(rest);
    if (!ident) {
      return fail("Unexpected character.");
    }
    const name = ident[0].toLowerCase();
    if (rest[ident[0].length] === "(") {
      if (name === "var") {
        const call = VAR_CALL.exec(rest);
        if (!allowVar || !call || !isThemeVariable(call[1])) {
          return fail("var() may only point at a themeable variable.");
        }
        index += call[0].length;
        continue;
      }
      const allowed =
        COLOR_FUNCTIONS.has(name) || (allowGradients && GRADIENT_FUNCTIONS.has(name));
      if (!allowed) {
        return fail(`Function "${name}()" is not allowed.`);
      }
      if (stack.length >= MAX_DEPTH) {
        return fail("Nested too deeply.");
      }
      stack.push(name);
      index += ident[0].length + 1;
      continue;
    }
    if (!KEYWORDS.has(name)) {
      return fail(`"${ident[0]}" is not an allowed keyword.`);
    }
    index += ident[0].length;
  }
  return stack.length === 0 ? { ok: true } : fail("Unbalanced parentheses.");
}

export function checkCssValue(kind: ThemeVarKind, raw: string): CssCheck {
  const value = raw.trim();
  if (!value) {
    return fail("Cannot be empty.");
  }
  for (const [pattern, message] of KNOWN_BAD) {
    if (pattern.test(value)) {
      return fail(message);
    }
  }
  switch (kind) {
    case "paint":
      return checkTokens(value, true, true);
    case "shadow":
      return checkTokens(value, false, false);
    case "font": {
      const reference = VAR_CALL.exec(value);
      if (reference && reference[0] === value && reference[1].startsWith("--font-") && isThemeVariable(reference[1])) {
        return { ok: true };
      }
      return value.split(",").every((part) => FONT_FAMILY.test(part.trim()))
        ? { ok: true }
        : fail("Use plain font family names separated by commas.");
    }
    case "duration":
      return DURATION.test(value) ? { ok: true } : fail('Use a duration such as "140ms".');
    case "easing":
      return EASING_KEYWORD.test(value) || CUBIC.test(value)
        ? { ok: true }
        : fail("Use an easing keyword or cubic-bezier(a, b, c, d).");
  }
}
