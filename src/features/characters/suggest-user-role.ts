import type { Character } from "../../types";

export interface SuggestedUserRole {
  name: string;
  description?: string;
  sourceField: "description" | "personality" | "scenario" | "greeting" | "exampleDialogue";
}

function normalizeRoleName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(an?|the)\s+/i, "")
    .replace(/\bguard\b/i, "Guard")
    .replace(/\bknight\b/i, "Knight");
}

function normalizeRoleDescription(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRoleFromField(
  value: string | undefined,
  sourceField: SuggestedUserRole["sourceField"],
): SuggestedUserRole | null {
  if (!value) {
    return null;
  }

  const explicitUserRolePattern =
    /(?:^|\n)\s*(?:[-*]\s*)?(?:\{\{\s*user\s*\}\}|<\s*user\s*>|you)\s*\(([^)]+)\)\s*:\s*([^\n]+)/i;
  const match = explicitUserRolePattern.exec(value);
  if (!match) {
    return null;
  }

  const name = normalizeRoleName(match[1] ?? "");
  if (!name) {
    return null;
  }

  const description = normalizeRoleDescription(match[2] ?? "");
  return {
    name,
    description: description || undefined,
    sourceField,
  };
}

export function suggestUserRole(character?: Character | null): SuggestedUserRole | null {
  if (!character) {
    return null;
  }

  return (
    extractRoleFromField(character.description, "description") ??
    extractRoleFromField(character.personality, "personality") ??
    extractRoleFromField(character.scenario, "scenario") ??
    extractRoleFromField(character.greeting, "greeting") ??
    extractRoleFromField(character.exampleDialogue, "exampleDialogue")
  );
}
