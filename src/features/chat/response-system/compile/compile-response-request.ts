import type { ChatMessage, LlamaChatMessage } from "../../../../types";
import { renderCardTemplate } from "../../card-template";
import {
  sanitizeAssistantHistoryContent,
  sanitizeAssistantReply,
} from "../../response-sanitizer";
import {
  composeMemorySummary,
  composeSemanticMemories,
  composeWorldContext,
  hasMemoryItemSnippets,
  isSameMemoryText,
} from "./compose-supporting-context";
import {
  STABLE_SYSTEM_PROMPT_CHARS,
  TURN_NOTES_OPEN,
  clipText,
  finalizePromptSections,
} from "./prompt-budget";
import {
  gateRuntimeExampleDialogue,
  isNarrativeHeavyRuntimeText,
} from "../runtime-field-gating";
import { latestUserTurnText } from "../latest-user-turn";
import { deriveUserPronouns } from "../user-reference";
import type {
  CompiledCharacterPrompt,
  CompiledResponseRequestInput,
  ExplicitUserChoice,
  PromptDialogueExample,
  PromptSection,
  PromptSectionKey,
} from "../types";

// Order inside each group only matters relative to its siblings. Stable
// sections form the cache-friendly system message; turn sections become the
// short notes attached to the newest user message.
const SECTION_PRIORITY = {
  system_contract: 0,
  character_identity: 1,
  character_scene: 2,
  character_rules: 3,
  user_profile: 4,
  example_dialogue_notes: 5,
  latest_user_move: 10,
  group_round_state: 11,
  dynamic_scene_state: 12,
  memory_summary: 13,
  memory_snippets: 14,
  relationship_state: 15,
  world_context: 16,
} satisfies Partial<Record<PromptSectionKey, number>>;

interface LoreLimits {
  single: number;
  group: number;
}

// Card lore limits depend only on the card and chat mode, never on the latest
// message, so the system message stays identical from turn to turn.
function resolveLoreLimit(
  input: CompiledResponseRequestInput,
  text: string | undefined,
  normal: LoreLimits,
  narrative: LoreLimits,
): number {
  const limits = isNarrativeHeavyRuntimeText(text, input.speaker?.name)
    ? narrative
    : normal;
  return input.mode === "group" ? limits.group : limits.single;
}

function resolveTemplateTokens(
  value: string | undefined,
  input: CompiledResponseRequestInput,
): string {
  return resolveTemplateTokensWithNames(
    value,
    input.speaker?.name?.trim() || "the character",
    input.userProfile?.name?.trim() || "you",
  );
}

function resolveTemplateTokensWithNames(
  value: string | undefined,
  speakerName: string,
  userName: string,
): string {
  return renderCardTemplate(value, { characterName: speakerName, userName });
}

function normalizeRuntimeLoreText(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[*_`]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.{3}$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function staticScenarioText(input: CompiledResponseRequestInput): string {
  return normalizeRuntimeLoreText(
    resolveTemplateTokens(input.speaker?.scenario, input),
  );
}

// A scene that merely restates the card scenario is already in the system
// message, so the per-turn notes skip it.
function restatesScenario(scene: string, scenario: string): boolean {
  const normalizedScene = normalizeForComparison(scene);
  return (
    Boolean(normalizedScene) &&
    normalizeForComparison(scenario).startsWith(normalizedScene)
  );
}

function lastUserMessageIndex(history: ChatMessage[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function toHistoryMessages(
  history: ChatMessage[],
  mode: "single" | "group" | "regenerate",
  userName?: string,
  participantDirectory?: Record<string, string>,
): LlamaChatMessage[] {
  const latestUserIndex = mode === "group" ? lastUserMessageIndex(history) : -1;
  return history
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "user" || message.role === "assistant")
    .flatMap(({ message, index }) => {
      if (
        mode === "group" &&
        message.role === "assistant" &&
        latestUserIndex >= 0 &&
        index > latestUserIndex
      ) {
        return [];
      }
      const knownGroupSpeaker =
        mode === "group" &&
        message.role === "assistant" &&
        Boolean(
          message.speakerCharacterId &&
            participantDirectory?.[message.speakerCharacterId]?.trim(),
        );
      const content = (() => {
        if (message.role !== "assistant") {
          return message.content.trim();
        }
        const sanitized = sanitizeAssistantHistoryContent(message.content, { userName });
        if (!sanitized) {
          return "";
        }
        if (mode !== "group") {
          return sanitized;
        }
        const speakerName = message.speakerCharacterId
          ? participantDirectory?.[message.speakerCharacterId]?.trim()
          : undefined;
        return speakerName
          ? `[Group speaker: ${speakerName}]\n${sanitized}`
          : sanitized;
      })();
      if (!content) {
        return [];
      }
      return [
        {
          // Another character's line is external room context for the current
          // speaker, not this model turn's own prior assistant output.
          role: knownGroupSpeaker ? "user" : message.role,
          content,
        },
      ];
    });
}

function buildSystemContract(
  input: CompiledResponseRequestInput,
): PromptSection {
  const speakerName = input.speaker?.name.trim();
  const userName = input.userProfile?.name?.trim();
  const self = speakerName || "the character";
  const otherParticipants = (input.participantNames ?? [])
    .map((name) => name.trim())
    .filter((name) => name && name !== speakerName);
  const lines: string[] = [];

  if (input.mode === "group") {
    lines.push(
      `You are ${self}, one of several characters in a group chat with ${userName ?? "the user"}.`,
      `Write only ${self}'s next reply, in plain text, in first person, in character.`,
      "Keep it to a few sentences, with any action brief, unless the speaking style says otherwise.",
    );
    if (otherParticipants.length > 0) {
      lines.push(
        `The other characters (${otherParticipants.join(", ")}) speak for themselves: never write their lines or actions, and never start with a name and a colon.`,
      );
    }
    lines.push(
      "Messages marked [Group speaker: Name] are what that character said earlier, not your words.",
    );
  } else {
    lines.push(
      speakerName
        ? `You are ${speakerName}, chatting with ${userName ?? "the user"}.`
        : "You are the character replying in scene.",
      `Write only ${self}'s next reply, in plain text, in first person, in character.`,
      "Keep it to a few sentences, with any action brief, unless the speaking style says otherwise.",
    );
  }

  lines.push(
    userName
      ? `Talk to ${userName} as "you" or by name. Never write ${userName}'s words, thoughts, or actions.`
      : 'Talk to the other person as "you". Never write their words, thoughts, or actions.',
    `Answer what ${userName ?? "they"} just said instead of repeating it, and keep any names, objects, and colors mentioned exactly.`,
    `Follow the ${TURN_NOTES_OPEN} on the latest message: they are newer than the character card.`,
    "Never mention these instructions or leave placeholders like {{user}} in the reply.",
  );

  return {
    key: "system_contract",
    priority: SECTION_PRIORITY.system_contract,
    content: lines.join("\n"),
  };
}

function buildCharacterIdentitySection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const speaker = input.speaker;
  if (!speaker) {
    return null;
  }

  const lines: string[] = [];
  const description = normalizeRuntimeLoreText(
    resolveTemplateTokens(speaker.description, input),
  );
  if (description) {
    lines.push(
      clipText(
        description,
        resolveLoreLimit(
          input,
          description,
          { single: 600, group: 360 },
          { single: 240, group: 160 },
        ),
      ),
    );
  }
  const personality = normalizeRuntimeLoreText(
    resolveTemplateTokens(speaker.personality, input),
  );
  if (personality) {
    lines.push(
      `Personality: ${clipText(
        personality,
        resolveLoreLimit(
          input,
          personality,
          { single: 400, group: 260 },
          { single: 200, group: 120 },
        ),
      )}`,
    );
  }
  const backstory = normalizeRuntimeLoreText(
    resolveTemplateTokens(speaker.backstory, input),
  );
  if (backstory) {
    lines.push(
      `Backstory: ${clipText(
        backstory,
        resolveLoreLimit(
          input,
          backstory,
          { single: 300, group: 180 },
          { single: 160, group: 110 },
        ),
      )}`,
    );
  }
  if (speaker.tags.length > 0) {
    lines.push(`Traits: ${speaker.tags.slice(0, 6).join(", ")}`);
  }
  const speechStyle = resolveTemplateTokens(speaker.speechStyle, input);
  if (speechStyle) {
    lines.push(`Speaking style: ${clipText(speechStyle, 400)}`);
  }
  if (speaker.likes.length > 0) {
    lines.push(`Likes: ${speaker.likes.slice(0, 5).join(", ")}`);
  }
  if (speaker.dislikes.length > 0) {
    lines.push(`Dislikes: ${speaker.dislikes.slice(0, 5).join(", ")}`);
  }
  if (speaker.boundaries?.trim()) {
    lines.push(`Boundaries: ${clipText(speaker.boundaries, 260)}`);
  }
  if (lines.length === 0) {
    return null;
  }

  return {
    key: "character_identity",
    priority: SECTION_PRIORITY.character_identity,
    content: lines.join("\n"),
  };
}

function buildCharacterSceneSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const scenario = staticScenarioText(input);
  // A saved chat scene replaces the card scenario and rides in the turn notes.
  if (!scenario || input.relationshipState?.currentScene.trim()) {
    return null;
  }
  return {
    key: "character_scene",
    priority: SECTION_PRIORITY.character_scene,
    content: clipText(
      scenario,
      resolveLoreLimit(
        input,
        scenario,
        { single: 400, group: 260 },
        { single: 180, group: 140 },
      ),
    ),
  };
}

function buildCharacterRulesSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const speaker = input.speaker;
  const systemPrompt = resolveTemplateTokens(speaker?.systemPrompt, input);
  const postHistoryInstructions = resolveTemplateTokens(
    speaker?.postHistoryInstructions,
    input,
  );
  const lines = [
    systemPrompt ? clipText(systemPrompt, 600) : "",
    postHistoryInstructions ? clipText(postHistoryInstructions, 400) : "",
  ].filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  return {
    key: "character_rules",
    priority: SECTION_PRIORITY.character_rules,
    content: lines.join("\n"),
  };
}

function buildUserProfileSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const userProfile = input.userProfile;
  const relationshipState = input.relationshipState;
  const roleName = relationshipState?.userRoleName.trim();
  const roleDescription = relationshipState?.userRoleDescription.trim();
  if (!userProfile && !roleName && !roleDescription) {
    return null;
  }

  const lines: string[] = [];
  if (userProfile?.name.trim()) {
    lines.push(`Name: ${userProfile.name.trim()}`);
  }
  if (userProfile?.gender.trim()) {
    const pronouns = deriveUserPronouns(userProfile.gender);
    lines.push(`Pronouns: ${pronouns.subject}/${pronouns.object}/${pronouns.possessive}`);
  }
  if (roleName) {
    lines.push(`Role in this chat: ${clipText(roleName, 120)}`);
  }
  if (roleDescription) {
    lines.push(`Role details: ${clipText(roleDescription, 300)}`);
  }
  if (userProfile?.about.trim()) {
    lines.push(
      `About (background, mention only when relevant): ${clipText(userProfile.about, 260)}`,
    );
  }
  if (userProfile && userProfile.traits.length > 0) {
    lines.push(`Traits: ${userProfile.traits.slice(0, 6).join(", ")}`);
  }
  if (userProfile?.preferences.trim()) {
    lines.push(`Preferences: ${clipText(userProfile.preferences, 300)}`);
  }
  if (userProfile?.boundaries.trim()) {
    lines.push(`Boundaries: ${clipText(userProfile.boundaries, 300)}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    key: "user_profile",
    priority: SECTION_PRIORITY.user_profile,
    content: lines.join("\n"),
  };
}

// Example dialogue that cannot be replayed as chat turns still shows the model
// how the character talks.
function buildExampleDialogueNotes(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  if (input.mode === "group") {
    return null;
  }
  const raw = resolveTemplateTokens(input.speaker?.exampleDialogue, input);
  if (!raw) {
    return null;
  }
  const parsed = parseExampleDialogue(
    raw,
    input.speaker?.name ?? "assistant",
    input.userProfile?.name?.trim() || "you",
  );
  if (parsed.length > 1 || isNarrativeHeavyRuntimeText(raw, input.speaker?.name)) {
    return null;
  }
  return {
    key: "example_dialogue_notes",
    priority: SECTION_PRIORITY.example_dialogue_notes,
    content: `Example of how ${input.speaker?.name ?? "the character"} talks: ${clipText(
      normalizeRuntimeLoreText(raw).replace(/\s+/g, " "),
      260,
    )}`,
  };
}

const CHARGED_USER_TONES = new Set([
  "provocative",
  "flirtatious",
  "playful",
  "urgent",
  "frustrated",
]);

function possessive(name: string | undefined): string {
  return name ? `${name}'s` : "Their";
}

function describeUserMove(
  input: CompiledResponseRequestInput,
  audience: string,
): string | null {
  const name = input.userProfile?.name?.trim() || "The other person";
  switch (input.turnInterpretation?.actionType) {
    case "greeting":
      return `${name} is greeting ${audience}; greet back briefly in your own voice.`;
    case "question":
      return `${name} is asking ${audience} a question; answer it directly.`;
    case "armed-question":
      return `${name} is showing ${audience} something and asking about it; say what you see.`;
    case "request":
      return `${name} is asking ${audience} for something; respond to it directly.`;
    case "command":
      return `${name} is telling ${audience} to do something; react to it directly.`;
    case "armed-command":
    case "threat":
      return `${name} is threatening ${audience}; react to the danger first, in character.`;
    default:
      return null;
  }
}

function describeExplicitChoice(
  choice: ExplicitUserChoice | null | undefined,
  userName: string | undefined,
): string | null {
  if (!choice) {
    return null;
  }
  const surface = choice.surfaceText
    .replace(/\b(?:as|while)\s+(?:i|my|we|our)\b[\s\S]*$/i, "")
    .trim();
  if (!surface || surface.length > 60 || surface.split(/\s+/).length > 7) {
    return null;
  }
  // "I want to know ..." states a wish to talk, not a pick to preserve.
  if (/^(?:know|ask|hear|talk|tell|see|understand|say|be|go|find\s+out|learn|check|make\s+sure)\b/i.test(surface)) {
    return null;
  }
  return `${possessive(userName)} choice: ${surface}. Keep it exactly; do not swap it for something else.`;
}

function buildLatestUserMoveSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const lines: string[] = [];
  if (input.isRegeneration) {
    lines.push(
      "Write a different reply to the same message, with a new opening and new wording.",
    );
    if (input.previousAssistantReply?.trim()) {
      lines.push(
        `Do not reuse the previous reply: "${clipText(input.previousAssistantReply, 140)}"`,
      );
    }
  }

  const group = input.mode === "group" ? input.groupRoundState : null;
  const observing = group?.currentSpeakerRole === "observer_to_other_address";
  if (latestUserTurnText(input.history)?.trim() && !observing) {
    const move = describeUserMove(
      input,
      group?.currentSpeakerRole === "shared_group" ? "the group" : "you",
    );
    if (move) {
      lines.push(move);
    }
  }
  const choice = describeExplicitChoice(
    input.explicitUserChoice,
    input.userProfile?.name?.trim(),
  );
  if (choice) {
    lines.push(choice);
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    key: "latest_user_move",
    priority: SECTION_PRIORITY.latest_user_move,
    content: lines.join("\n"),
  };
}

function buildGroupRoundStateSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const group = input.groupRoundState;
  if (input.mode !== "group" || !group) {
    return null;
  }

  const name = input.userProfile?.name?.trim() || "The other person";
  const lines: string[] = [];
  // The user-move line already says who is being asked or told something.
  const moveLineCoversAudience = describeUserMove(input, "you") !== null;
  if (group.currentSpeakerRole === "directly_addressed") {
    if (!moveLineCoversAudience) {
      lines.push(`${name} is talking to you.`);
    }
  } else if (
    group.currentSpeakerRole === "observer_to_other_address" &&
    group.addressedParticipants.length > 0
  ) {
    lines.push(
      `${name} is talking to ${group.addressedParticipants.join(" and ")}, not to you. React as a listener in the room; do not answer for them.`,
    );
  } else if (!moveLineCoversAudience) {
    lines.push(`${name} is talking to the whole group.`);
  }
  if (CHARGED_USER_TONES.has(group.latestUserSocialTone)) {
    lines.push(
      `${possessive(input.userProfile?.name?.trim())} tone is ${group.latestUserSocialTone}; answer that tone in character.`,
    );
  }
  if (group.priorReplies.length > 0) {
    for (const reply of group.priorReplies) {
      lines.push(`${reply.speakerName} already said: ${clipText(reply.gist, 100)}`);
    }
    lines.push("Do not repeat them; add your own angle.");
  }

  if (lines.length === 0) {
    return null;
  }
  return {
    key: "group_round_state",
    priority: SECTION_PRIORITY.group_round_state,
    content: lines.join("\n"),
  };
}

// Scene analysis is written about "the user"; the model should read the name.
function rewriteUserReference(text: string, userName: string | undefined): string {
  return text
    .replace(/\bthe user's\b/gi, possessive(userName))
    .replace(/\bthe user\b/gi, userName || "the other person");
}

function describeSceneFact(
  fact: string,
  userName: string | undefined,
  scenario: string,
): string | null {
  const name = userName || "The other person";
  const rest = (pattern: RegExp): string | undefined => pattern.exec(fact)?.[1]?.trim();

  if (/^(?:Character scenario frame|Latest user scene assertion overrides)/i.test(fact)) {
    return null;
  }
  const scene = rest(/^Current live scene:\s*(.+)$/i);
  if (scene) {
    return restatesScenario(scene, scenario) ? null : `Scene now: ${scene}`;
  }
  const movement = rest(/^User-directed movement target:\s*(.+?)\.?$/i);
  if (movement) {
    return `${name} is heading to ${movement}.`;
  }
  const userState = rest(/^User appears:\s*(.+)$/i);
  if (userState) {
    return `${name} appears: ${userState}`;
  }
  const characterState = rest(/^Character appears:\s*(.+)$/i);
  if (characterState) {
    return `You appear: ${characterState}`;
  }
  const threat = rest(/^Visible threat cue:\s*(.+)$/i);
  if (threat) {
    return rewriteUserReference(threat, userName).replace(/^./, (first) => first.toUpperCase());
  }
  const held = rest(/^Visible user-held object:\s*(.+)$/i);
  if (held) {
    return `${name} is holding ${held}`;
  }
  const profileFact = rest(/^Relevant saved user profile fact:\s*(.+)$/i);
  if (profileFact) {
    return `About ${name}: ${profileFact}`;
  }
  const condition = rest(/^Visible user condition:\s*(.+)$/i);
  if (condition) {
    return `Visible condition of ${name}: ${condition}`;
  }
  return fact;
}

function buildDynamicSceneStateSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const derived = input.sceneState;
  if (!derived) {
    return null;
  }

  const userName = input.userProfile?.name?.trim();
  const scenario = staticScenarioText(input);
  const lines = derived.visibleFacts
    .map((fact) => describeSceneFact(fact, userName, scenario))
    .filter((line): line is string => Boolean(line))
    .map((line) => clipText(line, 180));

  if (derived.tension === "high" && !/^No obvious/i.test(derived.powerDynamic)) {
    lines.push(clipText(rewriteUserReference(derived.powerDynamic, userName), 180));
  }
  if (!/^Continue the interaction/i.test(derived.immediatePriority)) {
    lines.push(clipText(rewriteUserReference(derived.immediatePriority, userName), 180));
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    key: "dynamic_scene_state",
    priority: SECTION_PRIORITY.dynamic_scene_state,
    content: lines.join("\n"),
  };
}

function buildMemorySummarySection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  // Remembered items replace the regex-extracted facts of the chat memory.
  const memory =
    input.memory && hasMemoryItemSnippets(input.semanticMemorySnippets)
      ? { ...input.memory, facts: [] }
      : input.memory;
  const content = composeMemorySummary(
    memory,
    input.userProfile?.name?.trim() || "the user",
  );
  if (!content) {
    return null;
  }
  return {
    key: "memory_summary",
    priority: SECTION_PRIORITY.memory_summary,
    content,
  };
}

function buildMemorySnippetSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const knownFacts = hasMemoryItemSnippets(input.semanticMemorySnippets)
    ? []
    : (input.memory?.facts ?? []);
  const content = composeSemanticMemories(
    (input.semanticMemorySnippets ?? []).filter(
      (snippet) => !knownFacts.some((fact) => isSameMemoryText(snippet.content, fact)),
    ),
    input.participantDirectory,
    input.userProfile?.name?.trim(),
  );
  if (!content) {
    return null;
  }
  return {
    key: "memory_snippets",
    priority: SECTION_PRIORITY.memory_snippets,
    content,
  };
}

function buildRelationshipSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const relationshipState = input.relationshipState;
  if (!relationshipState) {
    return null;
  }
  const lines: string[] = [];
  if (relationshipState.summary.trim()) {
    lines.push(`Relationship: ${clipText(relationshipState.summary, 200)}`);
  }
  if (
    relationshipState.interactionTone.trim() &&
    !isSameMemoryText(relationshipState.interactionTone, relationshipState.summary)
  ) {
    lines.push(`Tone: ${clipText(relationshipState.interactionTone, 120)}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    key: "relationship_state",
    priority: SECTION_PRIORITY.relationship_state,
    content: lines.join("\n"),
  };
}

function buildContextSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const content = composeWorldContext(input.contextEntries);
  if (!content) {
    return null;
  }
  return {
    key: "world_context",
    priority: SECTION_PRIORITY.world_context,
    content,
  };
}

function normalizeDialoguePrefix(prefix: string): string {
  return prefix
    .trim()
    .toLowerCase()
    .replace(/[{}<>[\]]/g, "")
    .replace(/\s+/g, " ");
}

function normalizeSpeakerRole(
  prefix: string,
  characterName: string,
  userName?: string,
): PromptDialogueExample["role"] | null {
  const normalizedPrefix = normalizeDialoguePrefix(prefix);
  const normalizedCharacter = normalizeDialoguePrefix(characterName);
  const normalizedUser = normalizeDialoguePrefix(userName ?? "");
  if (
    normalizedPrefix === "user" ||
    normalizedPrefix === "human" ||
    normalizedPrefix === "you" ||
    normalizedPrefix === "me" ||
    (normalizedUser !== "" && normalizedPrefix === normalizedUser)
  ) {
    return "user";
  }
  if (
    normalizedPrefix === normalizedCharacter ||
    normalizedPrefix === "assistant" ||
    normalizedPrefix === "character" ||
    normalizedPrefix === "ai" ||
    normalizedPrefix === "char" ||
    normalizedPrefix === "bot"
  ) {
    return "assistant";
  }
  return null;
}

function parseExampleDialogue(
  raw: string | undefined,
  characterName: string,
  userName = "you",
): PromptDialogueExample[] {
  const normalized = resolveTemplateTokensWithNames(raw, characterName, userName);
  if (!normalized) {
    return [];
  }

  const examples: PromptDialogueExample[] = [];
  let currentRole: PromptDialogueExample["role"] | null = null;
  let currentLines: string[] = [];

  const flushCurrent = () => {
    if (!currentRole) {
      currentLines = [];
      return;
    }
    const rawContent = currentLines.join("\n").trim();
    const content =
      currentRole === "assistant"
        ? sanitizeAssistantReply(rawContent, { speakerName: characterName })
        : rawContent;
    if (content) {
      examples.push({ role: currentRole, content, source: "example_dialogue" });
    }
    currentRole = null;
    currentLines = [];
  };

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (currentRole && currentLines.length > 0) {
        currentLines.push("");
      }
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const prefix = separatorIndex > 0 ? line.slice(0, separatorIndex) : "";
    const role =
      separatorIndex > 0 ? normalizeSpeakerRole(prefix, characterName, userName) : null;
    if (role) {
      flushCurrent();
      currentRole = role;
      const content = line.slice(separatorIndex + 1).trim();
      currentLines = content ? [content] : [];
      continue;
    }

    if (currentRole) {
      currentLines.push(line);
    }
  }

  flushCurrent();
  return examples.slice(0, 8);
}

function buildRuntimeExampleDialogue(
  input: CompiledResponseRequestInput,
): PromptDialogueExample[] {
  if (input.mode === "group") {
    return [];
  }
  const raw = resolveTemplateTokens(input.speaker?.exampleDialogue, input);
  return gateRuntimeExampleDialogue(
    parseExampleDialogue(
      raw,
      input.speaker?.name ?? "assistant",
      input.userProfile?.name?.trim() || "you",
    ),
    input.speaker?.name,
    input.userProfile?.name?.trim() || "you",
  );
}

export function compileResponseRequest(
  input: CompiledResponseRequestInput,
): CompiledCharacterPrompt {
  const systemSections = finalizePromptSections([
    buildSystemContract(input),
    buildCharacterIdentitySection(input),
    buildCharacterSceneSection(input),
    buildCharacterRulesSection(input),
    buildUserProfileSection(input),
    buildExampleDialogueNotes(input),
    buildLatestUserMoveSection(input),
    buildGroupRoundStateSection(input),
    buildDynamicSceneStateSection(input),
    buildMemorySummarySection(input),
    buildMemorySnippetSection(input),
    buildRelationshipSection(input),
    buildContextSection(input),
  ]);

  return {
    systemSections,
    systemPromptMaxLength: STABLE_SYSTEM_PROMPT_CHARS,
    exampleMessages: buildRuntimeExampleDialogue(input),
    historyMessages: toHistoryMessages(
      input.history,
      input.mode ?? "single",
      input.userProfile?.name?.trim() || "you",
      input.participantDirectory,
    ),
  };
}
