import { PACK_LIMITS as L } from "./limits";
import type { PersonaPackItem } from "./types";
import { checkText, isPlainObject, rejectUnknownKeys, type IssueList } from "./validate";

export function validatePersona(
  raw: unknown,
  path: string,
  issues: IssueList,
): PersonaPackItem | undefined {
  if (!isPlainObject(raw)) {
    issues.add(path, "Must be an object.");
    return undefined;
  }
  rejectUnknownKeys(raw, ["name", "about", "preferences"], path, issues);
  const name = checkText(raw.name, `${path}.name`, { max: L.nameChars, required: true, singleLine: true }, issues);
  const about = checkText(raw.about ?? "", `${path}.about`, { max: L.mediumTextChars }, issues);
  const preferences = checkText(raw.preferences ?? "", `${path}.preferences`, { max: L.mediumTextChars }, issues);
  if (name === undefined || about === undefined || preferences === undefined) {
    return undefined;
  }
  return { name, about, preferences };
}
