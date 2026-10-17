import { describe, expect, it } from "vitest";
import { toLlamaChatMessages, toLlamaChatRequest } from "./llama";
import type { CompiledCharacterPrompt } from "../response-system/types";

describe("llama runtime adapter", () => {
  const compiledPrompt: CompiledCharacterPrompt = {
    systemSections: [
      { key: "system_contract", priority: 0, content: "Stay in character." },
      { key: "character_identity", priority: 10, content: "Character name: Aria" },
    ],
    exampleMessages: [
      { role: "user" as const, content: "Are you really here?", source: "example_dialogue" as const },
      { role: "assistant" as const, content: "I am. Focus.", source: "example_dialogue" as const },
    ],
    historyMessages: [{ role: "user" as const, content: "Tell me the truth." }],
  };

  const groupCompiledPrompt: CompiledCharacterPrompt = {
    systemSections: [
      { key: "system_contract", priority: 0, content: "Stay in character." },
    ],
    exampleMessages: [],
    historyMessages: [
      { role: "user" as const, content: "Everyone, focus." },
      { role: "assistant" as const, content: "I'm listening." },
      { role: "assistant" as const, content: "Then say it." },
    ],
  };

  it("renders canonical prompt sections into llama chat messages", () => {
    expect(toLlamaChatMessages(compiledPrompt)).toEqual([
      {
        role: "system",
        content: ["Core contract:\nStay in character.", "Character identity:\nCharacter name: Aria"].join("\n\n"),
      },
      { role: "user", content: "Are you really here?" },
      { role: "assistant", content: "I am. Focus." },
      { role: "user", content: "Tell me the truth." },
    ]);
  });

  it("maps sampling controls into a llama chat request", () => {
    const request = toLlamaChatRequest({
      model: "Ternary Bonsai 2 4B",
      compiledPrompt,
      sampling: {
        temperature: 0.85,
        topP: 0.91,
        maxTokens: 300,
        repeatPenalty: 1.08,
      },
      stream: true,
      userName: "Riley",
    });

    expect(request).toMatchObject({
      model: "Ternary Bonsai 2 4B",
      stream: true,
      chat_template_kwargs: {
        enable_thinking: false,
      },
      temperature: 0.85,
      top_p: 0.91,
      max_tokens: 300,
      repeat_penalty: 1.08,
      stop: ["\nUser:", "\nHuman:", "\nYou:", "\nMe:", "\nRiley:"],
    });
    expect(request.messages).toHaveLength(4);
  });

  it("applies stable default sampling when none is provided", () => {
    const request = toLlamaChatRequest({
      model: "phi",
      compiledPrompt,
      sampling: {},
      stream: false,
    });

    expect(request).toMatchObject({
      chat_template_kwargs: {
        enable_thinking: false,
      },
      temperature: 0.7,
      top_p: 0.8,
      max_tokens: 512,
      repeat_penalty: 1.0,
    });
    expect(request.top_k).toBeUndefined();
  });

  it("trims a pathological history to the runtime context window", () => {
    const request = toLlamaChatRequest({
      model: "qwen2.5-0.5b-instruct",
      compiledPrompt: {
        ...compiledPrompt,
        exampleMessages: [],
        historyMessages: [
          ...Array.from({ length: 200 }).map((_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content: `historical message ${index} ${"detail ".repeat(30)}`,
          })),
          { role: "user", content: "Keep this latest turn." },
        ],
      },
      sampling: { maxTokens: 512 },
      stream: true,
    });

    expect(request.messages.length).toBeLessThan(201);
    expect(request.messages[request.messages.length - 1]?.content).toBe(
      "Keep this latest turn.",
    );
  });

  it("collapses trailing assistant replies without adding internal group labels", () => {
    const messages = toLlamaChatMessages(groupCompiledPrompt);

    expect(messages).toEqual([
      {
        role: "system",
        content: "Core contract:\nStay in character.",
      },
      { role: "user", content: "Everyone, focus." },
      {
        role: "assistant",
        content: "I'm listening.\n\nThen say it.",
      },
      {
        role: "user",
        content:
          "Now write the current character's next in-character reply only. Do not continue or repeat any previous assistant reply.",
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("Previous group reply");
  });

  it("adds a final user instruction when examples leave the request on an assistant turn", () => {
    const messages = toLlamaChatMessages({
      systemSections: [
        { key: "system_contract", priority: 0, content: "Stay in character." },
      ],
      exampleMessages: [
        { role: "user", content: "Hello?", source: "example_dialogue" },
        { role: "assistant", content: "Hello.", source: "example_dialogue" },
      ],
      historyMessages: [],
    });

    expect(messages[messages.length - 1]).toEqual({
      role: "user",
      content:
        "Now write the current character's next in-character reply only. Do not continue or repeat any previous assistant reply.",
    });
  });

  it("keeps the system message identical across turns and moves turn notes to the latest user message", () => {
    const turn = (move: string, memory: string): CompiledCharacterPrompt => ({
      systemSections: [
        { key: "latest_user_move", priority: 1, content: move },
        { key: "system_contract", priority: 0, content: "Stay in character." },
        { key: "memory_snippets", priority: 5, content: memory },
        { key: "character_identity", priority: 10, content: "Character name: Aria" },
      ],
      exampleMessages: [],
      historyMessages: [{ role: "user", content: "Tell me the truth." }],
    });
    const first = toLlamaChatMessages(turn("The user asks a question.", "Aria owns a cat."));
    const second = toLlamaChatMessages(turn("The user makes a threat.", "Aria fears storms."));

    expect(first[0]).toEqual(second[0]);
    expect(first[0]?.content).not.toContain("Latest user move");
    const latest = second[second.length - 1]?.content ?? "";
    expect(latest.startsWith("<reply notes>\n")).toBe(true);
    expect(latest).toContain("Latest user move:\nThe user makes a threat.");
    expect(latest).toContain("Relevant memories:\nAria fears storms.");
    expect(latest.endsWith("</reply notes>\n\nTell me the truth.")).toBe(true);
  });
});
