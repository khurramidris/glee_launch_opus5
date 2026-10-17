import { PACK_LIMITS as L } from "./limits";
import type { CharacterPackItem } from "./types";
import {
  checkText,
  checkTextList,
  isPlainObject,
  rejectUnknownKeys,
  type IssueList,
  type JsonObject,
} from "./validate";

// Accepted spellings per field. The snake_case names mirror the card import in
// src-tauri/src/character_card.rs, so cards copied between formats keep working.
const ALIASES: Record<keyof CharacterPackItem, readonly string[]> = {
  name: ["name", "char_name"],
  description: ["description"],
  personality: ["personality", "char_persona", "persona"],
  backstory: ["backstory"],
  scenario: ["scenario", "world_scenario"],
  systemPrompt: ["systemPrompt", "system_prompt", "system"],
  postHistoryInstructions: ["postHistoryInstructions", "post_history_instructions"],
  speechStyle: ["speechStyle", "speech_style"],
  greeting: ["greeting", "first_mes", "first_message"],
  alternateGreetings: ["alternateGreetings", "alternate_greetings"],
  tags: ["tags"],
  likes: ["likes"],
  dislikes: ["dislikes"],
  boundaries: ["boundaries"],
  creatorNotes: ["creatorNotes", "creator_notes"],
  creator: ["creator"],
  characterVersion: ["characterVersion", "character_version"],
  exampleDialogue: ["exampleDialogue", "example_dialogue", "mes_example"],
};

const TEXT_FIELDS: Partial<Record<keyof CharacterPackItem, { max: number; singleLine?: boolean }>> = {
  description: { max: L.mediumTextChars },
  personality: { max: L.mediumTextChars },
  backstory: { max: L.longTextChars },
  scenario: { max: L.mediumTextChars },
  systemPrompt: { max: L.longTextChars },
  postHistoryInstructions: { max: L.mediumTextChars },
  speechStyle: { max: L.shortTextChars },
  greeting: { max: L.mediumTextChars },
  boundaries: { max: L.mediumTextChars },
  creatorNotes: { max: L.mediumTextChars },
  creator: { max: L.nameChars, singleLine: true },
  characterVersion: { max: 40, singleLine: true },
  exampleDialogue: { max: L.longTextChars },
};

const LIST_FIELDS: Partial<
  Record<keyof CharacterPackItem, { maxItems: number; max: number; singleLine?: boolean }>
> = {
  alternateGreetings: { maxItems: L.alternateGreetings, max: L.mediumTextChars },
  tags: { maxItems: L.tagCount, max: L.tagChars, singleLine: true },
  likes: { maxItems: L.tagCount, max: L.listItemChars, singleLine: true },
  dislikes: { maxItems: L.tagCount, max: L.listItemChars, singleLine: true },
};

// Cards exported by other tools wrap everything in { spec, data }.
function unwrap(raw: JsonObject): JsonObject {
  if (typeof raw.spec === "string" && isPlainObject(raw.data)) {
    return raw.data;
  }
  return raw;
}

export function validateCharacter(
  raw: unknown,
  path: string,
  issues: IssueList,
): CharacterPackItem | undefined {
  if (!isPlainObject(raw)) {
    issues.add(path, "Must be an object.");
    return undefined;
  }
  const source = unwrap(raw);
  const allowed = Object.values(ALIASES).flat();
  rejectUnknownKeys(source, allowed, path, issues);

  const before = issues.items.length;
  const out: Record<string, unknown> = {};
  for (const [field, names] of Object.entries(ALIASES) as [keyof CharacterPackItem, string[]][]) {
    const present = names.filter((alias) => alias in source);
    if (present.length > 1) {
      issues.add(`${path}.${present[1]}`, `Duplicates "${present[0]}".`);
      continue;
    }
    if (present.length === 0) {
      if (field === "name") {
        issues.add(`${path}.name`, "A character needs a name.");
      }
      continue;
    }
    const key = present[0];
    const value = source[key];
    const where = `${path}.${key}`;
    if (field === "name") {
      const name = checkText(value, where, { max: L.nameChars, required: true, singleLine: true }, issues);
      if (name !== undefined) {
        out.name = name;
      }
    } else if (LIST_FIELDS[field]) {
      const rule = LIST_FIELDS[field];
      const list = checkTextList(
        value,
        where,
        { maxItems: rule.maxItems, item: { max: rule.max, singleLine: rule.singleLine } },
        issues,
      );
      if (list !== undefined) {
        out[field] = list;
      }
    } else if (TEXT_FIELDS[field]) {
      const text = checkText(value, where, TEXT_FIELDS[field], issues);
      if (text !== undefined) {
        out[field] = text;
      }
    }
  }
  return issues.items.length === before ? (out as unknown as CharacterPackItem) : undefined;
}
