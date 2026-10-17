import type {
  Character,
  ChatMemory,
  ChatMessage,
  ChatRelationshipState,
  ContextEntry,
  LlamaChatMessage,
  LlamaChatRequest,
  MemorySnippet,
  UserProfile,
} from "../../../types";

export type ResponseMode = "single" | "group" | "regenerate";
export type SceneTension = "low" | "medium" | "high";

export interface SceneStateInput {
  currentScene?: string;
  interactionTone?: string;
  characterState?: string;
  userState?: string;
  visibleFacts?: string[];
}

export interface DerivedSceneState {
  currentScene?: string;
  visibleFacts: string[];
  powerDynamic: string;
  tension: SceneTension;
  immediatePriority: string;
  sceneRoleExpectation?: "companions" | "service_possible" | "unknown";
}

export interface ResponseSalienceProfile {
  latestUserMoveWeight: number;
  liveSceneWeight: number;
  relationshipWeight: number;
  userProfileWeight: number;
  recentTurnWeight: number;
  memoryWeight: number;
  contextWeight: number;
  characterLoreWeight: number;
  suppressStaticScenario: boolean;
  prioritizeRelationshipTone: boolean;
  rankedFocus: Array<{
    key:
      | "latest_user_move"
      | "live_scene"
      | "relationship"
      | "user_profile"
      | "recent_turn"
      | "memory"
      | "world_context"
      | "character_lore";
    weight: number;
  }>;
}

export interface TurnInterpretation {
  actionType:
    | "armed-command"
    | "armed-question"
    | "threat"
    | "command"
    | "greeting"
    | "question"
    | "request"
    | "statement";
  intent: string;
  emotionalPressure: SceneTension;
  requiresImmediateReaction: boolean;
  antiParrotDirective: string;
}

export interface ExplicitUserChoice {
  kind: "selection" | "preference";
  surfaceText: string;
  anchorTokens: string[];
  headTokens: string[];
}

export type TurnFrameAction =
  | "greeting"
  | "search"
  | "choice"
  | "request"
  | "question"
  | "statement";

export type TurnFrameTone =
  | "neutral"
  | "friendly"
  | "uncertain"
  | "urgent"
  | "playful"
  | "flirtatious"
  | "provocative"
  | "frustrated";

export type TurnFrameResponseObligation =
  | "acknowledge_greeting"
  | "answer_direct_address"
  | "help_with_search"
  | "honor_user_choice"
  | "honor_scene_correction"
  | "honor_scene_transition"
  | "answer_question"
  | "respond_to_request"
  | "continue_conversation";

export interface TurnFrame {
  latestUserMessage: string;
  addressedParticipants: string[];
  userAction: TurnFrameAction;
  topic: string | null;
  concreteChoice: string | null;
  boundaryCue: boolean;
  stopInstruction: string | null;
  sceneAssertion: string | null;
  sceneTransition: string | null;
  visibleSearchCue: boolean;
  locationTarget: string | null;
  emotionalTone: TurnFrameTone;
  liveActionCueTokens: string[];
  responseObligation: TurnFrameResponseObligation;
}

export interface HarnessResponsePlan {
  mustAcknowledge: string[];
  mustAvoid: string[];
  sceneAnchor: string;
  personaAnchor: string;
  groupObligation?: string;
  distinctContribution?: string;
  outputContract: string;
}

export interface GroupRoundReplySummary {
  speakerCharacterId?: string;
  speakerName: string;
  gist: string;
  socialEffect: string;
  emotionalTone: string;
}

export type GroupRoundEngagementExpectation =
  | "none"
  | "light"
  | "required";

export interface GroupRoundState {
  rosterOrder: string[];
  priorReplies: GroupRoundReplySummary[];
  addressedParticipants: string[];
  latestUserSocialTone: TurnFrameTone;
  currentSpeakerRole:
    | "directly_addressed"
    | "observer_to_other_address"
    | "shared_group";
  currentTopicLabel: string;
  currentTopicCueTokens: string[];
  currentSocialBeat: string;
  expectedSocialMove: string;
  engagementExpectation: GroupRoundEngagementExpectation;
  engagementTargets: string[];
  engagementCueTokens: string[];
  currentSpeakerObligations: string[];
}

export type PromptSectionKey =
  | "system_contract"
  | "turn_frame"
  | "response_contract"
  | "character_identity"
  | "identity_guardrails"
  | "character_rules"
  | "character_scene"
  | "character_dynamics"
  | "response_style"
  | "latest_user_move"
  | "group_round_state"
  | "reaction_plan"
  | "user_profile"
  | "relationship_state"
  | "dynamic_scene_state"
  | "turn_interpretation"
  | "world_context"
  | "memory_summary"
  | "memory_snippets"
  | "example_dialogue_notes";

export interface PromptSection {
  key: PromptSectionKey;
  content: string;
  priority: number;
}

export interface PromptDialogueExample {
  role: Exclude<LlamaChatMessage["role"], "system" | "tool">;
  content: string;
  source: "example_dialogue";
}

export interface CompiledResponseRequestInput {
  runtimeModel?: string;
  speaker?: Character;
  userProfile?: UserProfile;
  relationshipState?: ChatRelationshipState;
  mode?: ResponseMode;
  isRegeneration?: boolean;
  previousAssistantReply?: string;
  participantNames?: string[];
  participantDirectory?: Record<string, string>;
  memory?: ChatMemory;
  contextEntries: ContextEntry[];
  semanticMemorySnippets?: MemorySnippet[];
  history: ChatMessage[];
  sceneState?: DerivedSceneState | null;
  turnInterpretation?: TurnInterpretation | null;
  turnFrame?: TurnFrame | null;
  responsePlan?: HarnessResponsePlan | null;
  reactionPlan?: CharacterReactionPlan | null;
  salienceProfile?: ResponseSalienceProfile | null;
  groupRoundState?: GroupRoundState | null;
}

export interface CompiledCharacterPrompt {
  systemSections: PromptSection[];
  systemPromptMaxLength?: number;
  exampleMessages: PromptDialogueExample[];
  historyMessages: LlamaChatMessage[];
}

export interface RuntimeSamplingProfile {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  repeatPenalty?: number;
}

export interface ResponseSystemInput {
  speaker?: Character;
  userProfile?: UserProfile;
  relationshipState?: ChatRelationshipState;
  participantNames?: string[];
  participantDirectory?: Record<string, string>;
  isRegeneration?: boolean;
  previousAssistantReply?: string;
  sceneStateInput?: SceneStateInput | null;
  memory?: ChatMemory;
  contextEntries: ContextEntry[];
  semanticMemorySnippets?: MemorySnippet[];
  history: ChatMessage[];
  sampling: RuntimeSamplingProfile;
  runtime: {
    model: string;
    stream: boolean;
  };
  mode?: ResponseMode;
}

export interface ResponseContext {
  speaker?: Character;
  userProfile?: UserProfile;
  relationshipState?: ChatRelationshipState;
  participantNames?: string[];
  participantDirectory?: Record<string, string>;
  sceneStateInput?: SceneStateInput | null;
  memory?: ChatMemory;
  contextEntries: ContextEntry[];
  semanticMemorySnippets: MemorySnippet[];
  history: ChatMessage[];
  latestUserMessage?: string;
  mode: ResponseMode;
  isRegeneration?: boolean;
  previousAssistantReply?: string;
  explicitUserChoice?: ExplicitUserChoice | null;
  turnFrame?: TurnFrame | null;
  responsePlan?: HarnessResponsePlan | null;
  sceneState?: DerivedSceneState | null;
  turnInterpretation?: TurnInterpretation | null;
  salienceProfile?: ResponseSalienceProfile | null;
  groupRoundState?: GroupRoundState | null;
}

export interface CharacterReactionPlan {
  strategy: "v2";
  immediateObjective: string;
  primaryGoal: string;
  responseStrategy: string;
  interactionStance: string;
  emotionalPosture: string;
  sceneFocus: string;
  replyOpening: string;
  salientFacts: string[];
  continuityAnchors: string[];
  mustAddress: string[];
  styleAnchors: string[];
  forbiddenMoves: string[];
}

export interface MemorySelection {
  contextEntries: ContextEntry[];
  semanticMemorySnippets: MemorySnippet[];
  retrievalHints?: string;
}

export interface PreparedResponseRequest {
  context: ResponseContext;
  sceneState: DerivedSceneState | null;
  turnInterpretation: TurnInterpretation | null;
  turnFrame: TurnFrame | null;
  responsePlan: HarnessResponsePlan | null;
  salienceProfile: ResponseSalienceProfile;
  groupRoundState: GroupRoundState | null;
  reactionPlan: CharacterReactionPlan;
  memorySelection: MemorySelection;
  compiledPrompt: CompiledCharacterPrompt;
  runtimeRequest: LlamaChatRequest;
}

export type ResponseEvaluationReason =
  | "meta_reasoning"
  | "third_person_self_narration"
  | "insufficient_substance"
  | "incomplete_sentence"
  | "repeated_opening"
  | "user_choice_overwrite"
  | "scene_replacement_drift"
  | "observer_role_violation"
  | "same_round_copying"
  | "same_round_non_engagement"
  | "static_lore_echo"
  | "other_participant_impersonation"
  | "user_echo"
  | "placeholder_leak"
  | "role_inversion"
  | "transcript_leakage"
  | "scene_role_drift"
  | "generic_assistant_drift"
  | "generic_user_reference"
  | "user_agency_violation"
  | "relationship_tone_violation"
  | "missed_immediate_reaction"
  | "empty_after_sanitize"
  | "policy_retry_requested"
  | "repair_applied"
  | "repair_failed"
  | "fallback_used";

export interface ResponseEvaluation {
  accepted: boolean;
  repaired: boolean;
  retryRequested: boolean;
  qualityScore: number;
  reasons: ResponseEvaluationReason[];
  rawReply: string;
  finalReply: string;
}
