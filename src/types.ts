export type MessageRole = "system" | "user" | "assistant" | "tool";
export type ChatMode = "single" | "group";

export interface ModelInfo {
  id: string;
  name: string;
  path: string;
  sha256: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type FirstRunPreparationStatus = "ready";

export interface ResourceStatusItem {
  key: string;
  label: string;
  sizeBytes: number;
  installed: boolean;
  optional: boolean;
}

export interface ResourceStatus {
  ready: boolean;
  platform: string;
  platformSupported: boolean;
  missingRequiredBytes: number;
  items: ResourceStatusItem[];
}

export interface FirstRunPreparation {
  status: FirstRunPreparationStatus;
  resourceDir: string;
  downloadedAssets: number;
  reusedAssets: number;
  totalAssets: number;
  message: string;
}

export type ProvisioningProgressPhase =
  | "planning"
  | "checking_disk"
  | "downloading"
  | "verifying"
  | "installing"
  | "ready"
  | "cancelled"
  | "failed";

export interface ProvisioningProgress {
  jobId: string;
  phase: ProvisioningProgressPhase;
  currentFile?: string | null;
  fileBytes: number;
  fileTotalBytes?: number | null;
  aggregateBytes: number;
  aggregateTotalBytes?: number | null;
  completedObjects: number;
  totalObjects: number;
  retryCount: number;
  message?: string | null;
}

export interface Character {
  id: string;
  name: string;
  description: string;
  personality?: string;
  backstory?: string;
  scenario?: string;
  systemPrompt: string;
  postHistoryInstructions?: string;
  speechStyle?: string;
  greeting?: string;
  alternateGreetings: string[];
  avatar?: string;
  tags: string[];
  likes: string[];
  dislikes: string[];
  boundaries?: string;
  creatorNotes?: string;
  creator?: string;
  characterVersion?: string;
  cardExtensions?: Record<string, unknown>;
  exampleDialogue?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  characterId?: string;
  chatMode: ChatMode;
  participantIds: string[];
  historyEpoch: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  speakerCharacterId?: string;
  createdAt: string;
}

export interface ChatMemory {
  chatId: string;
  summary: string;
  facts: string[];
  updatedAt: string;
}

export interface UserProfile {
  name: string;
  about: string;
  gender: string;
  avatar: string;
  traits: string[];
  preferences: string;
  boundaries: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatRelationshipState {
  chatId: string;
  summary: string;
  currentScene: string;
  interactionTone: string;
  characterState: string;
  userState: string;
  userRoleName: string;
  userRoleDescription: string;
  updatedAt: string;
}

export interface BootstrapState {
  models: ModelInfo[];
  characters: Character[];
  chats: ChatSummary[];
  userProfile: UserProfile;
  runtime: RuntimeState;
}

export interface MemorySnippet {
  chatId: string;
  messageId?: string;
  role: MessageRole;
  content: string;
  speakerCharacterId?: string;
  createdAt: string;
  score: number;
}

export interface ContextEntry {
  id: string;
  scope: "global" | "character";
  characterId?: string;
  title: string;
  keywords: string[];
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeState {
  status: "stopped" | "starting" | "running" | "error";
  endpoint: string;
  port?: number;
  pid?: number;
  activeModelId?: string;
  startedAt?: string;
  logFile?: string;
  error?: string;
  selection?: RuntimeSelectionInfo;
  /** Per-launch key required by the local llama-server. */
  apiKey?: string;
}

export type RuntimePerformanceMode = "auto" | "cpu" | "gpu";
export type RuntimeBackend = "cpu" | "cuda" | "vulkan" | "metal";

export interface DetectedGpuDevice {
  id?: string;
  name: string;
  vendor?: string;
  driverVersion?: string;
  totalVramMb?: number;
  freeVramMb?: number;
  supportedBackends: RuntimeBackend[];
}

export interface RuntimeSelectionInfo {
  performanceMode: RuntimePerformanceMode;
  backend: RuntimeBackend;
  attemptedBackend?: RuntimeBackend;
  binaryPath: string;
  variantId?: string;
  runtimeVersion?: string;
  requestedGpuLayers: number;
  actualGpuLayers?: number;
  fallbackReason?: string;
  detectedGpus: DetectedGpuDevice[];
  backendLogSummary?: string;
}

export interface RuntimeLaunchSettings {
  warmupEnabled: boolean;
  performanceMode: RuntimePerformanceMode;
  gpuLayers: number;
  updatedAt: string;
}

export interface RuntimeStartupSettings {
  warmupEnabled: boolean;
  performanceMode: RuntimePerformanceMode;
  gpuLayers: number;
}

export type RuntimeLaunchSettingsRecord = RuntimeLaunchSettings;

export type HealthCheckStatus = "ok" | "warn" | "error";
export type IndexingHealthStatus = "healthy" | "pending" | "degraded" | "unavailable";

export interface HealthCheckRecord {
  key: string;
  label: string;
  status: HealthCheckStatus;
  detail: string;
  path?: string;
  required: boolean;
  recoverable: boolean;
}

export interface IndexingDiagnostics {
  status: IndexingHealthStatus;
  updatedAt: string;
  lastError?: string;
  lastIndexedMessageId?: string;
}

export interface StartupHealthSnapshot {
  checkedAt: string;
  overallStatus: HealthCheckStatus;
  appDataDir: string;
  databasePath: string;
  backupDir: string;
  lastMigrationBackupPath?: string;
  runtimeBinaryPath: string;
  sqliteVecAvailable: boolean;
  activeModelId?: string;
  activeModelPath?: string;
  embeddingModelId?: string;
  embeddingModelPath?: string;
  embeddingAvailable: boolean;
  indexing: IndexingDiagnostics;
  checks: HealthCheckRecord[];
}

export interface FeatureExposure {
  stable: string[];
  labs: string[];
}

export interface AppSettingEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  platform: string;
  runtime: RuntimeState;
  startup: StartupHealthSnapshot;
  settings: AppSettingEntry[];
  featureExposure: FeatureExposure;
  recentErrors: string[];
}

export interface DiagnosticsExportResponse {
  directory: string;
  summaryPath: string;
  runtimeLogPath?: string;
  databaseBackupPath?: string;
}

export interface DatabaseBackupResponse {
  path: string;
}

export interface DatabaseBackup {
  fileName: string;
  path: string;
  reason: "manual" | "pre-migration" | "pre-restore" | "other";
  sizeBytes: number;
  modifiedAt: string;
}

export interface DatabaseRestoreResponse {
  restoredFrom: string;
  safetyBackupPath: string;
}

export interface CharacterCardExportResponse {
  path: string;
}

export interface GenerationPreset {
  id: string;
  name: string;
  description?: string;
  temperature: number;
  topP: number;
  maxTokens?: number;
  repeatPenalty: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatPresetProfile {
  chatId: string;
  generationPresetId?: string;
  updatedAt: string;
}

export interface ChatCompletionDelta {
  content: string;
  finishReason?: string | null;
  usage?: LlamaTokenUsage;
}

export interface LlamaTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AppendMessagePayload {
  chatId: string;
  role: Exclude<MessageRole, "system" | "tool">;
  content: string;
  speakerCharacterId?: string;
  expectedHistoryEpoch?: number;
}

export interface RuntimeStartPayload {
  modelId: string;
  extraArgs?: string[];
  warmupEnabled?: boolean;
  performanceMode?: RuntimePerformanceMode;
  gpuLayers?: number;
}

export interface UpdateRuntimeSettingsPayload {
  warmupEnabled?: boolean;
  performanceMode?: RuntimePerformanceMode;
  gpuLayers?: number;
}

export interface CreateGenerationPresetPayload {
  name: string;
  description?: string;
  temperature: number;
  topP: number;
  maxTokens?: number;
  repeatPenalty?: number;
}

export interface UpdateGenerationPresetPayload {
  id: string;
  name?: string;
  description?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  repeatPenalty?: number;
}

export interface UpdateMessagePayload {
  id: string;
  content: string;
  expectedHistoryEpoch?: number;
}

export interface ChatHistoryMutation {
  chatId: string;
  historyEpoch: number;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface EditAndTruncatePayload {
  id: string;
  content: string;
  expectedHistoryEpoch: number;
}

export interface BranchChatPayload {
  chatId: string;
  messageId: string;
  title?: string;
}

export interface ImportModelPayload {
  path: string;
  name?: string;
}

export interface DownloadModelPayload {
  url: string;
  name?: string;
  sha256?: string;
}

export type ModelDownloadPhase = "starting" | "downloading" | "retrying" | "ready";

export interface ModelDownloadProgress {
  phase: ModelDownloadPhase;
  fileName: string;
  downloadedBytes: number;
  totalBytes?: number;
  attempt: number;
  maxAttempts: number;
}

export interface CreateCharacterPayload {
  name: string;
  description?: string;
  personality?: string;
  backstory?: string;
  scenario?: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  speechStyle?: string;
  greeting?: string;
  alternateGreetings?: string[];
  avatar?: string;
  tags?: string[];
  likes?: string[];
  dislikes?: string[];
  boundaries?: string;
  creatorNotes?: string;
  creator?: string;
  characterVersion?: string;
  cardExtensions?: Record<string, unknown>;
  exampleDialogue?: string;
}

export interface UpdateCharacterPayload {
  id: string;
  name?: string;
  description?: string;
  personality?: string;
  backstory?: string;
  scenario?: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  speechStyle?: string;
  greeting?: string;
  alternateGreetings?: string[];
  avatar?: string;
  tags?: string[];
  likes?: string[];
  dislikes?: string[];
  boundaries?: string;
  creatorNotes?: string;
  creator?: string;
  characterVersion?: string;
  cardExtensions?: Record<string, unknown>;
  exampleDialogue?: string;
}

export interface UpsertChatMemoryPayload {
  chatId: string;
  summary?: string;
  facts?: string[];
  expectedHistoryEpoch?: number;
}

export interface UpsertUserProfilePayload {
  name?: string;
  about?: string;
  gender?: string;
  avatar?: string;
  traits?: string[];
  preferences?: string;
  boundaries?: string;
}

export interface UpsertChatRelationshipStatePayload {
  chatId: string;
  summary?: string;
  currentScene?: string;
  interactionTone?: string;
  characterState?: string;
  userState?: string;
  userRoleName?: string;
  userRoleDescription?: string;
  expectedHistoryEpoch?: number;
}

export interface UpsertChatPresetProfilePayload {
  chatId: string;
  generationPresetId?: string;
}

export interface CreateContextEntryPayload {
  scope: "global" | "character";
  characterId?: string;
  title: string;
  keywords?: string[];
  content: string;
  enabled?: boolean;
}

export interface UpdateContextEntryPayload {
  id: string;
  title?: string;
  keywords?: string[];
  content?: string;
  enabled?: boolean;
}

export interface LlamaChatMessage {
  role: MessageRole;
  content: string;
}

export interface LlamaChatCompletionChunk {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string;
      role?: MessageRole;
    };
    finish_reason?: string | null;
    index?: number;
  }>;
  error?: {
    message: string;
    type?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface LlamaChatRequest {
  model: string;
  messages: LlamaChatMessage[];
  stream: boolean;
  chat_template_kwargs?: {
    enable_thinking?: boolean;
  };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  repeat_penalty?: number;
  stop?: string[];
}

export interface LlamaChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      role?: MessageRole;
      content?: string;
    };
    finish_reason?: string | null;
    index?: number;
  }>;
  error?: {
    message: string;
    type?: string;
  };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
