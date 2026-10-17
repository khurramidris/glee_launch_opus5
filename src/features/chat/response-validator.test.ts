import { describe, expect, it } from "vitest";
import {
  buildCharacterReplyRepairInstruction,
  shouldSuppressStreamingPreview,
  shouldRetryCharacterReply,
} from "./response-validator";

describe("response validator", () => {
  it("requests a retry for meta reasoning", () => {
    expect(
      shouldRetryCharacterReply({
        reply: "As an AI assistant, I need to understand the request first.",
        speakerName: "Priyanka",
      }),
    ).toBe(true);
  });

  it("requests a retry for third-person self narration", () => {
    expect(
      shouldRetryCharacterReply({
        reply: "Priyanka's movements are slow and exaggerated as she looks down.",
        speakerName: "Priyanka",
      }),
    ).toBe(true);
  });

  it("requests a retry for direct user echo", () => {
    expect(
      shouldRetryCharacterReply({
        reply: "Put your hands up. Do not move.",
        speakerName: "Chris",
        latestUserMessage: "Put your hands up. Do not move.",
      }),
    ).toBe(true);
  });

  it('requests a retry when the reply refers to the person as "the user"', () => {
    expect(
      shouldRetryCharacterReply({
        reply: "She struggles against the user's grip and tries to break free.",
        speakerName: "Pooja",
        userName: "Sam",
      }),
    ).toBe(true);
  });

  it("requests a retry when the reply scripts the user's speech or body", () => {
    expect(
      shouldRetryCharacterReply({
        reply:
          '"Oh please, don\'t be so embarrassed," you say, your body tensing as you pull her closer.',
        speakerName: "Pooja",
        userName: "Sam",
      }),
    ).toBe(true);
  });

  it("suppresses named user transcript leakage", () => {
    expect(
      shouldSuppressStreamingPreview({
        reply: 'Riley: "Stay down."\nChris: Fine.',
        speakerName: "Chris",
        userName: "Riley",
      }),
    ).toBe(true);
  });

  it("allows a direct but original in-character reply", () => {
    expect(
      shouldRetryCharacterReply({
        reply: "Easy. I'm moving, but not because you scare me.",
        speakerName: "Chris",
        latestUserMessage: "Put your hands up.",
      }),
    ).toBe(false);
  });

  it("suppresses third-person streaming previews", () => {
    expect(
      shouldSuppressStreamingPreview({
        reply: "Priyanka's hands lift slowly while she looks down.",
        speakerName: "Priyanka",
      }),
    ).toBe(true);
  });

  it("builds a corrective instruction that forces first-person repair", () => {
    const instruction = buildCharacterReplyRepairInstruction({
      speakerName: "Priyanka",
      userName: "Riley",
      userGender: "Man",
      latestUserMessage: "Put your hands up.",
      turnInterpretation: {
        actionType: "command",
        intent: "The user is directing the character to do something immediately.",
        emotionalPressure: "medium",
        requiresImmediateReaction: true,
        antiParrotDirective:
          "Treat the line as an action to respond to. Do not repeat the command unless intentionally quoting it.",
      },
      reactionPlan: {
        strategy: "v2",
        immediateObjective: "React to the order directly.",
        primaryGoal: "Make Priyanka's choice under the command legible.",
        responseStrategy: "Show how Priyanka responds instead of mirroring the words.",
        interactionStance: "Present and responsive.",
        emotionalPosture: "present and responsive",
        sceneFocus: "the user's direct order",
        replyOpening: "Open with Priyanka's answer to the command itself.",
        salientFacts: ["Power dynamic: The user is directing Priyanka right now."],
        continuityAnchors: [],
        mustAddress: ["The user is issuing an immediate command."],
        styleAnchors: [],
        forbiddenMoves: [],
      },
    });

    expect(instruction).toContain("Respond in first person as Priyanka");
    expect(instruction).toContain("Do not write any dialogue, actions, inner thoughts, or transcript lines for Riley.");
    expect(instruction).toContain("Do not script the user's bodily reactions");
    expect(instruction).toContain('Do not call Riley "the user".');
    expect(instruction).toContain("Do not write lines like '... you say'");
    expect(instruction).toContain("he/him/his");
    expect(instruction).toContain("Put your hands up.");
    expect(instruction).toContain("Detected move type: command");
    expect(instruction).toContain("Immediate objective: React to the order directly.");
    expect(instruction).toContain("Primary goal: Make Priyanka's choice under the command legible.");
    expect(instruction).toContain("Opening move: Open with Priyanka's answer to the command itself.");
  });
});
