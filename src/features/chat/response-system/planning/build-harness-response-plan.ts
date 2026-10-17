import { clipText } from "../compile/prompt-budget";
import type { HarnessResponsePlan, ResponseContext, TurnFrameTone } from "../types";

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sceneAnchor(context: ResponseContext): string {
  const liveScene = context.sceneStateInput?.currentScene?.trim() ||
    context.relationshipState?.currentScene.trim() ||
    context.sceneState?.visibleFacts.find((fact) => /^Current live scene:/i.test(fact)) ||
    "";
  if (liveScene) {
    return clipText(liveScene.replace(/^Current live scene:\s*/i, ""), 180);
  }
  return "Use the immediate exchange and recent history as the active scene.";
}

function personaAnchor(context: ResponseContext): string {
  const parts = [
    context.speaker?.name?.trim() ? `Respond as ${context.speaker.name.trim()}.` : "",
    context.speaker?.tags.length ? `Core traits: ${context.speaker.tags.slice(0, 4).join(", ")}.` : "",
    context.speaker?.speechStyle?.trim()
      ? `Voice: ${clipText(context.speaker.speechStyle, 160)}.`
      : "",
  ];
  return dedupe(parts).join(" ");
}

function latestUserSocialTone(context: ResponseContext): TurnFrameTone {
  return context.groupRoundState?.latestUserSocialTone ?? context.turnFrame?.emotionalTone ?? "neutral";
}

function isChargedLatestUserTone(tone: TurnFrameTone | undefined): boolean {
  return tone === "provocative" || tone === "flirtatious" || tone === "playful";
}

function describeLatestUserSocialTone(tone: TurnFrameTone | undefined): string {
  switch (tone) {
    case "provocative":
      return "provocative/flirtatious";
    case "flirtatious":
      return "flirtatious";
    case "playful":
      return "playful/teasing";
    default:
      return tone ?? "neutral";
  }
}

function groupObligation(context: ResponseContext): string | undefined {
  const group = context.groupRoundState;
  if (!group) {
    return undefined;
  }
  const socialTone = latestUserSocialTone(context);
  const socialToneLabel = describeLatestUserSocialTone(socialTone);
  if (group.currentSpeakerRole === "directly_addressed") {
    if (isChargedLatestUserTone(socialTone)) {
      return group.priorReplies.length > 0
        ? `You are the addressee of a ${socialToneLabel} latest line; answer it directly while showing the previous group replies affected the room.`
        : `You are the addressee of a ${socialToneLabel} latest line; answer the social beat directly.`;
    }
    return group.priorReplies.length > 0
      ? "You are the addressee; answer directly while showing the previous group replies affected the room."
      : "You are the addressee; answer the user directly.";
  }
  if (group.currentSpeakerRole === "observer_to_other_address") {
    if (isChargedLatestUserTone(socialTone)) {
      return group.addressedParticipants.length > 0
        ? `You are observing a ${socialToneLabel} exchange aimed at ${group.addressedParticipants.join(", ")}; react in the room without answering for them.`
        : `You are observing a ${socialToneLabel} exchange; add a relevant in-character beat.`;
    }
    return group.addressedParticipants.length > 0
      ? `You are observing an exchange aimed at ${group.addressedParticipants.join(", ")}; react as a participant in the room without taking over their task.`
      : "You are observing the exchange; add a relevant in-character beat.";
  }
  if (group.priorReplies.length > 0) {
    return "You are speaking after other participants; position yourself relative to the room beat before adding a new angle.";
  }
  return "You are part of a shared group conversation; keep awareness of the other participants.";
}

function distinctContribution(context: ResponseContext): string | undefined {
  const group = context.groupRoundState;
  if (!group || group.priorReplies.length === 0) {
    return undefined;
  }
  const latest = group.priorReplies[group.priorReplies.length - 1];
  return `Do not restate ${latest?.speakerName ?? "the previous speaker"}'s point. Add one distinct contribution: agree with a new detail, contrast, clarify, redirect, or add a character-specific reaction.`;
}

export function buildHarnessResponsePlan(context: ResponseContext): HarnessResponsePlan {
  const frame = context.turnFrame;
  const socialTone = latestUserSocialTone(context);
  const mustAcknowledge = dedupe([
    frame?.topic ? `Live topic: ${frame.topic}` : "",
    frame?.userAction ? `User action: ${frame.userAction}` : "",
    frame?.emotionalTone && frame.emotionalTone !== "neutral"
      ? `User emotional tone: ${frame.emotionalTone}`
      : "",
    isChargedLatestUserTone(socialTone)
      ? `Latest user social tone: ${describeLatestUserSocialTone(socialTone)}`
      : "",
    frame?.concreteChoice ? `User choice/preference: ${frame.concreteChoice}` : "",
    frame?.sceneAssertion
      ? `Latest user scene correction: ${frame.sceneAssertion}`
      : "",
    frame?.sceneTransition
      ? `User-directed movement target: ${frame.sceneTransition}`
      : "",
    frame?.visibleSearchCue ? "Visible search/action cue: user is trying to locate, inspect, or move toward something." : "",
    frame?.locationTarget ? `Likely location target: ${frame.locationTarget}` : "",
    frame?.responseObligation ? `Response obligation: ${frame.responseObligation}` : "",
    context.turnInterpretation?.intent ?? "",
    context.groupRoundState?.currentSocialBeat ?? "",
  ]).slice(0, 8);

  const mustAvoid = dedupe([
    "Do not write dialogue, actions, or body reactions for the user.",
    "Do not replace the live scene with static card lore.",
    "Do not turn saved user-profile clothing, weapons, props, or biography into the active topic unless the latest user move points at them.",
    "Do not answer as a generic assistant, salesperson, waiter, narrator, or another participant.",
    "Do not output speaker labels, role labels, prompt text, or section headers.",
    "Do not output unresolved placeholders like <NAME>, {{user}}, {{char}}, [name], or %user%.",
    frame?.sceneAssertion
      ? "Do not let an older saved scene or static character scenario override the user's latest scene correction."
      : "",
    frame?.sceneTransition
      ? "Do not ignore the user-directed movement target or snap back to the old static scene."
      : "",
    frame?.concreteChoice
      ? "Do not silently replace the user's stated choice with a different choice."
      : "",
    context.groupRoundState?.priorReplies.length
      ? "Do not copy or merely rephrase an earlier same-round reply."
      : "",
    context.groupRoundState?.currentSpeakerRole === "observer_to_other_address"
      ? "Do not take over the addressee's practical task."
      : "",
    isChargedLatestUserTone(socialTone)
      ? "Do not treat the flirtatious/provocative line as stale venue logistics, a food order, or an older practical topic."
      : "",
  ]);

  return {
    mustAcknowledge,
    mustAvoid,
    sceneAnchor: sceneAnchor(context),
    personaAnchor: personaAnchor(context),
    groupObligation: groupObligation(context),
    distinctContribution: distinctContribution(context),
    outputContract:
      "Return only the character reply in plain text. Do not use markdown wrappers, speaker labels, prompt text, placeholders, or text for the user/other speakers.",
  };
}
