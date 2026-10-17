import type { PromptSection, PromptSectionKey } from "../types";

const DEFAULT_SYSTEM_PROMPT_BUDGET = 4200;
const MIN_INCLUDED_SECTION_CHARS = 48;
const OPTIONAL_SECTION_START_CHARS = 96;
const SECTION_EXPANSION_STEP_CHARS = 160;

// The system message holds only what stays fixed for a chat (contract, card,
// persona), so it is re-read from llama-server's prompt cache every turn.
export const STABLE_SYSTEM_PROMPT_CHARS = 3200;
// Per-turn notes ride on the newest user message and are re-evaluated every
// turn, so they stay short and only carry what changes the answer.
export const TURN_NOTES_CHARS = 700;
export const TURN_NOTES_OPEN = "<reply notes>";
export const TURN_NOTES_CLOSE = "</reply notes>";

const INVARIANT_SECTION_MIN_CHARS: Partial<Record<PromptSectionKey, number>> = {
  system_contract: 640,
  character_identity: 300,
  user_profile: 200,
};

const INVARIANT_SECTION_ORDER: PromptSectionKey[] = [
  "system_contract",
  "character_identity",
  "user_profile",
];

const PROMPT_SECTION_LABELS: Record<PromptSectionKey, string> = {
  system_contract: "Core contract",
  turn_frame: "Turn frame",
  response_contract: "Response contract",
  character_identity: "Character identity",
  identity_guardrails: "Identity guardrails",
  character_rules: "Character rules",
  character_scene: "Scenario",
  character_dynamics: "Character dynamics",
  response_style: "Response style",
  latest_user_move: "Latest user move",
  group_round_state: "Group round state",
  user_profile: "User profile",
  relationship_state: "Relationship state",
  dynamic_scene_state: "Dynamic scene state",
  turn_interpretation: "Latest turn interpretation",
  reaction_plan: "Reaction plan",
  world_context: "World context",
  memory_summary: "Memory summary",
  memory_snippets: "Relevant memories",
  example_dialogue_notes: "Dialogue notes",
};

// Clips on a sentence, line, or word boundary so a cut never lands mid-word.
export function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const budget = Math.max(0, maxLength - 3);
  const head = normalized.slice(0, budget);
  const floor = Math.floor(budget * 0.6);

  // Whole sentences or lines read cleanly without a trailing ellipsis.
  let wholeUnitEnd = head.lastIndexOf("\n");
  const sentenceEnd = /[.!?]["')\]]?(?=\s)/g;
  const probe = normalized.slice(0, budget + 1);
  for (let match = sentenceEnd.exec(probe); match; match = sentenceEnd.exec(probe)) {
    const end = match.index + match[0].length;
    if (end <= budget) {
      wholeUnitEnd = Math.max(wholeUnitEnd, end);
    }
  }
  if (wholeUnitEnd >= floor) {
    return head.slice(0, wholeUnitEnd).trimEnd();
  }

  const endsOnWord = /\s/.test(normalized[budget] ?? "");
  const lastSpace = head.search(/\s\S*$/);
  const cut = !endsOnWord && lastSpace >= floor ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}...`;
}

export function finalizePromptSections(
  sections: Array<PromptSection | null | undefined>,
): PromptSection[] {
  return sections
    .filter((section): section is PromptSection => Boolean(section?.content.trim()))
    .sort((left, right) => left.priority - right.priority);
}

// Per-turn notes are plain lines in priority order. A line that no longer fits
// is dropped whole instead of being cut, so the model never reads half a fact.
export function mergeTurnNotes(
  sections: PromptSection[],
  maxLength = TURN_NOTES_CHARS,
): string {
  const lines: string[] = [];
  let used = 0;
  const ordered = [...sections].sort((left, right) => left.priority - right.priority);
  for (const section of ordered) {
    for (const rawLine of section.content.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const cost = line.length + (lines.length > 0 ? 1 : 0);
      if (used + cost > maxLength) {
        continue;
      }
      lines.push(line);
      used += cost;
    }
  }
  return lines.join("\n");
}

export function mergePromptSections(
  sections: PromptSection[],
  maxLength = DEFAULT_SYSTEM_PROMPT_BUDGET,
): string {
  if (maxLength <= 0) {
    return "";
  }

  const normalizedSections = sections
    .map((section) => ({ ...section, content: section.content.trim() }))
    .filter((section) => Boolean(section.content));
  const byKey = new Map(normalizedSections.map((section) => [section.key, section]));
  const allocations = new Map<PromptSectionKey, number>();

  const usedLength = (): number => {
    const selected = normalizedSections.filter((section) => allocations.has(section.key));
    return selected.reduce((total, section, index) => {
      const label = PROMPT_SECTION_LABELS[section.key] ?? section.key;
      return (
        total +
        (index > 0 ? 2 : 0) +
        label.length +
        2 +
        (allocations.get(section.key) ?? 0)
      );
    }, 0);
  };

  for (const key of INVARIANT_SECTION_ORDER) {
    const section = byKey.get(key);
    if (!section) {
      continue;
    }
    const label = PROMPT_SECTION_LABELS[key] ?? key;
    const separatorLength = allocations.size > 0 ? 2 : 0;
    const available = maxLength - usedLength() - separatorLength - label.length - 2;
    if (available < MIN_INCLUDED_SECTION_CHARS) {
      continue;
    }
    allocations.set(
      key,
      Math.min(
        section.content.length,
        INVARIANT_SECTION_MIN_CHARS[key] ?? MIN_INCLUDED_SECTION_CHARS,
        available,
      ),
    );
  }

  for (const section of normalizedSections) {
    if (allocations.has(section.key)) {
      continue;
    }
    const label = PROMPT_SECTION_LABELS[section.key] ?? section.key;
    const separatorLength = allocations.size > 0 ? 2 : 0;
    const available = maxLength - usedLength() - separatorLength - label.length - 2;
    if (available < MIN_INCLUDED_SECTION_CHARS) {
      continue;
    }
    allocations.set(
      section.key,
      Math.min(section.content.length, OPTIONAL_SECTION_START_CHARS, available),
    );
  }

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const section of normalizedSections) {
      const current = allocations.get(section.key);
      if (current === undefined || current >= section.content.length) {
        continue;
      }
      const available = maxLength - usedLength();
      if (available <= 0) {
        break;
      }
      const next = Math.min(
        section.content.length,
        current + SECTION_EXPANSION_STEP_CHARS,
        current + available,
      );
      if (next > current) {
        allocations.set(section.key, next);
        expanded = true;
      }
    }
  }

  return normalizedSections
    .filter((section) => allocations.has(section.key))
    .map((section) => {
      const label = PROMPT_SECTION_LABELS[section.key] ?? section.key;
      return `${label}:\n${clipText(section.content, allocations.get(section.key) ?? 0)}`;
    })
    .join("\n\n")
    .slice(0, maxLength)
    .trimEnd();
}
