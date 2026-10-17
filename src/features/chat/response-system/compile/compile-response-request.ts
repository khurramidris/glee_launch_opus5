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
} from "./compose-supporting-context";
import { clipText, finalizePromptSections } from "./prompt-budget";
import {
  gateRuntimeExampleDialogue,
  isNarrativeHeavyRuntimeText,
  shouldReuseGreetingAsVoiceReference,
} from "../runtime-field-gating";
import { latestUserTurnText } from "../latest-user-turn";
import {
  buildUserReferenceInstruction,
  deriveUserPronouns,
} from "../user-reference";
import type {
  CompiledCharacterPrompt,
  CompiledResponseRequestInput,
  PromptDialogueExample,
  PromptSection,
  PromptSectionKey,
} from "../types";

function prioritizeSection(
  basePriority: number,
  weight: number,
  maxLift = 8,
): number {
  return Math.max(1, basePriority - Math.round((Math.max(0, Math.min(100, weight)) / 100) * maxLift));
}

function deprioritizeSection(
  basePriority: number,
  competingWeight: number,
  maxDrop = 10,
): number {
  return basePriority + Math.round((Math.max(0, Math.min(100, competingWeight)) / 100) * maxDrop);
}

function promptPriority(
  input: CompiledResponseRequestInput,
  key: PromptSectionKey,
  fallback: number,
): number {
  const salience = input.salienceProfile;
  const livePriorityWeight = Math.max(
    salience?.latestUserMoveWeight ?? 100,
    salience?.liveSceneWeight ?? 0,
    salience?.recentTurnWeight ?? 0,
  );
  switch (key) {
    case "latest_user_move":
      return 2;
    case "turn_frame":
      return 3;
    case "response_contract":
      return 4;
    case "group_round_state":
      return 5;
    case "dynamic_scene_state":
      return hasOnlyStaticScenarioFrame(input) ? 16 : 6;
    case "turn_interpretation":
      return 9;
    case "reaction_plan":
      return 10;
    default:
      break;
  }
  if (!salience) {
    return fallback;
  }
  switch (key) {
    case "relationship_state":
      return prioritizeSection(9, salience.relationshipWeight, 2);
    case "user_profile":
      return prioritizeSection(10, salience.userProfileWeight, 2);
    case "memory_summary":
      return deprioritizeSection(fallback, salience.liveSceneWeight, 8)
        - Math.round((salience.memoryWeight / 100) * 3);
    case "memory_snippets":
      return deprioritizeSection(fallback, salience.liveSceneWeight, 8)
        - Math.round((salience.memoryWeight / 100) * 3);
    case "world_context":
      return deprioritizeSection(fallback, salience.liveSceneWeight, 8)
        - Math.round((salience.contextWeight / 100) * 3);
    case "character_identity":
    case "identity_guardrails":
    case "response_style":
    case "character_rules":
    case "character_scene":
    case "character_dynamics":
      return Math.max(
        18,
        deprioritizeSection(fallback, livePriorityWeight, 10) -
          Math.round((salience.characterLoreWeight / 100) * 2),
      );
    default:
      return fallback;
  }
}

function hasLiveSceneOrCorrection(input: CompiledResponseRequestInput): boolean {
  return Boolean(
    input.sceneState?.currentScene?.trim() ||
      input.relationshipState?.currentScene.trim() ||
      (input.sceneState?.visibleFacts ?? []).some((fact) =>
        /^(Current live scene|User appears|Character appears):/i.test(fact),
      ),
  );
}

function hasOnlyStaticScenarioFrame(input: CompiledResponseRequestInput): boolean {
  const facts = input.sceneState?.visibleFacts ?? [];
  return (
    facts.length > 0 &&
    !input.sceneState?.currentScene?.trim() &&
    facts.every((fact) => /^Character scenario frame:/i.test(fact))
  );
}

function shouldCompressStaticCharacterLore(
  input: CompiledResponseRequestInput,
): boolean {
  const actionType = input.turnInterpretation?.actionType;
  if (actionType && actionType !== "statement") {
    return true;
  }
  return (
    (input.salienceProfile?.latestUserMoveWeight ?? 0) >= 70 ||
    (input.salienceProfile?.liveSceneWeight ?? 0) >= 65
  );
}

function resolveSystemPromptBudget(
  input: CompiledResponseRequestInput,
): number {
  const actionType = input.turnInterpretation?.actionType;
  if (actionType === "greeting") {
    return input.mode === "group" ? 3000 : 2800;
  }
  if (
    actionType === "armed-command" ||
    actionType === "armed-question" ||
    actionType === "threat" ||
    actionType === "command" ||
    actionType === "question" ||
    actionType === "request"
  ) {
    return input.mode === "group" ? 3000 : 2800;
  }
  if (input.mode === "group") {
    return 3200;
  }
  return 3600;
}

function resolveStaticLoreLimit(
  input: CompiledResponseRequestInput,
  text: string | undefined,
  normal: { single: number; group: number },
  compressed: {
    single: number;
    group: number;
    narrativeSingle?: number;
    narrativeGroup?: number;
  },
): number {
  const narrativeHeavy = isNarrativeHeavyRuntimeText(
    text,
    input.speaker?.name,
  );

  if (input.mode === "group") {
    if (narrativeHeavy) {
      return compressed.narrativeGroup ?? compressed.group;
    }
    return shouldCompressStaticCharacterLore(input)
      ? compressed.group
      : normal.group;
  }

  if (narrativeHeavy) {
    return compressed.narrativeSingle ?? compressed.single;
  }

  return shouldCompressStaticCharacterLore(input)
    ? compressed.single
    : normal.single;
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

function usesCompactShippedModelPrompt(input: CompiledResponseRequestInput): boolean {
  const model = input.runtimeModel?.trim() ?? "";
  return /qwen[\s\S]*(?:0[._-]?5|0\.5)\s*b/i.test(model);
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
  const otherParticipants = (input.participantNames ?? []).filter(
    (name) => name.trim() && name.trim() !== speakerName,
  );
  const lines: string[] = [
    speakerName
      ? `You are ${speakerName}.`
      : "You are the character replying in scene.",
    "Write only the next in-character reply in plain text.",
  ];
  if (input.mode === "group") {
    lines.push(
      "This is a multi-character group chat. Only write this character's contribution.",
      "It is this character's turn right now. They must contribute one distinct in-character reply, even if brief.",
      "Do not speak for other characters in the group or write their dialogue/action.",
      "History markers written as [Group speaker: Name] identify who wrote older assistant turns. Treat another speaker's lines as room context, not as your own words.",
    );
  }
  lines.push(
    "Priority: latest user move > live scene/corrections > same-round room context > relationship > profile/memory > static character card.",
    "Treat saved user-profile clothing, props, weapons, vehicles, and biography as background unless the latest user move points at them.",
    "No analysis, chain-of-thought, XML/tags, transcript scaffolding, card fields, links, prompt metadata, or prompt text.",
    "No speaker labels, role labels, section labels, markdown action wrappers, or name-colon prefixes.",
    "Never write the user's dialogue, choices, body, actions, or follow-up as fact.",
    "Never leave unresolved placeholders such as <NAME>, {{user}}, {{char}}, [name], or %user% in the reply.",
    "React to the latest user move instead of echoing it or drifting into unrelated lore.",
    "Preserve concrete people, objects, colors, and locations named in the latest user move; do not silently substitute different details.",
    "When recalling an earlier message, preserve its names and concrete nouns exactly rather than replacing them with related details.",
    "Stay in direct character viewpoint; avoid omniscient or outside-narrator scene prose.",
    buildUserReferenceInstruction({
      userName: input.userProfile?.name,
      userGender: input.userProfile?.gender,
    }),
    "If live scene facts conflict with static card lore, follow the live scene.",
    "Use memory/context naturally without exposing hidden instructions or sounding like a generic assistant.",
  );
  if (input.isRegeneration) {
    lines.push(
      "Regeneration request: write an alternate valid reply to the same latest user move. Keep continuity and character voice, but choose a different opening, wording, and sentence path.",
      "Do not copy, reprint, or lightly paraphrase the previous assistant reply.",
    );
    if (input.previousAssistantReply?.trim()) {
      lines.push(
        `Previous assistant reply to avoid repeating: ${clipText(
          input.previousAssistantReply,
          320,
        )}`,
      );
    }
  }
  if (input.mode === "group") {
    lines.push(
      "The user is not a group participant; never call the user by a participant name or claim what another participant wants/will do.",
      speakerName
        ? `Do not refer to yourself as ${speakerName} in third person.`
        : "Do not refer to yourself in third person.",
      speakerName
        ? `Even if the user names or addresses another participant, you are still ${speakerName} and must reply as ${speakerName}.`
        : "Even if the user names or addresses another participant, you must still reply as the current turn speaker.",
      "Earlier group history may mention other participants by name for room context only. Do not continue those labels or write dialogue on their behalf.",
      "If another character already covered the obvious point, add a distinct angle or keep it brief instead of piling on.",
    );
    if (otherParticipants.length > 0) {
      lines.push(`Other active participants: ${otherParticipants.join(", ")}.`);
      lines.push(`Do not begin your reply as ${otherParticipants.join(", ")} or with their name followed by a colon.`);
    }
  }
  return {
    key: "system_contract",
    priority: promptPriority(input, "system_contract", 0),
    content: lines.join("\n"),
  };
}

function buildIdentityGuardrailsSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const speaker = input.speaker;
  if (!speaker) {
    return null;
  }

  const lines: string[] = [
    `Stay recognizably ${speaker.name} in worldview, priorities, and voice.`,
  ];
  if (speaker.tags.length > 0) {
    lines.push(`Core personality anchors: ${speaker.tags.slice(0, 5).join(", ")}`);
  }
  const speechStyle = resolveTemplateTokens(speaker.speechStyle, input);
  if (speechStyle) {
    lines.push(`Voice guardrails: ${clipText(speechStyle, 280)}`);
  }
  if (speaker.likes.length > 0) {
    lines.push(`Instinctively drawn to: ${speaker.likes.slice(0, 4).join(", ")}`);
  }
  if (speaker.dislikes.length > 0) {
    lines.push(`Instinctively pushes back on: ${speaker.dislikes.slice(0, 4).join(", ")}`);
  }
  if (speaker.boundaries?.trim()) {
    lines.push(`Never violate these character boundaries: ${clipText(speaker.boundaries, 260)}`);
  }
  lines.push(
    "Do not flatten the reply into generic politeness, generic lust, generic aggression, or neutral assistant language.",
  );

  return {
    key: "identity_guardrails",
    priority: promptPriority(input, "identity_guardrails", 11),
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

  const lines: string[] = [`Character name: ${speaker.name}`];
  lines.unshift(`You are ${speaker.name}.`);
  const description = normalizeRuntimeLoreText(
    resolveTemplateTokens(speaker.description, input),
  );
  if (description) {
    lines.push(
      `Identity overview: ${clipText(
        description,
        resolveStaticLoreLimit(
          input,
          description,
          { single: 1200, group: 420 },
          { single: 360, group: 220, narrativeSingle: 220, narrativeGroup: 160 },
        ),
      )}`,
    );
  }
  const personality = normalizeRuntimeLoreText(
    resolveTemplateTokens(speaker.personality, input),
  );
  if (personality) {
    lines.push(
      `Personality: ${clipText(
        personality,
        resolveStaticLoreLimit(
          input,
          personality,
          { single: 900, group: 320 },
          { single: 220, group: 160, narrativeSingle: 160, narrativeGroup: 120 },
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
        resolveStaticLoreLimit(
          input,
          backstory,
          { single: 700, group: 220 },
          { single: 180, group: 120, narrativeSingle: 160, narrativeGroup: 110 },
        ),
      )}`,
    );
  }
  if (speaker.tags.length > 0) {
    lines.push(`Traits: ${speaker.tags.join(", ")}`);
  }

  return {
    key: "character_identity",
    priority: promptPriority(input, "character_identity", 10),
    content: lines.join("\n"),
  };
}

function buildCharacterSceneSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const speaker = input.speaker;
  const scenario = normalizeRuntimeLoreText(
    resolveTemplateTokens(speaker?.scenario, input),
  );
  if (!scenario) {
    return null;
  }
  if (input.salienceProfile?.suppressStaticScenario || hasLiveSceneOrCorrection(input)) {
    return null;
  }
  return {
    key: "character_scene",
    priority: promptPriority(input, "character_scene", 32),
    content: `Scenario and roleplay framing: ${clipText(
      scenario,
      resolveStaticLoreLimit(
        input,
        scenario,
        { single: 700, group: 420 },
        { single: 220, group: 180, narrativeSingle: 180, narrativeGroup: 140 },
      ),
    )}`,
  };
}

function buildCharacterDynamicsSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const speaker = input.speaker;
  if (!speaker) {
    return null;
  }
  const lines: string[] = [];
  if (speaker.likes.length > 0) {
    lines.push(`Usually drawn toward: ${speaker.likes.join(", ")}`);
  }
  if (speaker.dislikes.length > 0) {
    lines.push(`Usually pushes back on: ${speaker.dislikes.join(", ")}`);
  }
  if (speaker.boundaries?.trim()) {
    lines.push(`Character boundaries: ${clipText(speaker.boundaries, 700)}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    key: "character_dynamics",
    priority: promptPriority(input, "character_dynamics", 34),
    content: lines.join("\n"),
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
  if (!systemPrompt && !postHistoryInstructions) {
    return null;
  }
  const lines: string[] = [];
  if (systemPrompt) {
    lines.push(`Advanced character instructions: ${clipText(systemPrompt, 1000)}`);
  }
  if (postHistoryInstructions) {
    lines.push(
      `Post-history instructions: ${clipText(postHistoryInstructions, 900)}`,
    );
  }
  return {
    key: "character_rules",
    priority: promptPriority(input, "character_rules", 30),
    content: lines.join("\n"),
  };
}

function buildResponseStyleSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const speaker = input.speaker;
  const lines = [
    "Lead with the character's direct reaction, not narrator exposition.",
    "Default to natural conversational prose, not screenplay labels.",
    "If you include actions, keep them brief, first person, and only for the character.",
    "Prefer one focused in-character reply over a narrated scene recap.",
    "Do not write omniscient scene prose or describe the character from the outside.",
    speaker?.name
      ? `Stay inside ${speaker.name}'s viewpoint. Do not refer to ${speaker.name} in third person while narrating ${speaker.name}'s own actions.`
      : "Stay inside the character's viewpoint.",
  ];
  const speechStyle = resolveTemplateTokens(speaker?.speechStyle, input);
  if (speechStyle) {
    lines.push(`Speaking style: ${clipText(speechStyle, 700)}`);
  }
  const greeting = resolveTemplateTokens(speaker?.greeting, input);
  if (greeting && shouldReuseGreetingAsVoiceReference(greeting, speaker?.name)) {
    lines.push(`Voice reference from the opening line: ${clipText(greeting, 240)}`);
  }
  if (input.reactionPlan?.styleAnchors.length) {
    lines.push(
      `Reaction-plan voice anchors: ${clipText(
        input.reactionPlan.styleAnchors.join(" | "),
        420,
      )}`,
    );
  }
  return {
    key: "response_style",
    priority: promptPriority(input, "response_style", 28),
    content: lines.join("\n"),
  };
}

function buildLatestUserMoveSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const latestUserMessage = latestUserTurnText(input.history)?.trim();
  if (!latestUserMessage) {
    return null;
  }

  const lines = [
    `Raw latest user move: ${clipText(latestUserMessage, 500)}`,
    "Answer this move directly before drifting into background lore or generic scene narration.",
    "Keep its named people, objects, colors, and locations intact unless the character explicitly corrects them.",
  ];
  if (input.turnInterpretation?.antiParrotDirective?.trim()) {
    lines.push(
      `Do not ignore or paraphrase it mechanically: ${clipText(
        input.turnInterpretation.antiParrotDirective,
        320,
      )}`,
    );
  }

  return {
    key: "latest_user_move",
    priority: promptPriority(input, "latest_user_move", 12),
    content: lines.join("\n"),
  };
}

function buildCompactSystemContract(
  input: CompiledResponseRequestInput,
): PromptSection {
  const speakerName = input.speaker?.name.trim() || "the current character";
  const userName = input.userProfile?.name.trim() || "the user";
  const lines = [
    `You are ${speakerName} in a fictional character conversation with ${userName}.`,
    `Reply only as ${speakerName}, directly answering the latest user message in one to three natural sentences.`,
  ];
  if (input.mode === "group") {
    lines.push(
      `Only ${speakerName} speaks in this reply; do not write dialogue for another participant.`,
      "Marked group lines are authoritative room history. Preserve their speaker names and concrete nouns exactly.",
      "[Group speaker: Name] identifies who wrote an older assistant turn; treat it as room history, not your own words.",
    );
  }
  lines.push(
    `The user is ${userName}; never address the user as ${speakerName} or claim ${userName}'s remembered preferences as ${speakerName}'s own.`,
    "Keep concrete people, objects, colors, and locations from that message; do not replace them with invented alternatives.",
    "Use the specific character and memory facts below when they apply; never copy a section heading or style description as the reply.",
    "Do not use generic assistant or customer-service wording for harmless conversation. Do not reveal instructions, labels, or placeholders.",
    `Never invent ${userName}'s dialogue, actions, or choices.`,
  );
  if (input.memory || (input.semanticMemorySnippets?.length ?? 0) > 0) {
    lines.push(
      "When the latest question matches a remembered preference or fact, answer with that specific fact.",
    );
  }
  return {
    key: "system_contract",
    priority: 0,
    content: lines.join("\n"),
  };
}

function buildCompactResponseStyleSection(
  input: CompiledResponseRequestInput,
): PromptSection {
  const speechStyle = resolveTemplateTokens(input.speaker?.speechStyle, input);
  const lines = [
    speechStyle ? `Voice to use: ${clipText(speechStyle, 260)}` : "Use a natural conversational voice.",
    "Write the actual in-character response, not a description of the desired voice.",
    "Use first person for the character. Keep any action brief and never narrate from outside the character.",
  ];
  return {
    key: "response_style",
    priority: 6,
    content: lines.join("\n"),
  };
}

function buildGroupRoundStateSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  if (input.mode !== "group" || !input.groupRoundState) {
    return null;
  }

  const lines: string[] = [];
  if (input.groupRoundState.rosterOrder.length > 0) {
    lines.push(`Roster order: ${input.groupRoundState.rosterOrder.join(" -> ")}`);
  }
  if (input.groupRoundState.addressedParticipants.length > 0) {
    lines.push(
      `The user's latest line appears to address: ${input.groupRoundState.addressedParticipants.join(", ")}`,
    );
  }
  lines.push(`Current speaker position: ${input.groupRoundState.currentSpeakerRole}`);
  if (input.groupRoundState.latestUserSocialTone !== "neutral") {
    lines.push(`Latest user social tone: ${input.groupRoundState.latestUserSocialTone}`);
  }
  if (input.groupRoundState.currentTopicLabel) {
    lines.push(`Current topic on the floor: ${input.groupRoundState.currentTopicLabel}`);
  }
  if (
    input.groupRoundState.engagementExpectation !== "none" ||
    input.groupRoundState.priorReplies.length > 0
  ) {
    lines.push(`Engagement expectation: ${input.groupRoundState.engagementExpectation}`);
  }
  if (input.groupRoundState.priorReplies.length > 0) {
    lines.push("Earlier replies this round:");
    lines.push("Use these as room context already heard by the current speaker, not labels to continue.");
    for (const reply of input.groupRoundState.priorReplies) {
      lines.push(
        `- ${reply.speakerName}: ${reply.socialEffect}; tone=${reply.emotionalTone}; gist=${reply.gist}`,
      );
    }
  }
  if (
    input.groupRoundState.currentSocialBeat &&
    (
      input.groupRoundState.priorReplies.length > 0 ||
      input.groupRoundState.currentSpeakerRole !== "shared_group" ||
      input.groupRoundState.latestUserSocialTone !== "neutral"
    )
  ) {
    lines.push(`Current social beat: ${input.groupRoundState.currentSocialBeat}`);
  }
  if (
    input.groupRoundState.expectedSocialMove &&
    (
      input.groupRoundState.priorReplies.length > 0 ||
      input.groupRoundState.currentSpeakerRole !== "shared_group"
    )
  ) {
    lines.push(`Expected social move: ${input.groupRoundState.expectedSocialMove}`);
  }
  if (input.groupRoundState.currentSpeakerObligations.length > 0) {
    lines.push("Current speaker obligations:");
    for (const obligation of input.groupRoundState.currentSpeakerObligations) {
      lines.push(`- ${obligation}`);
    }
  }

  if (lines.length === 0) {
    return null;
  }

  return {
    key: "group_round_state",
    priority: promptPriority(input, "group_round_state", 16),
    content: lines.join("\n"),
  };
}

function buildReactionPlanSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const plan = input.reactionPlan;
  if (!plan) {
    return null;
  }

  const lines: string[] = [
    `Immediate objective: ${plan.immediateObjective}`,
    `Primary goal: ${plan.primaryGoal}`,
    `Response strategy: ${plan.responseStrategy}`,
    `Interaction stance: ${plan.interactionStance}`,
    `Emotional posture: ${plan.emotionalPosture}`,
    `Scene focus: ${plan.sceneFocus}`,
    `Opening move: ${plan.replyOpening}`,
  ];

  if (plan.salientFacts.length > 0) {
    lines.push(
      `Salient facts: ${clipText(plan.salientFacts.join(" | "), 360)}`,
    );
  }
  if (plan.continuityAnchors.length > 0) {
    lines.push(
      `Continuity anchors: ${clipText(
        plan.continuityAnchors.join(" | "),
        320,
      )}`,
    );
  }
  if (plan.mustAddress.length > 0) {
    lines.push(
      `Must address: ${clipText(plan.mustAddress.join(" | "), 320)}`,
    );
  }
  if (plan.forbiddenMoves.length > 0) {
    lines.push(
      `Avoid: ${clipText(plan.forbiddenMoves.join(" | "), 260)}`,
    );
  }

  return {
    key: "reaction_plan",
    priority: promptPriority(input, "reaction_plan", 24),
    content: lines.join("\n"),
  };
}

function buildTurnFrameSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const frame = input.turnFrame;
  if (!frame) {
    return null;
  }

  const currentScene =
    input.sceneState?.currentScene?.trim() ||
    input.relationshipState?.currentScene?.trim() ||
    "";
  const criticalVisibleFacts = (input.sceneState?.visibleFacts ?? [])
    .filter((fact) =>
      /^(Current live scene:|Latest user scene assertion|User-directed movement target:|Visible threat cue:|Visible user condition:|Visible user-held object:|Relevant saved user profile fact:)/i.test(
        fact,
      ),
    )
    .slice(0, 3);
  const shouldPromoteProfileAbout = criticalVisibleFacts.some((fact) =>
    /^Relevant saved user profile fact:/i.test(fact),
  );
  const promotedProfileAbout = shouldPromoteProfileAbout
    ? input.userProfile?.about.trim()
    : "";
  const lines = [
    currentScene ? `Current live scene: ${clipText(currentScene, 180)}` : "",
    criticalVisibleFacts.length > 0
      ? `Immediate live fact(s): ${clipText(criticalVisibleFacts.join(" | "), 320)}`
      : "",
    promotedProfileAbout ? `About the user: ${clipText(promotedProfileAbout, 220)}` : "",
    promotedProfileAbout
      ? "If the latest move points at the user's current state or possessions, treat relevant saved profile facts as live unless the scene contradicts them."
      : "",
    frame.topic ? `Topic: ${clipText(frame.topic, 160)}` : "",
    frame.userAction ? `User action: ${clipText(frame.userAction, 160)}` : "",
    frame.concreteChoice ? `Concrete user choice: ${clipText(frame.concreteChoice, 140)}` : "",
    frame.sceneAssertion ? `Latest user scene assertion: ${clipText(frame.sceneAssertion, 160)}` : "",
    frame.sceneTransition ? `User-directed movement target: ${clipText(frame.sceneTransition, 140)}` : "",
    frame.visibleSearchCue ? "Visible search/action cue: user is actively trying to locate, inspect, or move toward something." : "",
    frame.locationTarget ? `Likely location target: ${clipText(frame.locationTarget, 120)}` : "",
    frame.addressedParticipants.length > 0
      ? `Addressed participant(s): ${frame.addressedParticipants.join(", ")}`
      : "",
    frame.liveActionCueTokens.length > 0
      ? `Live cue tokens: ${frame.liveActionCueTokens.slice(0, 8).join(", ")}`
      : "",
    `User emotional tone: ${frame.emotionalTone}`,
    `Response obligation: ${clipText(frame.responseObligation, 220)}`,
  ].filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  return {
    key: "turn_frame",
    priority: promptPriority(input, "turn_frame", 16),
    content: lines.join("\n"),
  };
}

function buildResponseContractSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const plan = input.responsePlan;
  if (!plan) {
    return null;
  }

  const lines = [
    `Scene anchor: ${clipText(plan.sceneAnchor, 140)}`,
    plan.personaAnchor ? `Persona anchor: ${clipText(plan.personaAnchor, 160)}` : "",
    plan.groupObligation ? `Group obligation: ${clipText(plan.groupObligation, 180)}` : "",
    plan.distinctContribution
      ? `Distinct contribution: ${clipText(plan.distinctContribution, 180)}`
      : "",
  ].filter(Boolean);

  if (plan.mustAcknowledge.length > 0) {
    lines.push(`Must acknowledge: ${clipText(plan.mustAcknowledge.join(" | "), 240)}`);
  }
  if (plan.mustAvoid.length > 0) {
    lines.push(`Must avoid: ${clipText(plan.mustAvoid.join(" | "), 240)}`);
  }
  lines.push(`Output contract: ${clipText(plan.outputContract, 220)}`);

  return {
    key: "response_contract",
    priority: promptPriority(input, "response_contract", 24),
    content: lines.join("\n"),
  };
}

function buildUserProfileSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const userProfile = input.userProfile;
  const relationshipState = input.relationshipState;
  const hasPromotedProfileCue = (input.sceneState?.visibleFacts ?? []).some((fact) =>
    /^(Visible threat cue|Visible user condition|Visible user-held object|Relevant saved user profile fact):/i.test(
      fact,
    ),
  );
  if (!userProfile) {
    if (
      !relationshipState?.userRoleName.trim() &&
      !relationshipState?.userRoleDescription.trim()
    ) {
      return null;
    }
  }
  const lines: string[] = [];
  if (userProfile?.name.trim()) {
    lines.push(`User name: ${userProfile.name.trim()}`);
  }
  if (userProfile?.gender.trim()) {
    const pronouns = deriveUserPronouns(userProfile.gender);
    lines.push(`User pronouns: ${pronouns.subject}/${pronouns.object}/${pronouns.possessive}`);
  }
  if (relationshipState?.userRoleName.trim()) {
    lines.push(`User role in this chat: ${clipText(relationshipState.userRoleName, 180)}`);
  }
  if (relationshipState?.userRoleDescription.trim()) {
    lines.push(
      `User role details: ${clipText(relationshipState.userRoleDescription, 500)}`,
    );
  }
  if (userProfile?.about.trim()) {
    if (hasPromotedProfileCue) {
      lines.push(`About the user: ${clipText(userProfile.about, 420)}`);
      lines.push(
        "If the latest move points at the user's current state or possessions, treat relevant saved profile facts as live unless the scene contradicts them.",
      );
    } else {
      lines.push(
        `Background about the user: ${clipText(userProfile.about, 220)}`,
      );
      lines.push(
        "Treat background profile details as identity context only. Do not turn clothing, props, weapons, vehicles, or biography into the active topic unless the latest user move points at them.",
      );
    }
  }
  if (userProfile && userProfile.traits.length > 0) {
    lines.push(`User traits: ${userProfile.traits.join(", ")}`);
  }
  if (userProfile?.preferences.trim()) {
    lines.push(`User preferences: ${clipText(userProfile.preferences, 800)}`);
  }
  if (userProfile?.boundaries.trim()) {
    lines.push(`User boundaries: ${clipText(userProfile.boundaries, 600)}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    key: "user_profile",
    priority: promptPriority(input, "user_profile", 18),
    content: lines.join("\n"),
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
    lines.push(`Relationship summary: ${clipText(relationshipState.summary, 900)}`);
  }
  if (relationshipState.currentScene.trim()) {
    lines.push(`Current scene: ${clipText(relationshipState.currentScene, 500)}`);
  }
  if (relationshipState.interactionTone.trim()) {
    lines.push(
      `Interaction tone: ${clipText(relationshipState.interactionTone, 500)}`,
    );
  }
  if (relationshipState.characterState.trim()) {
    lines.push(
      `Character state: ${clipText(relationshipState.characterState, 500)}`,
    );
  }
  if (relationshipState.userState.trim()) {
    lines.push(
      `User state: ${clipText(relationshipState.userState, 500)}`,
    );
  }
  if (lines.length === 0) {
    return null;
  }
  return {
    key: "relationship_state",
    priority: promptPriority(input, "relationship_state", 20),
    content: lines.join("\n"),
  };
}

function buildDynamicSceneStateSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const derived = input.sceneState;
  if (!derived) {
    return null;
  }

  const lines: string[] = [];
  if (derived.visibleFacts.length > 0) {
    lines.push(...derived.visibleFacts);
  }
  lines.push(`Power dynamic: ${derived.powerDynamic}`);
  lines.push(`Immediate tension: ${derived.tension}`);
  lines.push(`Immediate priority: ${derived.immediatePriority}`);

  return {
    key: "dynamic_scene_state",
    priority: promptPriority(input, "dynamic_scene_state", 22),
    content: lines.join("\n"),
  };
}

function buildTurnInterpretationSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const interpreted = input.turnInterpretation;
  if (!interpreted) {
    return null;
  }

  return {
    key: "turn_interpretation",
    priority: promptPriority(input, "turn_interpretation", 23),
    content: [
      `Latest user move type: ${interpreted.actionType}`,
      `Likely intent: ${interpreted.intent}`,
      `Emotional pressure: ${interpreted.emotionalPressure}`,
      `Requires immediate reaction: ${interpreted.requiresImmediateReaction ? "yes" : "no"}`,
      `Response directive: ${interpreted.antiParrotDirective}`,
    ].join("\n"),
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
    priority: promptPriority(input, "world_context", 50),
    content: clipText(content, 1400),
  };
}

function buildMemorySummarySection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const content = composeMemorySummary(
    input.memory,
    input.userProfile?.name?.trim() || "the user",
  );
  if (!content) {
    return null;
  }
  return {
    key: "memory_summary",
    priority: promptPriority(input, "memory_summary", 60),
    content: clipText(content, 1200),
  };
}

function buildMemorySnippetSection(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const content = composeSemanticMemories(
    input.semanticMemorySnippets ?? [],
    input.participantDirectory,
    input.userProfile?.name?.trim(),
  );
  if (!content) {
    return null;
  }
  return {
    key: "memory_snippets",
    priority: promptPriority(input, "memory_snippets", 70),
    content: clipText(content, 1400),
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

function buildExampleDialogueNotes(
  input: CompiledResponseRequestInput,
): PromptSection | null {
  const raw = resolveTemplateTokens(input.speaker?.exampleDialogue, input);
  if (!raw) {
    return null;
  }
  const parsed = gateRuntimeExampleDialogue(
    parseExampleDialogue(
      raw,
      input.speaker?.name ?? "assistant",
      input.userProfile?.name?.trim() || "you",
    ),
    input.speaker?.name,
    input.userProfile?.name?.trim() || "you",
  );
  if (parsed.length > 1 || isNarrativeHeavyRuntimeText(raw, input.speaker?.name)) {
    return null;
  }
  return {
    key: "example_dialogue_notes",
    priority: promptPriority(input, "example_dialogue_notes", 80),
    content:
      "Any freeform example dialogue is only a loose tone hint. Keep the actual reply in first person, in character, and free of narrator-style recap.",
  };
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
  if (usesCompactShippedModelPrompt(input)) {
    const systemSections = finalizePromptSections([
      buildCompactSystemContract(input),
      buildLatestUserMoveSection(input),
      buildCharacterIdentitySection(input),
      buildCompactResponseStyleSection(input),
      buildGroupRoundStateSection(input),
      buildMemorySummarySection(input),
      buildMemorySnippetSection(input),
      buildRelationshipSection(input),
      hasLiveSceneOrCorrection(input) ? buildDynamicSceneStateSection(input) : null,
      buildCharacterRulesSection(input),
      buildContextSection(input),
    ].map((section) => {
      if (!section) {
        return section;
      }
      const compactPriorities: Partial<Record<PromptSection["key"], number>> = {
        system_contract: 0,
        latest_user_move: 2,
        character_identity: 4,
        response_style: 6,
        group_round_state: 8,
        memory_summary: 10,
        memory_snippets: 11,
        relationship_state: 12,
        dynamic_scene_state: 13,
        character_rules: 14,
        world_context: 16,
      };
      return {
        ...section,
        priority: compactPriorities[section.key] ?? section.priority,
      };
    }));
    const historyMessages = toHistoryMessages(
      input.history,
      input.mode ?? "single",
      input.userProfile?.name?.trim() || "you",
      input.participantDirectory,
    );
    return {
      systemSections,
      systemPromptMaxLength: 2400,
      exampleMessages: buildRuntimeExampleDialogue(input).slice(0, 4),
      historyMessages,
    };
  }

  const systemSections = finalizePromptSections([
    buildSystemContract(input),
    buildTurnFrameSection(input),
    buildResponseContractSection(input),
    buildCharacterIdentitySection(input),
    buildIdentityGuardrailsSection(input),
    buildLatestUserMoveSection(input),
    buildGroupRoundStateSection(input),
    buildUserProfileSection(input),
    buildDynamicSceneStateSection(input),
    buildTurnInterpretationSection(input),
    buildRelationshipSection(input),
    buildReactionPlanSection(input),
    buildResponseStyleSection(input),
    buildCharacterRulesSection(input),
    buildCharacterSceneSection(input),
    buildCharacterDynamicsSection(input),
    buildContextSection(input),
    buildMemorySummarySection(input),
    buildMemorySnippetSection(input),
    buildExampleDialogueNotes(input),
  ]);

  const exampleMessages = buildRuntimeExampleDialogue(input);
  const historyMessages = toHistoryMessages(
    input.history,
    input.mode ?? "single",
    input.userProfile?.name?.trim() || "you",
    input.participantDirectory,
  );

  return {
    systemSections,
    systemPromptMaxLength: resolveSystemPromptBudget(input),
    exampleMessages,
    historyMessages,
  };
}
