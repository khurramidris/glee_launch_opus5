import { validateCharacter } from "./characters";
import { validateContextEntry } from "./context";
import { PACK_LIMITS as L, PACK_SCHEMA_VERSION } from "./limits";
import { validatePersona } from "./personas";
import { validateSnippet } from "./snippets";
import { validateTheme } from "./theme";
import type { LoadPackResult, Pack, PackKind, PackMeta } from "./types";
import {
  checkItems,
  checkText,
  isPlainObject,
  rejectUnknownKeys,
  IssueList,
  type JsonObject,
} from "./validate";
import { parseVersion } from "../version";

const KINDS: readonly PackKind[] = ["characters", "context", "personas", "snippets", "theme"];
const PAYLOAD_KEY: Record<PackKind, string> = {
  characters: "characters",
  context: "entries",
  personas: "personas",
  snippets: "snippets",
  theme: "theme",
};
const META_KEYS = ["schemaVersion", "kind", "name", "description", "author", "version"];

function readMeta(root: JsonObject, issues: IssueList): PackMeta | undefined {
  const before = issues.items.length;
  if (typeof root.schemaVersion !== "number") {
    issues.add("schemaVersion", `Required. Use ${PACK_SCHEMA_VERSION}.`);
  } else if (root.schemaVersion > PACK_SCHEMA_VERSION) {
    issues.add("schemaVersion", "This pack was made for a newer version of Glee.");
  } else if (root.schemaVersion !== PACK_SCHEMA_VERSION) {
    issues.add("schemaVersion", `Unsupported version. Use ${PACK_SCHEMA_VERSION}.`);
  }
  const name = checkText(root.name, "name", { max: L.nameChars, required: true, singleLine: true }, issues);
  const description =
    "description" in root
      ? checkText(root.description, "description", { max: L.packDescriptionChars }, issues)
      : undefined;
  const author =
    "author" in root
      ? checkText(root.author, "author", { max: L.nameChars, singleLine: true }, issues)
      : undefined;
  let version: string | undefined;
  if ("version" in root) {
    version = checkText(root.version, "version", { max: 20, singleLine: true }, issues);
    if (version !== undefined && !parseVersion(version)) {
      issues.add("version", 'Use a version such as "1.0.0".');
    }
  }
  if (issues.items.length > before || name === undefined) {
    return undefined;
  }
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    name,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(version ? { version } : {}),
  };
}

function mapItems<T>(
  raw: unknown,
  path: string,
  max: number,
  issues: IssueList,
  validate: (item: unknown, path: string, issues: IssueList) => T | undefined,
): T[] | undefined {
  const items = checkItems(raw, path, max, issues);
  if (!items) {
    return undefined;
  }
  const before = issues.items.length;
  const out = items.map((item, index) => validate(item, `${path}[${index}]`, issues));
  return issues.items.length > before ? undefined : (out as T[]);
}

/**
 * Parse and validate a pack. Accepts raw JSON text or an already-parsed value.
 * Never throws and never touches the app: the result is plain data.
 */
export function loadPack(input: unknown): LoadPackResult {
  const issues = new IssueList();
  const fail = (): LoadPackResult => ({ ok: false, errors: issues.items });

  let root: unknown = input;
  if (typeof input === "string") {
    if (input.length > L.maxJsonChars) {
      issues.add("", `The file is larger than ${L.maxJsonChars} characters.`);
      return fail();
    }
    try {
      root = JSON.parse(input);
    } catch (error) {
      issues.add("", `Not valid JSON: ${error instanceof Error ? error.message : "parse error"}.`);
      return fail();
    }
  }
  if (!isPlainObject(root)) {
    issues.add("", "A pack must be a JSON object.");
    return fail();
  }

  const kind = root.kind;
  if (typeof kind !== "string" || !KINDS.includes(kind as PackKind)) {
    issues.add("kind", `Must be one of: ${KINDS.join(", ")}.`);
    return fail();
  }
  const payloadKey = PAYLOAD_KEY[kind as PackKind];
  rejectUnknownKeys(root, [...META_KEYS, payloadKey], "", issues);
  const meta = readMeta(root, issues);
  if (!(payloadKey in root)) {
    issues.add(payloadKey, "Required.");
  }

  let pack: Pack | undefined;
  const payload = root[payloadKey];
  switch (kind as PackKind) {
    case "characters": {
      const characters = mapItems(payload, payloadKey, L.maxCharacters, issues, validateCharacter);
      pack = meta && characters ? { ...meta, kind: "characters", characters } : undefined;
      break;
    }
    case "context": {
      const entries = mapItems(payload, payloadKey, L.maxContextEntries, issues, validateContextEntry);
      pack = meta && entries ? { ...meta, kind: "context", entries } : undefined;
      break;
    }
    case "personas": {
      const personas = mapItems(payload, payloadKey, L.maxPersonas, issues, validatePersona);
      pack = meta && personas ? { ...meta, kind: "personas", personas } : undefined;
      break;
    }
    case "snippets": {
      const snippets = mapItems(payload, payloadKey, L.maxSnippets, issues, validateSnippet);
      if (snippets) {
        const seen = new Set<string>();
        snippets.forEach((snippet, index) => {
          if (seen.has(snippet.id)) {
            issues.add(`${payloadKey}[${index}].id`, `Duplicate snippet id "${snippet.id}".`);
          }
          seen.add(snippet.id);
        });
      }
      pack = meta && snippets ? { ...meta, kind: "snippets", snippets } : undefined;
      break;
    }
    case "theme": {
      const theme = validateTheme(payload, payloadKey, issues);
      pack = meta && theme ? { ...meta, kind: "theme", theme } : undefined;
      break;
    }
  }
  return pack && issues.ok ? { ok: true, pack } : fail();
}
