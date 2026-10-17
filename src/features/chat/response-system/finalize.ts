import {
  sanitizeAssistantReply,
  sanitizeStreamingAssistantPreview,
} from "../response-sanitizer";
import { buildCharacterReplyRepairInstruction } from "../response-validator";
import {
  formatResponseDiagnosticError,
  type ResponseDiagnosticsRecorder,
} from "./diagnostics";
import { evaluateCharacterReply } from "./evaluation/evaluate-reply";
import { isNarrativeHeavyRuntimeText } from "./runtime-field-gating";
import { buildUserReferenceInstruction } from "./user-reference";
import type {
  PreparedResponseRequest,
  ResponseEvaluation,
  ResponseEvaluationReason,
} from "./types";

function buildRescueRepairInstruction(prepared: PreparedResponseRequest): string {
  const speakerName = prepared.context.speaker?.name?.trim() || "the character";
  const latestUserMessage = prepared.context.latestUserMessage?.trim();
  const visibleFacts = (prepared.sceneState?.visibleFacts ?? [])
    .filter((fact) => /^Current live scene:|^Visible user condition:|^Visible user-held object:|^Relevant saved user profile fact:/i.test(fact))
    .slice(0, 3);

  const lines = [
    `Rewrite the reply as ${speakerName} in one or two short in-character paragraphs.`,
    "This is a rescue rewrite because the previous reply ignored the live scene, crossed roles, or violated tone.",
    "Do not speak as the user. Do not use transcript labels. Do not sexualize a platonic scene.",
    buildUserReferenceInstruction({
      userName: prepared.context.userProfile?.name,
      userGender: prepared.context.userProfile?.gender,
    }),
    "Lead with direct acknowledgment of the user's visible situation before anything else.",
  ];
  if (latestUserMessage) {
    lines.push(`Latest user move: ${latestUserMessage}`);
  }
  if (visibleFacts.length > 0) {
    lines.push(`Live facts to acknowledge: ${visibleFacts.join(" | ")}`);
  }
  if (prepared.reactionPlan.mustAddress.length > 0) {
    lines.push(`Must address: ${prepared.reactionPlan.mustAddress.join(" | ")}`);
  }
  return lines.join("\n");
}

function dedupeReasons(
  reasons: ResponseEvaluationReason[],
): ResponseEvaluationReason[] {
  return [...new Set(reasons)];
}

function canAcceptOriginalReplyAfterRepairFailure(
  prepared: PreparedResponseRequest,
  reasons: ResponseEvaluationReason[],
): boolean {
  if (prepared.context.mode === "group") {
    return false;
  }

  const severeReasons = new Set<ResponseEvaluationReason>([
    "meta_reasoning",
    "third_person_self_narration",
    "insufficient_substance",
    "incomplete_sentence",
    "user_choice_overwrite",
    "scene_replacement_drift",
    "observer_role_violation",
    "same_round_copying",
    "same_round_non_engagement",
    "static_lore_echo",
    "other_participant_impersonation",
    "user_echo",
    "placeholder_leak",
    "transcript_leakage",
    "role_inversion",
    "scene_role_drift",
    "generic_assistant_drift",
    "user_agency_violation",
    "relationship_tone_violation",
    "missed_immediate_reaction",
  ]);

  if (reasons.some((reason) => severeReasons.has(reason))) {
    return false;
  }

  return true;
}

function canAcceptDegradedSingleReply(
  prepared: PreparedResponseRequest,
  reasons: ResponseEvaluationReason[],
): boolean {
  if (prepared.context.mode !== "single" || reasons.length === 0) {
    return false;
  }

  const allowedReasons = new Set<ResponseEvaluationReason>([
    "generic_user_reference",
  ]);

  return reasons.every((reason) => allowedReasons.has(reason));
}

function canAcceptDegradedGroupReply(
  prepared: PreparedResponseRequest,
  reasons: ResponseEvaluationReason[],
): boolean {
  if (prepared.context.mode !== "group" || reasons.length === 0) {
    return false;
  }

  const greetingOnlyMiss =
    reasons.includes("missed_immediate_reaction") &&
    prepared.turnInterpretation?.actionType === "greeting";

  return greetingOnlyMiss && reasons.every((reason) => reason === "missed_immediate_reaction");
}

function extractQuotedDialogueSegments(reply: string): string[] {
  const closedSegments = [
    ...reply.matchAll(/["“]([^"”\n]{3,240})["”]/g),
  ]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  if (closedSegments.length > 0) {
    return closedSegments;
  }

  const lastStraightQuote = reply.lastIndexOf("\"");
  const lastCurlyQuote = reply.lastIndexOf("“");
  const lastQuoteIndex = Math.max(lastStraightQuote, lastCurlyQuote);
  if (lastQuoteIndex === -1 || lastQuoteIndex >= reply.length - 4) {
    return [];
  }

  const trailing = reply.slice(lastQuoteIndex + 1).trim();
  if (trailing.length < 12) {
    return [];
  }
  return [trailing];
}

function normalizeSalvagedDialogue(reply: string): string {
  const segments = extractQuotedDialogueSegments(reply);
  if (segments.length > 0) {
    return segments
      .join(" ")
      .replace(/\s+([,.;!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  const starredTail = reply
    .split("*")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(-1)[0];
  if (starredTail && starredTail.length >= 12) {
    return starredTail.replace(/\s+/g, " ").trim();
  }

  const speechTailMatch = reply.match(
    /(?:^|[.!?]\s+)(["“])?((?:ah|hello|hi|well|i|what|please|good|greetings)\b[\s\S]*)/i,
  );
  if (speechTailMatch?.[2]) {
    return speechTailMatch[2].trim();
  }

  return "";
}

function maybePreferDialogueOnlyReply(input: {
  reply: string;
  speakerName?: string;
  userName?: string;
  latestUserMessage?: string;
  prepared: PreparedResponseRequest;
}): { reply: string; assessment: ReturnType<typeof evaluateCharacterReply> } | null {
  const dialogueOnly = normalizeSalvagedDialogue(input.reply);
  if (!dialogueOnly) {
    return null;
  }

  const assessment = evaluateCharacterReply({
    reply: dialogueOnly,
    speakerName: input.speakerName,
    userName: input.userName,
    latestUserMessage: input.latestUserMessage,
    prepared: input.prepared,
  });

  return { reply: dialogueOnly, assessment };
}

function shouldSuppressNarrativeFirstReplyPreview(
  preview: string,
  prepared: PreparedResponseRequest,
): boolean {
  if (preview.length < 240) {
    return false;
  }

  const hasAssistantHistory = prepared.context.history.some(
    (message) => message.role === "assistant",
  );
  if (hasAssistantHistory) {
    return false;
  }

  return isNarrativeHeavyRuntimeText(
    preview,
    prepared.context.speaker?.name,
  );
}

function shouldSuppressLongFirstReplyPreview(
  preview: string,
  prepared: PreparedResponseRequest,
): boolean {
  const hasAssistantHistory = prepared.context.history.some(
    (message) => message.role === "assistant",
  );
  if (hasAssistantHistory) {
    return false;
  }

  return preview.length >= 220;
}

function acceptOriginalReply(input: {
  reasons: ResponseEvaluationReason[];
  rawReply: string;
  finalReply: string;
  qualityScore: number;
}): ResponseEvaluation {
  return {
    accepted: true,
    repaired: false,
    retryRequested: true,
    qualityScore: input.qualityScore,
    reasons: dedupeReasons(input.reasons),
    rawReply: input.rawReply,
    finalReply: input.finalReply,
  };
}

export function buildStreamingPreview(
  rawOutput: string,
  prepared: PreparedResponseRequest,
): string {
  const preview = sanitizeStreamingAssistantPreview(rawOutput, {
    speakerName: prepared.context.speaker?.name,
    userName: prepared.context.userProfile?.name,
  });
  if (!preview) {
    return "";
  }
  const assessment = evaluateCharacterReply({
    reply: preview,
    speakerName: prepared.context.speaker?.name,
    userName: prepared.context.userProfile?.name,
    latestUserMessage: prepared.context.latestUserMessage,
    prepared,
  });
  if (assessment.suppressPreview) {
    return "";
  }
  if (shouldSuppressNarrativeFirstReplyPreview(preview, prepared)) {
    return "";
  }
  if (shouldSuppressLongFirstReplyPreview(preview, prepared)) {
    return "";
  }
  return preview;
}

export async function finalizeResponseOutput(input: {
  rawOutput: string;
  prepared: PreparedResponseRequest;
  repair?: (instruction: string) => Promise<string>;
  fallbackReply?: string;
  diagnostics?: ResponseDiagnosticsRecorder;
}): Promise<ResponseEvaluation> {
  const speakerName = input.prepared.context.speaker?.name;
  const userName = input.prepared.context.userProfile?.name;
  const latestUserMessage = input.prepared.context.latestUserMessage;
  const sanitized = sanitizeAssistantReply(input.rawOutput, {
    speakerName,
    userName,
  });
  input.diagnostics?.recordRawOutput(input.rawOutput);
  input.diagnostics?.recordSanitizedOutput(sanitized);
  const finish = (evaluation: ResponseEvaluation): ResponseEvaluation => {
    input.diagnostics?.recordFinalEvaluation(evaluation);
    return evaluation;
  };
  const fallbackReply = input.fallbackReply ?? `${speakerName ?? "Assistant"} has no response yet.`;
  let initialReply = sanitized;
  let initialAssessment = evaluateCharacterReply({
    reply: initialReply,
    speakerName,
    userName,
    latestUserMessage,
    prepared: input.prepared,
  });
  const dialogueOnlyCandidate = maybePreferDialogueOnlyReply({
    reply: sanitized,
    speakerName,
    userName,
    latestUserMessage,
    prepared: input.prepared,
  });
  if (
    dialogueOnlyCandidate &&
    (
      (initialAssessment.retryRequested &&
        !dialogueOnlyCandidate.assessment.fatal &&
        dialogueOnlyCandidate.assessment.qualityScore >= initialAssessment.qualityScore) ||
      dialogueOnlyCandidate.assessment.qualityScore > initialAssessment.qualityScore ||
      (
        dialogueOnlyCandidate.assessment.qualityScore === initialAssessment.qualityScore &&
        dialogueOnlyCandidate.assessment.reasons.length < initialAssessment.reasons.length
      )
    )
  ) {
    initialReply = dialogueOnlyCandidate.reply;
    initialAssessment = dialogueOnlyCandidate.assessment;
    input.diagnostics?.recordSanitizedOutput(initialReply);
  }
  input.diagnostics?.recordInitialValidation({
    reasons: initialAssessment.reasons,
    qualityScore: initialAssessment.qualityScore,
  });
  const reasons: ResponseEvaluationReason[] = [...initialAssessment.reasons];
  const retryRequested = initialAssessment.retryRequested;

  if (
    retryRequested &&
    !initialAssessment.fatal &&
    canAcceptDegradedGroupReply(input.prepared, initialAssessment.reasons)
  ) {
    return finish(acceptOriginalReply({
      reasons,
      rawReply: input.rawOutput,
      finalReply: initialReply.trim(),
      qualityScore: initialAssessment.qualityScore,
    }));
  }

  const reject = (reply: string, qualityScore: number): ResponseEvaluation =>
    finish({
      accepted: false,
      repaired: false,
      retryRequested: true,
      qualityScore,
      reasons: dedupeReasons(reasons),
      rawReply: input.rawOutput,
      finalReply: reply,
    });

  const resolveRepairFailure = (): ResponseEvaluation => {
    reasons.push("repair_failed");
    if (
      initialReply.trim() &&
      !initialAssessment.fatal &&
      (
        canAcceptOriginalReplyAfterRepairFailure(
          input.prepared,
          initialAssessment.reasons,
        ) ||
        canAcceptDegradedSingleReply(
          input.prepared,
          initialAssessment.reasons,
        ) ||
        canAcceptDegradedGroupReply(
          input.prepared,
          initialAssessment.reasons,
        )
      )
    ) {
      return finish(acceptOriginalReply({
        reasons,
        rawReply: input.rawOutput,
        finalReply: initialReply.trim(),
        qualityScore: initialAssessment.qualityScore,
      }));
    }
    if (!initialReply.trim()) {
      reasons.push("fallback_used");
      return reject(fallbackReply, 0);
    }
    return reject("", initialAssessment.qualityScore);
  };

  if (retryRequested && input.repair) {
    reasons.push("policy_retry_requested");
    let repairedRaw: string;
    const repairAttempt = input.diagnostics?.startRepairAttempt("policy");
    try {
      repairedRaw = await input.repair(
        buildCharacterReplyRepairInstruction({
          speakerName,
          userName,
          userGender: input.prepared.context.userProfile?.gender,
          latestUserMessage,
          turnInterpretation: input.prepared.turnInterpretation,
          reactionPlan: input.prepared.reactionPlan,
        }),
      );
    } catch (error) {
      repairAttempt?.finish({
        error: formatResponseDiagnosticError(error),
      });
      return resolveRepairFailure();
    }
    const repaired = sanitizeAssistantReply(repairedRaw, {
      speakerName,
      userName,
    });
    const repairedAssessment = evaluateCharacterReply({
      reply: repaired,
      speakerName,
      userName,
      latestUserMessage,
      prepared: input.prepared,
    });
    const repairedAccepted =
      Boolean(repaired.trim()) &&
      (
        !repairedAssessment.retryRequested ||
        (
          !repairedAssessment.fatal &&
          (
            canAcceptDegradedSingleReply(input.prepared, repairedAssessment.reasons) ||
            canAcceptDegradedGroupReply(input.prepared, repairedAssessment.reasons)
          )
        )
      );
    repairAttempt?.finish({
      rawOutput: repairedRaw,
      sanitizedOutput: repaired,
      reasons: repairedAssessment.reasons,
      accepted: repairedAccepted,
    });
    if (repaired.trim() && !repairedAssessment.retryRequested) {
      reasons.push("repair_applied");
      return finish({
        accepted: true,
        repaired: true,
        retryRequested: true,
        qualityScore: repairedAssessment.qualityScore,
        reasons: dedupeReasons(reasons),
        rawReply: input.rawOutput,
        finalReply: repaired.trim(),
      });
    }
    if (
      repaired.trim() &&
      !repairedAssessment.fatal &&
      canAcceptDegradedSingleReply(input.prepared, repairedAssessment.reasons)
    ) {
      reasons.push(...repairedAssessment.reasons);
      reasons.push("repair_applied");
      return finish({
        accepted: true,
        repaired: true,
        retryRequested: true,
        qualityScore: repairedAssessment.qualityScore,
        reasons: dedupeReasons(reasons),
        rawReply: input.rawOutput,
        finalReply: repaired.trim(),
      });
    }
    if (
      repaired.trim() &&
      !repairedAssessment.fatal &&
      canAcceptDegradedGroupReply(input.prepared, repairedAssessment.reasons)
    ) {
      reasons.push(...repairedAssessment.reasons);
      reasons.push("repair_applied");
      return finish({
        accepted: true,
        repaired: true,
        retryRequested: true,
        qualityScore: repairedAssessment.qualityScore,
        reasons: dedupeReasons(reasons),
        rawReply: input.rawOutput,
        finalReply: repaired.trim(),
      });
    }
    if (
      initialReply.trim() &&
      !initialAssessment.fatal &&
      (
        canAcceptOriginalReplyAfterRepairFailure(
          input.prepared,
          initialAssessment.reasons,
        ) ||
        canAcceptDegradedSingleReply(
          input.prepared,
          initialAssessment.reasons,
        ) ||
        canAcceptDegradedGroupReply(
          input.prepared,
          initialAssessment.reasons,
        )
      )
    ) {
      reasons.push("repair_failed");
      return finish(acceptOriginalReply({
        reasons,
        rawReply: input.rawOutput,
        finalReply: initialReply.trim(),
        qualityScore: initialAssessment.qualityScore,
      }));
    }
    if (
      repairedAssessment.retryRequested &&
      !repairedAssessment.fatal &&
      input.prepared.context.mode === "group"
    ) {
      const rescueAttempt = input.diagnostics?.startRepairAttempt("rescue");
      try {
        repairedRaw = await input.repair(buildRescueRepairInstruction(input.prepared));
      } catch (error) {
        rescueAttempt?.finish({
          error: formatResponseDiagnosticError(error),
        });
        return resolveRepairFailure();
      }
      const rescued = sanitizeAssistantReply(repairedRaw, {
        speakerName,
        userName,
      });
      const rescuedAssessment = evaluateCharacterReply({
        reply: rescued,
        speakerName,
        userName,
        latestUserMessage,
        prepared: input.prepared,
      });
      rescueAttempt?.finish({
        rawOutput: repairedRaw,
        sanitizedOutput: rescued,
        reasons: rescuedAssessment.reasons,
        accepted: Boolean(rescued.trim() && !rescuedAssessment.retryRequested),
      });
      if (rescued.trim() && !rescuedAssessment.retryRequested) {
        reasons.push("repair_applied");
        return finish({
          accepted: true,
          repaired: true,
          retryRequested: true,
          qualityScore: rescuedAssessment.qualityScore,
          reasons: dedupeReasons(reasons),
          rawReply: input.rawOutput,
          finalReply: rescued.trim(),
        });
      }
    }
    if (!repaired.trim()) {
      const repairedRawAssessment = evaluateCharacterReply({
        reply: repairedRaw,
        speakerName,
        userName,
        latestUserMessage,
        prepared: input.prepared,
      });
      reasons.push(
        ...repairedRawAssessment.reasons.filter(
          (reason) =>
            reason === "role_inversion" ||
            reason === "transcript_leakage" ||
            reason === "meta_reasoning",
        ),
      );
      reasons.push("empty_after_sanitize");
      reasons.push("fallback_used");
    }
    reasons.push("repair_failed");
    return reject("", repairedAssessment.qualityScore);
  }

  const finalReply = initialReply.trim() || fallbackReply;
  if (!initialReply.trim()) {
    const rawAssessment = evaluateCharacterReply({
      reply: input.rawOutput,
      speakerName,
      userName,
      latestUserMessage,
      prepared: input.prepared,
    });
    reasons.push(
      ...rawAssessment.reasons.filter(
        (reason) =>
          reason === "role_inversion" ||
          reason === "transcript_leakage" ||
          reason === "meta_reasoning",
      ),
    );
    reasons.push("empty_after_sanitize");
    reasons.push("fallback_used");
    return reject(finalReply, 0);
  }

  if (retryRequested) {
    return reject(finalReply, initialAssessment.qualityScore);
  }

  return finish({
    accepted: true,
    repaired: false,
    retryRequested,
    qualityScore: initialReply.trim() ? initialAssessment.qualityScore : 0,
    reasons: dedupeReasons(reasons),
    rawReply: input.rawOutput,
    finalReply,
  });
}
