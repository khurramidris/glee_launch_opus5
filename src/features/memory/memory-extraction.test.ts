import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryExtractionBatch, MemoryItem } from "../../types";

const mocks = vi.hoisted(() => ({
  getMemoryExtractionBatch: vi.fn(),
  storeMemoryExtraction: vi.fn(),
  runtimeFetch: vi.fn(),
}));

vi.mock("../../api/tauri", () => ({
  getMemoryExtractionBatch: mocks.getMemoryExtractionBatch,
  storeMemoryExtraction: mocks.storeMemoryExtraction,
}));

vi.mock("../../lib/runtime-fetch", () => ({
  runtimeFetch: mocks.runtimeFetch,
}));

import { memoryStore } from "../../stores/memory-store";
import { modelStore } from "../../stores/model-store";
import {
  MEMORY_EXTRACTION_MAX_ADDS,
  MEMORY_EXTRACTION_MIN_INTERVAL_MS,
  buildMemoryExtractionPrompt,
  extractJsonObject,
  maybeExtractMemories,
  parseMemoryExtraction,
  resetMemoryExtractionState,
  sanitizeMemoryContent,
  type MemoryExtractionContext,
} from "./memory-extraction";

function item(index: number, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: `item-${index}`,
    scope: "user",
    kind: "fact",
    content: `Sam knows fact number ${index}`,
    importance: 3,
    pinned: false,
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    recallCount: 0,
    archived: false,
    ...overrides,
  };
}

function batch(overrides: Partial<MemoryExtractionBatch> = {}): MemoryExtractionBatch {
  return {
    chatId: "chat-1",
    historyEpoch: 3,
    ready: true,
    pendingCount: 6,
    lastMessageId: "msg-5",
    participants: [
      { id: "char-ada", name: "Ada" },
      { id: "char-bea", name: "Bea" },
    ],
    messages: Array.from({ length: 6 }, (_, index) => ({
      id: `msg-${index}`,
      chatId: "chat-1",
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index}`,
      ...(index % 2 === 1 ? { speakerCharacterId: index === 3 ? "char-bea" : "char-ada" } : {}),
      createdAt: "2000-01-01T00:00:00.000Z",
    })),
    relatedItems: [
      item(1),
      item(2, { scope: "character", characterId: "char-ada", content: "Ada owns a telescope" }),
    ],
    ...overrides,
  };
}

function context(overrides: Partial<MemoryExtractionContext> = {}): MemoryExtractionContext {
  return {
    handles: new Map([
      ["m1", "item-1"],
      ["m2", "item-2"],
      ["m3", "item-3"],
      ["m4", "item-4"],
    ]),
    participants: [
      { id: "char-ada", name: "Ada Lovelace" },
      { id: "char-bea", name: "Bea" },
    ],
    userName: "Sam",
    ...overrides,
  };
}

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const emptyOutcome = { added: [], updated: [], removed: [], skipped: 0 };

describe("extractJsonObject", () => {
  it("ignores reasoning, fences, and prose around the object", () => {
    const raw =
      '<think>{"add": "not this"}</think>Sure!\n```json\n{"add": [], "note": "a } brace"}\n```\nDone.';
    expect(JSON.parse(extractJsonObject(raw) ?? "")).toEqual({ add: [], note: "a } brace" });
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("nothing here")).toBeNull();
    expect(extractJsonObject('{"add": [')).toBeNull();
  });

  it("closes output that was cut off after the last complete value", () => {
    const raw = '{"add":[{"scope":"user","content":"Sam likes tea"},{"scope":"us';
    const repaired = JSON.parse(extractJsonObject(raw) ?? "");
    expect(repaired.add).toHaveLength(1);
  });
});

describe("sanitizeMemoryContent", () => {
  it("accepts a clean third-person statement and tidies decoration", () => {
    expect(sanitizeMemoryContent("  - **Sam** is allergic to peanuts.  ")).toBe(
      "Sam is allergic to peanuts",
    );
    expect(sanitizeMemoryContent('"Ada promised to teach Sam chess"')).toBe(
      "Ada promised to teach Sam chess",
    );
  });

  it("rejects first person, questions, placeholders, and fragments", () => {
    for (const bad of [
      "I am allergic to peanuts",
      "My dog is called Biscuit",
      "You said you like tea",
      "What does Sam like?",
      "none",
      "N/A",
      "tea",
      "Hi",
      "",
      42,
      null,
    ]) {
      expect(sanitizeMemoryContent(bad)).toBeNull();
    }
  });

  it("caps length at a boundary", () => {
    const long = sanitizeMemoryContent(`Sam visited ${"the old harbor town ".repeat(30)}`) ?? "";
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.length).toBeGreaterThan(100);
    expect(long.endsWith(" ")).toBe(false);
  });
});

describe("parseMemoryExtraction", () => {
  it("validates additions and resolves who each one is about", () => {
    const parsed = parseMemoryExtraction(
      JSON.stringify({
        add: [
          { scope: "user", about: "user", kind: "fact", content: "Sam is allergic to peanuts", importance: 5 },
          { scope: "character", about: "Ada", kind: "promise", content: "Ada promised to teach Sam chess", importance: "4" },
          { scope: "character", about: "Sam", content: "Sam lives by the coast" },
          { scope: "chat", about: "user", kind: "mystery", content: "The trip is planned for spring", importance: 12 },
          { scope: "character", about: "Nobody", content: "Someone unknown knows a secret" },
          { scope: "planet", content: "Bad scope entry here" },
          { scope: "user", content: "I like tea" },
          "not an object",
        ],
        update: [],
        remove: [],
      }),
      context(),
    );
    expect(parsed?.add).toEqual([
      { scope: "user", kind: "fact", content: "Sam is allergic to peanuts", importance: 5 },
      { scope: "character", characterId: "char-ada", kind: "promise", content: "Ada promised to teach Sam chess", importance: 4 },
      { scope: "user", kind: "fact", content: "Sam lives by the coast", importance: 3 },
      { scope: "chat", kind: "fact", content: "The trip is planned for spring", importance: 5 },
    ]);
  });

  it("assigns an unnamed character memory to the only character in the chat", () => {
    const parsed = parseMemoryExtraction(
      '{"add":[{"scope":"character","content":"Ada keeps a brass telescope"}]}',
      context({ participants: [{ id: "char-ada", name: "Ada" }] }),
    );
    expect(parsed?.add[0]).toMatchObject({ scope: "character", characterId: "char-ada" });
  });

  it("matches a character by first name", () => {
    const parsed = parseMemoryExtraction(
      '{"add":[{"scope":"character","about":"Ada","content":"Ada keeps a brass telescope"}]}',
      context(),
    );
    expect(parsed?.add[0]).toMatchObject({ characterId: "char-ada" });
  });

  it("repeats and runaway lists are capped", () => {
    const add = Array.from({ length: 20 }, (_, index) => ({
      scope: "user",
      content: `Sam visited unique location ${["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t"][index]}${index}`,
    }));
    const parsed = parseMemoryExtraction(
      JSON.stringify({
        add: [...add, { scope: "user", content: add[0].content }],
        remove: [{ id: "M1" }, { id: "M2" }, { id: "M3" }, { id: "M4" }],
      }),
      context(),
    );
    expect(parsed?.add).toHaveLength(MEMORY_EXTRACTION_MAX_ADDS);
    expect(parsed?.remove).toHaveLength(3);
  });

  it("maps handles to ids and ignores ones the model invented", () => {
    const parsed = parseMemoryExtraction(
      JSON.stringify({
        add: [],
        update: [
          { id: "M1", content: "Sam is severely allergic to peanuts", importance: 5 },
          { id: "m2", importance: 4 },
          { id: "M9", content: "Invented memory about nothing" },
          { id: "M3" },
          { id: "item-4", content: "I did it a long time ago" },
        ],
        remove: [{ id: "M3" }, "M4", { id: "M1" }, { id: "M77" }],
      }),
      context(),
    );
    expect(parsed?.update).toEqual([
      { id: "item-1", content: "Sam is severely allergic to peanuts", importance: 5 },
      { id: "item-2", importance: 4 },
    ]);
    // M1 was updated, so it cannot also be removed.
    expect(parsed?.remove).toEqual(["item-3", "item-4"]);
  });

  it("survives trailing commas, fences, and reasoning", () => {
    const parsed = parseMemoryExtraction(
      '<think>hmm</think>```json\n{"add":[{"scope":"user","content":"Sam plays the cello","importance":2,},],"update":[],"remove":[],}\n```',
      context(),
    );
    expect(parsed?.add).toEqual([
      { scope: "user", kind: "fact", content: "Sam plays the cello", importance: 2 },
    ]);
  });

  it("returns null for unreadable output and empty changes for an empty reply", () => {
    expect(parseMemoryExtraction("I could not find anything.", context())).toBeNull();
    expect(parseMemoryExtraction("[1, 2, 3]", context())).toBeNull();
    expect(parseMemoryExtraction('{"add":"oops","update":5,"remove":null}', context())).toEqual({
      add: [],
      update: [],
      remove: [],
    });
  });
});

describe("buildMemoryExtractionPrompt", () => {
  it("lists existing memories by handle and labels speakers", () => {
    const { messages, context: promptContext } = buildMemoryExtractionPrompt(batch(), {
      chatId: "chat-1",
      userName: "Sam",
      participantDirectory: { "char-ada": "Ada", "char-bea": "Bea" },
    });
    expect(messages[0]?.content).toContain("JSON only");
    const body = messages[1]?.content ?? "";
    expect(body).toContain("Characters: Ada, Bea.");
    expect(body).toContain("The user is called Sam.");
    expect(body).toContain("M1 [user] Sam knows fact number 1");
    expect(body).toContain("M2 [Ada] Ada owns a telescope");
    expect(body).toContain("Sam: message 0\nAda: message 1\nSam: message 2\nBea: message 3");
    expect(promptContext.handles.get("m2")).toBe("item-2");
  });

  it("says so when nothing is remembered yet", () => {
    const { messages } = buildMemoryExtractionPrompt(batch({ relatedItems: [] }), { chatId: "chat-1" });
    expect(messages[1]?.content).toContain("Existing memories:\n(none yet)");
    expect(messages[1]?.content).toContain("The user is called User.");
  });
});

describe("maybeExtractMemories", () => {
  beforeEach(() => {
    resetMemoryExtractionState();
    mocks.getMemoryExtractionBatch.mockReset();
    mocks.storeMemoryExtraction.mockReset();
    mocks.runtimeFetch.mockReset();
    memoryStore.getState().reset();
    modelStore.setState({
      runtime: { status: "running", endpoint: "http://127.0.0.1:8080" },
      models: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks the runtime for JSON, stores validated changes, and refreshes views", async () => {
    mocks.getMemoryExtractionBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockResolvedValue(
      completion(
        '{"add":[{"scope":"user","about":"user","kind":"fact","content":"Sam is allergic to peanuts","importance":5}],"update":[],"remove":[]}',
      ),
    );
    const outcome = { ...emptyOutcome, added: [item(9)] };
    mocks.storeMemoryExtraction.mockResolvedValue(outcome);
    const revision = memoryStore.getState().revision;

    const result = await maybeExtractMemories({ chatId: "chat-1", userName: "Sam" });

    expect(result).toEqual({ status: "stored", outcome });
    const [url, init] = mocks.runtimeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: false,
      temperature: 0.1,
      response_format: { type: "json_object" },
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(mocks.storeMemoryExtraction).toHaveBeenCalledWith({
      chatId: "chat-1",
      throughMessageId: "msg-5",
      expectedHistoryEpoch: 3,
      add: [{ scope: "user", kind: "fact", content: "Sam is allergic to peanuts", importance: 5 }],
      update: [],
      remove: [],
    });
    expect(memoryStore.getState().revision).toBe(revision + 1);
  });

  it("falls back to plain text when the server refuses constrained output", async () => {
    mocks.getMemoryExtractionBatch.mockResolvedValue(batch());
    mocks.runtimeFetch
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(completion('{"add":[],"update":[],"remove":[]}'));
    mocks.storeMemoryExtraction.mockResolvedValue(emptyOutcome);

    expect((await maybeExtractMemories({ chatId: "chat-1" })).status).toBe("stored");
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(2);
    const retried = JSON.parse(String((mocks.runtimeFetch.mock.calls[1] as [string, RequestInit])[1].body));
    expect(retried.response_format).toBeUndefined();

    // The refusal is remembered, so later runs skip the failed first attempt.
    mocks.runtimeFetch.mockResolvedValue(completion('{"add":[]}'));
    await maybeExtractMemories({ chatId: "chat-2" });
    expect(mocks.runtimeFetch).toHaveBeenCalledTimes(3);
  });

  it("does not refresh views when nothing changed", async () => {
    mocks.getMemoryExtractionBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockResolvedValue(completion('{"add":[],"update":[],"remove":[]}'));
    mocks.storeMemoryExtraction.mockResolvedValue(emptyOutcome);
    const revision = memoryStore.getState().revision;
    await maybeExtractMemories({ chatId: "chat-1" });
    expect(mocks.storeMemoryExtraction).toHaveBeenCalledTimes(1);
    expect(memoryStore.getState().revision).toBe(revision);
  });

  it("skips when busy, aborted, or the runtime is not ready", async () => {
    expect(await maybeExtractMemories({ chatId: "chat-1", isBusy: () => true })).toEqual({
      status: "skipped",
      reason: "busy",
    });
    const controller = new AbortController();
    controller.abort();
    expect(await maybeExtractMemories({ chatId: "chat-1", signal: controller.signal })).toEqual({
      status: "skipped",
      reason: "aborted",
    });
    modelStore.setState({ runtime: { status: "starting", endpoint: "http://127.0.0.1:8080" } });
    expect(await maybeExtractMemories({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "runtime-not-ready",
    });
    expect(mocks.getMemoryExtractionBatch).not.toHaveBeenCalled();
  });

  it("waits until the backend says enough messages piled up", async () => {
    mocks.getMemoryExtractionBatch.mockResolvedValue(
      batch({ ready: false, pendingCount: 3, messages: [], lastMessageId: undefined }),
    );
    expect(await maybeExtractMemories({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "not-enough-messages",
    });
    expect(mocks.runtimeFetch).not.toHaveBeenCalled();
  });

  it("throttles repeated attempts per chat", async () => {
    let clock = 1_000_000;
    mocks.getMemoryExtractionBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockImplementation(async () => completion('{"add":[]}'));
    mocks.storeMemoryExtraction.mockResolvedValue(emptyOutcome);
    const options = { chatId: "chat-1", now: () => clock };

    expect((await maybeExtractMemories(options)).status).toBe("stored");
    clock += MEMORY_EXTRACTION_MIN_INTERVAL_MS - 1;
    expect(await maybeExtractMemories(options)).toEqual({ status: "skipped", reason: "throttled" });
    expect(mocks.getMemoryExtractionBatch).toHaveBeenCalledTimes(1);
    clock += 1;
    expect((await maybeExtractMemories(options)).status).toBe("stored");
  });

  it("does not store when the user starts generating mid-request, and retries later", async () => {
    const controller = new AbortController();
    mocks.getMemoryExtractionBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          controller.abort();
        }),
    );
    expect(await maybeExtractMemories({ chatId: "chat-1", signal: controller.signal })).toEqual({
      status: "skipped",
      reason: "aborted",
    });
    expect(mocks.storeMemoryExtraction).not.toHaveBeenCalled();

    mocks.runtimeFetch.mockImplementation(async () => completion('{"add":[]}'));
    mocks.storeMemoryExtraction.mockResolvedValue(emptyOutcome);
    expect((await maybeExtractMemories({ chatId: "chat-1" })).status).toBe("stored");
  });

  it("drops a reply that arrives after the chat became busy", async () => {
    let busy = false;
    mocks.getMemoryExtractionBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockImplementation(async () => {
      busy = true;
      return completion('{"add":[{"scope":"user","content":"Sam plays the cello"}]}');
    });
    expect(await maybeExtractMemories({ chatId: "chat-1", isBusy: () => busy })).toEqual({
      status: "skipped",
      reason: "busy",
    });
    expect(mocks.storeMemoryExtraction).not.toHaveBeenCalled();
  });

  it("retries unreadable output once, then lets the window go", async () => {
    let clock = 1_000_000;
    mocks.getMemoryExtractionBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockImplementation(async () => completion("I cannot do that."));
    mocks.storeMemoryExtraction.mockResolvedValue(emptyOutcome);
    const options = { chatId: "chat-1", now: () => clock };

    expect(await maybeExtractMemories(options)).toEqual({
      status: "skipped",
      reason: "unreadable-output",
    });
    expect(mocks.storeMemoryExtraction).not.toHaveBeenCalled();

    clock += MEMORY_EXTRACTION_MIN_INTERVAL_MS;
    expect((await maybeExtractMemories(options)).status).toBe("stored");
    expect(mocks.storeMemoryExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ add: [], update: [], remove: [] }),
    );
  });

  it("never throws into the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getMemoryExtractionBatch.mockRejectedValue(new Error("database unavailable"));
    expect(await maybeExtractMemories({ chatId: "chat-1" })).toEqual({
      status: "skipped",
      reason: "error",
    });

    mocks.getMemoryExtractionBatch.mockResolvedValue(batch());
    mocks.runtimeFetch.mockResolvedValue(new Response("nope", { status: 500 }));
    expect(
      await maybeExtractMemories({ chatId: "chat-1", now: () => Date.now() + 10_000_000 }),
    ).toEqual({ status: "skipped", reason: "error" });

    mocks.runtimeFetch.mockResolvedValue(completion('{"add":[]}'));
    mocks.storeMemoryExtraction.mockRejectedValue(new Error("stale history epoch"));
    expect(
      await maybeExtractMemories({ chatId: "chat-1", now: () => Date.now() + 20_000_000 }),
    ).toEqual({ status: "skipped", reason: "error" });
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
