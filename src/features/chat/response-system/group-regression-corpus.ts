import type {
  Character,
  ChatMessage,
  ChatRelationshipState,
  UserProfile,
} from "../../../types";

export interface GroupRegressionScenario {
  id: string;
  title: string;
  targetSpeakerId: string;
  participantIds: string[];
  characters: Character[];
  history: ChatMessage[];
  userProfile: UserProfile;
  relationshipState: ChatRelationshipState;
}

function makeCharacter(input: {
  id: string;
  name: string;
  description: string;
  personality: string;
  speechStyle: string;
  tags: string[];
}): Character {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    personality: input.personality,
    backstory: "",
    scenario: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    speechStyle: input.speechStyle,
    greeting: "",
    alternateGreetings: [],
    avatar: "",
    tags: input.tags,
    likes: [],
    dislikes: [],
    boundaries: "",
    creatorNotes: "",
    creator: "",
    characterVersion: "",
    cardExtensions: {},
    exampleDialogue: "",
    createdAt: "2000-04-16T00:00:00.000Z",
    updatedAt: "2000-04-16T00:00:00.000Z",
  };
}

function makeUserProfile(input: {
  name: string;
  about: string;
  gender?: string;
}): UserProfile {
  return {
    name: input.name,
    about: input.about,
    gender: input.gender ?? "",
    avatar: "",
    traits: [],
    preferences: "",
    boundaries: "",
    createdAt: "2000-04-16T00:00:00.000Z",
    updatedAt: "2000-04-16T00:00:00.000Z",
  };
}

function makeRelationshipState(input: {
  currentScene: string;
  summary: string;
  interactionTone: string;
}): ChatRelationshipState {
  return {
    chatId: "chat-group-regression",
    summary: input.summary,
    currentScene: input.currentScene,
    interactionTone: input.interactionTone,
    characterState: "",
    userState: "",
    userRoleName: "",
    userRoleDescription: "",
    updatedAt: "2000-04-16T00:00:00.000Z",
  };
}

const lara = makeCharacter({
  id: "char-lara",
  name: "Lara Lightland",
  description: "A smart, polished scientist who notices details and keeps composure.",
  personality: "Curious, warm when comfortable, observant under pressure.",
  speechStyle: "Polite, articulate, lightly formal.",
  tags: ["observant", "composed", "curious"],
});

const pooja = makeCharacter({
  id: "char-pooja",
  name: "Pooja",
  description: "Expressive and socially bold, with a playful edge.",
  personality: "Playful, teasing, socially agile, emotionally legible.",
  speechStyle: "Expressive, casual, playful.",
  tags: ["playful", "teasing", "social"],
});

const priyanka = makeCharacter({
  id: "char-priyanka",
  name: "Priyanka",
  description: "Friendly, emotionally expressive, and quick to react to social cues.",
  personality: "Warm, excitable, impressionable, people-focused.",
  speechStyle: "Bright, conversational, eager.",
  tags: ["warm", "excitable", "friendly"],
});

const angelina = makeCharacter({
  id: "char-angelina",
  name: "Angelina",
  description: "Stylish, confident, and a little theatrical without losing social awareness.",
  personality: "Confident, stylish, socially aware, direct.",
  speechStyle: "Smooth, stylish, direct.",
  tags: ["confident", "stylish", "direct"],
});

const sajal = makeCharacter({
  id: "char-sajal",
  name: "Sajal",
  description: "Reactive and emotional, but still grounded in the live scene.",
  personality: "Reactive, expressive, impulsive, socially readable.",
  speechStyle: "Emotional, quick, informal.",
  tags: ["reactive", "expressive", "impulsive"],
});

const yulian = makeCharacter({
  id: "char-yulian",
  name: "Yulian",
  description: "Gentle, guarded, and aristocratic without becoming stiff.",
  personality: "Gentle, inward, polite, emotionally careful.",
  speechStyle: "Soft, measured, slightly formal.",
  tags: ["gentle", "formal", "guarded"],
});

export const GROUP_REGRESSION_SCENARIOS: GroupRegressionScenario[] = [
  {
    id: "mercedes_showroom_priyanka_car",
    title: "Mercedes showroom / Priyanka car-buying",
    targetSpeakerId: "char-angelina",
    participantIds: ["char-lara", "char-pooja", "char-priyanka", "char-angelina"],
    characters: [lara, pooja, priyanka, angelina],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "I am dressed like a medieval king.",
      gender: "Man",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are in a Mercedes showroom. Priyanka wants to buy a new car.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "ms-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "I like the red one Priyanka, buy that one I say excitingly",
        createdAt: "2000-04-16T03:14:00.000Z",
      },
      {
        id: "ms-assistant-1",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '"That red one really does stand out. If Priyanka wants something bold, it suits the moment."',
        speakerCharacterId: "char-lara",
        createdAt: "2000-04-16T03:16:00.000Z",
      },
      {
        id: "ms-assistant-2",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '"Ooh, red is daring. If she wants something that feels exciting, that one is hard to ignore."',
        speakerCharacterId: "char-pooja",
        createdAt: "2000-04-16T03:19:00.000Z",
      },
      {
        id: "ms-assistant-3",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '"I do like the red one. It feels lively, but I still want to hear what else is around before I commit."',
        speakerCharacterId: "char-priyanka",
        createdAt: "2000-04-16T03:20:00.000Z",
      },
    ],
  },
  {
    id: "candy_shop_downstreaming",
    title: "Candy shop / late-speaker downstreaming",
    targetSpeakerId: "char-sajal",
    participantIds: ["char-lara", "char-priyanka", "char-sajal"],
    characters: [lara, priyanka, sajal],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are standing in a candy shop.",
      summary: "Hostile",
      interactionTone: "Tense and reactive",
    }),
    history: [
      {
        id: "cs-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "I want candies I say shoutingly",
        createdAt: "2000-04-16T14:47:00.000Z",
      },
      {
        id: "cs-assistant-1",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '*Lara blinks at the outburst.* "You do not have to shout. Just point at what you want."',
        speakerCharacterId: "char-lara",
        createdAt: "2000-04-16T14:49:00.000Z",
      },
      {
        id: "cs-assistant-2",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '*Priyanka edges back from the shelf.* "Hey, calm down. We can figure it out without yelling."',
        speakerCharacterId: "char-priyanka",
        createdAt: "2000-04-16T14:50:00.000Z",
      },
    ],
  },
  {
    id: "beach_picnic_dolphin",
    title: "Beach picnic / dolphin follow-up",
    targetSpeakerId: "char-priyanka",
    participantIds: ["char-lara", "char-pooja", "char-priyanka"],
    characters: [lara, pooja, priyanka],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "I am dressed like a medieval king. I have a longbow in my hand.",
      gender: "Man",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are on a picnic, sitting at the beach.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "bp-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "Hey look over there, i see a dolphin *I say excitingly*",
        createdAt: "2000-04-16T14:10:00.000Z",
      },
      {
        id: "bp-assistant-1",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '*Lara smiles toward the water.* "Dolphins this close to shore are a lovely surprise."',
        speakerCharacterId: "char-lara",
        createdAt: "2000-04-16T14:12:00.000Z",
      },
      {
        id: "bp-assistant-2",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '"Oh wow, that really is adorable. It keeps popping back up like it wants an audience."',
        speakerCharacterId: "char-pooja",
        createdAt: "2000-04-16T14:14:00.000Z",
      },
    ],
  },
  {
    id: "restaurant_steak_platonic_boundary",
    title: "Restaurant steak order / platonic boundary",
    targetSpeakerId: "char-priyanka",
    participantIds: ["char-lara", "char-priyanka"],
    characters: [lara, priyanka],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
      gender: "Man",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are at a restaurant.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "rs-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "I think I am gonna order a steak *I say looking at the menu*",
        createdAt: "2000-04-16T16:55:00.000Z",
      },
      {
        id: "rs-assistant-1",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '"A steak makes sense here. If you want something hearty, that is the obvious choice."',
        speakerCharacterId: "char-lara",
        createdAt: "2000-04-16T16:57:00.000Z",
      },
    ],
  },
  {
    id: "pizzeria_choice_overwrite_companion_scene",
    title: "Pizzeria / user choice overwrite and companion-vs-staff drift",
    targetSpeakerId: "char-lara",
    participantIds: ["char-lara", "char-pooja"],
    characters: [lara, pooja],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are sitting in a pizzeria.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "pz-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "I wanna have cheese pizza I say looking at the menu card",
        createdAt: "2000-04-20T14:31:00.000Z",
      },
    ],
  },
  {
    id: "cafe_coffee_scene_drift",
    title: "Cafe / second-person scripting and live-scene replacement drift",
    targetSpeakerId: "char-yulian",
    participantIds: ["char-yulian", "char-priyanka"],
    characters: [yulian, priyanka],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
      gender: "Man",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are sitting in a cafe.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "cf-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content:
          "I wanna have a coffee I say while looking at a woman on the other table",
        createdAt: "2000-04-20T15:30:00.000Z",
      },
    ],
  },
  {
    id: "fine_dining_observer_reaction",
    title: "Fine dining / observer reaction to a remark aimed at someone else",
    targetSpeakerId: "char-lara",
    participantIds: ["char-lara", "char-pooja"],
    characters: [lara, pooja],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
      gender: "Man",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are in a fine dining restaurant.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "fd-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "Pooja I dont think you are appropriately dressed for this place *I say naughtily*",
        createdAt: "2000-04-16T18:11:00.000Z",
      },
    ],
  },
  {
    id: "indian_restaurant_downstream_copying",
    title: "Indian restaurant / later speaker copying earlier reply",
    targetSpeakerId: "char-priyanka",
    participantIds: ["char-pooja", "char-priyanka"],
    characters: [pooja, priyanka],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
      gender: "Man",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are sitting in an Indian restaurant.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "ir-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "What do you wanna eat Pooja? I just want to eat priyanka tonight I say naughilty",
        createdAt: "2000-04-17T14:19:00.000Z",
      },
      {
        id: "ir-assistant-1",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          "*Oh! Well, you can't just eat Priyanka like that. Let me see what I can do to make it more... interesting.* How about we order some spicy chicken tikka masala?",
        speakerCharacterId: "char-pooja",
        createdAt: "2000-04-17T14:22:00.000Z",
      },
    ],
  },
  {
    id: "supermarket_observer_topic_grounding",
    title: "Supermarket / observer topic grounding",
    targetSpeakerId: "char-lara",
    participantIds: ["char-lara", "char-pooja"],
    characters: [lara, pooja],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are standing in a supermarket.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "sm-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "I want to buy parmesan cheese, what do you want Pooja?",
        createdAt: "2000-04-18T14:50:00.000Z",
      },
    ],
  },
  {
    id: "shopping_mall_sneakers_downstreaming",
    title: "Shopping mall / later speaker should build on prior reply",
    targetSpeakerId: "char-priyanka",
    participantIds: ["char-yulian", "char-priyanka"],
    characters: [yulian, priyanka],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are at a shopping mall.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "small-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content: "I wanna buy some sneakers I say excitingly",
        createdAt: "2000-04-18T15:35:00.000Z",
      },
      {
        id: "small-assistant-1",
        chatId: "chat-group-regression",
        role: "assistant",
        content:
          '"Of course, we can start with the sneaker shops on this floor and narrow it down from there."',
        speakerCharacterId: "char-yulian",
        createdAt: "2000-04-18T15:38:00.000Z",
      },
    ],
  },
  {
    id: "music_driver_direct_address",
    title: "Music in car / direct address should prioritize the named driver",
    targetSpeakerId: "char-yulian",
    participantIds: ["char-yulian", "char-lara"],
    characters: [yulian, lara],
    userProfile: makeUserProfile({
      name: "John Smith",
      about: "",
    }),
    relationshipState: makeRelationshipState({
      currentScene: "We are driving towards my house. Music is playing in the car.",
      summary: "Friendly",
      interactionTone: "Friendly",
    }),
    history: [
      {
        id: "music-user-1",
        chatId: "chat-group-regression",
        role: "user",
        content:
          "Can you please change the music Lara, I say loudly to Lara who is driving",
        createdAt: "2000-04-20T16:02:00.000Z",
      },
    ],
  },
];

export function getGroupRegressionScenario(
  id: string,
): GroupRegressionScenario {
  const scenario = GROUP_REGRESSION_SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Unknown group regression scenario: ${id}`);
  }
  return scenario;
}
