import { PACK_LIMITS as L } from "./limits";
import type { ContextPackItem } from "./types";
import {
  checkText,
  checkTextList,
  isPlainObject,
  rejectUnknownKeys,
  type IssueList,
} from "./validate";

const KEYS = ["scope", "characterName", "title", "keywords", "content", "enabled"] as const;

export function validateContextEntry(
  raw: unknown,
  path: string,
  issues: IssueList,
): ContextPackItem | undefined {
  if (!isPlainObject(raw)) {
    issues.add(path, "Must be an object.");
    return undefined;
  }
  rejectUnknownKeys(raw, KEYS, path, issues);
  const before = issues.items.length;

  const scope = raw.scope ?? "global";
  if (scope !== "global" && scope !== "character") {
    issues.add(`${path}.scope`, 'Must be "global" or "character".');
  }
  let characterName: string | undefined;
  if (scope === "character") {
    characterName = checkText(
      raw.characterName,
      `${path}.characterName`,
      { max: L.nameChars, required: true, singleLine: true },
      issues,
    );
  } else if ("characterName" in raw) {
    issues.add(`${path}.characterName`, 'Only allowed when scope is "character".');
  }
  const title = checkText(raw.title, `${path}.title`, { max: L.nameChars, required: true, singleLine: true }, issues);
  const keywords = checkTextList(
    raw.keywords ?? [],
    `${path}.keywords`,
    { maxItems: L.keywordCount, item: { max: L.keywordChars, singleLine: true } },
    issues,
  );
  const content = checkText(raw.content, `${path}.content`, { max: L.contextContentChars, required: true }, issues);
  if ("enabled" in raw && typeof raw.enabled !== "boolean") {
    issues.add(`${path}.enabled`, "Must be true or false.");
  }
  if (issues.items.length > before || title === undefined || keywords === undefined || content === undefined) {
    return undefined;
  }
  return {
    scope: scope as "global" | "character",
    ...(characterName ? { characterName } : {}),
    title,
    keywords,
    content,
    enabled: raw.enabled !== false,
  };
}
