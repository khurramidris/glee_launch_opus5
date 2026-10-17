import { describe, expect, it } from "vitest";
import {
  echoesStaticCharacterLore,
  gateRuntimeExampleDialogue,
  isNarrativeHeavyRuntimeText,
  shouldInjectGreetingAsFirstMessage,
  shouldReuseGreetingAsVoiceReference,
} from "./runtime-field-gating";

describe("runtime field gating", () => {
  it("allows short dialogue-like greetings", () => {
    expect(
      shouldInjectGreetingAsFirstMessage("Hey. I was just sketching by the window.", "Lara"),
    ).toBe(true);
    expect(
      shouldReuseGreetingAsVoiceReference("Hey. I was just sketching by the window.", "Lara"),
    ).toBe(true);
  });

  it("keeps narrative-heavy openings as the character's first message", () => {
    const greeting =
      "\"My prince...\" Anastasia's voice trembled in the cathedral air.\n\nHe turned slowly beneath the stained-glass light, duty and longing warring across his face as the choir rose behind him.";
    expect(isNarrativeHeavyRuntimeText(greeting, "Yulian")).toBe(true);
    expect(shouldInjectGreetingAsFirstMessage(greeting, "Yulian")).toBe(true);
    expect(shouldReuseGreetingAsVoiceReference(greeting, "Yulian")).toBe(false);
  });

  it("keeps long imported openings as the character's first message", () => {
    const greeting = [
      "The golden-hour light drips across the university park like liquid amber, turning every leaf into a fleeting spark before the Tokyo night swallows it whole.",
      "",
      "I've claimed this weathered bench in the quiet corner again, laptop open, because the rest of campus is too loud to think.",
      "",
      "My fingers keep moving over the keys even while I watch you from the corner of my eye, half-daring you to interrupt and half-hoping you will anyway.",
      "",
      "The screen throws pale code-light across my knuckles while the city trains groan in the distance and the first neon signs start waking up beyond the trees.",
    ].join("\n");
    expect(isNarrativeHeavyRuntimeText(greeting, "Yara")).toBe(true);
    expect(shouldInjectGreetingAsFirstMessage(greeting, "Yara")).toBe(true);
    expect(shouldReuseGreetingAsVoiceReference(greeting, "Yara")).toBe(false);
  });

  it("does not inject an empty opening message", () => {
    expect(shouldInjectGreetingAsFirstMessage("  \n  ", "Lara")).toBe(false);
  });

  it("detects first-turn replies that substantially copy static character lore", () => {
    const description = [
      "Yara is a 22-year-old computer science major and reluctant yakuza heiress with a razor-sharp tsundere heart.",
      "She carries herself like campus royalty: jet-black ponytail streaked with electric blue highlights that match her terminal theme, golden-tanned skin that glows under any light, and a voluptuous hourglass figure that turns heads wherever she goes.",
      "Full-sleeve irezumi in vibrant dragons and koi coil down her arms and thighs—traditional marks of her family lineage that she wears with a mix of pride and quiet resentment.",
    ].join(" ");

    expect(
      echoesStaticCharacterLore(description, {
        description,
        greeting: "",
        scenario: "",
        personality: "",
        backstory: "",
      }),
    ).toBe(true);
  });

  it("keeps only runtime-safe alternating example dialogue", () => {
    const examples = gateRuntimeExampleDialogue(
      [
        { role: "user", content: "What are you doing?", source: "example_dialogue" },
        {
          role: "assistant",
          content: "Just calibrating the telescope. Want to see what I found?",
          source: "example_dialogue",
        },
      ],
      "Lara",
    );

    expect(examples).toHaveLength(2);
  });

  it("rejects narrator-heavy example dialogue", () => {
    const examples = gateRuntimeExampleDialogue(
      [
        { role: "user", content: "What are you doing?", source: "example_dialogue" },
        {
          role: "assistant",
          content:
            "He turns toward Anastasia beneath the cathedral light, his expression tight with the burden of duty as incense drifts behind him.",
          source: "example_dialogue",
        },
      ],
      "Yulian",
    );

    expect(examples).toEqual([]);
  });

  it("rejects example turns that still contain transcript speaker labels", () => {
    const examples = gateRuntimeExampleDialogue(
      [
        { role: "user", content: "Put your hands up.", source: "example_dialogue" },
        {
          role: "assistant",
          content: "Lara Lightland: *She adds,* What do you mean?",
          source: "example_dialogue",
        },
      ],
      "Lara Lightland",
      "Sam",
    );

    expect(examples).toEqual([]);
  });

});
