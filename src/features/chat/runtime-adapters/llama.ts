import type { LlamaChatMessage, LlamaChatRequest } from "../../../types";
import type {
  CompiledCharacterPrompt,
  PromptSection,
  PromptSectionKey,
  RuntimeSamplingProfile,
} from "../response-system/types";
import {
  STABLE_SYSTEM_PROMPT_CHARS,
  TURN_NOTES_CHARS,
  TURN_NOTES_CLOSE,
  TURN_NOTES_OPEN,
  mergePromptSections,
  mergeTurnNotes,
} from "../response-system/compile/prompt-budget";
import { buildLlamaStopSequences } from "../response-sanitizer";
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  clampOutputTokens,
  fitChatMessagesToContextWindow,
} from "./token-budget";

// Ternary Bonsai 2's recommended non-thinking profile. top-k, min-p, and the
// presence penalty are set as llama-server defaults by the desktop backend.
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TOP_P = 0.8;
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_REPEAT_PENALTY = 1.0;

function collapseTrailingAssistantRun(
  messages: LlamaChatMessage[],
): LlamaChatMessage[] {
  if (messages.length < 2) {
    return messages;
  }

  let assistantRunStart = messages.length;
  while (assistantRunStart > 0 && messages[assistantRunStart - 1]?.role === "assistant") {
    assistantRunStart -= 1;
  }

  if (messages.length - assistantRunStart < 2) {
    return messages;
  }

  const mergedAssistantContent = messages
    .slice(assistantRunStart)
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");

  if (!mergedAssistantContent) {
    return messages.slice(0, assistantRunStart);
  }

  return [
    ...messages.slice(0, assistantRunStart),
    { role: "assistant", content: mergedAssistantContent },
  ];
}

function ensureRequestEndsWithUserTurn(
  messages: LlamaChatMessage[],
): LlamaChatMessage[] {
  const lastRole = messages[messages.length - 1]?.role;
  if (lastRole === "user") {
    return messages;
  }

  return [
    ...messages,
    {
      role: "user",
      content:
        "Now write the current character's next in-character reply only. Do not continue or repeat any previous assistant reply.",
    },
  ];
}

// Sections that change only when the character, persona, or settings change.
// They form a system message that stays byte-identical between turns, so
// llama-server can reuse its prompt cache instead of re-reading the whole
// conversation on every reply (the difference between seconds and tens of
// seconds on a CPU).
const STABLE_SECTION_ORDER: PromptSectionKey[] = [
  "system_contract",
  "character_identity",
  "character_scene",
  "character_rules",
  "user_profile",
  "example_dialogue_notes",
];
export { TURN_NOTES_CLOSE, TURN_NOTES_OPEN };

function splitSections(sections: PromptSection[]): {
  stable: PromptSection[];
  turn: PromptSection[];
} {
  const stable = sections
    .filter((section) => STABLE_SECTION_ORDER.includes(section.key))
    .sort(
      (left, right) =>
        STABLE_SECTION_ORDER.indexOf(left.key) - STABLE_SECTION_ORDER.indexOf(right.key),
    );
  const turn = sections.filter((section) => !STABLE_SECTION_ORDER.includes(section.key));
  return { stable, turn };
}

function withTurnNotes(messages: LlamaChatMessage[], notes: string): LlamaChatMessage[] {
  if (!notes) {
    return messages;
  }
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") {
    return messages;
  }
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: `${TURN_NOTES_OPEN}\n${notes}\n${TURN_NOTES_CLOSE}\n\n${last.content}`,
    },
  ];
}

/** The per-turn notes for `compiledPrompt`, one entry per line. */
export function buildTurnNoteLines(compiledPrompt: CompiledCharacterPrompt): string[] {
  const { turn } = splitSections(compiledPrompt.systemSections);
  const notes = mergeTurnNotes(turn, TURN_NOTES_CHARS);
  return notes ? notes.split("\n") : [];
}

/**
 * `turnNotes` replaces the computed per-turn notes (extensions add lines to
 * them); the stable system message is never affected.
 */
export function toLlamaChatMessages(
  compiledPrompt: CompiledCharacterPrompt,
  turnNotes?: readonly string[],
): LlamaChatMessage[] {
  const messages: LlamaChatMessage[] = [];
  const { stable, turn } = splitSections(compiledPrompt.systemSections);

  const systemPrompt = mergePromptSections(
    stable,
    compiledPrompt.systemPromptMaxLength ?? STABLE_SYSTEM_PROMPT_CHARS,
  );
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const example of compiledPrompt.exampleMessages) {
    messages.push({ role: example.role, content: example.content });
  }
  messages.push(...collapseTrailingAssistantRun(compiledPrompt.historyMessages));

  // Per-turn guidance rides on the newest user message, the only part of the
  // prompt that is new anyway.
  const notes = turnNotes ? turnNotes.join("\n") : mergeTurnNotes(turn, TURN_NOTES_CHARS);
  return withTurnNotes(ensureRequestEndsWithUserTurn(messages), notes);
}

export function toLlamaChatRequest(input: {
  model: string;
  compiledPrompt: CompiledCharacterPrompt;
  sampling: RuntimeSamplingProfile;
  stream: boolean;
  userName?: string;
  // Group chats: the current speaker and everyone in the room, so lines
  // labelled with another participant's name end the reply.
  speakerName?: string;
  participantNames?: string[];
  turnNotes?: readonly string[];
}): LlamaChatRequest {
  const maxTokens = clampOutputTokens(
    input.sampling.maxTokens,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
  );
  const fitted = fitChatMessagesToContextWindow(
    toLlamaChatMessages(input.compiledPrompt, input.turnNotes),
    {
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: maxTokens,
    },
  );
  return {
    model: input.model,
    messages: fitted.messages,
    stream: input.stream,
    chat_template_kwargs: {
      enable_thinking: false,
    },
    temperature: input.sampling.temperature ?? DEFAULT_TEMPERATURE,
    top_p: input.sampling.topP ?? DEFAULT_TOP_P,
    max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
    repeat_penalty: input.sampling.repeatPenalty ?? DEFAULT_REPEAT_PENALTY,
    stop: buildLlamaStopSequences({
      userName: input.userName,
      speakerName: input.speakerName,
      participantNames: input.participantNames,
    }),
  };
}
