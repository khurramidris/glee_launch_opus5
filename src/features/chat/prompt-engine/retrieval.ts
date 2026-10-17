import type { RetrievalHintInput } from "./types";
import { buildResponseRetrievalHints } from "../response-system/memory/build-retrieval-query";

export function buildCharacterRetrievalHints(
  input: RetrievalHintInput,
): string | undefined {
  return buildResponseRetrievalHints(input);
}
