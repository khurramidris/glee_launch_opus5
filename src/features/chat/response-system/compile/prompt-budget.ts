import type { PromptSection, PromptSectionKey } from "../types";

const DEFAULT_SYSTEM_PROMPT_BUDGET = 4200;
const MIN_INCLUDED_SECTION_CHARS = 48;
const OPTIONAL_SECTION_START_CHARS = 96;
const SECTION_EXPANSION_STEP_CHARS = 160;

const INVARIANT_SECTION_MIN_CHARS: Partial<Record<PromptSectionKey, number>> = {
  system_contract: 520,
  latest_user_move: 160,
  turn_frame: 180,
  response_contract: 220,
  character_identity: 300,
  identity_guardrails: 240,
  response_style: 160,
  group_round_state: 260,
  dynamic_scene_state: 180,
  user_profile: 320,
  relationship_state: 140,
};

const INVARIANT_SECTION_ORDER: PromptSectionKey[] = [
  "system_contract",
  "latest_user_move",
  "turn_frame",
  "response_contract",
  "character_identity",
  "identity_guardrails",
  "response_style",
  "group_round_state",
  "dynamic_scene_state",
  "user_profile",
  "relationship_state",
];

const PROMPT_SECTION_LABELS: Record<PromptSectionKey, string> = {
  system_contract: "Core contract",
  turn_frame: "Turn frame",
  response_contract: "Response contract",
  character_identity: "Character identity",
  identity_guardrails: "Identity guardrails",
  character_rules: "Character rules",
  character_scene: "Character scene",
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

export function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function finalizePromptSections(
  sections: Array<PromptSection | null | undefined>,
): PromptSection[] {
  return sections
    .filter((section): section is PromptSection => Boolean(section?.content.trim()))
    .sort((left, right) => left.priority - right.priority);
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
