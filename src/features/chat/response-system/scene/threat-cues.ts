const WEAPON_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "AK47", pattern: /\bak[\s-]?47\b/i },
  { label: "rifle", pattern: /\brifle\b/i },
  { label: "gun", pattern: /\bgun\b/i },
  { label: "pistol", pattern: /\bpistol\b/i },
  { label: "shotgun", pattern: /\bshotgun\b/i },
  { label: "knife", pattern: /\bknife\b/i },
];

const PRESENT_POSSESSION_PATTERNS = [
  /\bi have\b/i,
  /\bi've got\b/i,
  /\bi got\b/i,
  /\bi am holding\b/i,
  /\bi'm holding\b/i,
  /\bi hold\b/i,
  /\bi am carrying\b/i,
  /\bi'm carrying\b/i,
  /\bi carry\b/i,
  /\bwith me\b/i,
  /\bon me\b/i,
  /\bin (?:my|your|his|her|their|our) hand\b/i,
  /\bin (?:my|your|his|her|their|our) hands\b/i,
  /\bpointed at you\b/i,
  /\baimed at you\b/i,
];

const HELD_OBJECT_PATTERNS = [
  /\b(?:i|you|he|she|they|we|[a-z][a-z0-9_'-]*)\s+(?:have|has)\s+(?:a|an|the|some)?\s*([a-z0-9][a-z0-9\s'_-]{1,80}?)\s+in\s+(?:my|your|his|her|their|our)\s+hands?\b/i,
  /\b(?:i|you|he|she|they|we|[a-z][a-z0-9_'-]*)\s+(?:am|are|is)\s+holding\s+(?:a|an|the|some)?\s*([a-z0-9][a-z0-9\s'_-]{1,80}?)(?:[.!?,]|$)/i,
  /\b(?:i|you|he|she|they|we|[a-z][a-z0-9_'-]*)\s+(?:carry|carries|carrying)\s+(?:a|an|the|some)?\s*([a-z0-9][a-z0-9\s'_-]{1,80}?)(?:[.!?,]|$)/i,
];

const TRAILING_OBJECT_STOP_WORDS = /\b(?:and|but|while|with|that|which|because)\b.*$/i;

function normalizeHeldObjectLabel(value: string): string {
  return value
    .replace(/\r\n/g, " ")
    .replace(TRAILING_OBJECT_STOP_WORDS, "")
    .replace(/\s+/g, " ")
    .replace(/^[,.;:!?-]+|[,.;:!?-]+$/g, "")
    .trim();
}

export function detectWeapons(text: string): string[] {
  const found = WEAPON_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(
    ({ label }) => label,
  );
  return [...new Set(found)];
}

export function extractPresentWeaponFacts(text: string | undefined): string[] {
  const compact = text?.trim();
  if (!compact) {
    return [];
  }
  if (!PRESENT_POSSESSION_PATTERNS.some((pattern) => pattern.test(compact))) {
    return [];
  }
  return detectWeapons(compact);
}

export function extractPresentHeldObjectFacts(text: string | undefined): string[] {
  const compact = text?.trim();
  if (!compact) {
    return [];
  }
  if (!PRESENT_POSSESSION_PATTERNS.some((pattern) => pattern.test(compact))) {
    return [];
  }
  const facts = HELD_OBJECT_PATTERNS.flatMap((pattern) => {
    const match = compact.match(pattern);
    if (!match?.[1]) {
      return [];
    }
    const normalized = normalizeHeldObjectLabel(match[1]);
    if (!normalized) {
      return [];
    }
    return [normalized];
  });
  return [...new Set(facts)];
}

export function isHeldObjectInspectionPrompt(text: string): boolean {
  return /\b(what do you see in my hand|what do you see in my hands|do you see what i have in my hand|do you see what i have in my hands|do you see what'?s in my hand|do you see what'?s in my hands|look at what i have in my hand|look at what i have in my hands|look what i have in my hand|look what i have in my hands|look what'?s in my hand|look what'?s in my hands)\b/i.test(
    text,
  );
}
