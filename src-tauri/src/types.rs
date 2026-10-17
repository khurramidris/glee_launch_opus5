use serde::{Deserialize, Serialize};

pub use crate::runtime_selection::{DetectedGpuDevice, RuntimeBackend};

fn default_json_object() -> String {
    "{}".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRecord {
    pub id: String,
    pub name: String,
    pub source_path: String,
    pub sha256: String,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub personality: String,
    pub backstory: String,
    pub scenario: String,
    pub system_prompt: String,
    pub post_history_instructions: String,
    pub speech_style: String,
    pub greeting: String,
    pub alternate_greetings_json: String,
    #[serde(default)]
    pub alternate_greetings: Vec<String>,
    pub avatar: String,
    pub tags_json: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub likes_json: String,
    #[serde(default)]
    pub likes: Vec<String>,
    pub dislikes_json: String,
    #[serde(default)]
    pub dislikes: Vec<String>,
    pub boundaries: String,
    pub creator_notes: String,
    pub creator: String,
    pub character_version: String,
    pub card_extensions_json: String,
    #[serde(skip_serializing, default = "default_json_object")]
    pub card_passthrough_json: String,
    pub example_dialogue: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRecord {
    pub id: String,
    pub title: String,
    pub character_id: Option<String>,
    pub chat_mode: String,
    #[serde(default)]
    pub participant_ids: Vec<String>,
    #[serde(default)]
    pub history_epoch: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMemoryRecord {
    pub chat_id: String,
    pub summary: String,
    pub facts_json: String,
    #[serde(default)]
    pub facts: Vec<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatPresetProfileRecord {
    pub chat_id: String,
    pub generation_preset_id: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageRecord {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub speaker_character_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettingRecord {
    pub key: String,
    pub value: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeLaunchSettingsRecord {
    pub warmup_enabled: bool,
    pub gpu_layers: i64,
    pub performance_mode: RuntimePerformanceMode,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfileRecord {
    pub id: String,
    pub display_name: String,
    pub about: String,
    pub gender: String,
    pub avatar: String,
    pub traits_json: String,
    #[serde(default)]
    pub traits: Vec<String>,
    pub preferences: String,
    pub boundaries: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRelationshipStateRecord {
    pub chat_id: String,
    pub summary: String,
    pub current_scene: String,
    pub interaction_tone: String,
    pub character_state: String,
    pub user_state: String,
    pub user_role_name: String,
    pub user_role_description: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaPresetRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationPresetRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub temperature: f64,
    pub top_p: f64,
    pub max_tokens: i64,
    pub repeat_penalty: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportModelInput {
    pub path: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadModelInput {
    pub url: String,
    pub name: Option<String>,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FirstRunPreparationStatus {
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FirstRunPreparationResponse {
    pub status: FirstRunPreparationStatus,
    pub resource_dir: String,
    pub downloaded_assets: usize,
    pub reused_assets: usize,
    pub total_assets: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelProvisioningInput {
    pub job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceItemStatus {
    pub key: String,
    pub label: String,
    pub size_bytes: u64,
    pub installed: bool,
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceStatusResponse {
    pub ready: bool,
    pub platform: String,
    pub platform_supported: bool,
    pub missing_required_bytes: u64,
    pub items: Vec<ResourceItemStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCharacterInput {
    pub name: String,
    pub description: Option<String>,
    pub personality: Option<String>,
    pub backstory: Option<String>,
    pub scenario: Option<String>,
    pub system_prompt: Option<String>,
    pub post_history_instructions: Option<String>,
    pub speech_style: Option<String>,
    pub greeting: Option<String>,
    pub alternate_greetings_json: Option<String>,
    pub alternate_greetings: Option<Vec<String>>,
    pub avatar: Option<String>,
    pub tags_json: Option<String>,
    pub tags: Option<Vec<String>>,
    pub likes_json: Option<String>,
    pub likes: Option<Vec<String>>,
    pub dislikes_json: Option<String>,
    pub dislikes: Option<Vec<String>>,
    pub boundaries: Option<String>,
    pub creator_notes: Option<String>,
    pub creator: Option<String>,
    pub character_version: Option<String>,
    pub card_extensions_json: Option<String>,
    pub example_dialogue: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCharacterInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub personality: Option<String>,
    pub backstory: Option<String>,
    pub scenario: Option<String>,
    pub system_prompt: Option<String>,
    pub post_history_instructions: Option<String>,
    pub speech_style: Option<String>,
    pub greeting: Option<String>,
    pub alternate_greetings_json: Option<String>,
    pub alternate_greetings: Option<Vec<String>>,
    pub avatar: Option<String>,
    pub tags_json: Option<String>,
    pub tags: Option<Vec<String>>,
    pub likes_json: Option<String>,
    pub likes: Option<Vec<String>>,
    pub dislikes_json: Option<String>,
    pub dislikes: Option<Vec<String>>,
    pub boundaries: Option<String>,
    pub creator_notes: Option<String>,
    pub creator: Option<String>,
    pub character_version: Option<String>,
    pub card_extensions_json: Option<String>,
    pub example_dialogue: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateChatInput {
    pub title: Option<String>,
    pub character_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppendMessageInput {
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub speaker_character_id: Option<String>,
    #[serde(default)]
    pub expected_history_epoch: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMessageInput {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub expected_history_epoch: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditAndTruncateInput {
    pub id: String,
    pub content: String,
    pub expected_history_epoch: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatHistoryMutationRecord {
    pub chat_id: String,
    pub history_epoch: i64,
    pub updated_at: String,
    pub messages: Vec<MessageRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchChatInput {
    pub chat_id: String,
    pub anchor_message_id: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertChatMemoryInput {
    pub chat_id: String,
    pub summary: Option<String>,
    pub facts_json: Option<String>,
    #[serde(default)]
    pub expected_history_epoch: Option<i64>,
    pub facts: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertUserProfileInput {
    pub display_name: Option<String>,
    pub about: Option<String>,
    pub gender: Option<String>,
    pub avatar: Option<String>,
    pub traits_json: Option<String>,
    pub traits: Option<Vec<String>>,
    pub preferences: Option<String>,
    pub boundaries: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertChatRelationshipStateInput {
    pub chat_id: String,
    #[serde(alias = "relationship_summary")]
    pub summary: Option<String>,
    #[serde(alias = "scene_summary")]
    pub current_scene: Option<String>,
    pub interaction_tone: Option<String>,
    pub character_state: Option<String>,
    pub user_state: Option<String>,
    pub user_role_name: Option<String>,
    pub user_role_description: Option<String>,
    #[serde(default)]
    pub expected_history_epoch: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpsertChatPresetProfileInput {
    pub chat_id: String,
    pub generation_preset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextEntryRecord {
    pub id: String,
    pub scope: String,
    pub character_id: Option<String>,
    pub title: String,
    pub keywords_json: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    pub content: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateContextEntryInput {
    pub scope: String,
    pub character_id: Option<String>,
    pub title: String,
    pub keywords_json: Option<String>,
    pub keywords: Option<Vec<String>>,
    pub content: String,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateContextEntryInput {
    pub id: String,
    pub title: Option<String>,
    pub keywords_json: Option<String>,
    pub keywords: Option<Vec<String>>,
    pub content: Option<String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveContextEntriesInput {
    pub character_ids: Option<Vec<String>>,
    pub query: String,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySnippetRecord {
    pub message_id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub speaker_character_id: Option<String>,
    pub created_at: String,
    pub score: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveMemorySnippetsInput {
    pub chat_id: String,
    pub query: String,
    pub limit: Option<u32>,
    pub speaker_character_id: Option<String>,
    #[serde(alias = "persona_prompt")]
    pub retrieval_hints: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportCharacterCardInput {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportCharacterCardJsonInput {
    pub character_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportCharacterCardPngInput {
    pub character_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGroupChatInput {
    pub title: Option<String>,
    pub character_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateGroupChatInput {
    pub chat_id: String,
    pub title: Option<String>,
    pub character_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePersonaPresetInput {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePersonaPresetInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateGenerationPresetInput {
    pub name: String,
    pub description: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<i64>,
    pub repeat_penalty: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateGenerationPresetInput {
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<i64>,
    pub repeat_penalty: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartRuntimeInput {
    pub model_id: Option<String>,
    pub extra_args: Option<Vec<String>>,
    pub warmup_enabled: Option<bool>,
    pub gpu_layers: Option<i64>,
    pub performance_mode: Option<RuntimePerformanceMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateRuntimeLaunchSettingsInput {
    pub warmup_enabled: Option<bool>,
    pub gpu_layers: Option<i64>,
    pub performance_mode: Option<RuntimePerformanceMode>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePerformanceMode {
    Auto,
    Cpu,
    Gpu,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSelectionInfo {
    pub performance_mode: RuntimePerformanceMode,
    pub backend: RuntimeBackend,
    pub attempted_backend: Option<RuntimeBackend>,
    pub binary_path: String,
    pub variant_id: Option<String>,
    pub runtime_version: Option<String>,
    pub requested_gpu_layers: i64,
    pub actual_gpu_layers: Option<i64>,
    pub fallback_reason: Option<String>,
    #[serde(default)]
    pub detected_gpus: Vec<DetectedGpuDevice>,
    pub backend_log_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePhase {
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatusResponse {
    pub state: RuntimePhase,
    pub endpoint: Option<String>,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub model_id: Option<String>,
    pub started_at: Option<String>,
    pub log_file: Option<String>,
    pub error: Option<String>,
    pub selection: Option<RuntimeSelectionInfo>,
    /// Per-launch key the frontend sends to llama-server.
    pub api_key: Option<String>,
}

impl RuntimeStatusResponse {
    pub fn stopped() -> Self {
        Self {
            state: RuntimePhase::Stopped,
            endpoint: None,
            port: None,
            pid: None,
            model_id: None,
            started_at: None,
            log_file: None,
            error: None,
            selection: None,
            api_key: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HealthCheckStatus {
    Ok,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IndexingHealthStatus {
    Healthy,
    Pending,
    Degraded,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthCheckRecord {
    pub key: String,
    pub label: String,
    pub status: HealthCheckStatus,
    pub detail: String,
    pub path: Option<String>,
    pub required: bool,
    pub recoverable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexingDiagnostics {
    pub status: IndexingHealthStatus,
    pub updated_at: String,
    pub last_error: Option<String>,
    pub last_indexed_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupHealthSnapshot {
    pub checked_at: String,
    pub overall_status: HealthCheckStatus,
    pub app_data_dir: String,
    pub database_path: String,
    pub backup_dir: String,
    pub last_migration_backup_path: Option<String>,
    pub runtime_binary_path: String,
    pub sqlite_vec_available: bool,
    pub active_model_id: Option<String>,
    pub active_model_path: Option<String>,
    pub embedding_model_id: Option<String>,
    pub embedding_model_path: Option<String>,
    pub embedding_available: bool,
    pub indexing: IndexingDiagnostics,
    pub checks: Vec<HealthCheckRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeatureExposure {
    pub stable: Vec<String>,
    pub labs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsSnapshot {
    pub app_version: String,
    pub platform: String,
    pub runtime: RuntimeStatusResponse,
    pub startup: StartupHealthSnapshot,
    pub settings: Vec<AppSettingRecord>,
    pub feature_exposure: FeatureExposure,
    pub recent_errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsExportResponse {
    pub directory: String,
    pub summary_path: String,
    pub runtime_log_path: Option<String>,
    pub database_backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseBackupResponse {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseBackupRecord {
    pub file_name: String,
    pub path: String,
    pub reason: String,
    pub size_bytes: u64,
    pub modified_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreDatabaseBackupInput {
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseRestoreResponse {
    pub restored_from: String,
    pub safety_backup_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterCardExportResponse {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapDbState {
    pub models: Vec<ModelRecord>,
    pub characters: Vec<CharacterRecord>,
    pub chats: Vec<ChatRecord>,
    pub settings: Vec<AppSettingRecord>,
    pub user_profile: UserProfileRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BootstrapStateResponse {
    pub models: Vec<ModelRecord>,
    pub active_model: Option<ModelRecord>,
    pub characters: Vec<CharacterRecord>,
    pub chats: Vec<ChatRecord>,
    pub settings: Vec<AppSettingRecord>,
    pub user_profile: UserProfileRecord,
    pub runtime: RuntimeStatusResponse,
}
