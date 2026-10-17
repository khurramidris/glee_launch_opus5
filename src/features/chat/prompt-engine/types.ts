import type {
  Character,
  ChatMemory,
  ChatMessage,
  ChatRelationshipState,
  ContextEntry,
  MemorySnippet,
  UserProfile,
} from "../../../types";
import type {
  CompiledCharacterPrompt,
  PromptDialogueExample,
  PromptSection,
  PromptSectionKey,
  RuntimeSamplingProfile,
} from "../response-system/types";

export type { CompiledCharacterPrompt, PromptDialogueExample, PromptSection, PromptSectionKey, RuntimeSamplingProfile };

export interface CompiledCharacterPromptInput {
  speaker?: Character;
  userProfile?: UserProfile;
  relationshipState?: ChatRelationshipState;
  memory?: ChatMemory;
  contextEntries: ContextEntry[];
  semanticMemorySnippets?: MemorySnippet[];
  history: ChatMessage[];
}

export interface RetrievalHintInput {
  speaker?: Character;
  userProfile?: UserProfile;
  relationshipState?: ChatRelationshipState;
}
