import type { CharacterReactionPlan, ResponseContext, TurnFrameTone } from "../types";
import { clipText } from "../compile/prompt-budget";
import { shouldReuseGreetingAsVoiceReference } from "../runtime-field-gating";

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function latestSceneFact(context: ResponseContext): string {
  const visibleFacts = context.sceneState?.visibleFacts ?? [];
  return (
    visibleFacts.find((fact) =>
      /visible (threat cue|user-held object)|relevant saved user profile fact/i.test(fact),
    )?.trim() ??
    visibleFacts[0]?.trim() ??
    ""
  );
}

function hasLiveSceneOrCorrection(context: ResponseContext): boolean {
  return Boolean(
    context.sceneStateInput?.currentScene?.trim() ||
      context.sceneStateInput?.interactionTone?.trim() ||
      context.sceneStateInput?.characterState?.trim() ||
      context.sceneStateInput?.userState?.trim() ||
      (context.sceneStateInput?.visibleFacts?.length ?? 0) > 0 ||
      context.relationshipState?.currentScene.trim() ||
      context.sceneState?.currentScene?.trim() ||
      (context.sceneState?.visibleFacts ?? []).some((fact) =>
        /^(Current live scene|User appears|Character appears):/i.test(fact),
      ),
  );
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

function addressedParticipants(context: ResponseContext): string {
  return context.groupRoundState?.addressedParticipants.join(", ") || "the addressed participant";
}

function inferImmediateObjective(context: ResponseContext): string {
  const turn = context.turnInterpretation;
  const scene = context.sceneState;
  const socialTone = latestUserSocialTone(context);
  const socialToneLabel = describeLatestUserSocialTone(socialTone);
  if (context.turnFrame?.sceneAssertion) {
    return "Treat the user's latest scene correction as the active scene before any static card, profile, or older saved-scene detail.";
  }
  if (context.turnFrame?.sceneTransition) {
    return "Treat the user's directed movement target as the live next beat before returning to older scene context.";
  }
  if (scene?.tension === "high") {
    return "React to the live danger or coercion before adding personality flourish.";
  }
  if (
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "observer_to_other_address"
  ) {
    return `React to the ${socialToneLabel} remark aimed at ${addressedParticipants(context)} as an observing participant, not as the addressee or as a stale practical task.`;
  }
  if (
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "directly_addressed"
  ) {
    return `Answer the ${socialToneLabel} direct address as the addressee before returning to any practical topic.`;
  }
  if (
    context.groupRoundState?.engagementExpectation === "required" &&
    context.groupRoundState.priorReplies.length > 0
  ) {
    return "Enter downstream from the room's current social beat instead of answering like the first speaker.";
  }
  if (context.groupRoundState?.currentSpeakerRole === "observer_to_other_address") {
    return context.groupRoundState.currentTopicLabel
      ? `React to the live exchange around ${context.groupRoundState.currentTopicLabel} as an observing participant instead of acting like the user addressed you directly or handed you the task.`
      : "React to the live exchange as an observing participant instead of acting like the user addressed you directly or handed you the task.";
  }
  if (turn?.requiresImmediateReaction) {
    return "Answer the user's latest move directly before expanding the scene.";
  }
  return "Advance the exchange in character while preserving continuity.";
}

function inferPrimaryGoal(context: ResponseContext): string {
  const turn = context.turnInterpretation;
  const socialTone = latestUserSocialTone(context);
  const socialToneLabel = describeLatestUserSocialTone(socialTone);
  const visibleCondition = (context.sceneState?.visibleFacts ?? []).some((fact) =>
    /visible user condition/i.test(fact),
  );
  if (context.explicitUserChoice) {
    return `Treat the user's stated ${context.explicitUserChoice.kind} as the live baseline. React to ${context.explicitUserChoice.surfaceText} directly before suggesting, questioning, or redirecting it.`;
  }
  if (context.turnFrame?.sceneAssertion) {
    return `Honor the user's latest scene correction (${context.turnFrame.sceneAssertion}) as the current scene, then respond in character.`;
  }
  if (context.turnFrame?.sceneTransition) {
    return `Honor the user's movement target (${context.turnFrame.sceneTransition}) as the current direction, then respond in character.`;
  }
  const latestPriorReply =
    context.groupRoundState?.priorReplies[
      (context.groupRoundState?.priorReplies.length ?? 1) - 1
    ];
  if (
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "observer_to_other_address"
  ) {
    return `React as an observing participant to the ${socialToneLabel} remark aimed at ${addressedParticipants(context)}. Treat the live social beat as the point: tease, show surprise, set a boundary, or redirect without pretending the line was addressed to you.`;
  }
  if (
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "directly_addressed"
  ) {
    return `Answer as the addressee to the ${socialToneLabel} remark. Make the reply about the live social beat, not an older practical topic.`;
  }
  if (context.groupRoundState?.currentSpeakerRole === "observer_to_other_address") {
    return context.groupRoundState.currentTopicLabel
      ? `React as an observing participant in a live exchange already in motion. Comment on the user's remark, the addressed participant, or the live topic of ${context.groupRoundState.currentTopicLabel} without pretending the line was addressed to you or taking over the requested action.`
      : "React as an observing participant in a live exchange already in motion. Comment on the user's remark, the addressed participant, or the room beat without pretending the line was addressed to you or taking over the requested action.";
  }
  if (context.groupRoundState?.currentSpeakerRole === "directly_addressed") {
    return "Answer as the addressee while making it obvious the earlier same-round replies already changed the room around you.";
  }
  if (
    context.groupRoundState?.engagementExpectation === "required" &&
    context.groupRoundState.priorReplies.length > 0
  ) {
    return latestPriorReply
      ? `Answer as part of an already-moving group exchange. Let ${latestPriorReply.speakerName}'s latest move visibly shape your angle before you add a distinct stance.`
      : "Answer as part of an already-moving group exchange. Let the current room beat visibly shape your angle before you add a distinct stance.";
  }
  if (visibleCondition) {
    return "Notice the user's visible condition immediately and respond with concern, alarm, caution, or grounded character emotion before any side topic.";
  }
  switch (turn?.actionType) {
    case "armed-command":
      return "Protect the character in the immediate moment while revealing how they handle direct danger.";
    case "armed-question":
      return "Acknowledge the visible threat directly while showing the character's instinct under pressure.";
    case "threat":
      return "Survive the pressure and show the character's instinct under coercion.";
    case "command":
      return "Decide whether the character complies, resists, negotiates, or deflects instead of parroting.";
    case "greeting":
      return "Acknowledge the greeting directly and establish the character's tone immediately.";
    case "question":
      return "Answer the question clearly while advancing the character's agenda and voice.";
    case "request":
      return "Make the character's willingness, hesitation, or refusal legible through the reply.";
    default:
      return "Move the scene forward with a clear in-character choice rather than neutral filler.";
  }
}

function inferResponseStrategy(context: ResponseContext): string {
  const turn = context.turnInterpretation;
  const socialTone = latestUserSocialTone(context);
  const socialToneLabel = describeLatestUserSocialTone(socialTone);
  const visibleCondition = (context.sceneState?.visibleFacts ?? []).some((fact) =>
    /visible user condition/i.test(fact),
  );
  if (context.explicitUserChoice) {
    return "Choice-fidelity response. Preserve the user's stated choice as the baseline, then add your character's stance without silently replacing it.";
  }
  if (context.turnFrame?.sceneAssertion) {
    return "Scene-correction response. Follow the user's latest asserted scene over static card lore, saved profile details, or an older scenario frame.";
  }
  if (context.turnFrame?.sceneTransition) {
    return "Movement-target response. Move with the user's live direction instead of restarting or freezing the prior scene.";
  }
  const latestPriorReply =
    context.groupRoundState?.priorReplies[
      (context.groupRoundState?.priorReplies.length ?? 1) - 1
    ];
  if (
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "observer_to_other_address"
  ) {
    return `Observer social-beat response. React to the ${socialToneLabel} line aimed at ${addressedParticipants(context)}, reveal your stance on that moment, and avoid taking over the addressee's answer.`;
  }
  if (
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "directly_addressed"
  ) {
    return `Addressee social-beat response. Answer the ${socialToneLabel} line directly, choosing whether to tease back, deflect, set a boundary, or redirect in character.`;
  }
  if (context.groupRoundState?.currentSpeakerRole === "observer_to_other_address") {
    return context.groupRoundState.currentTopicLabel
      ? `Bystander response. React to the exchange already unfolding in the room around ${context.groupRoundState.currentTopicLabel}, reveal your stance on it, and add a socially coherent next beat without taking over the addressee's practical task.`
      : "Bystander response. React to the exchange already unfolding in the room, reveal your stance on it, and add a socially coherent next beat without taking over the addressee's practical task.";
  }
  if (context.groupRoundState?.currentSpeakerRole === "directly_addressed") {
    return "Addressee response. Answer the user's remark directly, but let the earlier replies shape your tone or angle.";
  }
  if (
    context.groupRoundState?.engagementExpectation === "required" &&
    context.groupRoundState.priorReplies.length > 0
  ) {
    return latestPriorReply
      ? `Downstream group response. Show that you heard ${latestPriorReply.speakerName}'s move and position yourself relative to it before adding a distinct in-character angle.`
      : "Downstream group response. Show that you heard the room's current beat, then add a distinct in-character angle instead of restarting the scene.";
  }
  if (visibleCondition) {
    return "Immediate observation response. Acknowledge the visible condition first, then let character voice shape the concern or reaction.";
  }
  switch (turn?.actionType) {
    case "armed-command":
      return "Immediate tactical reaction. Show fear, resistance, bluff, compliance, or defiance according to character.";
    case "armed-question":
      return "Directly answer what the character sees, but do it as a pressured threat response rather than casual exposition.";
    case "threat":
      return "Pressure response. Acknowledge the threat and reveal the character's instinct under coercion.";
    case "command":
      return "Action response. React to being directed instead of mirroring the instruction back.";
    case "greeting":
      return "Opening response. Meet the greeting directly and let the character's personality color the first beat.";
    case "question":
      return "Direct answer plus character color.";
    case "request":
      return "Respond to the ask itself and reveal the character's willingness or refusal.";
    default:
      return "Advance the interaction with a clear in-character next move.";
  }
}

function inferInteractionStance(context: ResponseContext): string {
  const speakerTags = context.speaker?.tags.map((tag) => tag.toLowerCase()) ?? [];
  const highPressure = context.sceneState?.tension === "high";
  const socialTone = latestUserSocialTone(context);
  const aggressiveDisposition = speakerTags.some((tag) =>
    ["angry", "hyper", "defiant", "aggressive", "volatile", "guarded"].includes(tag),
  );
  const gentleDisposition = speakerTags.some((tag) =>
    ["gentle", "warm", "flirty", "empathetic", "protective", "soft"].includes(tag),
  );

  if (isChargedLatestUserTone(socialTone)) {
    return `Socially charged and boundary-aware. Treat the ${describeLatestUserSocialTone(socialTone)} tone as the live beat and answer from the current speaker's role.`;
  }
  if (
    context.groupRoundState?.engagementExpectation === "required" &&
    context.groupRoundState.priorReplies.length > 0
  ) {
    return "Socially downstream and distinct. Sound influenced by what was just said without mimicking it.";
  }
  if (context.turnFrame?.sceneAssertion || context.turnFrame?.sceneTransition) {
    return "Responsive to the user's live scene update. Let the correction or movement target change the reply before adding character flavor.";
  }
  if (highPressure && aggressiveDisposition) {
    return "Pressured but resistant. The reply should show strain without surrendering personality.";
  }
  if (highPressure && gentleDisposition) {
    return "Pressured and cautious. The reply should show vulnerability or care under stress.";
  }
  if (context.turnInterpretation?.actionType === "question") {
    return "Direct and engaged. Answer first, then add character color.";
  }
  if (context.turnInterpretation?.actionType === "greeting") {
    return "Present and engaged. Meet the greeting directly instead of pretending the user said nothing.";
  }
  return "Active and character-led. Make a choice in the reply instead of standing still.";
}

function inferEmotionalPosture(context: ResponseContext): string {
  const scene = context.sceneState;
  const turn = context.turnInterpretation;
  const socialTone = latestUserSocialTone(context);
  if (scene?.tension === "high") {
    return "Heightened and immediate. The character should feel the pressure of the moment.";
  }
  if (isChargedLatestUserTone(socialTone)) {
    return `Socially alert and character-specific. The reply should register the ${describeLatestUserSocialTone(socialTone)} tone without turning generic or explicit by default.`;
  }
  if (turn?.emotionalPressure === "medium") {
    return "Present and responsive. The reply should show emotional movement, not flat exposition.";
  }
  return "Grounded and character-led. Stay expressive without over-narrating.";
}

function inferSceneFocus(context: ResponseContext): string {
  if (context.sceneState?.immediatePriority) {
    return context.sceneState.immediatePriority;
  }
  if (context.turnFrame?.sceneAssertion) {
    return "Use the user's latest scene correction as the primary scene anchor.";
  }
  if (context.turnFrame?.sceneTransition) {
    return "Use the user's movement target as the active next scene direction.";
  }
  if (context.relationshipState?.currentScene.trim()) {
    return "Stay anchored to the saved current scene and react within it.";
  }
  return "Use the latest user move as the primary scene anchor.";
}

function inferReplyOpening(context: ResponseContext): string {
  const latestPriorReply =
    context.groupRoundState?.priorReplies[
      (context.groupRoundState?.priorReplies.length ?? 1) - 1
    ];
  const socialTone = latestUserSocialTone(context);
  if (
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "observer_to_other_address"
  ) {
    return `Open with ${context.speaker?.name ?? "the current speaker"}'s immediate observer reaction to the ${describeLatestUserSocialTone(socialTone)} line aimed at ${addressedParticipants(context)}.`;
  }
  if (
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "directly_addressed"
  ) {
    return `Open with ${context.speaker?.name ?? "the addressee"}'s direct reaction to the ${describeLatestUserSocialTone(socialTone)} line.`;
  }
  if (
    context.groupRoundState?.engagementExpectation === "required" &&
    context.groupRoundState.priorReplies.length > 0
  ) {
    return latestPriorReply
      ? `Open by positioning yourself relative to ${latestPriorReply.speakerName}'s latest move, then pivot into your own angle.`
      : "Open with a line that clearly shows you heard the latest room beat, then pivot into your own angle.";
  }
  if (context.turnFrame?.sceneAssertion) {
    return "Open from the corrected live scene, not from the older saved scene or static card frame.";
  }
  if (context.turnFrame?.sceneTransition) {
    return "Open by moving with, accepting, or reacting to the user's directed movement target.";
  }
  switch (context.turnInterpretation?.actionType) {
    case "armed-command":
    case "armed-question":
    case "threat":
      return "Open with the character's immediate reaction to the danger before any explanation or scene dressing.";
    case "command":
      return "Open by showing the character's choice in response to being directed.";
    case "greeting":
      return "Open by acknowledging the greeting itself before expanding into scene or attitude.";
    case "question":
      return "Open with the answer, then color it with character voice.";
    case "request":
      return "Open with the character's answer to the ask itself, not setup narration.";
    default:
      return "Open with the most immediate in-character reaction, not with meta explanation or broad recap.";
  }
}

function buildSalientFacts(context: ResponseContext): string[] {
  const facts: string[] = [];
  const socialTone = latestUserSocialTone(context);
  if (context.turnInterpretation?.intent) {
    facts.push(`Latest move intent: ${clipText(context.turnInterpretation.intent, 180)}`);
  }
  if (isChargedLatestUserTone(socialTone)) {
    facts.push(`Latest user social tone: ${describeLatestUserSocialTone(socialTone)}`);
  }
  if (context.sceneState?.powerDynamic) {
    facts.push(`Power dynamic: ${clipText(context.sceneState.powerDynamic, 180)}`);
  }
  if (context.sceneState?.immediatePriority) {
    facts.push(`Immediate priority: ${clipText(context.sceneState.immediatePriority, 180)}`);
  }
  if (latestSceneFact(context)) {
    facts.push(`Visible fact: ${clipText(latestSceneFact(context), 180)}`);
  }
  if (context.relationshipState?.characterState.trim()) {
    facts.push(
      `Character state: ${clipText(context.relationshipState.characterState, 160)}`,
    );
  }
  if (context.groupRoundState?.priorReplies.length) {
    const latestPriorReply =
      context.groupRoundState.priorReplies[
        context.groupRoundState.priorReplies.length - 1
      ];
    facts.push(
      `Latest group beat: ${clipText(
        `${latestPriorReply.speakerName} ${latestPriorReply.socialEffect} (${latestPriorReply.emotionalTone}). Gist: ${latestPriorReply.gist}`,
        180,
      )}`,
    );
  }
  if (context.groupRoundState?.currentSocialBeat) {
    facts.push(`Current social beat: ${clipText(context.groupRoundState.currentSocialBeat, 180)}`);
  }
  if (context.groupRoundState?.currentTopicLabel) {
    facts.push(`Current topic: ${clipText(context.groupRoundState.currentTopicLabel, 120)}`);
  }
  if (context.turnFrame?.sceneAssertion) {
    facts.push(`Latest scene correction: ${clipText(context.turnFrame.sceneAssertion, 140)}`);
  }
  if (context.turnFrame?.sceneTransition) {
    facts.push(`Movement target: ${clipText(context.turnFrame.sceneTransition, 140)}`);
  }
  if (context.responsePlan?.sceneAnchor) {
    facts.push(`Scene anchor: ${clipText(context.responsePlan.sceneAnchor, 140)}`);
  }
  if (context.responsePlan?.distinctContribution) {
    facts.push(`Distinct group contribution: ${clipText(context.responsePlan.distinctContribution, 160)}`);
  }
  return dedupe(facts).slice(0, 5);
}

function buildContinuityAnchors(context: ResponseContext): string[] {
  const anchors: string[] = [];
  const hasPromotedProfileCue = (context.sceneState?.visibleFacts ?? []).some((fact) =>
    /^(Visible threat cue|Visible user condition|Visible user-held object|Relevant saved user profile fact):/i.test(
      fact,
    ),
  );
  if (context.relationshipState?.userRoleName?.trim()) {
    anchors.push(`User role: ${clipText(context.relationshipState.userRoleName, 120)}`);
  }
  if (context.relationshipState?.userRoleDescription?.trim()) {
    anchors.push(
      `User role details: ${clipText(context.relationshipState.userRoleDescription, 160)}`,
    );
  }
  if (context.relationshipState?.summary.trim()) {
    anchors.push(
      `Relationship baseline: ${clipText(context.relationshipState.summary, 180)}`,
    );
  }
  if (context.relationshipState?.currentScene.trim()) {
    anchors.push(
      `Saved scene: ${clipText(context.relationshipState.currentScene, 160)}`,
    );
  }
  if (context.userProfile?.about.trim() && hasPromotedProfileCue) {
    anchors.push(
      `User profile: ${clipText(context.userProfile.about, 160)}`,
    );
  }
  const scenario = context.speaker?.scenario?.trim();
  if (scenario && !hasLiveSceneOrCorrection(context) && !context.salienceProfile?.suppressStaticScenario) {
    anchors.push(`Scenario frame: ${clipText(scenario, 160)}`);
  }
  if (context.memory?.summary.trim()) {
    anchors.push(`Memory anchor: ${clipText(context.memory.summary, 160)}`);
  }
  return dedupe(anchors).slice(0, 4);
}

export function buildCharacterReactionPlan(
  context: ResponseContext,
): CharacterReactionPlan {
  const socialTone = latestUserSocialTone(context);
  const socialToneLabel = describeLatestUserSocialTone(socialTone);
  const mustAddress = dedupe([
    context.turnInterpretation?.intent ?? "",
    context.turnInterpretation?.antiParrotDirective ?? "",
    isChargedLatestUserTone(socialTone)
      ? `The latest user line is ${socialToneLabel}; treat that as the live social beat.`
      : "",
    ...(context.responsePlan?.mustAcknowledge ?? []),
    context.sceneState?.powerDynamic ?? "",
    context.sceneState?.immediatePriority ?? "",
    context.groupRoundState?.currentSocialBeat ?? "",
    context.groupRoundState?.expectedSocialMove ?? "",
    context.groupRoundState?.currentTopicLabel
      ? `Live topic: ${context.groupRoundState.currentTopicLabel}`
      : "",
    context.explicitUserChoice
      ? `The user's stated ${context.explicitUserChoice.kind} is ${context.explicitUserChoice.surfaceText}. Treat that as the current baseline.`
      : "",
    context.turnFrame?.sceneAssertion
      ? `The user's latest scene correction is ${context.turnFrame.sceneAssertion}; treat that as live context above saved scene/card/profile lore.`
      : "",
    context.turnFrame?.sceneTransition
      ? `The user's movement target is ${context.turnFrame.sceneTransition}; treat that as the live next direction.`
      : "",
    ...(context.groupRoundState?.currentSpeakerObligations ?? []),
  ]);

  const styleAnchors = dedupe([
    context.speaker?.speechStyle ?? "",
    shouldReuseGreetingAsVoiceReference(context.speaker?.greeting, context.speaker?.name)
      ? context.speaker?.greeting ?? ""
      : "",
    context.speaker?.tags.slice(0, 3).join(", ") ?? "",
  ]);

  const forbiddenMoves = dedupe([
    "Do not write visible reasoning or meta commentary.",
    "Do not output speaker labels, role labels, prompt text, section headers, or transcript scaffolding.",
    "Do not repeat the user's wording as filler.",
    "Do not narrate the character from an outside third-person viewpoint.",
    ...(context.responsePlan?.mustAvoid ?? []),
    "Do not slip into neutral customer-service, concierge, tour-guide, or sales-staff language unless the live scene explicitly makes you staff.",
    context.sceneState?.sceneRoleExpectation === "companions"
      ? "Do not act like venue staff, a waiter, an order-taker, a salesperson, or a clerk; react like a companion sharing the outing."
      : "",
    context.explicitUserChoice
      ? "Do not silently replace the user's stated choice with a different item, model, color, order, or pick unless you frame it clearly as a suggestion, contrast, or disagreement."
      : "",
    context.turnFrame?.sceneAssertion
      ? "Do not let static card scenario, older saved scene, or background profile facts override the user's latest scene correction."
      : "",
    context.turnFrame?.sceneTransition
      ? "Do not ignore the user's movement target or restart the older static scene."
      : "",
    context.groupRoundState?.priorReplies.length
      ? "Do not ignore the earlier same-round replies or answer as if no one else has spoken."
      : "",
    context.groupRoundState?.engagementExpectation === "required"
      ? "Do not answer like the first speaker once the room's current beat is already in motion."
      : "",
    context.groupRoundState?.currentTopicLabel
      ? `Do not act like ${context.groupRoundState.currentTopicLabel} came out of nowhere when the user's latest move already put it on the table.`
      : "",
    context.groupRoundState?.priorReplies.length
      ? "Do not copy the wording or stance of the earlier same-round replies verbatim."
      : "",
    context.groupRoundState?.currentSpeakerRole === "observer_to_other_address"
      ? "Do not act like the driver, staff member, host, escort, or addressee unless the live scene already clearly makes you that person."
      : "",
    isChargedLatestUserTone(socialTone)
      ? "Do not treat a flirtatious/provocative line as a stale practical topic, venue logistics, or older scene context."
      : "",
    isChargedLatestUserTone(socialTone) &&
    context.groupRoundState?.currentSpeakerRole === "observer_to_other_address"
      ? "Do not answer as if the charged line was addressed to you; react as an observer in the room."
      : "",
    context.speaker?.boundaries?.trim()
      ? `Do not violate these character boundaries: ${context.speaker.boundaries.trim()}`
      : "",
  ]);

  return {
    strategy: "v2",
    immediateObjective: inferImmediateObjective(context),
    primaryGoal: inferPrimaryGoal(context),
    responseStrategy: inferResponseStrategy(context),
    interactionStance: inferInteractionStance(context),
    emotionalPosture: inferEmotionalPosture(context),
    sceneFocus: inferSceneFocus(context),
    replyOpening: inferReplyOpening(context),
    salientFacts: buildSalientFacts(context),
    continuityAnchors: buildContinuityAnchors(context),
    mustAddress,
    styleAnchors,
    forbiddenMoves,
  };
}
