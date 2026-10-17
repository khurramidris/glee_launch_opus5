import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { historyForQueuedSpeakerTurn } from "./group-turn-history";

const baseHistory: ChatMessage[] = [
  {
    id: "user-1",
    chatId: "chat-1",
    role: "user",
    content: "Look what I have in my hand.",
    createdAt: "2000-01-01T00:00:00.000Z",
  },
];

const currentHistory: ChatMessage[] = [
  ...baseHistory,
  {
    id: "assistant-1",
    chatId: "chat-1",
    role: "assistant",
    content: "I glance toward your hand.",
    speakerCharacterId: "char-1",
    createdAt: "2000-01-01T00:00:01.000Z",
  },
];

describe("historyForQueuedSpeakerTurn", () => {
  it("lets later group speakers see sanitized earlier same-round replies", () => {
    expect(
      historyForQueuedSpeakerTurn({
        groupMode: true,
        roundHistoryBase: baseHistory,
        currentHistory: [
          ...baseHistory,
          {
            id: "assistant-meta",
            chatId: "chat-1",
            role: "assistant",
            content:
              "System is asking: core contract.\nChris: Stay back from that display.",
            speakerCharacterId: "char-1",
            createdAt: "2000-01-01T00:00:01.000Z",
          },
        ],
      }),
    ).toEqual([
      ...baseHistory,
      {
        id: "assistant-meta",
        chatId: "chat-1",
        role: "assistant",
        content: "Stay back from that display.",
        speakerCharacterId: "char-1",
        createdAt: "2000-01-01T00:00:01.000Z",
      },
    ]);
  });

  it("unwraps leaked internal same-round labels before shaping group history", () => {
    expect(
      historyForQueuedSpeakerTurn({
        groupMode: true,
        roundHistoryBase: baseHistory,
        currentHistory: [
          ...baseHistory,
          {
            id: "assistant-scaffold",
            chatId: "chat-1",
            role: "assistant",
            content: 'Previous group reply from Lara: "I am listening."',
            speakerCharacterId: "char-1",
            createdAt: "2000-01-01T00:00:01.000Z",
          },
        ],
      }),
    ).toEqual([
      ...baseHistory,
      {
        id: "assistant-scaffold",
        chatId: "chat-1",
        role: "assistant",
        content: '"I am listening."',
        speakerCharacterId: "char-1",
        createdAt: "2000-01-01T00:00:01.000Z",
      },
    ]);
  });

  it("bounds same-round assistant carryover for later group speakers", () => {
    const longReply = "A".repeat(260);
    const shaped = historyForQueuedSpeakerTurn({
      groupMode: true,
      roundHistoryBase: baseHistory,
      currentHistory: [
        ...baseHistory,
        {
          id: "assistant-1",
          chatId: "chat-1",
          role: "assistant",
          content: longReply,
          speakerCharacterId: "char-1",
          createdAt: "2000-01-01T00:00:01.000Z",
        },
        {
          id: "assistant-2",
          chatId: "chat-1",
          role: "assistant",
          content: longReply,
          speakerCharacterId: "char-2",
          createdAt: "2000-01-01T00:00:02.000Z",
        },
        {
          id: "assistant-3",
          chatId: "chat-1",
          role: "assistant",
          content: longReply,
          speakerCharacterId: "char-3",
          createdAt: "2000-01-01T00:00:03.000Z",
        },
        {
          id: "assistant-4",
          chatId: "chat-1",
          role: "assistant",
          content: longReply,
          speakerCharacterId: "char-4",
          createdAt: "2000-01-01T00:00:04.000Z",
        },
        {
          id: "assistant-5",
          chatId: "chat-1",
          role: "assistant",
          content: longReply,
          speakerCharacterId: "char-5",
          createdAt: "2000-01-01T00:00:05.000Z",
        },
      ],
    });

    expect(shaped).toHaveLength(5);
    expect(shaped.slice(1).every((message) => message.content.length <= 180)).toBe(
      true,
    );
    expect(shaped.slice(1).map((message) => message.speakerCharacterId)).toEqual([
      "char-1",
      "char-2",
      "char-3",
      "char-4",
    ]);
  });

  it("lets single-speaker turns use the progressively updated history", () => {
    expect(
      historyForQueuedSpeakerTurn({
        groupMode: false,
        roundHistoryBase: baseHistory,
        currentHistory,
      }),
    ).toEqual(currentHistory);
  });
});
