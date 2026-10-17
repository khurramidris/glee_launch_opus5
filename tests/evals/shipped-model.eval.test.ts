import { afterAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  LlamaChatCompletionResponse,
  LlamaChatRequest,
} from "../../src/types";
import {
  finalizeResponseOutput,
  prepareResponseRequest,
} from "../../src/features/chat/response-system";
import { estimateChatMessagesTokens } from "../../src/features/chat/runtime-adapters/token-budget";
import { defaultUserProfile, evalCases, evalModel } from "./eval-cases";
import { resolveMinPassRate, scoreTerms, summarizeEval } from "./eval-scoring";

const endpoint = process.env.GLEE_MODEL_EVAL_ENDPOINT?.replace(/\/+$/, "") ?? "";
const reportPath = resolve(
  process.env.GLEE_MODEL_EVAL_REPORT ??
    ".artifacts/evals/shipped-model-latest.json",
);
const apiKey = process.env.GLEE_MODEL_EVAL_API_KEY?.trim() ?? "";
// A small model can miss one case on a good day, so the suite fails on the
// pass rate, not on any single reply. Requests that error out still fail
// their own case.
const minPassRate = resolveMinPassRate(process.env.GLEE_MODEL_EVAL_MIN_PASS_RATE);
const MAX_CONSECUTIVE_ERRORS = 2;

async function completion(request: LlamaChatRequest): Promise<{
  content: string;
  finishReason?: string;
  usage?: LlamaChatCompletionResponse["usage"];
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
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
  mechanicalFailures: string[];
  finishReason?: string;
  usage?: LlamaChatCompletionResponse["usage"];
  mechanicalPass: boolean;
};

const caseReports: CaseReport[] = [];
const suiteStartedAt = new Date().toISOString();
let consecutiveErrors = 0;

afterAll(async () => {
  if (!endpoint) {
    return;
  }
  const report = {
    schemaVersion: 2,
    suite: "Glee shipped-model response evaluation",
    startedAt: suiteStartedAt,
    finishedAt: new Date().toISOString(),
    endpoint: "http://127.0.0.1:<ephemeral>/v1/chat/completions",
    model: evalModel,
    caseCount: evalCases.length,
    passedCount: caseReports.filter((item) => item.mechanicalPass).length,
    summary: summarizeEval(caseReports, evalCases.length, minPassRate),
    cases: caseReports,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
});

describe.skipIf(!endpoint)("shipped model response evaluation", () => {
  for (const evalCase of evalCases) {
    it(
      evalCase.id,
      async () => {
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(
            `Skipped: the model endpoint failed ${consecutiveErrors} cases in a row.`,
          );
        }
        const prepared = prepareResponseRequest({
          speaker: evalCase.speaker,
          userProfile: evalCase.userProfile ?? defaultUserProfile,
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
          runtime: { model: evalModel, stream: false },
          mode: evalCase.mode,
          participantNames: evalCase.participantNames,
          participantDirectory: evalCase.participantDirectory,
        });
        const startedAt = Date.now();
        let initial: Awaited<ReturnType<typeof completion>>;
        let evaluation: Awaited<ReturnType<typeof finalizeResponseOutput>>;
        try {
          initial = await completion(prepared.runtimeRequest);
          evaluation = await finalizeResponseOutput({
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
          consecutiveErrors = 0;
        } catch (error) {
          consecutiveErrors += 1;
          throw error;
        }
        const { expectedTermHits, requiredTermMisses, forbiddenTermHits } = scoreTerms(
          evaluation.finalReply,
          evalCase,
        );
        const forbiddenLeak = /\{\{|core contract:|response contract:|system prompt|group speaker:|reply notes/i.test(
          evaluation.finalReply,
        );
        const mechanicalFailures = [
          !initial.content.trim() && "empty model output",
          !evaluation.finalReply.trim() && "empty final reply",
          !evaluation.accepted && "reply rejected by Glee's reply checks",
          expectedTermHits.length === 0 && "none of the expected terms appeared",
          ...requiredTermMisses.map((term) => `missing required term "${term}"`),
          ...forbiddenTermHits.map((term) => `contains forbidden term "${term}"`),
          forbiddenLeak && "prompt text leaked into the reply",
        ].filter((failure): failure is string => Boolean(failure));
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
          mechanicalFailures,
          finishReason: initial.finishReason,
          usage: initial.usage,
          mechanicalPass: mechanicalFailures.length === 0,
        });
      },
    );
  }

  it("meets the minimum pass rate", () => {
    const summary = summarizeEval(caseReports, evalCases.length, minPassRate);
    const failing = caseReports
      .filter((item) => !item.mechanicalPass)
      .map((item) => `${item.id}: ${item.mechanicalFailures.join("; ")}`);
    expect(
      summary.passRate,
      `${summary.passedCount}/${summary.caseCount} cases passed (minimum ${minPassRate}).\n${failing.join("\n")}`,
    ).toBeGreaterThanOrEqual(minPassRate);
  });
});
