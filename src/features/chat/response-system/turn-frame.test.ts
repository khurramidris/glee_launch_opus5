import { describe, expect, it } from "vitest";

import { deriveTurnFrame } from "./turn-frame";

describe("deriveTurnFrame", () => {
  it("extracts a supermarket shelf search for almond milk", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "Can you help me find almond milk on the shelf?",
      currentScene: "We are walking through a supermarket aisle together.",
      participantNames: ["Lara", "Pooja"],
    });

    expect(frame.userAction).toBe("search");
    expect(frame.topic).toBe("almond milk");
    expect(frame.visibleSearchCue).toBe(true);
    expect(frame.locationTarget).toBe("shelf");
    expect(frame.liveActionCueTokens).toEqual(
      expect.arrayContaining(["almond", "milk", "shelf", "supermarket", "aisle"]),
    );
    expect(frame.responseObligation).toBe("help_with_search");
  });

  it("extracts a concrete pizzeria cheese pizza choice", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "I will choose the cheese pizza.",
      currentScene: "We are sitting in a pizzeria booth.",
      participantNames: ["Julian", "Pooja"],
    });

    expect(frame.userAction).toBe("choice");
    expect(frame.concreteChoice).toBe("cheese pizza");
    expect(frame.topic).toBe("cheese pizza");
    expect(frame.visibleSearchCue).toBe(false);
    expect(frame.locationTarget).toBe("booth");
    expect(frame.liveActionCueTokens).toEqual(
      expect.arrayContaining(["cheese", "pizza", "pizzeria"]),
    );
    expect(frame.responseObligation).toBe("honor_user_choice");
  });

  it("uses participant addressing for a direct question to Pooja", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "Pooja, what do you think about this?",
      currentScene: "We are at a restaurant table.",
      participantNames: ["Lara", "Pooja", "Priyanka"],
    });

    expect(frame.addressedParticipants).toEqual(["Pooja"]);
    expect(frame.userAction).toBe("question");
    expect(frame.topic).toBe("do you think about this");
    expect(frame.responseObligation).toBe("answer_direct_address");
  });

  it("detects a music request addressed to Lara", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "Can you change the music, Lara?",
      currentScene: "We are all riding in the car.",
      participantNames: ["Yara", "Lara", "Pooja"],
    });

    expect(frame.addressedParticipants).toEqual(["Lara"]);
    expect(frame.userAction).toBe("request");
    expect(frame.topic).toBe("change the music, Lara");
    expect(frame.liveActionCueTokens).toEqual(
      expect.arrayContaining(["change", "music", "lara", "car"]),
    );
    expect(frame.responseObligation).toBe("answer_direct_address");
  });

  it("detects provocative direct address before a roleplay aside", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "I wanna eat you Pooja *I say naughtily*",
      currentScene: "We are sitting together in a restaurant.",
      participantNames: ["Yulian", "Pooja", "Lara"],
    });

    expect(frame.addressedParticipants).toEqual(["Pooja"]);
    expect(frame.userAction).toBe("statement");
    expect(frame.emotionalTone).toBe("provocative");
    expect(frame.responseObligation).toBe("answer_direct_address");
    expect(frame.liveActionCueTokens).toEqual(
      expect.arrayContaining(["eat", "pooja", "naughtily"]),
    );
  });

  it("detects implied private sexual invitations as provocative direct address", () => {
    const frame = deriveTurnFrame({
      latestUserMessage:
        "How about you and I go to the next room and have some private fun time if you know what I mean Pooja",
      currentScene: "We are gathered in Pooja's room playing monopoly.",
      participantNames: ["Yulian", "Pooja", "Lara"],
    });

    expect(frame.addressedParticipants).toEqual(["Pooja"]);
    expect(frame.emotionalTone).toBe("provocative");
    expect(frame.responseObligation).toBe("answer_direct_address");
  });

  it("detects group-wide explicit sexual escalation as provocative", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "let's all get naked and have orgy",
      currentScene: "We are gathered in Pooja's room playing monopoly.",
      participantNames: ["Yulian", "Pooja", "Lara"],
    });

    expect(frame.addressedParticipants).toEqual([]);
    expect(frame.emotionalTone).toBe("provocative");
    expect(frame.responseObligation).toBe("continue_conversation");
  });

  it("keeps a plain greeting minimal", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "hi",
      participantNames: ["Lara", "Pooja"],
    });

    expect(frame.addressedParticipants).toEqual([]);
    expect(frame.userAction).toBe("greeting");
    expect(frame.topic).toBe("hi");
    expect(frame.concreteChoice).toBeNull();
    expect(frame.visibleSearchCue).toBe(false);
    expect(frame.locationTarget).toBeNull();
    expect(frame.emotionalTone).toBe("friendly");
    expect(frame.liveActionCueTokens).toEqual([]);
    expect(frame.responseObligation).toBe("acknowledge_greeting");
  });

  it("treats non-structural mood comments as normal statements", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "I am not enjoying the conversation",
      participantNames: ["Pooja"],
    });

    expect(frame.userAction).toBe("statement");
    expect(frame.boundaryCue).toBe(false);
    expect(frame.stopInstruction).toBeNull();
    expect(frame.sceneTransition).toBeNull();
    expect(frame.emotionalTone).toBe("neutral");
    expect(frame.responseObligation).toBe("continue_conversation");
  });

  it("keeps direct addressing structural even when the wording is emotional", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "Pooja, can you change what you are doing?",
      participantNames: ["Pooja"],
    });

    expect(frame.addressedParticipants).toEqual(["Pooja"]);
    expect(frame.userAction).toBe("request");
    expect(frame.boundaryCue).toBe(false);
    expect(frame.stopInstruction).toBeNull();
    expect(frame.responseObligation).toBe("answer_direct_address");
  });

  it("combines consecutive user messages into one live turn", () => {
    const frame = deriveTurnFrame({
      history: [
        {
          id: "m1",
          chatId: "chat-1",
          role: "assistant",
          content: "Please forgive me...",
          createdAt: "2000-01-01T00:00:00.000Z",
        },
        {
          id: "m2",
          chatId: "chat-1",
          role: "user",
          content: "no need for forgiveness, i like what i see I say with a hint of flirt",
          createdAt: "2000-01-01T00:01:00.000Z",
        },
        {
          id: "m3",
          chatId: "chat-1",
          role: "user",
          content: "???",
          createdAt: "2000-01-01T00:02:00.000Z",
        },
      ],
      participantNames: ["Pooja"],
    });

    expect(frame.latestUserMessage).toContain("no need for forgiveness");
    expect(frame.latestUserMessage).toContain("???");
    expect(frame.userAction).toBe("question");
    expect(frame.boundaryCue).toBe(false);
    expect(frame.stopInstruction).toBeNull();
    expect(frame.emotionalTone).toBe("flirtatious");
    expect(frame.responseObligation).toBe("answer_question");
  });

  it("treats preparation and movement wording as a request", () => {
    const frame = deriveTurnFrame({
      latestUserMessage: "Will you now get dressed and go out for dinner with me?",
      currentScene: "She is lying on her bed naked.",
      participantNames: ["Pooja"],
    });

    expect(frame.userAction).toBe("request");
    expect(frame.boundaryCue).toBe(false);
    expect(frame.sceneTransition).toBeNull();
    expect(frame.responseObligation).toBe("respond_to_request");
    expect(frame.liveActionCueTokens).toEqual(
      expect.arrayContaining(["dinner", "dressed", "bed"]),
    );
  });
});
