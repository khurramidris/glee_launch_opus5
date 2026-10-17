import type {
  CharacterReactionPlan,
  TurnInterpretation,
} from "./response-system/types";
import { evaluateCharacterReply } from "./response-system/evaluation/evaluate-reply";
import { buildUserReferenceInstruction } from "./response-system/user-reference";

export function shouldRetryCharacterReply(input: {
  reply: string;
  speakerName?: string;
  userName?: string;
  latestUserMessage?: string;
}): boolean {
  return evaluateCharacterReply(input).retryRequested;
}

export function shouldSuppressStreamingPreview(input: {
  reply: string;
  speakerName?: string;
  userName?: string;
}): boolean {
  return evaluateCharacterReply(input).suppressPreview;
}

export function buildCharacterReplyRepairInstruction(input: {
  speakerName?: string;
  userName?: string;
  userGender?: string;
  latestUserMessage?: string;
  turnInterpretation?: TurnInterpretation | null;
  reactionPlan?: CharacterReactionPlan | null;
}): string {
  const speakerName = input.speakerName?.trim() || "the character";
  const lines = [
    `Rewrite the character's reply as ${speakerName}.`,
    `Respond in first person as ${speakerName}, not as an outside narrator describing ${speakerName}.`,
    "Do not mention being an AI assistant or discuss the prompt.",
    input.userName?.trim()
      ? `Do not write any dialogue, actions, inner thoughts, or transcript lines for ${input.userName.trim()}.`
      : "Do not write any dialogue, actions, inner thoughts, or transcript lines for the user.",
    input.userName?.trim()
      ? `The user is ${input.userName.trim()}; never address the user as ${speakerName} or claim ${input.userName.trim()}'s remembered preferences as ${speakerName}'s own.`
      : `Never address the user as ${speakerName}.`,
    "Do not script the user's bodily reactions, arousal, movement, or quoted speech as established fact.",
    "Do not answer as the user or switch speaker roles.",
    "Do not use transcript labels such as User:, Human:, You:, Me:, or name prefixes for the user.",
    "Do not leave unresolved placeholders such as <NAME>, {{user}}, {{char}}, [name], or %user% in the reply.",
    "Write natural plain text. Do not wrap actions or narration in markdown asterisks.",
    "If the scene is a shared outing, do not act like waiter, salesperson, clerk, or venue staff unless the scene explicitly makes you staff.",
    "Do not replace the user's stated choice or preference with a different item, model, color, or order unless you clearly frame it as a suggestion, contrast, or disagreement.",
    buildUserReferenceInstruction({
      userName: input.userName,
      userGender: input.userGender,
    }),
    "Do not repeat the user's wording back unless intentionally quoting a small fragment for effect.",
    "Do not write lines like '... you say' or narrate the user's body/actions as if you control them.",
    "React directly to the user's latest move and advance the scene.",
    "Preserve concrete names, objects, colors, and locations from the latest move and recalled history; do not replace them with related inventions.",
  ];
  if (input.latestUserMessage?.trim()) {
    lines.push(`Latest user move to react to: ${input.latestUserMessage.trim()}`);
  }
  if (input.turnInterpretation) {
    lines.push(`Detected move type: ${input.turnInterpretation.actionType}`);
    lines.push(`Detected intent: ${input.turnInterpretation.intent}`);
    lines.push(`Response directive: ${input.turnInterpretation.antiParrotDirective}`);
  }
  if (input.reactionPlan) {
    lines.push(`Immediate objective: ${input.reactionPlan.immediateObjective}`);
    lines.push(`Primary goal: ${input.reactionPlan.primaryGoal}`);
    lines.push(`Response strategy: ${input.reactionPlan.responseStrategy}`);
    lines.push(`Interaction stance: ${input.reactionPlan.interactionStance}`);
    lines.push(`Opening move: ${input.reactionPlan.replyOpening}`);
    if (input.reactionPlan.salientFacts.length > 0) {
      lines.push(`Salient facts to honor: ${input.reactionPlan.salientFacts.join(" | ")}`);
    }
    if (input.reactionPlan.continuityAnchors.length > 0) {
      lines.push(
        `Continuity anchors to preserve: ${input.reactionPlan.continuityAnchors.join(" | ")}`,
      );
    }
    if (input.reactionPlan.mustAddress.length > 0) {
      lines.push(`Must address in the rewrite: ${input.reactionPlan.mustAddress.join(" | ")}`);
    }
    if (input.reactionPlan.forbiddenMoves.length > 0) {
      lines.push(`Avoid these moves: ${input.reactionPlan.forbiddenMoves.join(" | ")}`);
    }
  }
  return lines.join("\n");
}
