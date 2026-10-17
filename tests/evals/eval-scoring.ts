export const DEFAULT_MIN_PASS_RATE = 0.8;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Expected and required terms match from a word start, so "lock" accepts
// "locked" but "hi" no longer matches inside "this". Forbidden terms match
// whole words, so "Mira" does not trip on "miracle".
export function replyHasTerm(
  reply: string,
  term: string,
  mode: "prefix" | "whole" = "prefix",
): boolean {
  const start = "(?<![\\p{L}\\p{N}])";
  const end = mode === "whole" ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${start}${escapeRegExp(term)}${end}`, "iu").test(reply);
}

export interface TermVerdict {
  expectedTermHits: string[];
  requiredTermMisses: string[];
  forbiddenTermHits: string[];
}

export function scoreTerms(
  reply: string,
  terms: {
    expectedTerms: string[];
    requiredTerms?: string[];
    forbiddenTerms?: string[];
  },
): TermVerdict {
  return {
    expectedTermHits: terms.expectedTerms.filter((term) => replyHasTerm(reply, term)),
    requiredTermMisses: (terms.requiredTerms ?? []).filter(
      (term) => !replyHasTerm(reply, term),
    ),
    forbiddenTermHits: (terms.forbiddenTerms ?? []).filter((term) =>
      replyHasTerm(reply, term, "whole"),
    ),
  };
}

export function resolveMinPassRate(raw: string | undefined): number {
  const parsed = Number.parseFloat(raw ?? "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_MIN_PASS_RATE;
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export interface ScoredCase {
  accepted: boolean;
  repaired: boolean;
  mechanicalPass: boolean;
  latencyMs: number;
  estimatedInputTokens: number;
  usage?: { prompt_tokens?: number } | null;
}

export interface EvalSummary {
  caseCount: number;
  executedCount: number;
  errorCount: number;
  passedCount: number;
  passRate: number;
  minPassRate: number;
  acceptedRate: number;
  repairedRate: number;
  rejectedCount: number;
  medianLatencyMs: number;
  p90LatencyMs: number;
  avgEstimatedInputTokens: number;
  avgPromptTokens: number | null;
}

// Cases that never produced a report (timeouts, HTTP errors) count as
// failures, so an unreachable model cannot pass on the cases that did run.
export function summarizeEval(
  reports: ScoredCase[],
  caseCount: number,
  minPassRate: number,
): EvalSummary {
  const executed = reports.length;
  const rate = (count: number, total: number) => (total > 0 ? round(count / total) : 0);
  const average = (values: number[]) =>
    values.length > 0
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : 0;
  const latencies = reports.map((report) => report.latencyMs);
  const promptTokens = reports
    .map((report) => report.usage?.prompt_tokens)
    .filter((value): value is number => typeof value === "number");
  const passedCount = reports.filter((report) => report.mechanicalPass).length;
  return {
    caseCount,
    executedCount: executed,
    errorCount: Math.max(0, caseCount - executed),
    passedCount,
    passRate: rate(passedCount, caseCount),
    minPassRate,
    acceptedRate: rate(reports.filter((report) => report.accepted).length, executed),
    repairedRate: rate(reports.filter((report) => report.repaired).length, executed),
    rejectedCount: reports.filter((report) => !report.accepted).length,
    medianLatencyMs: median(latencies),
    p90LatencyMs: percentile(latencies, 0.9),
    avgEstimatedInputTokens: average(reports.map((report) => report.estimatedInputTokens)),
    avgPromptTokens: promptTokens.length > 0 ? average(promptTokens) : null,
  };
}
