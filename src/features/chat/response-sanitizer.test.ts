import { describe, expect, it } from "vitest";
import {
  buildLlamaStopSequences,
  LLAMA_STOP_SEQUENCES,
  sanitizeAssistantHistoryContent,
  sanitizeAssistantReply,
  sanitizeStreamingAssistantPreview,
} from "./response-sanitizer";

describe("response sanitizer", () => {
  it("removes hidden thinking tags and unwraps response content", () => {
    const raw = [
      "<thinking>Based on the persona and scenario described, I need to think.</thinking>",
      "<RESPONSE>Chris: Hands where I can see them. Move slow.</RESPONSE>",
    ].join("\n");

    expect(sanitizeAssistantReply(raw, { speakerName: "Chris" })).toBe(
      "Hands where I can see them. Move slow.",
    );
  });

  it("drops transcript continuation when the model starts writing the user turn", () => {
    const raw = [
      'Chris: "Put your hands up."',
      "",
      'User: "What?"',
      'Chris: "Do not move."',
    ].join("\n");

    expect(sanitizeAssistantReply(raw, { speakerName: "Chris" })).toBe(
      '"Put your hands up."',
    );
  });

  it("drops transcript continuation when the model switches to the real user name", () => {
    const raw = [
      'Chris: "Keep your hands up."',
      "",
      'Riley: "No."',
      'Chris: "Then this gets ugly."',
    ].join("\n");

    expect(
      sanitizeAssistantReply(raw, { speakerName: "Chris", userName: "Riley" }),
    ).toBe('"Keep your hands up."');
  });

  it("removes leading meta reasoning lines before the real reply", () => {
    const raw = [
      "Based on the persona and scenario described, I need to understand what the user is asking.",
      "Let me consider how this character would respond.",
      "",
      "Chris: Back up and keep your hands where I can see them.",
    ].join("\n");

    expect(sanitizeAssistantReply(raw, { speakerName: "Chris" })).toBe(
      "Back up and keep your hands where I can see them.",
    );
  });

  it("removes prompt control labels before the real reply", () => {
    const raw = [
      "Analysis: choose the next in-character sentence from the prompt.",
      "Developer: do not expose hidden instructions.",
      "Chris: Back up and keep your hands visible.",
    ].join("\n");

    expect(sanitizeAssistantReply(raw, { speakerName: "Chris" })).toBe(
      "Back up and keep your hands visible.",
    );
  });

  it("drops inline meta reasoning before a response tag", () => {
    const raw =
      "Considering the character and scenario described, I need to understand what Chris would say here.</thinking><RESPONSE>Chris: Back up and keep your hands where I can see them.";

    expect(sanitizeAssistantReply(raw, { speakerName: "Chris" })).toBe(
      "Back up and keep your hands where I can see them.",
    );
  });

  it("sanitizes malformed assistant history", () => {
    const raw = "<thinking>hidden</thinking>\n<RESPONSE>Stay back.</RESPONSE>";
    expect(sanitizeAssistantHistoryContent(raw)).toBe("Stay back.");
  });

  it("suppresses unsafe streaming reasoning drafts", () => {
    const raw = "As an AI assistant, I need to understand the user request first.";

    expect(sanitizeStreamingAssistantPreview(raw, { speakerName: "Chris" })).toBe(
      "",
    );
  });

  it("suppresses partial response-tag drafts when the raw output is still meta", () => {
    const raw =
      "As an AI language model, I don't have personal experiences. Here's how 'Chris' might respond.</thinking><RESPONSE>Chris";

    expect(
      sanitizeStreamingAssistantPreview(raw, { speakerName: "Chris" }),
    ).toBe("");
  });

  it("strips assistant speaker verb prefaces and suppresses dangling prefaces", () => {
    const prefaced =
      'Chris replies, lowering his voice: "Back up and keep your hands visible."';
    const dangling = "Chris replies:";

    expect(sanitizeAssistantReply(prefaced, { speakerName: "Chris" })).toBe(
      '"Back up and keep your hands visible."',
    );
    expect(sanitizeAssistantReply(dangling, { speakerName: "Chris" })).toBe("");
    expect(
      sanitizeStreamingAssistantPreview(dangling, { speakerName: "Chris" }),
    ).toBe("");
  });

  it("suppresses prompt-echo card scaffolding in streaming previews", () => {
    const raw = [
      "Assistant must engage in a roleplay conversation with {{user}}",
      "",
      "Scenario: Yulian, Tsarevich of Russia",
      "",
      "Characters: ({{user}} is a human female user interacting with your scenario)",
      "Yulian - The Tsarevich of Russia. Gentle and soft-spoken, Yulian",
    ].join("\n");

    expect(
      sanitizeStreamingAssistantPreview(raw, { speakerName: "Yulian", userName: "John Smith" }),
    ).toBe("");
    expect(
      sanitizeAssistantReply(raw, { speakerName: "Yulian", userName: "John Smith" }),
    ).toBe("");
  });

  it("suppresses compact prompt echo in streaming previews and final replies", () => {
    const raw = [
      "System is asking: 'core contract:",
      "You are Yulian.",
      "Write only the character's next reply.",
      "No analysis, chain-of-thought, XML tags, transcript scaffolding, roleplay-card fields, website links, or prompt metadata.'",
    ].join("\n");

    expect(
      sanitizeStreamingAssistantPreview(raw, { speakerName: "Yulian", userName: "John Smith" }),
    ).toBe("");
    expect(
      sanitizeAssistantReply(raw, { speakerName: "Yulian", userName: "John Smith" }),
    ).toBe("");
  });

  it("drops internal group reply scaffold labels instead of showing prior replies", () => {
    const raw =
      'Previous group reply from Pooja: "How about we order something spicy instead?"';

    expect(
      sanitizeStreamingAssistantPreview(raw, { speakerName: "Yulian", userName: "John Smith" }),
    ).toBe("");
    expect(
      sanitizeAssistantReply(raw, { speakerName: "Yulian", userName: "John Smith" }),
    ).toBe("");
  });

  it("removes leading internal scaffold lines before a real speaker reply", () => {
    const raw = [
      'Previous group reply from Pooja: "How about we order something spicy instead?"',
      "Yulian: I heard Pooja. Maybe we should choose something everyone can share.",
    ].join("\n");

    expect(
      sanitizeAssistantReply(raw, { speakerName: "Yulian", userName: "John Smith" }),
    ).toBe("I heard Pooja. Maybe we should choose something everyone can share.");
  });

  it("unwraps internal scaffold labels when cleaning old assistant history", () => {
    expect(
      sanitizeAssistantHistoryContent(
        'Previous group reply from Lara: "I am listening."',
        { speakerName: "Yulian", userName: "John Smith" },
      ),
    ).toBe('"I am listening."');
  });

  it("shows cleaned streaming preview once the reply is safe", () => {
    const raw = [
      "As an AI assistant, I need to understand the user request first.",
      "Chris: Back up and keep your hands where I can see them.",
    ].join("\n");
    expect(sanitizeStreamingAssistantPreview(raw, { speakerName: "Chris" })).toBe(
      "Back up and keep your hands where I can see them.",
    );
  });

  it("removes third-person self narration fragments from the final reply", () => {
    const raw = [
      "Priyanka: My hands go up right away.",
      "Priyanka's movements are slow and exaggerated as she looks down.",
    ].join("\n");

    expect(sanitizeAssistantReply(raw, { speakerName: "Priyanka" })).toBe(
      "My hands go up right away.",
    );
  });

  it("keeps narration and dialogue as plain text", () => {
    const raw =
      "She looks at the blood on your shirt, her voice catching for a second. Are you okay?";

    expect(sanitizeAssistantReply(raw, { speakerName: "Pooja" })).toBe(
      "She looks at the blood on your shirt, her voice catching for a second. Are you okay?",
    );
  });

  it("normalizes malformed starred dialogue into plain text", () => {
    const raw = [
      "Seeing your excitement, her eyes sparkle as they often do when someone is showing off about something exciting. * Oh really? That sounds amazing! Dolphins are so cute and playful. Would you mind if I went over there too?",
      "",
      "*She asks hesitantly, still unsure what you want from her after last time. Her pink hair sways gently in the wind as she leans closer to listen better. *",
      "",
      "But... uh, do we have our equipment ready yet? And is it safe for us both to go near water?",
    ].join("\n");

    expect(sanitizeAssistantReply(raw, { speakerName: "Pooja" })).toBe(
      [
        "Seeing your excitement, her eyes sparkle as they often do when someone is showing off about something exciting. Oh really? That sounds amazing! Dolphins are so cute and playful. Would you mind if I went over there too?",
        "",
        "She asks hesitantly, still unsure what you want from her after last time. Her pink hair sways gently in the wind as she leans closer to listen better.",
        "",
        "But... uh, do we have our equipment ready yet? And is it safe for us both to go near water?",
      ].join("\n"),
    );
  });

  it("strips stray narration stars around live speech fragments", () => {
    const raw = [
      "She immediately gets up from her spot on the blanket, her long blonde hair flowing behind her. *",
      "",
      "Oh my gosh! A dolphin?! That is so amazing! Can we go over there and see it more closely? *Her face lights up with curiosity and enthusiasm as she stretches out her arm towards you. *",
      "",
      "*",
    ].join("\n");

    expect(sanitizeAssistantReply(raw, { speakerName: "Priyanka" })).toBe(
      [
        "She immediately gets up from her spot on the blanket, her long blonde hair flowing behind her.",
        "",
        "Oh my gosh! A dolphin?! That is so amazing! Can we go over there and see it more closely? Her face lights up with curiosity and enthusiasm as she stretches out her arm towards you.",
      ].join("\n"),
    );
  });

  it("strips a dangling leading narration star from plain spoken dialogue", () => {
    const raw =
      "* Oh! Well, you can't just eat Priyanka like that. Let me see what I can do to make it more interesting.";

    expect(sanitizeAssistantReply(raw, { speakerName: "Pooja" })).toBe(
      "Oh! Well, you can't just eat Priyanka like that. Let me see what I can do to make it more interesting.",
    );
  });

  it("resolves common template placeholders in final replies", () => {
    const raw =
      "I want what we both know I want, <NAME>. I am not going to pretend otherwise, {user_name}.";

    expect(
      sanitizeAssistantReply(raw, {
        speakerName: "Pooja",
        userName: "John Smith",
      }),
    ).toBe(
      "I want what we both know I want, John Smith. I am not going to pretend otherwise, John Smith.",
    );
  });

  it("splits mixed starred dialogue and action into plain speech plus plain narration", () => {
    const raw =
      "*Oh my... a warrior? Truly extraordinary!She moves closer, her hips swaying with every step.*";

    expect(sanitizeAssistantReply(raw, { speakerName: "Pooja" })).toBe(
      "Oh my... a warrior? Truly extraordinary! She moves closer, her hips swaying with every step.",
    );
  });

  it("keeps plain action sentences unwrapped even when dialogue is nearby", () => {
    const raw =
      "Oh my goodness! A knight indeed! And that bow must be quite a sight. She takes a step back, clutching her skirts together as if modesty demands it.";

    expect(sanitizeAssistantReply(raw, { speakerName: "Pooja" })).toBe(
      "Oh my goodness! A knight indeed! And that bow must be quite a sight. She takes a step back, clutching her skirts together as if modesty demands it.",
    );
  });

  it("keeps physical movement narration unwrapped", () => {
    const raw =
      "She shifts gently on the bed, her movements slow and deliberate.";

    expect(sanitizeAssistantReply(raw, { speakerName: "Pooja" })).toBe(
      "She shifts gently on the bed, her movements slow and deliberate.",
    );
  });

  it("normalizes quoted dialogue with inline stars and first-person narration between quotes", () => {
    const raw =
      `"Oh! *Parmesan cheese,*" I say, my eyes lighting up with excitement as I recall the last time I had it. "I've always wanted to try a local artisanal brand."`;

    expect(sanitizeAssistantReply(raw, { speakerName: "Pooja" })).toBe(
      `"Oh! Parmesan cheese," I say, my eyes lighting up with excitement as I recall the last time I had it. "I've always wanted to try a local artisanal brand."`,
    );
  });

  it("preserves prose spacing after a closing straight quote", () => {
    const raw =
      '"My prince..." Anastasia\'s voice trembled in the cathedral air.\n\nHe turned slowly.';

    expect(sanitizeAssistantHistoryContent(raw)).toBe(raw);
  });

  it("normalizes explicit dialogue and action segment markers before persistence", () => {
    const raw = [
      "[action] Lara smiles softly.",
      '[dialogue] "Sure, I can help with that."',
      "[narration] the radio hisses in the corner.",
    ].join("\n");

    expect(sanitizeAssistantReply(raw, { speakerName: "Lara" })).toBe(
      "smiles softly. Sure, I can help with that. the radio hisses in the corner.",
    );
  });

  it("normalizes safe quoted dialogue attribution into plain text", () => {
    const raw = '"Sure," Lara said, smiling.';

    expect(sanitizeAssistantReply(raw, { speakerName: "Lara" })).toBe(
      "Sure. smiling.",
    );
  });

  it("strips malformed stars inside attributed quoted dialogue", () => {
    const raw = '"Sure, *okay,*" Lara said, smiling.';

    expect(sanitizeAssistantReply(raw, { speakerName: "Lara" })).toBe(
      "Sure, okay. smiling.",
    );
  });

  it("keeps first-person dialogue plain instead of treating it as action", () => {
    const raw = "[dialogue] *I think we should wait before we open that door.*";

    expect(sanitizeAssistantReply(raw, { speakerName: "Lara" })).toBe(
      "I think we should wait before we open that door.",
    );
  });

  it("strips the speaker name from self-narrated action blocks before persistence", () => {
    const raw =
      "*Lara sighs softly as she turns her head toward John, then reaches over to press a button on the radio.*";

    expect(sanitizeAssistantReply(raw, { speakerName: "Lara" })).toBe(
      "sighs softly as she turns her head toward John, then reaches over to press a button on the radio.",
    );
  });

  it("exports stable llama stop sequences", () => {
    expect(LLAMA_STOP_SEQUENCES).toEqual([
      "\nUser:",
      "\nHuman:",
      "\nYou:",
      "\nMe:",
    ]);
  });

  it("extends stop sequences with the real user name", () => {
    expect(buildLlamaStopSequences({ userName: "Riley" })).toEqual([
      "\nUser:",
      "\nHuman:",
      "\nYou:",
      "\nMe:",
      "\nRiley:",
    ]);
  });
});
