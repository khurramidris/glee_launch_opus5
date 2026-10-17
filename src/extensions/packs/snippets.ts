import { PACK_LIMITS as L } from "./limits";
import type { SnippetPackItem } from "./types";
import { checkText, isPlainObject, rejectUnknownKeys, type IssueList } from "./validate";

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export function validateSnippet(
  raw: unknown,
  path: string,
  issues: IssueList,
): SnippetPackItem | undefined {
  if (!isPlainObject(raw)) {
    issues.add(path, "Must be an object.");
    return undefined;
  }
  rejectUnknownKeys(raw, ["id", "name", "text", "enabledByDefault"], path, issues);
  const before = issues.items.length;

  if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
    issues.add(`${path}.id`, "Must be lowercase letters, digits and dashes, starting with a letter (40 max).");
  }
  const name = checkText(raw.name, `${path}.name`, { max: L.nameChars, required: true, singleLine: true }, issues);
  const text = checkText(raw.text, `${path}.text`, { max: L.snippetChars, required: true }, issues);
  if (text !== undefined && text.split("\n").filter((line) => line.trim()).length > L.snippetLines) {
    issues.add(`${path}.text`, `Use at most ${L.snippetLines} lines.`);
  }
  if ("enabledByDefault" in raw && typeof raw.enabledByDefault !== "boolean") {
    issues.add(`${path}.enabledByDefault`, "Must be true or false.");
  }
  if (issues.items.length > before || name === undefined || text === undefined) {
    return undefined;
  }
  return {
    id: raw.id as string,
    name,
    text,
    enabledByDefault: raw.enabledByDefault === true,
  };
}
