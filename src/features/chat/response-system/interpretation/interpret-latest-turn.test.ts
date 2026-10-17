import { describe, expect, it } from "vitest";

import { interpretLatestUserTurn } from "./interpret-latest-turn";

function userMessage(content: string) {
  return {
    id: "user-1",
    chatId: "chat-1",
    role: "user" as const,
    content,
    createdAt: "2000-04-30T00:00:00.000Z",
  };
}

function assistantMessage(content: string) {
  return {
    id: "assistant-1",
    chatId: "chat-1",
    role: "assistant" as const,
    content,
    createdAt: "2000-04-30T00:00:00.000Z",
  };
}

describe("interpretLatestUserTurn", () => {
  it("treats a short direct greeting as an immediate-reaction turn", () => {
    const interpretation = interpretLatestUserTurn({
      history: [userMessage("hey")],
    });

    expect(interpretation).not.toBeNull();
    expect(interpretation?.actionType).toBe("greeting");
    expect(interpretation?.requiresImmediateReaction).toBe(true);
    expect(interpretation?.antiParrotDirective).toContain("Do not act as if the user stayed silent");
  });

  it("treats general statements as immediate-reaction turns without semantic phrase rules", () => {
    const interpretation = interpretLatestUserTurn({
      history: [userMessage("this is not working for me")],
    });

    expect(interpretation).not.toBeNull();
    expect(interpretation?.actionType).toBe("statement");
    expect(interpretation?.requiresImmediateReaction).toBe(true);
    expect(interpretation?.intent).toContain("statement");
    expect(interpretation?.antiParrotDirective).toContain("character-shaped response");
  });

  it("does not classify social-content examples as special boundary intents", () => {
    const interpretation = interpretLatestUserTurn({
      history: [userMessage("why are you acting this way")],
    });

    expect(interpretation).not.toBeNull();
    expect(interpretation?.actionType).toBe("question");
    expect(interpretation?.requiresImmediateReaction).toBe(true);
    expect(interpretation?.intent).toContain("answer");
  });

  it("keeps an unanswered user follow-up attached to the previous user move", () => {
    const interpretation = interpretLatestUserTurn({
      history: [
        assistantMessage("Please forgive me..."),
        userMessage("no need for forgiveness, i like what i see I say with a hint of flirt"),
        userMessage("???"),
      ],
    });

    expect(interpretation).not.toBeNull();
    expect(interpretation?.actionType).toBe("question");
    expect(interpretation?.requiresImmediateReaction).toBe(true);
    expect(interpretation?.antiParrotDirective).toContain("Answer or react directly");
  });

  it("uses a trailing question mark as structural question signal", () => {
    const interpretation = interpretLatestUserTurn({
      history: [userMessage("i like what i see I say with a hint of flirt ???")],
    });

    expect(interpretation).not.toBeNull();
    expect(interpretation?.actionType).toBe("question");
    expect(interpretation?.requiresImmediateReaction).toBe(true);
  });

  it("treats preparation and movement requests as structural requests", () => {
    const interpretation = interpretLatestUserTurn({
      history: [userMessage("Will you now get dressed and go out for dinner with me?")],
    });

    expect(interpretation).not.toBeNull();
    expect(interpretation?.actionType).toBe("question");
    expect(interpretation?.requiresImmediateReaction).toBe(true);
    expect(interpretation?.intent).toContain("answer");
  });
});
