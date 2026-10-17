import { describe, expect, it } from "vitest";
import type { ChatCompletionDelta } from "../types";
import { parseLlamaSseStream } from "./sse";

const encoder = new TextEncoder();

function streamFromFragments(fragments: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const fragment of fragments) {
        controller.enqueue(encoder.encode(fragment));
      }
      controller.close();
    },
  });
}

async function collect(
  source: AsyncGenerator<ChatCompletionDelta>,
): Promise<ChatCompletionDelta[]> {
  const values: ChatCompletionDelta[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

describe("parseLlamaSseStream", () => {
  it("decodes JSON events fragmented across arbitrary byte chunks", async () => {
    const stream = streamFromFragments([
      'data: {"choices":[{"delta":{"cont',
      'ent":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n',
      "data: [DONE]\n\n",
    ]);

    const deltas = await collect(parseLlamaSseStream(stream));

    expect(deltas.map((delta) => delta.content).join("")).toBe("Hello");
  });

  it("surfaces finish reason and token usage from terminal chunks", async () => {
    const stream = streamFromFragments([
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":120,"completion_tokens":8,"total_tokens":128}}\n\n',
      "data: [DONE]\n\n",
    ]);

    const deltas = await collect(parseLlamaSseStream(stream));
    const terminal = deltas[deltas.length - 1];

    expect(terminal?.finishReason).toBe("stop");
    expect(terminal?.usage).toEqual({
      promptTokens: 120,
      completionTokens: 8,
      totalTokens: 128,
    });
  });

  it("rejects malformed JSON instead of silently dropping model output", async () => {
    const stream = streamFromFragments([
      'data: {"choices": definitely-not-json}\n\n',
    ]);

    await expect(collect(parseLlamaSseStream(stream))).rejects.toThrow(
      "malformed streaming response",
    );
  });

  it("cancels a stream that never produces its first token", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Keep the stream open to exercise the parser deadline.
      },
    });

    await expect(
      collect(
        parseLlamaSseStream(stream, {
          firstTokenTimeoutMs: 15,
          inactivityTimeoutMs: 15,
          totalTimeoutMs: 50,
        }),
      ),
    ).rejects.toThrow("did not begin responding in time");
  });
});
