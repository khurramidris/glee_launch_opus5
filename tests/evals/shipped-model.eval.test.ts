import { afterAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  Character,
  ChatMessage,
  LlamaChatCompletionResponse,
  LlamaChatRequest,
  MemorySnippet,
  UserProfile,
} from "../../src/types";
import {
  finalizeResponseOutput,
  prepareResponseRequest,
} from "../../src/features/chat/response-system";
import { estimateChatMessagesTokens } from "../../src/features/chat/runtime-adapters/token-budget";

const endpoint = process.env.GLEE_MODEL_EVAL_ENDPOINT?.replace(/\/+$/, "") ?? "";
const reportPath = resolve(
  process.env.GLEE_MODEL_EVAL_REPORT ??
    ".artifacts/evals/shipped-model-latest.json",
);
const model = "ternary-bonsai-2-4b-pq2_0";
const apiKey = process.env.GLEE_MODEL_EVAL_API_KEY?.trim() ?? "";
const timestamp = "2000-01-01T00:00:00.000Z";

const userProfile: UserProfile = {
  name: "Sam",
  about: "Prefers direct, honest answers.",
  gender: "",
  avatar: "",
  traits: ["observant"],
  preferences: "Keep replies concise.",
  boundaries: "",
  createdAt: timestamp,
  updatedAt: timestamp,
};

function character(input: Partial<Character> & Pick<Character, "id" | "name">): Character {
  return {
    id: input.id,
    name: input.name,
    description: input.description ?? `${input.name} is present in the current scene.`,
    personality: input.personality ?? "Attentive, grounded, and candid.",
    backstory: input.backstory ?? "",
    scenario: input.scenario ?? "A quiet room after a long day.",
    systemPrompt: input.systemPrompt ?? "Stay in character and answer the live exchange directly.",
    postHistoryInstructions: input.postHistoryInstructions ?? "",
    speechStyle: input.speechStyle ?? "Natural, concise conversation.",
    greeting: input.greeting ?? "Hello.",
    alternateGreetings: input.alternateGreetings ?? [],
    avatar: "",
    tags: input.tags ?? [],
    likes: input.likes ?? [],
    dislikes: input.dislikes ?? [],
    boundaries: input.boundaries ?? "",
    creatorNotes: "",
    exampleDialogue: input.exampleDialogue ?? "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  speakerCharacterId?: string,
): ChatMessage {
  return {
    id,
    chatId: "eval-chat",
    role,
    content,
    ...(speakerCharacterId ? { speakerCharacterId } : {}),
    createdAt: timestamp,
  };
}

async function completion(request: LlamaChatRequest): Promise<{
  content: string;
  finishReason?: string;
  usage?: LlamaChatCompletionResponse["usage"];
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...request, stream: false, seed: 42 }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Model evaluation request failed (${response.status}): ${text.slice(0, 200)}`);
    }
    const payload = JSON.parse(text) as LlamaChatCompletionResponse;
    if (payload.error?.message) {
      throw new Error(payload.error.message);
    }
    const finishReason = payload.choices?.[0]?.finish_reason;
    return {
      content: payload.choices?.[0]?.message?.content ?? "",
      ...(typeof finishReason === "string" ? { finishReason } : {}),
      ...(payload.usage ? { usage: payload.usage } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

type EvalCase = {
  id: string;
  speaker: Character;
  history: ChatMessage[];
  mode?: "single" | "group";
  participantNames?: string[];
  participantDirectory?: Record<string, string>;
  memory?: {
    chatId: string;
    summary: string;
    facts: string[];
    updatedAt: string;
  };
  semanticMemorySnippets?: MemorySnippet[];
  expectedTerms: string[];
  requiredTerms?: string[];
  forbiddenTerms?: string[];
};

const cases: EvalCase[] = [
  {
    id: "persona-directness",
    speaker: character({
      id: "mira",
      name: "Mira",
      description: "Mira is a skeptical archivist who notices every misplaced object.",
      personality: "Dry-witted, precise, guarded, but quietly helpful.",
      speechStyle: "Brief, wry, concrete sentences. Never sound like a customer-service agent.",
      systemPrompt: "Do not flatter. Answer questions plainly, with understated dry wit.",
      exampleDialogue:
        "Sam: Did you move my pen?\nMira: I did. It was blocking the catalog.",
      tags: ["wry", "precise"],
    }),
    history: [message("u1", "user", "Mira, did you take my blue notebook from the desk?")],
    expectedTerms: ["yes", "no", "did", "took", "notebook", "desk", "blue"],
  },
  {
    id: "memory-continuity",
    speaker: character({ id: "mira", name: "Mira" }),
    history: [message("u2", "user", "What tea would you bring me without asking again?")],
    memory: {
      chatId: "eval-chat",
      summary: "Sam previously told Mira that jasmine is his favorite tea.",
      facts: ["My favorite tea is jasmine"],
      updatedAt: timestamp,
    },
    semanticMemorySnippets: [
      {
        chatId: "eval-chat",
        messageId: "old-user-tea",
        role: "user",
        content: "My favorite tea is jasmine.",
        createdAt: timestamp,
        score: 99,
      },
    ],
    expectedTerms: ["jasmine"],
    requiredTerms: ["jasmine"],
    forbiddenTerms: ["Mira"],
  },
  {
    id: "group-speaker-provenance",
    speaker: character({
      id: "pooja",
      name: "Pooja",
      personality: "Warm, attentive, and socially perceptive.",
    }),
    history: [
      message("u3", "user", "Who will carry the map?"),
      message("a3", "assistant", "I will carry the map.", "lara"),
      message("u4", "user", "Pooja, what did Lara volunteer to bring?"),
    ],
    mode: "group",
    participantNames: ["Pooja", "Lara"],
    participantDirectory: { pooja: "Pooja", lara: "Lara" },
    expectedTerms: ["map", "lara"],
    // "She'd carry it" is a correct answer, so only the attribution is required.
    requiredTerms: ["lara"],
    forbiddenTerms: ["compass"],
  },
];

type CaseReport = {
  id: string;
  promptMessages: LlamaChatRequest["messages"];
  latencyMs: number;
  estimatedInputTokens: number;
  rawOutput: string;
  finalOutput: string;
  accepted: boolean;
  repaired: boolean;
  qualityScore: number;
  reasons: string[];
  expectedTermHits: string[];
  requiredTermMisses: string[];
  forbiddenTermHits: string[];
  finishReason?: string;
  usage?: LlamaChatCompletionResponse["usage"];
  mechanicalPass: boolean;
};

const caseReports: CaseReport[] = [];
const suiteStartedAt = new Date().toISOString();

afterAll(async () => {
  if (!endpoint) {
    return;
  }
  const report = {
    schemaVersion: 1,
    suite: "Glee shipped-model response evaluation",
    startedAt: suiteStartedAt,
    finishedAt: new Date().toISOString(),
    endpoint: "http://127.0.0.1:<ephemeral>/v1/chat/completions",
    model,
    caseCount: cases.length,
    passedCount: caseReports.filter((item) => item.mechanicalPass).length,
    cases: caseReports,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
});

describe.skipIf(!endpoint)("shipped model response evaluation", () => {
  for (const evalCase of cases) {
    it(
      evalCase.id,
      async () => {
        const prepared = prepareResponseRequest({
          speaker: evalCase.speaker,
          userProfile,
          memory: evalCase.memory,
          semanticMemorySnippets: evalCase.semanticMemorySnippets,
          contextEntries: [],
          history: evalCase.history,
          sampling: {
            temperature: 0.2,
            topP: 0.9,
            maxTokens: 192,
            repeatPenalty: 1.1,
          },
          runtime: { model, stream: false },
          mode: evalCase.mode,
          participantNames: evalCase.participantNames,
          participantDirectory: evalCase.participantDirectory,
        });
        const startedAt = Date.now();
        const initial = await completion(prepared.runtimeRequest);
        const evaluation = await finalizeResponseOutput({
          rawOutput: initial.content,
          prepared,
          repair: async (instruction) => {
            const repaired = await completion({
              ...prepared.runtimeRequest,
              stream: false,
              max_tokens: 192,
              messages: [
                ...prepared.runtimeRequest.messages,
                {
                  role: "user",
                  content: `${instruction}\nReturn only the corrected in-character reply.`,
                },
              ],
            });
            return repaired.content;
          },
        });
        const normalizedOutput = evaluation.finalReply.toLocaleLowerCase();
        const expectedTermHits = evalCase.expectedTerms.filter((term) =>
          normalizedOutput.includes(term.toLocaleLowerCase()),
        );
        const requiredTermMisses = (evalCase.requiredTerms ?? []).filter(
          (term) => !normalizedOutput.includes(term.toLocaleLowerCase()),
        );
        const forbiddenTermHits = (evalCase.forbiddenTerms ?? []).filter((term) =>
          normalizedOutput.includes(term.toLocaleLowerCase()),
        );
        const forbiddenLeak = /\{\{|core contract:|response contract:|system prompt|group speaker:/i.test(
          evaluation.finalReply,
        );
        const mechanicalPass =
          Boolean(initial.content.trim()) &&
          evaluation.accepted &&
          Boolean(evaluation.finalReply.trim()) &&
          expectedTermHits.length > 0 &&
          requiredTermMisses.length === 0 &&
          forbiddenTermHits.length === 0 &&
          !forbiddenLeak;
        caseReports.push({
          id: evalCase.id,
          promptMessages: prepared.runtimeRequest.messages,
          latencyMs: Date.now() - startedAt,
          estimatedInputTokens: estimateChatMessagesTokens(
            prepared.runtimeRequest.messages,
          ),
          rawOutput: initial.content,
          finalOutput: evaluation.finalReply,
          accepted: evaluation.accepted,
          repaired: evaluation.repaired,
          qualityScore: evaluation.qualityScore,
          reasons: evaluation.reasons,
          expectedTermHits,
          requiredTermMisses,
          forbiddenTermHits,
          finishReason: initial.finishReason,
          usage: initial.usage,
          mechanicalPass,
        });

        expect(initial.content.trim()).not.toBe("");
        expect(forbiddenLeak).toBe(false);
        expect(evaluation.accepted).toBe(true);
        expect(evaluation.finalReply.trim()).not.toBe("");
        expect(expectedTermHits.length).toBeGreaterThan(0);
        expect(requiredTermMisses).toEqual([]);
        expect(forbiddenTermHits).toEqual([]);
      },
      240_000,
    );
  }
});
