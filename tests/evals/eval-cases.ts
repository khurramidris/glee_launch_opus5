import type {
  Character,
  ChatMessage,
  MemorySnippet,
  UserProfile,
} from "../../src/types";

const timestamp = "2000-01-01T00:00:00.000Z";

export const evalModel = "ternary-bonsai-2-4b-pq2_0";

export const defaultUserProfile: UserProfile = {
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

export interface EvalCase {
  id: string;
  speaker: Character;
  history: ChatMessage[];
  userProfile?: UserProfile;
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
  // At least one of these must appear in the final reply.
  expectedTerms: string[];
  // Every one of these must appear in the final reply.
  requiredTerms?: string[];
  // None of these may appear in the final reply.
  forbiddenTerms?: string[];
}

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

// Builds an alternating user/assistant history from plain lines.
function conversation(prefix: string, lines: string[], firstRole: "user" | "assistant" = "user") {
  return lines.map((line, index) =>
    message(
      `${prefix}${index + 1}`,
      (index % 2 === 0) === (firstRole === "user") ? "user" : "assistant",
      line,
    ),
  );
}

// A remembered item as the recall path delivers it to the prompt.
function memoryItem(id: string, content: string): MemorySnippet {
  return {
    chatId: "eval-chat",
    messageId: `memory-item:${id}`,
    source: "memory-item",
    role: "system",
    content,
    createdAt: timestamp,
    score: 90,
  };
}

const mira = character({ id: "mira", name: "Mira" });
const nova = character({
  id: "nova",
  name: "Nova",
  description: "Nova is a warm, perceptive companion who listens before she advises.",
  personality: "Warm, gently humorous, and emotionally intelligent.",
  speechStyle: "Friendly and natural, two or three sentences at a time.",
});

const groupMembers = {
  names: ["Ben", "Kofi", "Ayla"],
  directory: { ben: "Ben", kofi: "Kofi", ayla: "Ayla" },
};

export const evalCases: EvalCase[] = [
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
    speaker: mira,
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
    id: "memory-item-allergy",
    speaker: nova,
    history: [
      message("u2a", "user", "I'm putting together a snack plate for the party. What should I keep off it for me?"),
    ],
    semanticMemorySnippets: [memoryItem("allergy", "Sam is allergic to peanuts")],
    expectedTerms: ["peanut", "peanuts", "nut", "nuts", "allerg"],
  },
  {
    id: "memory-item-promise",
    speaker: mira,
    history: [message("u2b", "user", "Do you remember what you promised me last time?")],
    semanticMemorySnippets: [memoryItem("promise", "Mira promised to teach Sam chess on Sunday")],
    expectedTerms: ["chess"],
    requiredTerms: ["chess"],
  },
  {
    id: "memory-item-pet",
    speaker: nova,
    history: [message("u2c", "user", "What's my dog's name again? It's slipped my mind.")],
    semanticMemorySnippets: [
      memoryItem("pet", "Sam's dog is named Juniper"),
      memoryItem("hobby", "Sam plays the cello on weekends"),
    ],
    expectedTerms: ["juniper"],
    requiredTerms: ["juniper"],
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
  {
    id: "greeting-hi",
    speaker: nova,
    history: [message("u5", "user", "hi")],
    expectedTerms: ["hi", "hello", "hey", "there", "good", "welcome", "glad", "nice"],
    forbiddenTerms: ["as an ai", "language model"],
  },
  {
    id: "greeting-named",
    speaker: mira,
    history: [message("u6", "user", "Hello Mira!")],
    expectedTerms: ["hello", "hi", "hey", "sam", "good", "morning", "evening"],
    forbiddenTerms: ["as an ai", "language model"],
  },
  {
    id: "one-word-answer",
    speaker: mira,
    history: [
      message("a7", "assistant", "Tea or coffee while you wait?"),
      message("u7", "user", "Coffee."),
    ],
    expectedTerms: ["coffee", "black", "cup", "mug", "brew", "pour", "strong"],
  },
  {
    id: "one-word-yes",
    speaker: mira,
    history: [
      message("a8", "assistant", "Do you want me to lock up the archive for the night?"),
      message("u8", "user", "Yes."),
    ],
    expectedTerms: ["lock", "archive", "night", "door", "done", "okay", "alright", "right", "will"],
  },
  {
    id: "emotional-support",
    speaker: nova,
    history: [
      message("u9", "user", "I had a terrible day and I feel like I'm failing at everything."),
    ],
    expectedTerms: ["sorry", "hear", "rough", "tough", "hard", "here", "listen", "feel", "day"],
    forbiddenTerms: ["as an ai", "language model"],
  },
  {
    id: "card-question",
    speaker: character({
      id: "ilsa",
      name: "Ilsa",
      description:
        "Ilsa Varga is the weathered keeper of the Gull Rock lighthouse. She lives alone with a ginger cat named Biscuit and a brass lantern she inherited from her father.",
      personality: "Gruff, loyal, and quietly funny.",
      speechStyle: "Plain, salty, short sentences.",
      scenario: "Ilsa is trimming the lantern wick in the lighthouse at dusk.",
    }),
    history: [message("u10", "user", "What's your cat called?")],
    expectedTerms: ["biscuit"],
    requiredTerms: ["biscuit"],
  },
  {
    id: "history-recall",
    speaker: nova,
    history: [
      message("u11", "user", "My sister's wedding is in Lisbon in June, and I still have nothing to wear."),
      message("a11", "assistant", "Lisbon in June sounds lovely. We can sort out an outfit together."),
      message("u12", "user", "Remind me, where is the wedding again?"),
    ],
    expectedTerms: ["lisbon"],
    requiredTerms: ["lisbon"],
  },
  {
    id: "roleplay-actions",
    speaker: character({
      id: "tobin",
      name: "Tobin",
      description:
        "Tobin keeps the Gilded Lantern, a cozy inn at a rainy crossroads. He is cheerful, nosy, and always polishing a mug.",
      personality: "Cheerful, chatty, and hospitable.",
      speechStyle: "Warm and folksy. Describes small actions between *asterisks*.",
      scenario: "A stormy evening at the Gilded Lantern inn.",
    }),
    history: [
      message("u13", "user", "*I push open the heavy oak door and step inside, shaking the rain off my coat.*"),
    ],
    expectedTerms: ["rain", "door", "coat", "inside", "welcome", "dry", "fire", "evening", "come", "storm"],
  },
  {
    id: "explicit-choice",
    speaker: character({
      id: "odile",
      name: "Odile",
      description: "Odile runs a small scarf stall at the night market.",
      personality: "Brisk, friendly, and a little theatrical.",
      speechStyle: "Quick, upbeat sentences.",
      scenario: "A lantern-lit stall at the night market.",
    }),
    history: [
      message(
        "a14",
        "assistant",
        "Welcome in! I have two scarves left: a red one and a blue one. Which will it be?",
      ),
      message("u14", "user", "I'll take the red one."),
    ],
    expectedTerms: ["red"],
    requiredTerms: ["red"],
  },
  {
    id: "long-history",
    speaker: nova,
    history: conversation("h", [
      "I'm thinking about a long weekend away next month.",
      "That sounds like exactly what you need. Mountains, coast, or a city?",
      "Somewhere quiet. Maybe a small village.",
      "A quiet village is a great call. Any region in mind?",
      "I keep reading about Tollbridge, up in the hills.",
      "Tollbridge looks beautiful. It has a stone bridge and a tiny tea room.",
      "Is it easy to reach without a car?",
      "There is a morning train, then a short bus ride from the station.",
      "Good. I'd want to leave on Friday and be back on Sunday.",
      "Friday to Sunday is plenty of time to see the village and relax.",
      "I should book somewhere to stay soon.",
      "Yes, small inns fill up fast in the autumn.",
      "Let me go and pack a bag first.",
      "Good idea. Take a warm jacket, the hills get chilly.",
      "Okay, I'm back. Which village did we decide on again?",
    ]),
    expectedTerms: ["tollbridge"],
    requiredTerms: ["tollbridge"],
  },
  {
    id: "example-dialogue",
    speaker: character({
      id: "redd",
      name: "Captain Redd",
      description: "Captain Redd is a boisterous sea captain who has sailed every ocean twice.",
      personality: "Bold, jovial, and fond of the sea.",
      speechStyle: "Pirate cant: 'Ahoy', 'matey', 'ye', and 'aye'.",
      scenario: "The deck of the Salt Gull at sunrise.",
      exampleDialogue: [
        "{{user}}: Hello there.",
        "{{char}}: Ahoy, matey! Ye look like ye've weathered a squall.",
        "{{user}}: How are you?",
        "{{char}}: Salty and sound as ever, lad! The sea is kind this morning.",
      ].join("\n"),
    }),
    history: [message("u16", "user", "Good morning, captain.")],
    expectedTerms: ["ahoy", "aye", "matey", "ye", "lad", "lass", "morning", "sea", "salty"],
  },
  {
    id: "persona-user-name",
    speaker: mira,
    userProfile: {
      ...defaultUserProfile,
      name: "Priya",
      about: "Priya is a marine biologist who studies kelp forests.",
      gender: "woman",
      traits: ["curious"],
      preferences: "",
    },
    history: [message("u17", "user", "Quick check: do you remember my name and what I do for work?")],
    expectedTerms: ["priya"],
    requiredTerms: ["priya"],
  },
  {
    id: "group-addresses-other-member",
    speaker: character({ id: "marco", name: "Marco", personality: "Easygoing and observant." }),
    history: [message("u18", "user", "Lena, could you pass me the salt?")],
    mode: "group",
    participantNames: ["Marco", "Lena"],
    participantDirectory: { marco: "Marco", lena: "Lena" },
    expectedTerms: ["salt", "lena", "pass"],
    forbiddenTerms: ["Lena:", "Marco:"],
  },
  {
    id: "group-asks-about-other-member",
    speaker: character({ id: "ben", name: "Ben", personality: "Dry, calm, and observant." }),
    history: [
      message("u19", "user", "What should we cook tonight?"),
      message("a19", "assistant", "Let's make jollof rice.", "kofi"),
      message("u20", "user", "Ben, what did Kofi suggest?"),
    ],
    mode: "group",
    participantNames: groupMembers.names,
    participantDirectory: groupMembers.directory,
    expectedTerms: ["jollof", "rice", "kofi"],
    requiredTerms: ["jollof"],
    forbiddenTerms: ["pasta"],
  },
  {
    id: "group-open-question",
    speaker: character({ id: "ayla", name: "Ayla", personality: "Practical and quick to help." }),
    history: [message("u21", "user", "Does anyone here know how to fix a bicycle chain?")],
    mode: "group",
    participantNames: ["Ayla", "Kofi", "Ben"],
    participantDirectory: groupMembers.directory,
    expectedTerms: ["chain", "bike", "bicycle", "fix", "yes", "know", "help", "tool"],
  },
  {
    id: "group-follows-earlier-replies",
    speaker: character({ id: "ben", name: "Ben", personality: "Dry, calm, and observant." }),
    history: [
      message("u22", "user", "Which movie should we watch tonight?"),
      message("a22", "assistant", "Something funny. A comedy would be perfect.", "kofi"),
      message("a23", "assistant", "I'd rather watch a thriller, honestly.", "ayla"),
    ],
    mode: "group",
    participantNames: groupMembers.names,
    participantDirectory: groupMembers.directory,
    expectedTerms: ["comedy", "thriller", "movie", "watch", "funny", "kofi", "ayla", "both", "either"],
    forbiddenTerms: ["Kofi:", "Ayla:"],
  },
];
