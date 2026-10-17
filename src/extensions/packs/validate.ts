import { PACK_LIMITS } from "./limits";

export interface PackIssue {
  path: string;
  message: string;
}

/** Collects problems so one pass reports everything, capped to stay readable. */
export class IssueList {
  readonly items: PackIssue[] = [];

  add(path: string, message: string): void {
    if (this.items.length < PACK_LIMITS.maxIssues) {
      this.items.push({ path, message });
    } else if (this.items.length === PACK_LIMITS.maxIssues) {
      this.items.push({ path: "", message: "More problems were found but are not shown." });
    }
  }

  get ok(): boolean {
    return this.items.length === 0;
  }
}

export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Control characters (other than tab/newline) and bidi overrides have no place
// in card text and are a common way to hide instructions from a reader.
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;

export function rejectUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: IssueList,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.add(`${path}${path ? "." : ""}${key}`, `Unknown field "${key}".`);
    }
  }
}

export interface TextRule {
  max: number;
  required?: boolean;
  /** Collapse to a single line (names, keywords). */
  singleLine?: boolean;
}

export function checkText(
  value: unknown,
  path: string,
  rule: TextRule,
  issues: IssueList,
): string | undefined {
  if (typeof value !== "string") {
    issues.add(path, "Must be text.");
    return undefined;
  }
  if (value.length > rule.max) {
    issues.add(path, `Is ${value.length} characters; the limit is ${rule.max}.`);
    return undefined;
  }
  if (FORBIDDEN_TEXT.test(value)) {
    issues.add(path, "Contains control characters.");
    return undefined;
  }
  if (rule.singleLine && /[\r\n]/.test(value)) {
    issues.add(path, "Must be a single line.");
    return undefined;
  }
  const text = rule.singleLine ? value.trim() : value.replace(/\r\n?/g, "\n");
  if (rule.required && text.trim() === "") {
    issues.add(path, "Cannot be empty.");
    return undefined;
  }
  return text;
}

export function checkTextList(
  value: unknown,
  path: string,
  rule: { maxItems: number; item: TextRule },
  issues: IssueList,
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.add(path, "Must be a list.");
    return undefined;
  }
  if (value.length > rule.maxItems) {
    issues.add(path, `Has ${value.length} items; the limit is ${rule.maxItems}.`);
    return undefined;
  }
  const out: string[] = [];
  let ok = true;
  value.forEach((item, index) => {
    const text = checkText(item, `${path}[${index}]`, rule.item, issues);
    if (text === undefined) {
      ok = false;
    } else if (text.trim() !== "") {
      out.push(text);
    }
  });
  return ok ? out : undefined;
}

export function checkItems(
  value: unknown,
  path: string,
  maxItems: number,
  issues: IssueList,
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.add(path, "Must be a list.");
    return undefined;
  }
  if (value.length === 0) {
    issues.add(path, "Must contain at least one item.");
    return undefined;
  }
  if (value.length > maxItems) {
    issues.add(path, `Has ${value.length} items; the limit is ${maxItems}.`);
    return undefined;
  }
  return value;
}
