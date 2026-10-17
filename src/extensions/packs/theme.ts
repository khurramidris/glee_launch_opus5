import { isThemeId } from "../../features/theme/theme-domain";
import { checkCssValue } from "./css-value";
import { PACK_LIMITS as L } from "./limits";
import { THEME_VARIABLES, isThemeVariable } from "./theme-vars";
import type { ThemePackPayload } from "./types";
import { isPlainObject, rejectUnknownKeys, type IssueList } from "./validate";

export function validateTheme(
  raw: unknown,
  path: string,
  issues: IssueList,
): ThemePackPayload | undefined {
  if (!isPlainObject(raw)) {
    issues.add(path, "Must be an object.");
    return undefined;
  }
  rejectUnknownKeys(raw, ["base", "colorScheme", "variables"], path, issues);
  const before = issues.items.length;

  if ("base" in raw && !(typeof raw.base === "string" && isThemeId(raw.base))) {
    issues.add(`${path}.base`, "Must be the id of a built-in theme.");
  }
  if ("colorScheme" in raw && raw.colorScheme !== "light" && raw.colorScheme !== "dark") {
    issues.add(`${path}.colorScheme`, 'Must be "light" or "dark".');
  }
  const variables: Record<string, string> = {};
  if (!isPlainObject(raw.variables)) {
    issues.add(`${path}.variables`, "Must be an object of CSS variables.");
  } else {
    const entries = Object.entries(raw.variables);
    if (entries.length === 0) {
      issues.add(`${path}.variables`, "Set at least one variable.");
    }
    if (entries.length > L.maxThemeVariables) {
      issues.add(`${path}.variables`, `Has ${entries.length} variables; the limit is ${L.maxThemeVariables}.`);
    } else {
      for (const [name, value] of entries) {
        const where = `${path}.variables.${name}`;
        if (!isThemeVariable(name)) {
          issues.add(where, "Not a themeable variable.");
        } else if (typeof value !== "string") {
          issues.add(where, "Must be text.");
        } else if (value.length > L.themeValueChars) {
          issues.add(where, `Is ${value.length} characters; the limit is ${L.themeValueChars}.`);
        } else {
          const checked = checkCssValue(THEME_VARIABLES[name], value);
          if (checked.ok) {
            variables[name] = value.trim();
          } else {
            issues.add(where, checked.message);
          }
        }
      }
    }
  }
  if (issues.items.length > before) {
    return undefined;
  }
  return {
    ...(typeof raw.base === "string" ? { base: raw.base } : {}),
    ...(raw.colorScheme === "light" || raw.colorScheme === "dark"
      ? { colorScheme: raw.colorScheme }
      : {}),
    variables,
  };
}
