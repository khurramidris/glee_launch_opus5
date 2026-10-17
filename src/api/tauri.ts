import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettingEntry,
  AppendMessagePayload,
  BootstrapState,
  CharacterCardExportResponse,
  BranchChatPayload,
  Character,
  ChatRelationshipState,
  ChatHistoryMutation,
  ChatMemory,
  ChatMessage,
  ChatPresetProfile,
  ChatSummary,
  ContextEntry,
  CreateCharacterPayload,
  CreateContextEntryPayload,
  CreateGenerationPresetPayload,
  DatabaseBackup,
  DatabaseBackupResponse,
  DatabaseRestoreResponse,
  DetectedGpuDevice,
  DownloadModelPayload,
  DiagnosticsExportResponse,
  DiagnosticsSnapshot,
  FeatureExposure,
  FirstRunPreparation,
  ResourceStatus,
  GenerationPreset,
  HealthCheckRecord,
  ImportModelPayload,
  IndexingDiagnostics,
  MemorySnippet,
  ModelInfo,
  RuntimeLaunchSettings,
  RuntimeLaunchSettingsRecord,
  RuntimeBackend,
  RuntimePerformanceMode,
  RuntimeSelectionInfo,
  RuntimeStartPayload,
  RuntimeState,
  StartupHealthSnapshot,
  UpdateCharacterPayload,
  UpdateContextEntryPayload,
  UpdateGenerationPresetPayload,
  UpdateMessagePayload,
  EditAndTruncatePayload,
  UpsertChatMemoryPayload,
  UpsertChatPresetProfilePayload,
  UpsertChatRelationshipStatePayload,
  UpsertUserProfilePayload,
  UserProfile,
} from "../types";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8080";

type RuntimePhase = "stopped" | "starting" | "ready" | "error";

interface RawModelRecord {
  id: string;
  name: string;
  source_path: string;
  sha256: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface RawCharacterRecord {
  id: string;
  name: string;
  description: string;
  personality?: string | null;
  backstory?: string | null;
  scenario?: string | null;
  system_prompt: string;
  post_history_instructions?: string | null;
  speech_style?: string | null;
  greeting?: string | null;
  alternate_greetings_json?: string | null;
  alternate_greetings?: string[] | string | null;
  avatar?: string | null;
  tags?: string[] | string | null;
  likes_json?: string | null;
  likes?: string[] | string | null;
  dislikes_json?: string | null;
  dislikes?: string[] | string | null;
  boundaries?: string | null;
  creator_notes?: string | null;
  creator?: string | null;
  character_version?: string | null;
  card_extensions_json?: string | null;
  example_dialogue?: string | null;
  created_at: string;
  updated_at: string;
}

interface RawChatRecord {
  id: string;
  title: string;
  chat_mode?: "single" | "group" | null;
  character_id?: string | null;
  participant_ids?: string[] | null;
  history_epoch?: number | null;
  created_at: string;
  updated_at: string;
}

interface RawMessageRecord {
  id: string;
  chat_id: string;
  role: ChatMessage["role"];
  content: string;
  speaker_character_id?: string | null;
  created_at: string;
}

interface RawChatMemoryRecord {
  chat_id: string;
  summary?: string | null;
  facts_json?: string | null;
  facts?: string[] | string | null;
  updated_at: string;
}

interface RawUserProfileRecord {
  id?: string;
  display_name?: string | null;
  about?: string | null;
  gender?: string | null;
  avatar?: string | null;
  traits_json?: string | null;
  traits?: string[] | string | null;
  preferences?: string | string[] | null;
  preferences_json?: string | null;
  boundaries?: string | string[] | null;
  boundaries_json?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface RawChatRelationshipStateRecord {
  chat_id: string;
  summary?: string | null;
  relationship_summary?: string | null;
  current_scene?: string | null;
  scene_summary?: string | null;
  interaction_tone?: string | null;
  character_state?: string | null;
  user_state?: string | null;
  user_role_name?: string | null;
  user_role_description?: string | null;
  updated_at?: string;
}

interface RawContextEntryRecord {
  id: string;
  scope: "global" | "character";
  character_id?: string | null;
  title: string;
  keywords_json?: string | null;
  keywords?: string[] | string | null;
  content: string;
  enabled: boolean | number;
  created_at: string;
  updated_at: string;
}

interface RawMemorySnippetRecord {
  chat_id?: string | null;
  chatId?: string | null;
  message_id?: string | null;
  messageId?: string | null;
  role: ChatMessage["role"];
  content: string;
  speaker_character_id?: string | null;
  speakerCharacterId?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  score?: number | string | null;
}

interface RawRuntimeStatus {
  state: RuntimePhase;
  endpoint?: string | null;
  port?: number | null;
  pid?: number | null;
  model_id?: string | null;
  started_at?: string | null;
  log_file?: string | null;
  error?: string | null;
  selection?: RawRuntimeSelectionInfo | null;
  api_key?: string | null;
}

interface RawChatHistoryMutationRecord {
  chat_id: string;
  history_epoch: number;
  updated_at: string;
  messages: RawMessageRecord[];
}

interface RawResourceStatus {
  ready: boolean;
  platform: string;
  platform_supported: boolean;
  missing_required_bytes: number;
  items: Array<{
    key: string;
    label: string;
    size_bytes: number;
    installed: boolean;
    optional: boolean;
  }>;
}

interface RawFirstRunPreparation {
  status: "ready";
  resource_dir: string;
  downloaded_assets: number;
  reused_assets: number;
  total_assets: number;
  message: string;
}

interface RawDetectedGpuDevice {
  id?: string | null;
  name: string;
  vendor?: string | null;
  driver_version?: string | null;
  total_vram_mb?: number | string | null;
  free_vram_mb?: number | string | null;
  supported_backends?: string[] | null;
}

interface RawRuntimeSelectionInfo {
  performance_mode: string;
  backend: string;
  attempted_backend?: string | null;
  binary_path: string;
  variant_id?: string | null;
  runtime_version?: string | null;
  requested_gpu_layers: number | string;
  actual_gpu_layers?: number | string | null;
  fallback_reason?: string | null;
  detected_gpus?: RawDetectedGpuDevice[] | null;
  backend_log_summary?: string | null;
}

interface RawBootstrapState {
  models: RawModelRecord[];
  active_model?: RawModelRecord | null;
  characters: RawCharacterRecord[];
  chats: RawChatRecord[];
  user_profile?: RawUserProfileRecord | null;
  runtime: RawRuntimeStatus;
}

interface RawAppSettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

interface RawRuntimeLaunchSettingsRecord {
  warmup_enabled: boolean;
  performance_mode?: string | null;
  gpu_layers: number | string;
  updated_at: string;
}

interface RawHealthCheckRecord {
  key: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
  path?: string | null;
  required: boolean;
  recoverable: boolean;
}

interface RawIndexingDiagnostics {
  status: "healthy" | "pending" | "degraded" | "unavailable";
  updated_at: string;
  last_error?: string | null;
  last_indexed_message_id?: string | null;
}

interface RawStartupHealthSnapshot {
  checked_at: string;
  overall_status: "ok" | "warn" | "error";
  app_data_dir: string;
  database_path: string;
  backup_dir: string;
  last_migration_backup_path?: string | null;
  runtime_binary_path: string;
  sqlite_vec_available: boolean;
  active_model_id?: string | null;
  active_model_path?: string | null;
  embedding_model_id?: string | null;
  embedding_model_path?: string | null;
  embedding_available: boolean;
  indexing: RawIndexingDiagnostics;
  checks: RawHealthCheckRecord[];
}

interface RawFeatureExposure {
  stable: string[];
  labs: string[];
}

interface RawDiagnosticsSnapshot {
  app_version: string;
  platform: string;
  runtime: RawRuntimeStatus;
  startup: RawStartupHealthSnapshot;
  settings: RawAppSettingRecord[];
  feature_exposure: RawFeatureExposure;
  recent_errors: string[];
}

interface RawDiagnosticsExportResponse {
  directory: string;
  summary_path: string;
  runtime_log_path?: string | null;
  database_backup_path?: string | null;
}

interface RawDatabaseBackupResponse {
  path: string;
}

interface RawDatabaseBackupRecord {
  file_name: string;
  path: string;
  reason: "manual" | "pre-migration" | "pre-restore" | "other";
  size_bytes: number;
  modified_at: string;
}

interface RawDatabaseRestoreResponse {
  restored_from: string;
  safety_backup_path: string;
}

interface RawCharacterCardExportResponse {
  path: string;
}

interface RawParticipantRecord {
  id?: string | null;
  character_id?: string | null;
}

interface RawGenerationPresetRecord {
  id: string;
  name: string;
  description?: string | null;
  temperature: number | string;
  top_p: number | string;
  max_tokens?: number | string | null;
  repeat_penalty?: number | string | null;
  created_at: string;
  updated_at: string;
}

interface RawChatPresetProfileRecord {
  chat_id: string;
  generation_preset_id?: string | null;
  updated_at: string;
}

type RawBranchChatResponse = RawChatRecord | { chat: RawChatRecord };

function toOptionalString(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toNumber(value: number | string | null | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeRuntimePerformanceMode(
  value: string | null | undefined,
  gpuLayers: number,
): RuntimePerformanceMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "auto" || normalized === "cpu" || normalized === "gpu") {
    return normalized;
  }
  return gpuLayers > 0 ? "gpu" : "auto";
}

function normalizeRuntimeBackend(value: string | null | undefined): RuntimeBackend {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "cpu" ||
    normalized === "cuda" ||
    normalized === "vulkan" ||
    normalized === "metal"
  ) {
    return normalized;
  }
  return "cpu";
}

function mapDetectedGpu(record: RawDetectedGpuDevice): DetectedGpuDevice {
  return {
    id: toOptionalString(record.id),
    name: record.name,
    vendor: toOptionalString(record.vendor),
    driverVersion: toOptionalString(record.driver_version),
    totalVramMb: toNumber(record.total_vram_mb, 0) || undefined,
    freeVramMb: toNumber(record.free_vram_mb, 0) || undefined,
    supportedBackends: (record.supported_backends ?? []).map((backend) =>
      normalizeRuntimeBackend(backend),
    ),
  };
}

function mapRuntimeSelection(record: RawRuntimeSelectionInfo | null | undefined): RuntimeSelectionInfo | undefined {
  if (!record) {
    return undefined;
  }
  const requestedGpuLayers = toNumber(record.requested_gpu_layers, 0);
  return {
    performanceMode: normalizeRuntimePerformanceMode(record.performance_mode, requestedGpuLayers),
    backend: normalizeRuntimeBackend(record.backend),
    attemptedBackend: record.attempted_backend
      ? normalizeRuntimeBackend(record.attempted_backend)
      : undefined,
    binaryPath: record.binary_path,
    variantId: toOptionalString(record.variant_id),
    runtimeVersion: toOptionalString(record.runtime_version),
    requestedGpuLayers,
    actualGpuLayers:
      record.actual_gpu_layers === null || record.actual_gpu_layers === undefined
        ? undefined
        : toNumber(record.actual_gpu_layers, 0),
    fallbackReason: toOptionalString(record.fallback_reason),
    detectedGpus: (record.detected_gpus ?? []).map(mapDetectedGpu),
    backendLogSummary: toOptionalString(record.backend_log_summary),
  };
}

function gpuLayersForRuntimePayload(payload: {
  performanceMode?: RuntimePerformanceMode;
  gpuLayers?: number;
}): number | undefined {
  if (payload.performanceMode === "auto" || payload.performanceMode === "cpu") {
    return 0;
  }
  return payload.gpuLayers;
}

function parseStringList(raw: string[] | string | null | undefined, rawJson?: string | null): string[] {
  if (Array.isArray(raw)) {
    return raw.map((value) => value.trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (typeof rawJson === "string") {
    try {
      const decoded = JSON.parse(rawJson) as unknown;
      if (Array.isArray(decoded)) {
        return decoded
          .filter((item): item is string => typeof item === "string")
          .map((value) => value.trim())
          .filter(Boolean);
      }
    } catch {
      // ignore malformed json
    }
  }
  return [];
}

function parseTextField(raw: string | string[] | null | undefined, rawJson?: string | null): string {
  if (typeof raw === "string") {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    return raw.map((value) => value.trim()).filter(Boolean).join(", ");
  }
  const list = parseStringList(undefined, rawJson);
  return list.join(", ");
}

function parseJsonObject(rawJson: string | null | undefined): Record<string, unknown> | undefined {
  if (typeof rawJson !== "string" || rawJson.trim() === "") {
    return undefined;
  }
  try {
    const decoded = JSON.parse(rawJson) as unknown;
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
  } catch {
    // ignore malformed json
  }
  return undefined;
}

function mapModel(record: RawModelRecord): ModelInfo {
  return {
    id: record.id,
    name: record.name,
    path: record.source_path,
    sha256: record.sha256,
    isActive: record.is_active,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function mapCharacter(record: RawCharacterRecord): Character {
  const tags = parseStringList(record.tags);
  const alternateGreetings = parseStringList(
    record.alternate_greetings,
    record.alternate_greetings_json,
  );
  const likes = parseStringList(record.likes, record.likes_json);
  const dislikes = parseStringList(record.dislikes, record.dislikes_json);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    personality: record.personality?.trim() || undefined,
    backstory: record.backstory?.trim() || undefined,
    scenario: record.scenario?.trim() || undefined,
    systemPrompt: record.system_prompt,
    postHistoryInstructions: record.post_history_instructions?.trim() || undefined,
    speechStyle: record.speech_style?.trim() || undefined,
    greeting: record.greeting ?? undefined,
    alternateGreetings,
    avatar: record.avatar ?? undefined,
    tags,
    likes,
    dislikes,
    boundaries: record.boundaries?.trim() || undefined,
    creatorNotes: record.creator_notes?.trim() || undefined,
    creator: record.creator?.trim() || undefined,
    characterVersion: record.character_version?.trim() || undefined,
    cardExtensions: parseJsonObject(record.card_extensions_json),
    exampleDialogue: record.example_dialogue ?? undefined,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function mapChat(record: RawChatRecord): ChatSummary {
  const participantIds = (record.participant_ids ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  if (record.character_id && !participantIds.includes(record.character_id)) {
    participantIds.push(record.character_id);
  }

  const chatMode: ChatSummary["chatMode"] =
    record.chat_mode === "group" || participantIds.length > 1 ? "group" : "single";

  return {
    id: record.id,
    title: record.title,
    characterId: record.character_id ?? undefined,
    chatMode,
    participantIds,
    historyEpoch: Number.isSafeInteger(record.history_epoch) ? Number(record.history_epoch) : 0,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function mapMessage(record: RawMessageRecord): ChatMessage {
  return {
    id: record.id,
    chatId: record.chat_id,
    role: record.role,
    content: record.content,
    speakerCharacterId: record.speaker_character_id ?? undefined,
    createdAt: record.created_at,
  };
}

function mapChatMemory(record: RawChatMemoryRecord): ChatMemory {
  return {
    chatId: record.chat_id,
    summary: record.summary?.trim() ?? "",
    facts: [...new Set(parseStringList(record.facts, record.facts_json))],
    updatedAt: record.updated_at,
  };
}

function mapUserProfile(record?: RawUserProfileRecord | null): UserProfile {
  return {
    name: record?.display_name?.trim() ?? "",
    about: record?.about?.trim() ?? "",
    gender: record?.gender?.trim() ?? "",
    avatar: record?.avatar?.trim() ?? "",
    traits: [...new Set(parseStringList(record?.traits, record?.traits_json))],
    preferences: parseTextField(record?.preferences, record?.preferences_json),
    boundaries: parseTextField(record?.boundaries, record?.boundaries_json),
    createdAt: record?.created_at ?? "",
    updatedAt: record?.updated_at ?? "",
  };
}

function mapChatRelationshipState(
  record: RawChatRelationshipStateRecord | null | undefined,
  fallbackChatId?: string,
): ChatRelationshipState {
  return {
    chatId: record?.chat_id ?? fallbackChatId ?? "",
    summary: record?.summary?.trim() ?? record?.relationship_summary?.trim() ?? "",
    currentScene: record?.current_scene?.trim() ?? record?.scene_summary?.trim() ?? "",
    interactionTone: record?.interaction_tone?.trim() ?? "",
    characterState: record?.character_state?.trim() ?? "",
    userState: record?.user_state?.trim() ?? "",
    userRoleName: record?.user_role_name?.trim() ?? "",
    userRoleDescription: record?.user_role_description?.trim() ?? "",
    updatedAt: record?.updated_at ?? "",
  };
}

function mapContextEntry(record: RawContextEntryRecord): ContextEntry {
  return {
    id: record.id,
    scope: record.scope,
    characterId: record.character_id ?? undefined,
    title: record.title,
    keywords: [...new Set(parseStringList(record.keywords, record.keywords_json))],
    content: record.content,
    enabled: typeof record.enabled === "boolean" ? record.enabled : record.enabled !== 0,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function mapMemorySnippet(record: RawMemorySnippetRecord, fallbackChatId?: string): MemorySnippet {
  return {
    chatId: toOptionalString(record.chatId ?? record.chat_id) ?? fallbackChatId ?? "",
    messageId: toOptionalString(record.messageId ?? record.message_id),
    role: record.role,
    content: record.content,
    speakerCharacterId: toOptionalString(record.speakerCharacterId ?? record.speaker_character_id),
    createdAt: toOptionalString(record.createdAt ?? record.created_at) ?? "",
    score: toNumber(record.score, 0),
  };
}

function mapRuntime(raw: RawRuntimeStatus): RuntimeState {
  return {
    status: raw.state === "ready" ? "running" : raw.state,
    endpoint: raw.endpoint ?? DEFAULT_ENDPOINT,
    port: raw.port ?? undefined,
    pid: raw.pid ?? undefined,
    activeModelId: raw.model_id ?? undefined,
    startedAt: raw.started_at ?? undefined,
    logFile: raw.log_file ?? undefined,
    error: raw.error ?? undefined,
    selection: mapRuntimeSelection(raw.selection),
    apiKey: raw.api_key ?? undefined,
  };
}

function mapHistoryMutation(record: RawChatHistoryMutationRecord): ChatHistoryMutation {
  return {
    chatId: record.chat_id,
    historyEpoch: record.history_epoch,
    updatedAt: record.updated_at,
    messages: record.messages.map(mapMessage),
  };
}

function mapAppSetting(record: RawAppSettingRecord): AppSettingEntry {
  return {
    key: record.key,
    value: record.value,
    updatedAt: record.updated_at,
  };
}

function mapFirstRunPreparation(record: RawFirstRunPreparation): FirstRunPreparation {
  return {
    status: record.status,
    resourceDir: record.resource_dir,
    downloadedAssets: record.downloaded_assets,
    reusedAssets: record.reused_assets,
    totalAssets: record.total_assets,
    message: record.message,
  };
}

function mapRuntimeLaunchSettings(record: RawRuntimeLaunchSettingsRecord): RuntimeLaunchSettingsRecord {
  const gpuLayers = toNumber(record.gpu_layers, 0);
  return {
    warmupEnabled: Boolean(record.warmup_enabled),
    performanceMode: normalizeRuntimePerformanceMode(record.performance_mode, gpuLayers),
    gpuLayers,
    updatedAt: record.updated_at,
  };
}

function mapHealthCheck(record: RawHealthCheckRecord): HealthCheckRecord {
  return {
    key: record.key,
    label: record.label,
    status: record.status,
    detail: record.detail,
    path: toOptionalString(record.path),
    required: record.required,
    recoverable: record.recoverable,
  };
}

function mapIndexingDiagnostics(record: RawIndexingDiagnostics): IndexingDiagnostics {
  return {
    status: record.status,
    updatedAt: record.updated_at,
    lastError: toOptionalString(record.last_error),
    lastIndexedMessageId: toOptionalString(record.last_indexed_message_id),
  };
}

function mapStartupHealthSnapshot(record: RawStartupHealthSnapshot): StartupHealthSnapshot {
  return {
    checkedAt: record.checked_at,
    overallStatus: record.overall_status,
    appDataDir: record.app_data_dir,
    databasePath: record.database_path,
    backupDir: record.backup_dir,
    lastMigrationBackupPath: toOptionalString(record.last_migration_backup_path),
    runtimeBinaryPath: record.runtime_binary_path,
    sqliteVecAvailable: record.sqlite_vec_available,
    activeModelId: toOptionalString(record.active_model_id),
    activeModelPath: toOptionalString(record.active_model_path),
    embeddingModelId: toOptionalString(record.embedding_model_id),
    embeddingModelPath: toOptionalString(record.embedding_model_path),
    embeddingAvailable: record.embedding_available,
    indexing: mapIndexingDiagnostics(record.indexing),
    checks: record.checks.map(mapHealthCheck),
  };
}

function mapFeatureExposure(record: RawFeatureExposure): FeatureExposure {
  return {
    stable: [...record.stable],
    labs: [...record.labs],
  };
}

function mapDiagnosticsSnapshot(record: RawDiagnosticsSnapshot): DiagnosticsSnapshot {
  return {
    appVersion: record.app_version,
    platform: record.platform,
    runtime: mapRuntime(record.runtime),
    startup: mapStartupHealthSnapshot(record.startup),
    settings: record.settings.map(mapAppSetting),
    featureExposure: mapFeatureExposure(record.feature_exposure),
    recentErrors: [...record.recent_errors],
  };
}

function mapDiagnosticsExportResponse(record: RawDiagnosticsExportResponse): DiagnosticsExportResponse {
  return {
    directory: record.directory,
    summaryPath: record.summary_path,
    runtimeLogPath: toOptionalString(record.runtime_log_path),
    databaseBackupPath: toOptionalString(record.database_backup_path),
  };
}

function mapDatabaseBackupResponse(record: RawDatabaseBackupResponse): DatabaseBackupResponse {
  return { path: record.path };
}

function mapDatabaseBackup(record: RawDatabaseBackupRecord): DatabaseBackup {
  return {
    fileName: record.file_name,
    path: record.path,
    reason: record.reason,
    sizeBytes: record.size_bytes,
    modifiedAt: record.modified_at,
  };
}

function mapDatabaseRestoreResponse(
  record: RawDatabaseRestoreResponse,
): DatabaseRestoreResponse {
  return {
    restoredFrom: record.restored_from,
    safetyBackupPath: record.safety_backup_path,
  };
}

function mapGenerationPreset(record: RawGenerationPresetRecord): GenerationPreset {
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? undefined,
    temperature: toNumber(record.temperature, 0.78),
    topP: toNumber(record.top_p, 0.94),
    maxTokens: record.max_tokens == null ? undefined : Math.max(1, Math.round(toNumber(record.max_tokens, 256))),
    repeatPenalty: toNumber(record.repeat_penalty, 1.1),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function mapChatPresetProfile(record: RawChatPresetProfileRecord): ChatPresetProfile {
  return {
    chatId: record.chat_id,
    generationPresetId: toOptionalString(record.generation_preset_id),
    updatedAt: record.updated_at,
  };
}

export async function listModels(): Promise<ModelInfo[]> {
  const models = await invoke<RawModelRecord[]>("list_models");
  return models.map(mapModel);
}

export async function resourceStatus(): Promise<ResourceStatus> {
  const status = await invoke<RawResourceStatus>("resource_status");
  return {
    ready: status.ready,
    platform: status.platform,
    platformSupported: status.platform_supported,
    missingRequiredBytes: status.missing_required_bytes,
    items: status.items.map((item) => ({
      key: item.key,
      label: item.label,
      sizeBytes: item.size_bytes,
      installed: item.installed,
      optional: item.optional,
    })),
  };
}

export async function prepareFirstRunResources(): Promise<FirstRunPreparation> {
  const preparation = await invoke<RawFirstRunPreparation>("prepare_first_run_resources");
  return mapFirstRunPreparation(preparation);
}

export async function cancelFirstRunProvisioning(jobId?: string | null): Promise<boolean> {
  return invoke<boolean>("cancel_first_run_provisioning", {
    input: { job_id: jobId ?? null },
  });
}

export async function activeFirstRunProvisioningJobId(): Promise<string | null> {
  return invoke<string | null>("active_first_run_provisioning_job_id");
}

export async function bootstrapState(): Promise<BootstrapState> {
  const state = await invoke<RawBootstrapState>("bootstrap_state");
  const models = state.models.map(mapModel);
  const activeModelId = state.active_model?.id;
  return {
    models: models.map((model) => ({ ...model, isActive: model.id === activeModelId || model.isActive })),
    characters: state.characters.map(mapCharacter),
    chats: state.chats.map(mapChat),
    userProfile: mapUserProfile(state.user_profile),
    runtime: mapRuntime(state.runtime),
  };
}

export async function importModel(payload: ImportModelPayload): Promise<ModelInfo> {
  const model = await invoke<RawModelRecord>("import_model", { input: payload });
  return mapModel(model);
}

export async function downloadModel(payload: DownloadModelPayload): Promise<ModelInfo> {
  const model = await invoke<RawModelRecord>("download_model", { input: payload });
  return mapModel(model);
}

export async function cancelModelDownload(): Promise<boolean> {
  return invoke<boolean>("cancel_model_download");
}

export async function setActiveModel(modelId: string): Promise<ModelInfo> {
  const model = await invoke<RawModelRecord>("set_active_model", { modelId });
  return mapModel(model);
}

export async function getRuntimeState(): Promise<RuntimeState> {
  const state = await invoke<RawRuntimeStatus>("runtime_status");
  return mapRuntime(state);
}

export async function getRuntimeLaunchSettings(): Promise<RuntimeLaunchSettingsRecord> {
  const settings = await invoke<RawRuntimeLaunchSettingsRecord>("get_runtime_launch_settings");
  return mapRuntimeLaunchSettings(settings);
}

export async function setRuntimeLaunchSettings(
  payload: Partial<RuntimeLaunchSettings>,
): Promise<RuntimeLaunchSettingsRecord> {
  const settings = await invoke<RawRuntimeLaunchSettingsRecord>("set_runtime_launch_settings", {
    input: {
      warmup_enabled: payload.warmupEnabled,
      performance_mode: payload.performanceMode,
      gpu_layers: gpuLayersForRuntimePayload(payload),
    },
  });
  return mapRuntimeLaunchSettings(settings);
}

export async function startRuntime(payload: RuntimeStartPayload): Promise<RuntimeState> {
  const state = await invoke<RawRuntimeStatus>("start_runtime", {
    input: {
      model_id: payload.modelId,
      extra_args: payload.extraArgs ?? [],
      warmup_enabled: payload.warmupEnabled,
      performance_mode: payload.performanceMode,
      gpu_layers: gpuLayersForRuntimePayload(payload),
    },
  });
  return mapRuntime(state);
}

export async function stopRuntime(): Promise<RuntimeState> {
  const state = await invoke<RawRuntimeStatus>("stop_runtime");
  return mapRuntime(state);
}

export async function listCharacters(): Promise<Character[]> {
  const characters = await invoke<RawCharacterRecord[]>("list_characters");
  return characters.map(mapCharacter);
}

export async function createCharacter(input: CreateCharacterPayload): Promise<Character> {
  const character = await invoke<RawCharacterRecord>("create_character", {
    input: {
      name: input.name,
      description: input.description,
      personality: input.personality,
      backstory: input.backstory,
      scenario: input.scenario,
      system_prompt: input.systemPrompt,
      post_history_instructions: input.postHistoryInstructions,
      speech_style: input.speechStyle,
      greeting: input.greeting,
      alternate_greetings: input.alternateGreetings,
      avatar: input.avatar,
      tags: input.tags,
      likes: input.likes,
      dislikes: input.dislikes,
      boundaries: input.boundaries,
      creator_notes: input.creatorNotes,
      creator: input.creator,
      character_version: input.characterVersion,
      card_extensions_json: input.cardExtensions ? JSON.stringify(input.cardExtensions) : undefined,
      example_dialogue: input.exampleDialogue,
    },
  });
  return mapCharacter(character);
}

export async function updateCharacter(input: UpdateCharacterPayload): Promise<Character> {
  const character = await invoke<RawCharacterRecord>("update_character", {
    input: {
      id: input.id,
      name: input.name,
      description: input.description,
      personality: input.personality,
      backstory: input.backstory,
      scenario: input.scenario,
      system_prompt: input.systemPrompt,
      post_history_instructions: input.postHistoryInstructions,
      speech_style: input.speechStyle,
      greeting: input.greeting,
      alternate_greetings: input.alternateGreetings,
      avatar: input.avatar,
      tags: input.tags,
      likes: input.likes,
      dislikes: input.dislikes,
      boundaries: input.boundaries,
      creator_notes: input.creatorNotes,
      creator: input.creator,
      character_version: input.characterVersion,
      card_extensions_json: input.cardExtensions ? JSON.stringify(input.cardExtensions) : undefined,
      example_dialogue: input.exampleDialogue,
    },
  });
  return mapCharacter(character);
}

export async function deleteCharacter(id: string): Promise<void> {
  await invoke("delete_character", { characterId: id });
}

export async function importCharacterCard(input: { path: string }): Promise<Character> {
  const character = await invoke<RawCharacterRecord>("import_character_card", { input });
  return mapCharacter(character);
}

export async function exportCharacterCardJson(input: {
  characterId: string;
  path: string;
}): Promise<CharacterCardExportResponse> {
  const response = await invoke<RawCharacterCardExportResponse>("export_character_card_json", {
    input: {
      character_id: input.characterId,
      path: input.path,
    },
  });
  return { path: response.path };
}

export async function exportCharacterCardPng(input: {
  characterId: string;
  path: string;
}): Promise<CharacterCardExportResponse> {
  const response = await invoke<RawCharacterCardExportResponse>("export_character_card_png", {
    input: {
      character_id: input.characterId,
      path: input.path,
    },
  });
  return { path: response.path };
}

export async function readLocalImageDataUrl(path: string): Promise<string> {
  return invoke<string>("read_local_image_data_url", { path });
}

export async function listGenerationPresets(): Promise<GenerationPreset[]> {
  const presets = await invoke<RawGenerationPresetRecord[]>("list_generation_presets");
  return presets.map(mapGenerationPreset);
}

export async function createGenerationPreset(payload: CreateGenerationPresetPayload): Promise<GenerationPreset> {
  const preset = await invoke<RawGenerationPresetRecord>("create_generation_preset", {
    input: {
      name: payload.name,
      description: payload.description,
      temperature: payload.temperature,
      top_p: payload.topP,
      max_tokens: payload.maxTokens,
      repeat_penalty: payload.repeatPenalty,
    },
  });
  return mapGenerationPreset(preset);
}

export async function updateGenerationPreset(payload: UpdateGenerationPresetPayload): Promise<GenerationPreset> {
  const preset = await invoke<RawGenerationPresetRecord>("update_generation_preset", {
    input: {
      id: payload.id,
      name: payload.name,
      description: payload.description,
      temperature: payload.temperature,
      top_p: payload.topP,
      max_tokens: payload.maxTokens,
      repeat_penalty: payload.repeatPenalty,
    },
  });
  return mapGenerationPreset(preset);
}

export async function deleteGenerationPreset(id: string): Promise<void> {
  await invoke("delete_generation_preset", { presetId: id });
}

export async function listChats(characterId?: string): Promise<ChatSummary[]> {
  const chats = await invoke<RawChatRecord[]>("list_chats", {
    characterId: characterId ?? null,
  });
  return chats.map(mapChat);
}

export async function createChat(input: { title?: string; characterId?: string }): Promise<ChatSummary> {
  const chat = await invoke<RawChatRecord>("create_chat", {
    input: {
      title: input.title,
      character_id: input.characterId,
    },
  });
  return mapChat(chat);
}

export async function createGroupChat(input: { title?: string; characterIds: string[] }): Promise<ChatSummary> {
  const chat = await invoke<RawChatRecord>("create_group_chat", {
    input: {
      title: input.title,
      character_ids: input.characterIds,
    },
  });
  return mapChat(chat);
}

export async function updateGroupChat(input: {
  chatId: string;
  title: string;
  characterIds: string[];
}): Promise<ChatSummary> {
  const chat = await invoke<RawChatRecord>("update_group_chat", {
    input: {
      chat_id: input.chatId,
      title: input.title,
      character_ids: input.characterIds,
    },
  });
  return mapChat(chat);
}

export async function deleteChat(chatId: string): Promise<void> {
  await invoke("delete_chat", { chatId });
}

export async function clearChatHistory(chatId: string): Promise<ChatHistoryMutation> {
  const mutation = await invoke<RawChatHistoryMutationRecord>("clear_chat_history", { chatId });
  return mapHistoryMutation(mutation);
}

export async function listChatParticipants(chatId: string): Promise<string[]> {
  const participants = await invoke<Array<string | RawParticipantRecord>>("list_chat_participants", {
    chatId,
  });
  return participants
    .map((participant) => {
      if (typeof participant === "string") {
        return participant;
      }
      return participant.character_id ?? participant.id ?? "";
    })
    .map((id) => id.trim())
    .filter(Boolean);
}

export async function getChatMessages(chatId: string): Promise<ChatMessage[]> {
  const messages = await invoke<RawMessageRecord[]>("list_messages", { chatId });
  return messages.map(mapMessage);
}

export async function appendMessage(payload: AppendMessagePayload): Promise<ChatMessage> {
  const message = await invoke<RawMessageRecord>("append_message", {
    input: {
      chat_id: payload.chatId,
      role: payload.role,
      content: payload.content,
      speaker_character_id: payload.speakerCharacterId,
      expected_history_epoch: payload.expectedHistoryEpoch,
    },
  });
  return mapMessage(message);
}

export async function updateMessage(payload: UpdateMessagePayload): Promise<ChatMessage> {
  const message = await invoke<RawMessageRecord>("update_message", {
    input: {
      id: payload.id,
      content: payload.content,
      expected_history_epoch: payload.expectedHistoryEpoch,
    },
  });
  return mapMessage(message);
}

export async function editMessageAndTruncate(
  payload: EditAndTruncatePayload,
): Promise<ChatHistoryMutation> {
  const mutation = await invoke<RawChatHistoryMutationRecord>("edit_message_and_truncate", {
    input: {
      id: payload.id,
      content: payload.content,
      expected_history_epoch: payload.expectedHistoryEpoch,
    },
  });
  return mapHistoryMutation(mutation);
}

export async function branchChat(payload: BranchChatPayload): Promise<ChatSummary> {
  const response = await invoke<RawBranchChatResponse>("branch_chat", {
    input: {
      chat_id: payload.chatId,
      anchor_message_id: payload.messageId,
      title: payload.title,
    },
  });
  const chat = "chat" in response ? response.chat : response;
  return mapChat(chat);
}

export async function getChatMemory(chatId: string): Promise<ChatMemory> {
  const memory = await invoke<RawChatMemoryRecord>("get_chat_memory", { chatId });
  return mapChatMemory(memory);
}

export async function getUserProfile(): Promise<UserProfile> {
  const profile = await invoke<RawUserProfileRecord>("get_user_profile");
  return mapUserProfile(profile);
}

export async function upsertUserProfile(payload: UpsertUserProfilePayload): Promise<UserProfile> {
  const profile = await invoke<RawUserProfileRecord>("upsert_user_profile", {
    input: {
      display_name: payload.name,
      about: payload.about,
      gender: payload.gender,
      avatar: payload.avatar,
      traits: payload.traits,
      preferences: payload.preferences,
      boundaries: payload.boundaries,
    },
  });
  return mapUserProfile(profile);
}

export async function getChatRelationshipState(chatId: string): Promise<ChatRelationshipState> {
  const state = await invoke<RawChatRelationshipStateRecord>("get_chat_relationship_state", {
    chatId,
  });
  return mapChatRelationshipState(state, chatId);
}

export async function upsertChatRelationshipState(
  payload: UpsertChatRelationshipStatePayload,
): Promise<ChatRelationshipState> {
  const state = await invoke<RawChatRelationshipStateRecord>("upsert_chat_relationship_state", {
    input: {
      chat_id: payload.chatId,
      summary: payload.summary,
      current_scene: payload.currentScene,
      interaction_tone: payload.interactionTone,
      character_state: payload.characterState,
      user_state: payload.userState,
      user_role_name: payload.userRoleName,
      user_role_description: payload.userRoleDescription,
      expected_history_epoch: payload.expectedHistoryEpoch,
    },
  });
  return mapChatRelationshipState(state, payload.chatId);
}

export async function upsertChatMemory(payload: UpsertChatMemoryPayload): Promise<ChatMemory> {
  const memory = await invoke<RawChatMemoryRecord>("upsert_chat_memory", {
    input: {
      chat_id: payload.chatId,
      summary: payload.summary,
      facts: payload.facts,
      expected_history_epoch: payload.expectedHistoryEpoch,
    },
  });
  return mapChatMemory(memory);
}

export async function getChatPresetProfile(chatId: string): Promise<ChatPresetProfile | null> {
  const profile = await invoke<RawChatPresetProfileRecord | null>("get_chat_preset_profile", {
    chatId,
  });
  return profile ? mapChatPresetProfile(profile) : null;
}

export async function upsertChatPresetProfile(
  payload: UpsertChatPresetProfilePayload,
): Promise<ChatPresetProfile> {
  const profile = await invoke<RawChatPresetProfileRecord>("upsert_chat_preset_profile", {
    input: {
      chat_id: payload.chatId,
      generation_preset_id: toOptionalString(payload.generationPresetId),
    },
  });
  return mapChatPresetProfile(profile);
}

export async function listContextEntries(characterId?: string): Promise<ContextEntry[]> {
  const entries = await invoke<RawContextEntryRecord[]>("list_context_entries", {
    characterId: characterId ?? null,
  });
  return entries.map(mapContextEntry);
}

export async function createContextEntry(payload: CreateContextEntryPayload): Promise<ContextEntry> {
  const entry = await invoke<RawContextEntryRecord>("create_context_entry", {
    input: {
      scope: payload.scope,
      character_id: payload.characterId,
      title: payload.title,
      keywords: payload.keywords,
      content: payload.content,
      enabled: payload.enabled,
    },
  });
  return mapContextEntry(entry);
}

export async function updateContextEntry(payload: UpdateContextEntryPayload): Promise<ContextEntry> {
  const entry = await invoke<RawContextEntryRecord>("update_context_entry", {
    input: {
      id: payload.id,
      title: payload.title,
      keywords: payload.keywords,
      content: payload.content,
      enabled: payload.enabled,
    },
  });
  return mapContextEntry(entry);
}

export async function deleteContextEntry(id: string): Promise<void> {
  await invoke("delete_context_entry", { contextEntryId: id });
}

export async function resolveContextEntries(input: {
  characterIds?: string[];
  query: string;
  limit?: number;
}): Promise<ContextEntry[]> {
  const entries = await invoke<RawContextEntryRecord[]>("resolve_context_entries", {
    input: {
      character_ids: input.characterIds,
      query: input.query,
      limit: input.limit,
    },
  });
  return entries.map(mapContextEntry);
}

export interface MemoryRetrievalInput {
  chatId: string;
  query: string;
  limit?: number;
  speakerCharacterId?: string;
  retrievalHints?: string;
}

export async function resolveMemorySnippets(input: MemoryRetrievalInput): Promise<MemorySnippet[]> {
  const snippets = await invoke<RawMemorySnippetRecord[]>("resolve_memory_snippets", {
    input: {
      chat_id: input.chatId,
      query: input.query,
      limit: input.limit,
      speaker_character_id: input.speakerCharacterId,
      retrieval_hints: input.retrievalHints,
    },
  });
  return snippets.map((snippet) => mapMemorySnippet(snippet, input.chatId));
}

export async function resolveMemorySnippetsBatch(inputs: MemoryRetrievalInput[]): Promise<MemorySnippet[][]> {
  if (inputs.length === 0) return [];
  const results = await invoke<RawMemorySnippetRecord[][]>("resolve_memory_snippets_batch", {
    inputs: inputs.map((input) => ({
      chat_id: input.chatId,
      query: input.query,
      limit: input.limit,
      speaker_character_id: input.speakerCharacterId,
      retrieval_hints: input.retrievalHints,
    })),
  });
  return inputs.map((input, index) =>
    (results[index] ?? []).map((snippet) => mapMemorySnippet(snippet, input.chatId)),
  );
}

export async function getDiagnosticsSnapshot(): Promise<DiagnosticsSnapshot> {
  const snapshot = await invoke<RawDiagnosticsSnapshot>("diagnostics_snapshot");
  return mapDiagnosticsSnapshot(snapshot);
}

export async function exportDiagnosticsBundle(): Promise<DiagnosticsExportResponse> {
  const response = await invoke<RawDiagnosticsExportResponse>("export_diagnostics_bundle");
  return mapDiagnosticsExportResponse(response);
}

export async function createDatabaseBackup(): Promise<DatabaseBackupResponse> {
  const response = await invoke<RawDatabaseBackupResponse>("create_database_backup");
  return mapDatabaseBackupResponse(response);
}

export async function listDatabaseBackups(): Promise<DatabaseBackup[]> {
  const backups = await invoke<RawDatabaseBackupRecord[]>("list_database_backups");
  return backups.map(mapDatabaseBackup);
}

export async function restoreDatabaseBackup(
  fileName: string,
): Promise<DatabaseRestoreResponse> {
  const response = await invoke<RawDatabaseRestoreResponse>("restore_database_backup", {
    input: { file_name: fileName },
  });
  return mapDatabaseRestoreResponse(response);
}

export const __testing = {
  mapModel,
  mapCharacter,
  mapChat,
  mapMessage,
  mapHistoryMutation,
  mapChatMemory,
  mapUserProfile,
  mapChatRelationshipState,
  mapContextEntry,
  mapMemorySnippet,
  mapRuntime,
  mapRuntimeLaunchSettings,
  mapAppSetting,
  mapHealthCheck,
  mapIndexingDiagnostics,
  mapStartupHealthSnapshot,
  mapFeatureExposure,
  mapDiagnosticsSnapshot,
  mapDiagnosticsExportResponse,
  mapDatabaseBackupResponse,
  mapDatabaseBackup,
  mapDatabaseRestoreResponse,
  mapGenerationPreset,
  mapChatPresetProfile,
};
