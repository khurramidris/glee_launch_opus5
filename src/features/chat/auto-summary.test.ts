import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoSummaryBatch, ChatMemory, ChatMessage } from "../../types";

const mocks = vi.hoisted(() => ({
  getAutoSummaryBatch: vi.fn(),
  storeAutoSummary: vi.fn(),
  runtimeFetch: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  getAutoSummaryBatch: mocks.getAutoSummaryBatch,
  storeAutoSummary: mocks.storeAutoSummary,
}));

vi.mock("../../lib/runtime-fetch", () => ({
  runtimeFetch: mocks.runtimeFetch,
}));

import { chatStore } from "../../stores/chat-store";
import { modelStore } from "../../stores/model-store";
import {
  AUTO_SUMMARY_MIN_INTERVAL_MS,
  buildAutoSummaryPrompt,
  maybeUpdateAutoSummary,
  resetAutoSummaryState,
  sanitizeAutoSummary,
} from "./auto-summary";

function message(index: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${index}`,
    chatId: "chat-1",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
    createdAt: "2000-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function batch(overrides: Partial<AutoSummaryBatch> = {}): AutoSummaryBatch {
  return {
    chatId: "chat-1",
    historyEpoch: 3,
    writable: true,
    previousSummary: "Earlier they met at the harbor.",
    summarizedThroughMessageId: null,
    pendingCount: 13,
    messages: Array.from({ length: 13 }, (_, index) => message(index)),
    ...overrides,
  };
}

function completion(content: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const storedMemory: ChatMemory = {
  chatId: "chat-1",
  summary: "They met at the harbor and agreed to sail at dawn.",
  summaryAuto: true,
  summarizedThroughMessageId: "msg-12",
  facts: [],
  updatedAt: "2000-01-01T00:00:00.000Z",
};

describe("sanitizeAutoSummary", () => {
  it("removes reasoning blocks, including an unterminated one", () => {
    expect(
      sanitizeAutoSummary("<think>plan the answer</think>Mara promised to return the lantern."),
    ).toBe("Mara promised to return the lantern.");
    expect(sanitizeAutoSummary("Mara promised to return the lantern. <think>still going")).toBe(
      "Mara promised to return the lantern.",
    );
  });

  it("strips quotes, labels, and markdown into one paragraph", () => {
    const raw = '"Summary: **Mara** and _Ilan_ share a secret.\n\n- She keeps the `lantern`.\n- He owes a favor."';
    expect(sanitizeAutoSummary(raw)).toBe(
      "Mara and Ilan share a secret. She keeps the lantern. He owes a favor.",
    );
  });

  it("drops headings and code fences", () => {
    expect(sanitizeAutoSummary("# Summary\n```\nnoise\n```\nThey agreed to meet at the old mill.")).toBe(
      "They agreed to meet at the old mill.",
    );
  });

  it("caps length at a sentence boundary", () => {
    const sentence = "The two of them keep walking through the old orchard together. ";
    const result = sanitizeAutoSummary(sentence.repeat(40));
    expect(result.length).toBeLessThanOrEqual(1200);
    expect(result.endsWith(".")).toBe(true);
  });

  it("drops a partial trailing sentence when the model ran out of tokens", () => {
    expect(
      sanitizeAutoSummary("Mara trusts Ilan with the key. She then decided to", {
        truncated: true,
      }),
    ).toBe("Mara trusts Ilan with the key.");
  });

  it("rejects output too short to be a summary", () => {
    expect(sanitizeAutoSummary("<think>nothing</think>Ok.")).toBe("");
    expect(sanitizeAutoSummary("   ")).toBe("");
  });
});

describe("buildAutoSummaryPrompt", () => {
  it("labels speakers and includes the previous summary", () => {
    const prompt = buildAutoSummaryPrompt(
      "",
      [
        message(0),
        message(1, { speakerCharacterId: "char-b" }),
        message(2, { role: "assistant" }),
      ],
      {
        chatId: "chat-1",
        userName: "Ilan",
        characterName: "Mara",
        participantDirectory: { "char-b": "Corvin" },
      },
    );
    expect(prompt[0]?.content).toContain("120 words max, plain prose, no lists");
    const body = prompt[1]?.content ?? "";
    expect(body).toContain("Previous summary:\n(none yet)");
    expect(body).toContain("Ilan: message 0\nCorvin: message 1\nMara: message 2");
  });
});

describe("maybeUpdateAutoSummary", () => {
  beforeEach(() => {
    resetAutoSummaryState();
    mocks.getAutoSummaryBatch.mockReset();
    mocks.storeAutoSummary.mockReset();
    mocks.runtimeFetch.mockReset();
    modelStore.setState({
      runtime: { status: "running", endpoint: "http://127.0.0.1:8080" },
      models: [],
    });
    chatStore.setState({ memoryByChat: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("summarises older messages through the local runtime and stores the result", async () => {
    mocks.getAutoSummaryBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockResolvedValue(
      completion("<think>x</think>\"They met at the harbor and agreed to sail at dawn.\""),
    );
    mocks.storeAutoSummary.mockResolvedValue(storedMemory);

    const result = await maybeUpdateAutoSummary({ chatId: "chat-1", userName: "Ilan" });

    expect(result).toEqual({ status: "updated", memory: storedMemory });
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.runtimeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      stream: false,
      cache_prompt: true,
      temperature: 0.2,
      max_tokens: 220,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(mocks.storeAutoSummary).toHaveBeenCalledWith({
      chatId: "chat-1",
      summary: "They met at the harbor and agreed to sail at dawn.",
      throughMessageId: "msg-12",
      expectedHistoryEpoch: 3,
    });
    expect(chatStore.getState().memoryByChat["chat-1"]).toEqual(storedMemory);
  });

  it("skips when busy, aborted, or the runtime is not ready", async () => {
    expect(await maybeUpdateAutoSummary({ chatId: "chat-1", isBusy: () => true })).toEqual({
      status: "skipped",
      reason: "busy",
    });

    const controller = new AbortController();
    controller.abort();
    expect(await maybeUpdateAutoSummary({ chatId: "chat-1", signal: controller.signal })).toEqual({
      status: "skipped",
      reason: "aborted",
    });

    modelStore.setState({ runtime: { status: "starting", endpoint: "http://127.0.0.1:8080" } });
    expect(await maybeUpdateAutoSummary({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "runtime-not-ready",
    });
    expect(mocks.getAutoSummaryBatch).not.toHaveBeenCalled();
  });

  it("waits for enough older messages", async () => {
    mocks.getAutoSummaryBatch.mockResolvedValue(batch({ pendingCount: 11 }));
    expect(await maybeUpdateAutoSummary({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "not-enough-messages",
    });
    expect(mocks.runtimeFetch).not.toHaveBeenCalled();
  });

  it("leaves a summary the user owns alone", async () => {
    mocks.getAutoSummaryBatch.mockResolvedValue(batch({ writable: false, messages: [] }));
    expect(await maybeUpdateAutoSummary({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "manual-summary",
    });
    expect(mocks.runtimeFetch).not.toHaveBeenCalled();
    expect(mocks.storeAutoSummary).not.toHaveBeenCalled();
  });

  it("throttles repeated attempts per chat", async () => {
    let clock = 1_000_000;
    mocks.getAutoSummaryBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockImplementation(async () => completion("They sail at dawn together."));
    mocks.storeAutoSummary.mockResolvedValue(storedMemory);
    const options = { chatId: "chat-1", now: () => clock };

    expect((await maybeUpdateAutoSummary(options)).status).toBe("updated");

    clock += AUTO_SUMMARY_MIN_INTERVAL_MS - 1;
    expect(await maybeUpdateAutoSummary(options)).toEqual({
      status: "skipped",
      reason: "throttled",
    });
    expect(mocks.getAutoSummaryBatch).toHaveBeenCalledTimes(1);

    expect(
      await maybeUpdateAutoSummary({ chatId: "chat-2", now: () => clock }),
    ).toMatchObject({ status: "updated" });

    clock += 1;
    expect((await maybeUpdateAutoSummary(options)).status).toBe("updated");
  });

  it("does not store when the user starts generating mid-request, and retries later", async () => {
    const controller = new AbortController();
    mocks.getAutoSummaryBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          controller.abort();
        }),
    );

    const result = await maybeUpdateAutoSummary({ chatId: "chat-1", signal: controller.signal });

    expect(result).toEqual({ status: "skipped", reason: "aborted" });
    expect(mocks.storeAutoSummary).not.toHaveBeenCalled();

    mocks.runtimeFetch.mockImplementation(async () => completion("They sail at dawn together."));
    mocks.storeAutoSummary.mockResolvedValue(storedMemory);
    expect((await maybeUpdateAutoSummary({ chatId: "chat-1" })).status).toBe("updated");
  });

  it("never throws into the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getAutoSummaryBatch.mockRejectedValue(new Error("database unavailable"));
    expect(await maybeUpdateAutoSummary({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "error",
    });

    mocks.getAutoSummaryBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockResolvedValue(new Response("nope", { status: 500 }));
    expect(
      await maybeUpdateAutoSummary({ chatId: "chat-1", now: () => Date.now() + 10_000_000 }),
    ).toEqual({ status: "skipped", reason: "error" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(mocks.storeAutoSummary).not.toHaveBeenCalled();
  });

  it("ignores model output that sanitises to nothing", async () => {
    mocks.getAutoSummaryBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockResolvedValue(completion("<think>only thoughts</think>"));
    expect(await maybeUpdateAutoSummary({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "empty-output",
    });
    expect(mocks.storeAutoSummary).not.toHaveBeenCalled();
  });

  it("reports when the backend refuses the write", async () => {
    mocks.getAutoSummaryBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockResolvedValue(completion("They sail at dawn together."));
    mocks.storeAutoSummary.mockResolvedValue(null);
    expect(await maybeUpdateAutoSummary({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "not-stored",
    });
    expect(chatStore.getState().memoryByChat["chat-1"]).toBeUndefined();
  });
});
