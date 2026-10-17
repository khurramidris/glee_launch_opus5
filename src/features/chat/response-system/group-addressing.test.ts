import { describe, expect, it } from "vitest";

import {
  detectAddressedParticipants,
  MAX_UNADDRESSED_RESPONDERS,
  selectGroupResponderIds,
} from "./group-addressing";

describe("detectAddressedParticipants", () => {
  it("matches names that begin or end with non-ASCII letters", () => {
    expect(detectAddressedParticipants("Zoë, can you hand me that?", ["Zoë", "Ivan"])).toEqual([
      "Zoë",
    ]);
    expect(detectAddressedParticipants("Élodie, come here.", ["Élodie", "Ivan"])).toEqual([
      "Élodie",
    ]);
    expect(detectAddressedParticipants("What do you think, René?", ["René", "Ivan"])).toEqual([
      "René",
    ]);
  });

  it("matches CJK names without requiring surrounding spaces", () => {
    expect(detectAddressedParticipants("李明，你好", ["李明", "Ivan"])).toEqual(["李明"]);
    expect(detectAddressedParticipants("你好李明，过来", ["李明", "Ivan"])).toEqual(["李明"]);
  });

  it("does not match a name inside a longer word", () => {
    expect(detectAddressedParticipants("Ivana, come here.", ["Ivan", "Zoë"])).toEqual([]);
    expect(detectAddressedParticipants("Zoëlla, come here.", ["Zoë", "Ivan"])).toEqual([]);
  });

  it("does not treat a common-word name as addressed in ordinary speech", () => {
    const names = ["Will", "Hope", "May", "Ivan"];
    expect(detectAddressedParticipants("Will you pass the salt?", names)).toEqual([]);
    expect(detectAddressedParticipants("I will go and I hope it rains.", names)).toEqual([]);
    expect(detectAddressedParticipants("May I sit here?", names)).toEqual([]);
    expect(detectAddressedParticipants("Hope you are well, everyone.", names)).toEqual([]);
  });

  it("treats a common-word name as addressed when it is a deliberate vocative", () => {
    const names = ["Will", "Hope", "May", "Ivan"];
    expect(detectAddressedParticipants("Will, pass the salt.", names)).toEqual(["Will"]);
    expect(detectAddressedParticipants("Hey Will, are you hungry?", names)).toEqual(["Will"]);
    expect(detectAddressedParticipants("Can you pass the salt, Hope?", names)).toEqual(["Hope"]);
    expect(detectAddressedParticipants("Thanks May! That helped.", names)).toEqual(["May"]);
  });

  it("keeps matching ordinary names as before", () => {
    expect(detectAddressedParticipants("Ivan, are you there?", ["Ivan", "Zoë"])).toEqual([
      "Ivan",
    ]);
    expect(detectAddressedParticipants("hello everyone", ["Ivan", "Zoë"])).toEqual([]);
  });
});

describe("selectGroupResponderIds", () => {
  const participantDirectory = {
    a: "Ana",
    b: "Boris",
    c: "Chiara",
    d: "Dmitri",
  };
  const responderIds = ["a", "b", "c", "d"];

  it("returns only the addressed participants", () => {
    expect(
      selectGroupResponderIds({
        responderIds,
        participantDirectory,
        latestUserMessage: "Chiara, what do you think?",
        lastSpeakerId: "a",
      }),
    ).toEqual(["c"]);
  });

  it("limits unaddressed turns to a couple of responders", () => {
    const selected = selectGroupResponderIds({
      responderIds,
      participantDirectory,
      latestUserMessage: "so what is everyone up to today",
    });

    expect(selected).toHaveLength(MAX_UNADDRESSED_RESPONDERS);
    expect(selected).toEqual(["a", "b"]);
  });

  it("rotates in roster order starting after the last speaker", () => {
    const pick = (lastSpeakerId?: string) =>
      selectGroupResponderIds({
        responderIds,
        participantDirectory,
        latestUserMessage: "so what is everyone up to today",
        lastSpeakerId,
      });

    expect(pick("a")).toEqual(["b", "c"]);
    expect(pick("c")).toEqual(["d", "a"]);
    expect(pick("d")).toEqual(["a", "b"]);
    expect(pick("unknown-id")).toEqual(["a", "b"]);
  });

  it("keeps small rosters whole", () => {
    expect(
      selectGroupResponderIds({
        responderIds: ["a", "b"],
        participantDirectory,
        latestUserMessage: "hello",
        lastSpeakerId: "a",
      }),
    ).toEqual(["b", "a"]);
    expect(
      selectGroupResponderIds({
        responderIds: ["a"],
        participantDirectory,
        latestUserMessage: "hello",
      }),
    ).toEqual(["a"]);
  });
});
