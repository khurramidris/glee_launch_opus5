import { describe, expect, it } from "vitest";

import { evaluateCharacterReply } from "./evaluation/evaluate-reply";
import {
  GROUP_REGRESSION_SCENARIOS,
  getGroupRegressionScenario,
} from "./group-regression-corpus";
import { buildResponseDiagnosticsInspection } from "./diagnostics";
import { prepareResponseRequest } from "./prepare";

function prepareScenario(
  scenarioId: string,
) {
  const scenario = getGroupRegressionScenario(scenarioId);
  const speaker = scenario.characters.find(
    (character) => character.id === scenario.targetSpeakerId,
  );

  if (!speaker) {
    throw new Error(`Missing target speaker for scenario ${scenarioId}`);
  }

  return prepareResponseRequest({
    speaker,
    userProfile: scenario.userProfile,
    relationshipState: scenario.relationshipState,
    contextEntries: [],
    history: scenario.history,
    sampling: {},
    runtime: {
      model: "test-model",
      stream: true,
    },
    mode: "group",
    participantNames: scenario.characters.map((character) => character.name),
    participantDirectory: Object.fromEntries(
      scenario.characters.map((character) => [character.id, character.name]),
    ),
  });
}

describe("group regression corpus", () => {
  it("prepares every regression scenario with structured same-round state", () => {
    for (const scenario of GROUP_REGRESSION_SCENARIOS) {
      const prepared = prepareScenario(scenario.id);
      const assistantCount = scenario.history.filter(
        (message) => message.role === "assistant",
      ).length;
      const groupSection = prepared.compiledPrompt.systemSections.find(
        (section) => section.key === "group_round_state",
      );
      const inspection = buildResponseDiagnosticsInspection(prepared);

      expect(prepared.groupRoundState).not.toBeNull();
      expect(prepared.context.groupRoundState).toEqual(prepared.groupRoundState);
      expect(prepared.groupRoundState?.rosterOrder).toEqual(
        scenario.characters.map((character) => character.name),
      );
      expect(prepared.groupRoundState?.priorReplies).toHaveLength(assistantCount);
      expect(prepared.groupRoundState?.currentSpeakerObligations.length).toBeGreaterThan(0);
      expect(prepared.groupRoundState?.currentSocialBeat.length).toBeGreaterThan(0);
      expect(prepared.groupRoundState?.expectedSocialMove.length).toBeGreaterThan(0);
      expect(groupSection?.content).toContain("Roster order:");
      expect(groupSection?.content).toContain("Current speaker obligations:");
      expect(inspection.context.mode).toBe("group");
      expect(inspection.context.speakerName).toBe(scenario.characters.find(
        (character) => character.id === scenario.targetSpeakerId,
      )?.name);
      expect(inspection.groupRoundState?.currentSpeakerRole).toBe(
        prepared.groupRoundState?.currentSpeakerRole,
      );
      expect(inspection.groupRoundState?.addressedParticipants).toEqual(
        prepared.groupRoundState?.addressedParticipants,
      );
      expect(inspection.groupRoundState?.latestUserSocialTone).toBe(
        prepared.groupRoundState?.latestUserSocialTone,
      );
      expect(inspection.groupRoundState?.priorReplies).toHaveLength(
        assistantCount,
      );
      expect(inspection.prompt.systemSections.some(
        (section) => section.key === "group_round_state",
      )).toBe(true);
      expect(JSON.stringify(inspection.prompt.runtimeMessages)).not.toContain(
        "Previous group reply",
      );
      if (assistantCount > 0) {
        expect(groupSection?.content).toContain("Earlier replies this round:");
      }
    }
  });

  it("captures downstream same-round awareness in the showroom and candy-shop scenarios", () => {
    const showroom = prepareScenario("mercedes_showroom_priyanka_car");
    const candyShop = prepareScenario("candy_shop_downstreaming");

    expect(showroom.groupRoundState?.priorReplies.map((reply) => reply.speakerName)).toEqual([
      "Lara Lightland",
      "Pooja",
      "Priyanka",
    ]);
    expect(showroom.groupRoundState?.engagementExpectation).toBe("required");
    expect(showroom.groupRoundState?.currentSocialBeat).toMatch(/Priyanka/i);
    expect(showroom.groupRoundState?.expectedSocialMove).toMatch(/room beat|in motion/i);
    expect(showroom.reactionPlan.mustAddress.join(" ")).toMatch(/earlier same-round replies/i);
    expect(showroom.groupRoundState?.currentSpeakerObligations.join(" ")).toMatch(
      /You just heard Priyanka say:/i,
    );
    expect(showroom.groupRoundState?.currentSpeakerObligations.join(" ")).toMatch(
      /Current social beat:/i,
    );
    expect(showroom.reactionPlan.forbiddenMoves.join(" ")).toMatch(
      /copy .*wording|copy .*stance|first speaker/i,
    );

    expect(candyShop.groupRoundState?.priorReplies.map((reply) => reply.speakerName)).toEqual([
      "Lara Lightland",
      "Priyanka",
    ]);
    expect(candyShop.groupRoundState?.engagementExpectation).toBe("required");
    expect(candyShop.groupRoundState?.engagementCueTokens).toEqual(
      expect.arrayContaining(["calm", "point", "shout"]),
    );
    expect(candyShop.groupRoundState?.priorReplies.every((reply) => reply.gist.length > 0)).toBe(
      true,
    );
  });

  it("treats non-targeted speakers as observers when the user addresses someone else", () => {
    const prepared = prepareScenario("fine_dining_observer_reaction");
    const groupSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "group_round_state",
    );

    expect(prepared.groupRoundState?.addressedParticipants).toEqual(["Pooja"]);
    expect(prepared.groupRoundState?.latestUserSocialTone).toBe("provocative");
    expect(prepared.groupRoundState?.currentSpeakerRole).toBe("observer_to_other_address");
    expect(prepared.groupRoundState?.engagementExpectation).toBe("none");
    expect(prepared.groupRoundState?.currentSocialBeat).toMatch(/provocative\/flirtatious/i);
    expect(prepared.groupRoundState?.expectedSocialMove).toMatch(/hearing.*Pooja/i);
    expect(prepared.groupRoundState?.currentSpeakerObligations.join(" ")).toMatch(
      /addressed to Pooja, not you/i,
    );
    expect(prepared.reactionPlan.primaryGoal).toMatch(/observing participant/i);
    expect(prepared.reactionPlan.forbiddenMoves.join(" ")).toMatch(/stale practical topic/i);
    expect(groupSection?.content).toContain(
      "The user's latest line appears to address: Pooja",
    );
    expect(groupSection?.content).toContain("Latest user social tone: provocative");
    expect(groupSection?.content).toContain(
      "Current speaker position: observer_to_other_address",
    );
  });

  it("surfaces the live topic for observer turns instead of leaving it implicit", () => {
    const prepared = prepareScenario("supermarket_observer_topic_grounding");
    const groupSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "group_round_state",
    );

    expect(prepared.groupRoundState?.addressedParticipants).toEqual(["Pooja"]);
    expect(prepared.groupRoundState?.currentSpeakerRole).toBe("observer_to_other_address");
    expect(prepared.groupRoundState?.currentTopicLabel).toContain("parmesan");
    expect(prepared.groupRoundState?.currentTopicCueTokens).toEqual(
      expect.arrayContaining(["parmesan", "cheese"]),
    );
    expect(prepared.groupRoundState?.currentSpeakerObligations.join(" ")).toMatch(
      /live topic already on the floor/i,
    );
    expect(prepared.reactionPlan.forbiddenMoves.join(" ")).toMatch(
      /out of nowhere/i,
    );
    expect(groupSection?.content).toContain("Current topic on the floor:");
    expect(groupSection?.content).toContain("Expected social move:");
  });

  it("detects mid-clause direct address and marks earlier roster speakers as observers", () => {
    const prepared = prepareScenario("music_driver_direct_address");
    const groupSection = prepared.compiledPrompt.systemSections.find(
      (section) => section.key === "group_round_state",
    );

    expect(prepared.groupRoundState?.addressedParticipants).toEqual(["Lara Lightland"]);
    expect(prepared.groupRoundState?.currentSpeakerRole).toBe("observer_to_other_address");
    expect(prepared.groupRoundState?.currentTopicLabel).toContain("change music");
    expect(prepared.groupRoundState?.currentSpeakerObligations.join(" ")).toMatch(
      /not as the person carrying out the request/i,
    );
    expect(prepared.reactionPlan.primaryGoal).toMatch(/observing participant/i);
    expect(prepared.reactionPlan.forbiddenMoves.join(" ")).toMatch(
      /driver|addressee/i,
    );
    expect(groupSection?.content).toContain(
      "The user's latest line appears to address: Lara Lightland",
    );
  });

  it("flags later-speaker copying of earlier same-round wording", () => {
    const prepared = prepareScenario("indian_restaurant_downstream_copying");
    const result = evaluateCharacterReply({
      reply:
        "Oh! Well... you can't just eat Priyanka like that. It needs to be more... interesting.",
      speakerName: "Priyanka",
      latestUserMessage:
        "What do you wanna eat Pooja? I just want to eat priyanka tonight I say naughilty",
      prepared,
    });

    expect(prepared.groupRoundState?.addressedParticipants).toEqual(["Pooja"]);
    expect(prepared.groupRoundState?.currentSpeakerRole).toBe("observer_to_other_address");
    expect(result.reasons).toContain("same_round_copying");
    expect(result.retryRequested).toBe(true);
  });

  it("flags later speakers that answer like fresh first speakers instead of building on the live room beat", () => {
    const prepared = prepareScenario("shopping_mall_sneakers_downstreaming");
    const result = evaluateCharacterReply({
      reply:
        "Oh! That sounds so much fun! Have you thought about which brand or style you'd like? I've got some really cool ones that could go great with our outfits!",
      speakerName: "Priyanka",
      latestUserMessage: "I wanna buy some sneakers I say excitingly",
      prepared,
    });

    expect(prepared.groupRoundState?.engagementExpectation).toBe("required");
    expect(result.reasons).toContain("same_round_non_engagement");
    expect(result.retryRequested).toBe(true);
  });

  it("flags later speakers that ignore a required same-round social beat", () => {
    const prepared = prepareScenario("mercedes_showroom_priyanka_car");
    const result = evaluateCharacterReply({
      reply: '"Mercedes interiors usually feel expensive."',
      speakerName: "Angelina",
      latestUserMessage: "I like the red one Priyanka, buy that one I say excitingly",
      prepared,
    });

    expect(prepared.groupRoundState?.engagementExpectation).toBe("required");
    expect(result.reasons).toContain("same_round_non_engagement");
    expect(result.retryRequested).toBe(true);
  });

  it("preserves beach-scene downstream context without re-promoting unrelated profile facts", () => {
    const prepared = prepareScenario("beach_picnic_dolphin");

    expect(prepared.groupRoundState?.priorReplies.map((reply) => reply.speakerName)).toEqual([
      "Lara Lightland",
      "Pooja",
    ]);
    expect(prepared.groupRoundState?.engagementExpectation).toBe("required");
    expect(prepared.sceneState?.visibleFacts.join(" | ")).not.toContain(
      "Relevant saved user profile fact:",
    );
    expect(prepared.reactionPlan.mustAddress.join(" ")).not.toMatch(
      /saved user-profile fact/i,
    );
  });

  it("rejects intimate physical escalation in the platonic restaurant boundary scenario", () => {
    const prepared = prepareScenario("restaurant_steak_platonic_boundary");
    const result = evaluateCharacterReply({
      reply:
        "Priyanka leans over and places her hand on John Smith's thigh, smiling as she asks what else he wants.",
      speakerName: "Priyanka",
      latestUserMessage: "I think I am gonna order a steak *I say looking at the menu*",
      prepared,
    });

    expect(result.reasons).toContain("relationship_tone_violation");
    expect(result.retryRequested).toBe(true);
  });

  it("rejects pizzeria replies that overwrite the user's choice or act like venue staff", () => {
    const prepared = prepareScenario("pizzeria_choice_overwrite_companion_scene");
    const scenario = getGroupRegressionScenario("pizzeria_choice_overwrite_companion_scene");
    const pooja = scenario.characters.find((character) => character.name === "Pooja");

    expect(prepared.context.explicitUserChoice?.surfaceText).toBe("cheese pizza");
    expect(prepared.sceneState?.sceneRoleExpectation).toBe("companions");

    const overwriteResult = evaluateCharacterReply({
      reply:
        "\"Cheese pizza, huh? Well then it's settled. You've got yourself a large pepperoni pizza with extra mozzarella.\" *She begins writing down the order on her notepad.*",
      speakerName: "Lara Lightland",
      latestUserMessage: "I wanna have cheese pizza I say looking at the menu card",
      prepared,
    });

    expect(overwriteResult.reasons).toContain("user_choice_overwrite");
    expect(overwriteResult.reasons).toContain("scene_role_drift");
    expect(overwriteResult.retryRequested).toBe(true);

    const poisonedDownstreamResult = evaluateCharacterReply({
      reply:
        "\"Oh my gosh, yes, let's get that large pepperoni with extra mozzarella.\" *She starts writing down her order too.*",
      speakerName: "Pooja",
      latestUserMessage: "I wanna have cheese pizza I say looking at the menu card",
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          speaker: pooja,
        },
      },
    });

    expect(poisonedDownstreamResult.reasons).toContain("user_choice_overwrite");
    expect(poisonedDownstreamResult.reasons).toContain("scene_role_drift");
  });

  it("rejects cafe replies that script the user or replace the live scene", () => {
    const prepared = prepareScenario("cafe_coffee_scene_drift");
    const scenario = getGroupRegressionScenario("cafe_coffee_scene_drift");
    const priyanka = scenario.characters.find((character) => character.name === "Priyanka");

    const yulianResult = evaluateCharacterReply({
      reply:
        "(You turn your head slightly, catching a glimpse of John's outstretched hand. Your eyes widen with surprise at the sudden interruption.) Oh? A knight in shining armor seeks respite from the heat? Pray tell, what brings you here today?",
      speakerName: "Yulian",
      latestUserMessage:
        "I wanna have a coffee I say while looking at a woman on the other table",
      prepared,
    });

    expect(yulianResult.reasons).toContain("user_agency_violation");
    expect(yulianResult.retryRequested).toBe(true);
    expect(yulianResult.suppressPreview).toBe(true);

    const priyankaResult = evaluateCharacterReply({
      reply:
        "Sighs softly, running a hand through your hair. Oh, John... You've been here the whole time? What are you doing in my room?",
      speakerName: "Priyanka",
      latestUserMessage:
        "I wanna have a coffee I say while looking at a woman on the other table",
      prepared: {
        ...prepared,
        context: {
          ...prepared.context,
          speaker: priyanka,
        },
      },
    });

    expect(priyankaResult.reasons).toContain("scene_replacement_drift");
    expect(priyankaResult.retryRequested).toBe(true);
    expect(priyankaResult.suppressPreview).toBe(true);
  });
});
