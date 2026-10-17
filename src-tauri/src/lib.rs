mod character_card;
#[path = "db/mod.rs"]
mod db;
mod embedding_service;
mod errors;
mod gpu_check;
mod memory_service;
mod portraits;
mod resources;
mod runtime_manager;
mod runtime_selection;
mod types;
mod updates;

use std::{
    collections::HashSet,
    fs,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use character_card::{
    build_character_card_json, build_png_card_bytes,
    map_character_card_value as map_character_card_value_v2, ImportedCharacterCard,
};
use db::{Database, UserProfilePatch};
use embedding_service::{EmbeddingService, EmbeddingServiceConfig};
use errors::{AppError, AppResult};
use gpu_check::GpuCheckStore;
use resources::{AppProgressSink, ModelRole, Resources};
use runtime_manager::{RuntimeManager, RuntimeStartRequest};
use runtime_selection::{chat_server_args, cpu_fallback_plan, plan_chat_launch, RuntimeLaunchPlan};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sysinfo::Disks;
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;
use types::{
    AppendMessageInput, BootstrapStateResponse, BranchChatInput, CancelProvisioningInput,
    CharacterCardExportResponse, CharacterRecord, ChatHistoryMutationRecord, ChatMemoryRecord,
    ChatPresetProfileRecord, ChatRecord, ChatRelationshipStateRecord, ContextEntryRecord,
    CreateCharacterInput, CreateChatInput, CreateContextEntryInput, CreateGenerationPresetInput,
    CreateGroupChatInput, CreatePersonaPresetInput, DatabaseBackupRecord, DatabaseBackupResponse,
    DatabaseRestoreResponse, DeleteMessageInput, DiagnosticsExportResponse, DiagnosticsSnapshot,
    DownloadModelInput, EditAndTruncateInput, ExportCharacterCardJsonInput,
    ExportCharacterCardPngInput, ExportDatabaseBackupInput, FeatureExposure,
    FirstRunPreparationResponse, GenerationPresetRecord, HealthCheckRecord, HealthCheckStatus,
    ImportCharacterCardInput, ImportDatabaseBackupInput, ImportModelInput, IndexingDiagnostics,
    IndexingHealthStatus, MemorySnippetRecord, MessageRecord, ModelRecord, PersonaPresetRecord,
    RenameChatInput, ResolveContextEntriesInput, ResolveMemorySnippetsInput,
    ResourceStatusResponse, RestoreDatabaseBackupInput, RuntimeLaunchSettingsRecord,
    RuntimePerformanceMode, RuntimeStatusResponse, SetChatPersonaInput, StartRuntimeInput,
    StartupHealthSnapshot, UpdateCharacterInput, UpdateContextEntryInput,
    UpdateGenerationPresetInput, UpdateGroupChatInput, UpdateMessageInput,
    UpdatePersonaPresetInput, UpdateRuntimeLaunchSettingsInput, UpsertChatMemoryInput,
    UpsertChatPresetProfileInput, UpsertChatRelationshipStateInput, UpsertUserProfileInput,
    UserProfileRecord,
};

#[derive(Clone)]
struct InitializedAppState {
    db: Database,
    runtime_manager: RuntimeManager,
    embedding_service: Option<EmbeddingService>,
    app_data_dir: PathBuf,
    resources: Resources,
    vector_search: bool,
    indexing_diagnostics: Arc<tokio::sync::Mutex<IndexingDiagnostics>>,
}

struct AppState {
    app_handle: Option<tauri::AppHandle>,
    initialized: tokio::sync::OnceCell<InitializedAppState>,
}

impl AppState {
    fn new(app_handle: tauri::AppHandle) -> Self {
        Self {
            app_handle: Some(app_handle),
            initialized: tokio::sync::OnceCell::new(),
        }
    }

    #[cfg(test)]
    fn from_initialized(initialized: InitializedAppState) -> Self {
        let cell = tokio::sync::OnceCell::new();
        assert!(
            cell.set(initialized).is_ok(),
            "test app state should initialize synchronously"
        );
        Self {
            app_handle: None,
            initialized: cell,
        }
    }

    async fn handles(&self) -> AppResult<InitializedAppState> {
        let initialized = self
            .initialized
            .get_or_try_init(|| async {
                let app_handle = self.app_handle.clone().ok_or_else(|| {
                    AppError::Runtime(
                        "app state is unavailable because no app handle was configured".to_string(),
                    )
                })?;
                let build_handle = app_handle.clone();
                let initialized =
                    tauri::async_runtime::spawn_blocking(move || build_state(&build_handle))
                        .await
                        .map_err(|error| {
                            AppError::Runtime(format!(
                            "app state initialization task failed before startup completed: {error}"
                        ))
                        })??;
                Ok::<InitializedAppState, AppError>(initialized)
            })
            .await?;
        Ok(initialized.clone())
    }

    async fn shutdown(&self) -> AppResult<()> {
        let Some(initialized) = self.initialized.get() else {
            return Ok(());
        };

        let chat_result = initialized.runtime_manager.stop().await;
        let embedding_result = match initialized.embedding_service.as_ref() {
            Some(service) => service.stop().await,
            None => Ok(()),
        };

        match (chat_result, embedding_result) {
            (Ok(_), Ok(())) => Ok(()),
            (Err(chat_error), Ok(())) => Err(chat_error),
            (Ok(_), Err(embedding_error)) => Err(embedding_error),
            (Err(chat_error), Err(embedding_error)) => Err(AppError::Runtime(format!(
                "failed to stop chat runtime ({chat_error}) and embedding runtime ({embedding_error})"
            ))),
        }
    }
}

const MAX_CHARACTER_CARD_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CHARACTER_CARD_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHARACTER_CARD_METADATA_BYTES: usize = 6 * 1024 * 1024;
const MAX_LOCAL_IMAGE_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SAVED_TEXT_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_DIAGNOSTICS_LOG_EXPORT_BYTES: usize = 5 * 1024 * 1024;
pub(crate) const GENERATION_FAILURE_PREFIX: &str = "[Glee reply failed]";
const MODEL_DOWNLOAD_PROGRESS_EVENT: &str = "model-download-progress";
const MODEL_DOWNLOAD_ATTEMPTS: u32 = 3;
const MODEL_DOWNLOAD_MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MODEL_DOWNLOAD_DISK_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;
const MODEL_DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const MODEL_DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);
const MODEL_DOWNLOAD_TOTAL_TIMEOUT: Duration = Duration::from_secs(60 * 60);
static MODEL_DOWNLOAD_ACTIVE: AtomicBool = AtomicBool::new(false);
static MODEL_DOWNLOAD_CANCELLED: AtomicBool = AtomicBool::new(false);

fn resources_for(app_handle: &tauri::AppHandle<impl tauri::Runtime>) -> AppResult<Resources> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Path(format!("failed to resolve app data dir: {error}")))?;
    Resources::new(&app_data_dir)
}

#[tauri::command]
async fn resource_status(app_handle: tauri::AppHandle) -> AppResult<ResourceStatusResponse> {
    Ok(resources_for(&app_handle)?.status())
}

#[tauri::command]
async fn prepare_first_run_resources(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<FirstRunPreparationResponse> {
    let resources = resources_for(&app_handle)?;
    let response = resources
        .prepare(&AppProgressSink(app_handle.clone()))
        .await?;
    // Register the starter model right away when the workspace is already
    // loaded; bootstrap_state covers the normal first-launch order.
    if let Some(initialized) = state.initialized.get() {
        ensure_default_model_registered(initialized).await?;
    }
    Ok(response)
}

#[tauri::command]
async fn cancel_first_run_provisioning(input: Option<CancelProvisioningInput>) -> AppResult<bool> {
    let job_id = input.as_ref().and_then(|input| input.job_id.as_deref());
    Ok(resources::cancel_active_job(job_id))
}

#[tauri::command]
async fn active_first_run_provisioning_job_id() -> AppResult<Option<String>> {
    Ok(resources::active_job_id())
}

/// Adds the downloaded starter model to the model library and makes it active
/// unless the user already chose another model that still exists. The hash
/// comes from the verified install record, so this is cheap enough to run on
/// every bootstrap.
async fn ensure_default_model_registered(state: &InitializedAppState) -> AppResult<()> {
    let Some(path) = state.resources.installed_model_path(ModelRole::Chat) else {
        return Ok(());
    };
    let asset = state.resources.model_asset(ModelRole::Chat).clone();
    run_db_task(state.db.clone(), move |database| {
        let source_path = path.to_string_lossy().to_string();
        let sha256 = asset.source.sha256.trim().to_ascii_lowercase();
        let active = database.get_active_model()?;
        let already_registered = database
            .list_models()?
            .into_iter()
            .find(|model| model.sha256 == sha256 && model.source_path == source_path);
        let imported = match already_registered {
            Some(model) => model,
            None => database.import_model(&asset.display_name, &source_path, &sha256)?,
        };
        let other_active_is_usable = active.as_ref().is_some_and(|model| {
            model.id != imported.id && Path::new(&model.source_path).is_file()
        });
        if !imported.is_active && !other_active_is_usable {
            database.set_active_model(&imported.id)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn bootstrap_state(state: tauri::State<'_, AppState>) -> AppResult<BootstrapStateResponse> {
    let state = state.handles().await?;
    ensure_default_model_registered(&state).await?;
    let db = state.db.clone();
    let snapshot = run_db_task(db, |database| database.bootstrap_snapshot()).await?;
    let runtime = state.runtime_manager.status().await?;
    let active_model = snapshot
        .models
        .iter()
        .find(|model| model.is_active)
        .cloned();

    Ok(BootstrapStateResponse {
        models: snapshot.models,
        active_model,
        characters: snapshot.characters,
        chats: snapshot.chats,
        settings: snapshot.settings,
        user_profile: snapshot.user_profile,
        runtime,
    })
}

#[tauri::command]
async fn list_models(state: tauri::State<'_, AppState>) -> AppResult<Vec<ModelRecord>> {
    let state = state.handles().await?;
    run_db_task(state.db.clone(), |database| database.list_models()).await
}

#[tauri::command]
async fn import_model(
    state: tauri::State<'_, AppState>,
    input: ImportModelInput,
) -> AppResult<ModelRecord> {
    let state = state.handles().await?;
    let model_path = canonicalize_model_path(&input.path)?;
    import_model_record(state.db.clone(), model_path, input.name).await
}

#[tauri::command]
async fn download_model<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: DownloadModelInput,
) -> AppResult<ModelRecord> {
    let _guard = ModelDownloadGuard::begin()?;
    let state = state.handles().await?;
    let url = normalize_model_download_url(&input.url)?;
    let model_name_hint = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let target_file_name = infer_model_download_file_name(&url, model_name_hint.as_deref())?;
    let models_dir = state.app_data_dir.join("models");
    tokio::fs::create_dir_all(&models_dir).await?;
    let target_path = models_dir.join(target_file_name);
    let temp_path = target_path.with_extension("gguf.download");

    let expected_sha256 = input
        .sha256
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());
    if let Some(expected) = expected_sha256.as_deref() {
        if !is_sha256_hex(expected) {
            return Err(AppError::Validation(
                "expected model SHA256 must be a 64-character hex digest".to_string(),
            ));
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(MODEL_DOWNLOAD_CONNECT_TIMEOUT)
        .read_timeout(MODEL_DOWNLOAD_READ_TIMEOUT)
        .timeout(MODEL_DOWNLOAD_TOTAL_TIMEOUT)
        .user_agent(format!("Glee/{} model-download", env!("CARGO_PKG_VERSION")))
        .build()?;
    let mut last_error = String::new();
    for attempt in 1..=MODEL_DOWNLOAD_ATTEMPTS {
        MODEL_DOWNLOAD_CANCELLED.store(false, Ordering::Release);
        let _ = tokio::fs::remove_file(&temp_path).await;
        emit_model_download_progress(
            &app_handle,
            "starting",
            target_path.file_name().and_then(|value| value.to_str()),
            0,
            None,
            attempt,
        );
        match download_model_to_temp(
            &app_handle,
            &client,
            &url,
            &models_dir,
            &temp_path,
            target_path.file_name().and_then(|value| value.to_str()),
            attempt,
        )
        .await
        {
            Ok(actual_sha256) => {
                if let Some(expected) = expected_sha256.as_deref() {
                    if actual_sha256 != expected {
                        last_error =
                            "downloaded model hash did not match the expected SHA256".to_string();
                        let _ = tokio::fs::remove_file(&temp_path).await;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }
            Err(error) => {
                last_error = error.to_string();
                let _ = tokio::fs::remove_file(&temp_path).await;
                if MODEL_DOWNLOAD_CANCELLED.load(Ordering::Acquire) {
                    return Err(AppError::Runtime("model download cancelled".to_string()));
                }
            }
        }

        if attempt < MODEL_DOWNLOAD_ATTEMPTS {
            emit_model_download_progress(
                &app_handle,
                "retrying",
                target_path.file_name().and_then(|value| value.to_str()),
                0,
                None,
                attempt,
            );
            tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
        }
    }

    if !tokio::fs::try_exists(&temp_path).await.unwrap_or(false) {
        return Err(AppError::Runtime(format!(
            "model download failed after {MODEL_DOWNLOAD_ATTEMPTS} attempt(s): {last_error}"
        )));
    }

    if tokio::fs::try_exists(&target_path).await.unwrap_or(false) {
        tokio::fs::remove_file(&target_path).await?;
    }
    tokio::fs::rename(&temp_path, &target_path).await?;
    emit_model_download_progress(
        &app_handle,
        "ready",
        target_path.file_name().and_then(|value| value.to_str()),
        tokio::fs::metadata(&target_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        None,
        MODEL_DOWNLOAD_ATTEMPTS,
    );

    import_model_record(
        state.db.clone(),
        target_path.canonicalize()?,
        model_name_hint,
    )
    .await
}

#[tauri::command]
async fn cancel_model_download() -> AppResult<bool> {
    let active = MODEL_DOWNLOAD_ACTIVE.load(Ordering::Acquire);
    if active {
        MODEL_DOWNLOAD_CANCELLED.store(true, Ordering::Release);
    }
    Ok(active)
}

#[tauri::command]
async fn set_active_model(
    state: tauri::State<'_, AppState>,
    model_id: String,
) -> AppResult<ModelRecord> {
    let state = state.handles().await?;
    let model_id = normalize_non_empty(&model_id, "model id")?;
    run_db_task(state.db.clone(), move |database| {
        database.set_active_model(&model_id)
    })
    .await
}

#[tauri::command]
async fn list_characters(state: tauri::State<'_, AppState>) -> AppResult<Vec<CharacterRecord>> {
    let state = state.handles().await?;
    run_db_task(state.db.clone(), |database| database.list_characters()).await
}

#[tauri::command]
async fn create_character(
    state: tauri::State<'_, AppState>,
    input: CreateCharacterInput,
) -> AppResult<CharacterRecord> {
    let state = state.handles().await?;
    let name = normalize_non_empty(&input.name, "character name")?;
    let description = input.description.map(|value| value.trim().to_string());
    let personality = input.personality.map(|value| value.trim().to_string());
    let backstory = input.backstory.map(|value| value.trim().to_string());
    let scenario = input.scenario.map(|value| value.trim().to_string());
    let system_prompt = input.system_prompt.map(|value| value.trim().to_string());
    let post_history_instructions = input
        .post_history_instructions
        .map(|value| value.trim().to_string());
    let speech_style = input.speech_style.map(|value| value.trim().to_string());
    let greeting = input.greeting.map(|value| value.trim().to_string());
    let alternate_greetings_json = normalize_string_list_json_input(
        input.alternate_greetings,
        input.alternate_greetings_json,
    )?;
    let avatar = input
        .avatar
        .map(|value| portraits::persist_portrait(&state.app_data_dir, &value));
    let tags_json = normalize_tags_json_input(input.tags, input.tags_json)?;
    let likes_json = normalize_string_list_json_input(input.likes, input.likes_json)?;
    let dislikes_json = normalize_string_list_json_input(input.dislikes, input.dislikes_json)?;
    let boundaries = input.boundaries.map(|value| value.trim().to_string());
    let creator_notes = input.creator_notes.map(|value| value.trim().to_string());
    let creator = input.creator.map(|value| value.trim().to_string());
    let character_version = input
        .character_version
        .map(|value| value.trim().to_string());
    let card_extensions_json = input
        .card_extensions_json
        .map(|value| value.trim().to_string());
    let example_dialogue = input.example_dialogue.map(|value| value.trim().to_string());

    run_db_task(state.db.clone(), move |database| {
        database.create_character(
            &name,
            description.as_deref(),
            personality.as_deref(),
            backstory.as_deref(),
            scenario.as_deref(),
            system_prompt.as_deref(),
            post_history_instructions.as_deref(),
            speech_style.as_deref(),
            greeting.as_deref(),
            alternate_greetings_json.as_deref(),
            avatar.as_deref(),
            tags_json.as_deref(),
            likes_json.as_deref(),
            dislikes_json.as_deref(),
            boundaries.as_deref(),
            creator_notes.as_deref(),
            creator.as_deref(),
            character_version.as_deref(),
            card_extensions_json.as_deref(),
            example_dialogue.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn update_character(
    state: tauri::State<'_, AppState>,
    input: UpdateCharacterInput,
) -> AppResult<CharacterRecord> {
    let state = state.handles().await?;
    let character_id = normalize_non_empty(&input.id, "character id")?;
    let name = input.name.map(|value| value.trim().to_string());
    let description = input.description.map(|value| value.trim().to_string());
    let personality = input.personality.map(|value| value.trim().to_string());
    let backstory = input.backstory.map(|value| value.trim().to_string());
    let scenario = input.scenario.map(|value| value.trim().to_string());
    let system_prompt = input.system_prompt.map(|value| value.trim().to_string());
    let post_history_instructions = input
        .post_history_instructions
        .map(|value| value.trim().to_string());
    let speech_style = input.speech_style.map(|value| value.trim().to_string());
    let greeting = input.greeting.map(|value| value.trim().to_string());
    let alternate_greetings_json = normalize_string_list_json_input(
        input.alternate_greetings,
        input.alternate_greetings_json,
    )?;
    let avatar = input
        .avatar
        .map(|value| portraits::persist_portrait(&state.app_data_dir, &value));
    let tags_json = normalize_tags_json_input(input.tags, input.tags_json)?;
    let likes_json = normalize_string_list_json_input(input.likes, input.likes_json)?;
    let dislikes_json = normalize_string_list_json_input(input.dislikes, input.dislikes_json)?;
    let boundaries = input.boundaries.map(|value| value.trim().to_string());
    let creator_notes = input.creator_notes.map(|value| value.trim().to_string());
    let creator = input.creator.map(|value| value.trim().to_string());
    let character_version = input
        .character_version
        .map(|value| value.trim().to_string());
    let card_extensions_json = input
        .card_extensions_json
        .map(|value| value.trim().to_string());
    let example_dialogue = input.example_dialogue.map(|value| value.trim().to_string());

    run_db_task(state.db.clone(), move |database| {
        database.update_character(
            &character_id,
            name.as_deref(),
            description.as_deref(),
            personality.as_deref(),
            backstory.as_deref(),
            scenario.as_deref(),
            system_prompt.as_deref(),
            post_history_instructions.as_deref(),
            speech_style.as_deref(),
            greeting.as_deref(),
            alternate_greetings_json.as_deref(),
            avatar.as_deref(),
            tags_json.as_deref(),
            likes_json.as_deref(),
            dislikes_json.as_deref(),
            boundaries.as_deref(),
            creator_notes.as_deref(),
            creator.as_deref(),
            character_version.as_deref(),
            card_extensions_json.as_deref(),
            example_dialogue.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn delete_character(
    state: tauri::State<'_, AppState>,
    character_id: String,
) -> AppResult<()> {
    let state = state.handles().await?;
    let character_id = normalize_non_empty(&character_id, "character id")?;
    run_db_task(state.db.clone(), move |database| {
        database.delete_character(&character_id)
    })
    .await
}

#[tauri::command]
async fn list_persona_presets(
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<PersonaPresetRecord>> {
    let state = state.handles().await?;
    run_db_task(state.db.clone(), |database| database.list_persona_presets()).await
}

#[tauri::command]
async fn create_persona_preset(
    state: tauri::State<'_, AppState>,
    input: CreatePersonaPresetInput,
) -> AppResult<PersonaPresetRecord> {
    let state = state.handles().await?;
    let name = normalize_non_empty(&input.name, "persona preset name")?;
    let description = input.description.map(|value| value.trim().to_string());
    let system_prompt = input.system_prompt.map(|value| value.trim().to_string());

    run_db_task(state.db.clone(), move |database| {
        database.create_persona_preset(&name, description.as_deref(), system_prompt.as_deref())
    })
    .await
}

#[tauri::command]
async fn update_persona_preset(
    state: tauri::State<'_, AppState>,
    input: UpdatePersonaPresetInput,
) -> AppResult<PersonaPresetRecord> {
    let state = state.handles().await?;
    let preset_id = normalize_non_empty(&input.id, "persona preset id")?;
    let name = input.name.map(|value| value.trim().to_string());
    if name.as_ref().is_some_and(|value| value.is_empty()) {
        return Err(AppError::Validation(
            "persona preset name cannot be empty".to_string(),
        ));
    }
    let description = input.description.map(|value| value.trim().to_string());
    let system_prompt = input.system_prompt.map(|value| value.trim().to_string());

    run_db_task(state.db.clone(), move |database| {
        database.update_persona_preset(
            &preset_id,
            name.as_deref(),
            description.as_deref(),
            system_prompt.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn delete_persona_preset(
    state: tauri::State<'_, AppState>,
    preset_id: String,
) -> AppResult<()> {
    let state = state.handles().await?;
    let preset_id = normalize_non_empty(&preset_id, "persona preset id")?;
    run_db_task(state.db.clone(), move |database| {
        database.delete_persona_preset(&preset_id)
    })
    .await
}

#[tauri::command]
async fn list_generation_presets(
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<GenerationPresetRecord>> {
    let state = state.handles().await?;
    run_db_task(state.db.clone(), |database| {
        database.list_generation_presets()
    })
    .await
}

#[tauri::command]
async fn create_generation_preset(
    state: tauri::State<'_, AppState>,
    input: CreateGenerationPresetInput,
) -> AppResult<GenerationPresetRecord> {
    let state = state.handles().await?;
    let name = normalize_non_empty(&input.name, "generation preset name")?;
    let description = input.description.map(|value| value.trim().to_string());
    let temperature = normalize_temperature_input(input.temperature)?;
    let top_p = normalize_top_p_input(input.top_p)?;
    let max_tokens = normalize_max_tokens_input(input.max_tokens)?;
    let repeat_penalty = normalize_repeat_penalty_input(input.repeat_penalty)?;

    run_db_task(state.db.clone(), move |database| {
        database.create_generation_preset(
            &name,
            description.as_deref(),
            temperature,
            top_p,
            max_tokens,
            repeat_penalty,
        )
    })
    .await
}

#[tauri::command]
async fn update_generation_preset(
    state: tauri::State<'_, AppState>,
    input: UpdateGenerationPresetInput,
) -> AppResult<GenerationPresetRecord> {
    let state = state.handles().await?;
    let preset_id = normalize_non_empty(&input.id, "generation preset id")?;
    let name = input.name.map(|value| value.trim().to_string());
    if name.as_ref().is_some_and(|value| value.is_empty()) {
        return Err(AppError::Validation(
            "generation preset name cannot be empty".to_string(),
        ));
    }
    let description = input.description.map(|value| value.trim().to_string());
    let temperature = normalize_temperature_input(input.temperature)?;
    let top_p = normalize_top_p_input(input.top_p)?;
    let max_tokens = normalize_max_tokens_input(input.max_tokens)?;
    let repeat_penalty = normalize_repeat_penalty_input(input.repeat_penalty)?;

    run_db_task(state.db.clone(), move |database| {
        database.update_generation_preset(
            &preset_id,
            name.as_deref(),
            description.as_deref(),
            temperature,
            top_p,
            max_tokens,
            repeat_penalty,
        )
    })
    .await
}

#[tauri::command]
async fn delete_generation_preset(
    state: tauri::State<'_, AppState>,
    preset_id: String,
) -> AppResult<()> {
    let state = state.handles().await?;
    let preset_id = normalize_non_empty(&preset_id, "generation preset id")?;
    run_db_task(state.db.clone(), move |database| {
        database.delete_generation_preset(&preset_id)
    })
    .await
}

#[tauri::command]
async fn list_context_entries(
    state: tauri::State<'_, AppState>,
    character_id: Option<String>,
) -> AppResult<Vec<ContextEntryRecord>> {
    let state = state.handles().await?;
    let character_id = character_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    run_db_task(state.db.clone(), move |database| {
        database.list_context_entries(character_id.as_deref())
    })
    .await
}

#[tauri::command]
async fn create_context_entry(
    state: tauri::State<'_, AppState>,
    input: CreateContextEntryInput,
) -> AppResult<ContextEntryRecord> {
    let state = state.handles().await?;
    let scope = normalize_context_scope(&input.scope)?;
    let mut character_id = input
        .character_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if scope == "character" && character_id.is_none() {
        return Err(AppError::Validation(
            "character_id is required when scope is character".to_string(),
        ));
    }
    if scope == "global" {
        character_id = None;
    }

    let title = normalize_non_empty(&input.title, "context entry title")?;
    let content = input.content.trim().to_string();
    let keywords_json = normalize_keywords_json_input(input.keywords, input.keywords_json)?;

    run_db_task(state.db.clone(), move |database| {
        database.create_context_entry(
            &scope,
            character_id.as_deref(),
            &title,
            keywords_json.as_deref(),
            &content,
            input.enabled,
        )
    })
    .await
}

#[tauri::command]
async fn update_context_entry(
    state: tauri::State<'_, AppState>,
    input: UpdateContextEntryInput,
) -> AppResult<ContextEntryRecord> {
    let state = state.handles().await?;
    let context_entry_id = normalize_non_empty(&input.id, "context entry id")?;
    let title = if let Some(value) = input.title {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() {
            return Err(AppError::Validation(
                "context entry title cannot be empty".to_string(),
            ));
        }
        Some(trimmed)
    } else {
        None
    };
    let keywords_json = normalize_keywords_json_input(input.keywords, input.keywords_json)?;
    let content = input.content.map(|value| value.trim().to_string());

    run_db_task(state.db.clone(), move |database| {
        database.update_context_entry(
            &context_entry_id,
            title.as_deref(),
            keywords_json.as_deref(),
            content.as_deref(),
            input.enabled,
        )
    })
    .await
}

#[tauri::command]
async fn delete_context_entry(
    state: tauri::State<'_, AppState>,
    context_entry_id: String,
) -> AppResult<()> {
    let state = state.handles().await?;
    let context_entry_id = normalize_non_empty(&context_entry_id, "context entry id")?;
    run_db_task(state.db.clone(), move |database| {
        database.delete_context_entry(&context_entry_id)
    })
    .await
}

#[tauri::command]
async fn resolve_context_entries(
    state: tauri::State<'_, AppState>,
    input: ResolveContextEntriesInput,
) -> AppResult<Vec<ContextEntryRecord>> {
    let state = state.handles().await?;
    let character_ids = input
        .character_ids
        .map(normalize_string_values)
        .unwrap_or_default();
    let query = normalize_non_empty(&input.query, "query")?;
    let limit = input.limit.unwrap_or(6).clamp(1, 20) as usize;

    run_db_task(state.db.clone(), move |database| {
        database.resolve_context_entries(&character_ids, &query, limit)
    })
    .await
}

#[tauri::command]
async fn resolve_memory_snippets<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: ResolveMemorySnippetsInput,
) -> AppResult<Vec<MemorySnippetRecord>> {
    let state = state.handles().await?;
    let mut results = resolve_memory_batch(&app_handle, state, vec![input]).await?;
    Ok(results.pop().unwrap_or_default())
}

#[tauri::command]
async fn resolve_memory_snippets_batch<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    inputs: Vec<ResolveMemorySnippetsInput>,
) -> AppResult<Vec<Vec<MemorySnippetRecord>>> {
    resolve_memory_batch(&app_handle, state.handles().await?, inputs).await
}

async fn resolve_memory_batch<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    state: InitializedAppState,
    inputs: Vec<ResolveMemorySnippetsInput>,
) -> AppResult<Vec<Vec<MemorySnippetRecord>>> {
    let Some(first) = inputs.first() else {
        return Ok(Vec::new());
    };
    if inputs.len() > 32 {
        return Err(AppError::Validation(
            "too many memory retrieval requests".to_string(),
        ));
    }
    let chat_id = normalize_non_empty(&first.chat_id, "chat id")?;
    let query = normalize_non_empty(&first.query, "query")?;
    if inputs
        .iter()
        .any(|input| input.chat_id.trim() != chat_id || input.query.trim() != query)
    {
        return Err(AppError::Validation(
            "memory batch must share a chat and query".to_string(),
        ));
    }
    let max_limit = inputs
        .iter()
        .map(|input| input.limit.unwrap_or(6).clamp(1, 12) as usize)
        .max()
        .unwrap_or(6);
    let lexical_inputs = inputs.clone();
    let lexical_hits = run_db_task(state.db.clone(), move |database| {
        lexical_inputs
            .iter()
            .map(|input| {
                database.resolve_memory_snippets(
                    input.chat_id.trim(),
                    input.query.trim(),
                    input.limit.unwrap_or(6).clamp(1, 12) as usize,
                    input.speaker_character_id.as_deref(),
                    input.retrieval_hints.as_deref(),
                    Database::RECALL_EXCLUDED_RECENT_MESSAGES,
                )
            })
            .collect::<AppResult<Vec<_>>>()
    })
    .await?;
    // One query embedding and one vector lookup serve all responders in this turn.
    let retrieval_diagnostics = state.indexing_diagnostics.clone();
    let semantic_hits = match resolve_semantic_memory_hits(
        app_handle,
        state.db.clone(),
        state.embedding_service.clone(),
        state.indexing_diagnostics.clone(),
        &chat_id,
        &query,
        max_limit.saturating_mul(2).clamp(4, 24),
    )
    .await
    {
        Ok(hits) => hits,
        Err(error) => {
            // Lexical recall still answers the turn, but the failure must not vanish.
            eprintln!("semantic memory retrieval failed: {error}");
            record_retrieval_failure(&retrieval_diagnostics, &error).await;
            Vec::new()
        }
    };
    // Remembered items lead; recalled chat messages follow.
    let item_hits =
        memory_service::resolve_item_snippets(app_handle, &state, &inputs, &chat_id, &query).await;
    Ok(lexical_hits
        .into_iter()
        .zip(inputs)
        .zip(item_hits)
        .map(|((lexical, input), mut items)| {
            items.extend(merge_memory_snippets(
                lexical,
                semantic_hits.clone(),
                input.limit.unwrap_or(6).clamp(1, 12) as usize,
            ));
            items
        })
        .collect())
}

#[tauri::command]
async fn import_character_card(
    state: tauri::State<'_, AppState>,
    input: ImportCharacterCardInput,
) -> AppResult<CharacterRecord> {
    let state = state.handles().await?;
    let path = canonicalize_character_card_path(&input.path)?;
    let app_data_dir = state.app_data_dir.clone();

    run_db_task(state.db.clone(), move |database| {
        let mut imported = import_character_card_from_path(&path)?;
        imported.avatar = portraits::persist_portrait(&app_data_dir, &imported.avatar);
        database.create_character_with_card_passthrough(
            &imported.name,
            Some(&imported.description),
            Some(&imported.personality),
            Some(&imported.backstory),
            Some(&imported.scenario),
            Some(&imported.system_prompt),
            Some(&imported.post_history_instructions),
            Some(&imported.speech_style),
            Some(&imported.greeting),
            Some(&imported.alternate_greetings_json),
            Some(&imported.avatar),
            Some(&imported.tags_json),
            Some(&imported.likes_json),
            Some(&imported.dislikes_json),
            Some(&imported.boundaries),
            Some(&imported.creator_notes),
            Some(&imported.creator),
            Some(&imported.character_version),
            Some(&imported.card_extensions_json),
            Some(&imported.card_passthrough_json),
            Some(&imported.example_dialogue),
        )
    })
    .await
}

#[tauri::command]
async fn export_character_card_json(
    state: tauri::State<'_, AppState>,
    input: ExportCharacterCardJsonInput,
) -> AppResult<CharacterCardExportResponse> {
    let state = state.handles().await?;
    let character_id = normalize_non_empty(&input.character_id, "character id")?;
    let output_path = normalize_character_card_export_path(&input.path, "json")?;

    let character = run_db_task(state.db.clone(), move |database| {
        database.get_character(&character_id)
    })
    .await?;

    let payload = build_character_card_json(&character)?;
    let serialized = serde_json::to_string_pretty(&payload).map_err(|error| {
        AppError::Validation(format!("failed to serialize character card JSON: {error}"))
    })?;
    fs::write(&output_path, serialized)?;

    Ok(CharacterCardExportResponse {
        path: output_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn export_character_card_png(
    state: tauri::State<'_, AppState>,
    input: ExportCharacterCardPngInput,
) -> AppResult<CharacterCardExportResponse> {
    let state = state.handles().await?;
    let character_id = normalize_non_empty(&input.character_id, "character id")?;
    let output_path = normalize_character_card_export_path(&input.path, "png")?;

    let character = run_db_task(state.db.clone(), move |database| {
        database.get_character(&character_id)
    })
    .await?;

    let avatar_path = normalize_non_empty(&character.avatar, "character portrait path")?;
    let source_png = read_file_with_limit(
        Path::new(&avatar_path),
        MAX_CHARACTER_CARD_FILE_BYTES,
        "character portrait",
    )?;
    let encoded = build_png_card_bytes(&source_png, &character)?;
    fs::write(&output_path, encoded)?;

    Ok(CharacterCardExportResponse {
        path: output_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn save_text_file(path: String, content: String) -> AppResult<CharacterCardExportResponse> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "file path cannot be empty".to_string(),
        ));
    }
    if content.len() > MAX_SAVED_TEXT_FILE_BYTES {
        return Err(AppError::Validation(format!(
            "file exceeds the {} MiB size limit",
            MAX_SAVED_TEXT_FILE_BYTES / (1024 * 1024)
        )));
    }
    let output_path = PathBuf::from(trimmed);
    let extension = output_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("json" | "md" | "txt")) {
        return Err(AppError::Validation(
            "file must be a .json, .md, or .txt file".to_string(),
        ));
    }
    let parent_exists = output_path
        .parent()
        .is_some_and(|parent| parent.as_os_str().is_empty() || parent.is_dir());
    if !parent_exists || output_path.is_dir() {
        return Err(AppError::Validation(format!(
            "file location is invalid: {}",
            output_path.display()
        )));
    }
    fs::write(&output_path, content)?;
    Ok(CharacterCardExportResponse {
        path: output_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn read_local_image_data_url(path: String) -> AppResult<String> {
    let image_path = canonicalize_local_image_path(&path)?;
    let mime_type = infer_image_mime_type(&image_path)?;
    let bytes = read_file_with_limit(&image_path, MAX_LOCAL_IMAGE_FILE_BYTES, "local image")?;
    Ok(format!(
        "data:{mime_type};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

#[tauri::command]
async fn list_chats(
    state: tauri::State<'_, AppState>,
    character_id: Option<String>,
) -> AppResult<Vec<ChatRecord>> {
    let state = state.handles().await?;
    let character_id = character_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    run_db_task(state.db.clone(), move |database| {
        database.list_chats(character_id.as_deref())
    })
    .await
}

#[tauri::command]
async fn create_chat(
    state: tauri::State<'_, AppState>,
    input: CreateChatInput,
) -> AppResult<ChatRecord> {
    let state = state.handles().await?;
    let title = input
        .title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_chat_title);
    let character_id = input
        .character_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    run_db_task(state.db.clone(), move |database| {
        database.create_chat(&title, character_id.as_deref())
    })
    .await
}

#[tauri::command]
async fn create_group_chat(
    state: tauri::State<'_, AppState>,
    input: CreateGroupChatInput,
) -> AppResult<ChatRecord> {
    let state = state.handles().await?;
    let title = input
        .title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_group_chat_title);

    let character_ids = normalize_character_id_list(input.character_ids)?;

    run_db_task(state.db.clone(), move |database| {
        database.create_group_chat(&title, &character_ids)
    })
    .await
}

#[tauri::command]
async fn update_group_chat(
    state: tauri::State<'_, AppState>,
    input: UpdateGroupChatInput,
) -> AppResult<ChatRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let title = input
        .title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::Validation("group chat title cannot be empty".to_string()))?;
    let character_ids = normalize_character_id_list(input.character_ids)?;

    run_db_task(state.db.clone(), move |database| {
        database.update_group_chat(&chat_id, &title, &character_ids)
    })
    .await
}

#[tauri::command]
async fn delete_chat(state: tauri::State<'_, AppState>, chat_id: String) -> AppResult<()> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    run_db_task(state.db.clone(), move |database| {
        database.delete_chat(&chat_id)
    })
    .await
}

#[tauri::command]
async fn delete_message(
    state: tauri::State<'_, AppState>,
    input: DeleteMessageInput,
) -> AppResult<ChatHistoryMutationRecord> {
    let state = state.handles().await?;
    let message_id = normalize_non_empty(&input.id, "message id")?;
    let expected_history_epoch = input.expected_history_epoch;
    run_db_task(state.db.clone(), move |database| {
        database.delete_message(&message_id, expected_history_epoch)
    })
    .await
}

#[tauri::command]
async fn rename_chat(
    state: tauri::State<'_, AppState>,
    input: RenameChatInput,
) -> AppResult<ChatRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let title = normalize_non_empty(&input.title, "chat title")?;
    run_db_task(state.db.clone(), move |database| {
        database.rename_chat(&chat_id, &title)
    })
    .await
}

#[tauri::command]
async fn clear_chat_history(
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> AppResult<ChatHistoryMutationRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    run_db_task(state.db.clone(), move |database| {
        database.clear_chat_history_mutation(&chat_id)
    })
    .await
}

#[tauri::command]
async fn list_chat_participants(
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<CharacterRecord>> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    run_db_task(state.db.clone(), move |database| {
        database.list_chat_participants(&chat_id)
    })
    .await
}

#[tauri::command]
async fn list_messages(
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> AppResult<Vec<MessageRecord>> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    run_db_task(state.db.clone(), move |database| {
        database.list_messages(&chat_id)
    })
    .await
}

#[tauri::command]
async fn get_chat_memory(
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> AppResult<ChatMemoryRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    run_db_task(state.db.clone(), move |database| {
        database.get_chat_memory(&chat_id)
    })
    .await
}

#[tauri::command]
async fn upsert_chat_memory(
    state: tauri::State<'_, AppState>,
    input: UpsertChatMemoryInput,
) -> AppResult<ChatMemoryRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let summary = input.summary.map(|value| value.trim().to_string());
    let facts_json = normalize_facts_json_input(input.facts, input.facts_json)?;
    let expected_history_epoch = input.expected_history_epoch;

    run_db_task(state.db.clone(), move |database| {
        database.upsert_chat_memory_at_epoch(
            &chat_id,
            summary.as_deref(),
            facts_json.as_deref(),
            expected_history_epoch,
        )
    })
    .await
}

#[tauri::command]
async fn get_auto_summary_batch(
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> AppResult<types::AutoSummaryBatchRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    run_db_task(state.db.clone(), move |database| {
        database.get_auto_summary_batch(&chat_id)
    })
    .await
}

#[tauri::command]
async fn store_auto_summary(
    state: tauri::State<'_, AppState>,
    input: types::StoreAutoSummaryInput,
) -> AppResult<Option<ChatMemoryRecord>> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let through_message_id = normalize_non_empty(&input.through_message_id, "message id")?;
    let summary = input.summary;
    let expected_history_epoch = input.expected_history_epoch;

    run_db_task(state.db.clone(), move |database| {
        database.store_auto_summary_at_epoch(
            &chat_id,
            &summary,
            &through_message_id,
            expected_history_epoch,
        )
    })
    .await
}

#[tauri::command]
async fn get_chat_preset_profile(
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> AppResult<ChatPresetProfileRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    run_db_task(state.db.clone(), move |database| {
        database.get_chat_preset_profile(&chat_id)
    })
    .await
}

#[tauri::command]
async fn set_chat_persona(
    state: tauri::State<'_, AppState>,
    input: SetChatPersonaInput,
) -> AppResult<ChatPresetProfileRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let persona_preset_id = input
        .persona_preset_id
        .map(|value| value.trim().to_string());
    run_db_task(state.db.clone(), move |database| {
        database.set_chat_persona(&chat_id, persona_preset_id.as_deref())
    })
    .await
}

#[tauri::command]
async fn upsert_chat_preset_profile(
    state: tauri::State<'_, AppState>,
    input: UpsertChatPresetProfileInput,
) -> AppResult<ChatPresetProfileRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let generation_preset_id = input
        .generation_preset_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    run_db_task(state.db.clone(), move |database| {
        database.upsert_chat_preset_profile(&chat_id, generation_preset_id.as_deref())
    })
    .await
}

#[tauri::command]
async fn get_user_profile(state: tauri::State<'_, AppState>) -> AppResult<UserProfileRecord> {
    let state = state.handles().await?;
    run_db_task(state.db.clone(), |database| database.get_user_profile()).await
}

#[tauri::command]
async fn upsert_user_profile(
    state: tauri::State<'_, AppState>,
    input: UpsertUserProfileInput,
) -> AppResult<UserProfileRecord> {
    let state = state.handles().await?;
    let display_name = input.display_name.map(|value| value.trim().to_string());
    let about = input.about.map(|value| value.trim().to_string());
    let gender = input.gender.map(|value| value.trim().to_string());
    let avatar = input
        .avatar
        .map(|value| portraits::persist_portrait(&state.app_data_dir, &value));
    let traits_json = normalize_string_list_json_input(input.traits, input.traits_json)?;
    let preferences = input.preferences.map(|value| value.trim().to_string());
    let boundaries = input.boundaries.map(|value| value.trim().to_string());

    run_db_task(state.db.clone(), move |database| {
        database.upsert_user_profile(UserProfilePatch {
            display_name: display_name.as_deref(),
            about: about.as_deref(),
            gender: gender.as_deref(),
            avatar: avatar.as_deref(),
            traits_json: traits_json.as_deref(),
            preferences: preferences.as_deref(),
            boundaries: boundaries.as_deref(),
        })
    })
    .await
}

#[tauri::command]
async fn get_chat_relationship_state(
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> AppResult<ChatRelationshipStateRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    run_db_task(state.db.clone(), move |database| {
        database.get_chat_relationship_state(&chat_id)
    })
    .await
}

#[tauri::command]
async fn upsert_chat_relationship_state(
    state: tauri::State<'_, AppState>,
    input: UpsertChatRelationshipStateInput,
) -> AppResult<ChatRelationshipStateRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let summary = input.summary.map(|value| value.trim().to_string());
    let current_scene = input.current_scene.map(|value| value.trim().to_string());
    let interaction_tone = input.interaction_tone.map(|value| value.trim().to_string());
    let character_state = input.character_state.map(|value| value.trim().to_string());
    let user_state = input.user_state.map(|value| value.trim().to_string());
    let user_role_name = input.user_role_name.map(|value| value.trim().to_string());
    let user_role_description = input
        .user_role_description
        .map(|value| value.trim().to_string());
    let expected_history_epoch = input.expected_history_epoch;

    run_db_task(state.db.clone(), move |database| {
        database.upsert_chat_relationship_state_at_epoch(
            &chat_id,
            summary.as_deref(),
            current_scene.as_deref(),
            interaction_tone.as_deref(),
            character_state.as_deref(),
            user_state.as_deref(),
            user_role_name.as_deref(),
            user_role_description.as_deref(),
            expected_history_epoch,
        )
    })
    .await
}

#[tauri::command]
async fn append_message<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: AppendMessageInput,
) -> AppResult<MessageRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let role = normalize_role(&input.role)?;
    let content = normalize_non_empty(&input.content, "message content")?;
    let speaker_character_id = input
        .speaker_character_id
        .map(|value| value.trim().to_string());
    let expected_history_epoch = input.expected_history_epoch;

    let saved = run_db_task(state.db.clone(), move |database| {
        database.append_message_at_epoch(
            &chat_id,
            &role,
            &content,
            speaker_character_id.as_deref(),
            expected_history_epoch,
        )
    })
    .await?;

    schedule_message_embedding_index(
        app_handle,
        state.db.clone(),
        state.embedding_service.clone(),
        state.indexing_diagnostics.clone(),
        saved.clone(),
    );

    Ok(saved)
}

#[tauri::command]
async fn update_message<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: UpdateMessageInput,
) -> AppResult<MessageRecord> {
    let state = state.handles().await?;
    let message_id = normalize_non_empty(&input.id, "message id")?;
    let content = normalize_non_empty(&input.content, "message content")?;
    let expected_history_epoch = input.expected_history_epoch;
    let updated = run_db_task(state.db.clone(), move |database| {
        database.update_message_at_epoch(&message_id, &content, expected_history_epoch)
    })
    .await?;

    schedule_message_embedding_index(
        app_handle,
        state.db.clone(),
        state.embedding_service.clone(),
        state.indexing_diagnostics.clone(),
        updated.clone(),
    );

    Ok(updated)
}

#[tauri::command]
async fn edit_message_and_truncate<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: EditAndTruncateInput,
) -> AppResult<ChatHistoryMutationRecord> {
    let state = state.handles().await?;
    let message_id = normalize_non_empty(&input.id, "message id")?;
    let content = normalize_non_empty(&input.content, "message content")?;
    let expected_history_epoch = input.expected_history_epoch;
    let mutation = run_db_task(state.db.clone(), move |database| {
        database.edit_message_and_truncate(&message_id, &content, expected_history_epoch)
    })
    .await?;

    for message in mutation.messages.iter().cloned() {
        schedule_message_embedding_index(
            app_handle.clone(),
            state.db.clone(),
            state.embedding_service.clone(),
            state.indexing_diagnostics.clone(),
            message,
        );
    }

    Ok(mutation)
}

#[tauri::command]
async fn branch_chat(
    state: tauri::State<'_, AppState>,
    input: BranchChatInput,
) -> AppResult<ChatRecord> {
    let state = state.handles().await?;
    let source_chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    let anchor_message_id = normalize_non_empty(&input.anchor_message_id, "anchor message id")?;
    let title = input
        .title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    run_db_task(state.db.clone(), move |database| {
        database.branch_chat(&source_chat_id, &anchor_message_id, title.as_deref())
    })
    .await
}

#[tauri::command]
async fn start_runtime<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: Option<StartRuntimeInput>,
) -> AppResult<RuntimeStatusResponse> {
    let state = state.handles().await?;
    let StartRuntimeInput {
        model_id,
        extra_args,
        warmup_enabled,
        gpu_layers,
        performance_mode,
    } = input.unwrap_or(StartRuntimeInput {
        model_id: None,
        extra_args: None,
        warmup_enabled: None,
        gpu_layers: None,
        performance_mode: None,
    });
    let requested_model_id = model_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let explicit_args = normalize_runtime_extra_args(extra_args.unwrap_or_default());
    validate_runtime_extra_args(&explicit_args)?;
    let launch_settings = run_db_task(state.db.clone(), |database| {
        database.get_runtime_launch_settings()
    })
    .await?;
    let warmup_enabled = warmup_enabled.unwrap_or(launch_settings.warmup_enabled);
    let performance_mode = performance_mode.unwrap_or(launch_settings.performance_mode);
    let configured_gpu_layers = gpu_layers.unwrap_or(launch_settings.gpu_layers);
    let manual_gpu_layers = effective_runtime_gpu_layers(performance_mode, configured_gpu_layers)?;

    let model = run_db_task(state.db.clone(), move |database| {
        if let Some(model_id) = requested_model_id {
            return database
                .get_model_by_id(&model_id)?
                .ok_or_else(|| AppError::NotFound(format!("model {model_id} was not found")));
        }
        database
            .get_active_model()?
            .ok_or_else(|| AppError::NotFound("no active model has been set".to_string()))
    })
    .await?;
    let model_path = PathBuf::from(&model.source_path);

    let launch_args = |offload_args: &[String]| {
        let mut args = chat_server_args(warmup_enabled);
        args.extend(offload_args.iter().cloned());
        args.extend(explicit_args.iter().cloned());
        args
    };
    let launch = |plan: &RuntimeLaunchPlan| {
        state.runtime_manager.start(
            &app_handle,
            RuntimeStartRequest {
                model_id: model.id.clone(),
                model_path: model_path.clone(),
                binary_path: plan.binary_path.clone(),
                extra_args: launch_args(&plan.offload_args),
                selection: Some(plan.selection.clone()),
            },
        )
    };
    let plan = plan_chat_launch(&state.resources, performance_mode, manual_gpu_layers).await?;
    if !plan.backend.is_gpu() {
        return launch(&plan).await;
    }

    let checks = GpuCheckStore::new(state.app_data_dir.join("runtime").join("gpu-checks.json"));
    let check_key = gpu_check::check_key(&model.id, &plan.selection);
    let known = checks.get(&check_key);
    // In Auto mode a GPU that failed before goes straight to the CPU; choosing
    // GPU mode explicitly checks it again.
    let fallback_reason = if known == Some(false)
        && performance_mode == RuntimePerformanceMode::Auto
    {
        "This graphics processor gave unreadable replies before, so Glee is using the CPU."
            .to_string()
    } else {
        match launch(&plan).await {
            Ok(status) if known == Some(true) => return Ok(status),
            Ok(status) => match gpu_check::verify(&status).await {
                Ok(()) => {
                    checks.put(&check_key, true);
                    return Ok(status);
                }
                Err(detail) => {
                    eprintln!("GPU output check failed: {detail}");
                    checks.put(&check_key, false);
                    state.runtime_manager.stop().await?;
                    format!(
                        "The graphics processor gave unreadable replies ({detail}), so Glee is using the CPU."
                    )
                }
            },
            Err(error) => {
                state.runtime_manager.stop().await?;
                format!("GPU startup failed, so Glee is using the CPU. Original error: {error}")
            }
        }
    };
    let fallback = cpu_fallback_plan(&state.resources, &plan.selection, fallback_reason)?;
    launch(&fallback).await
}

#[tauri::command]
async fn stop_runtime(state: tauri::State<'_, AppState>) -> AppResult<RuntimeStatusResponse> {
    let state = state.handles().await?;
    state.runtime_manager.stop().await
}

#[tauri::command]
async fn runtime_status(state: tauri::State<'_, AppState>) -> AppResult<RuntimeStatusResponse> {
    let state = state.handles().await?;
    state.runtime_manager.status().await
}

#[tauri::command]
async fn get_runtime_launch_settings(
    state: tauri::State<'_, AppState>,
) -> AppResult<RuntimeLaunchSettingsRecord> {
    let state = state.handles().await?;
    run_db_task(state.db.clone(), |database| {
        database.get_runtime_launch_settings()
    })
    .await
}

#[tauri::command]
async fn set_runtime_launch_settings(
    state: tauri::State<'_, AppState>,
    input: UpdateRuntimeLaunchSettingsInput,
) -> AppResult<RuntimeLaunchSettingsRecord> {
    let state = state.handles().await?;
    let current = run_db_task(state.db.clone(), |database| {
        database.get_runtime_launch_settings()
    })
    .await?;
    let warmup_enabled = input.warmup_enabled.unwrap_or(current.warmup_enabled);
    let gpu_layers = match input.gpu_layers {
        Some(value) => normalize_runtime_gpu_layers(value)?,
        None => current.gpu_layers,
    };
    let performance_mode = input.performance_mode.unwrap_or(current.performance_mode);

    run_db_task(state.db.clone(), move |database| {
        database.set_runtime_launch_settings(warmup_enabled, gpu_layers, performance_mode)
    })
    .await
}

#[tauri::command]
async fn diagnostics_snapshot<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> AppResult<DiagnosticsSnapshot> {
    let state = state.handles().await?;
    let _ = app_handle;
    build_diagnostics_snapshot(&state).await
}

#[tauri::command]
async fn export_diagnostics_bundle<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> AppResult<DiagnosticsExportResponse> {
    let state = state.handles().await?;
    let _ = app_handle;
    let snapshot = build_diagnostics_snapshot(&state).await?;
    let runtime_log_source = snapshot.runtime.log_file.clone();
    let path_redactions = diagnostics_path_redactions(&snapshot);
    let export_snapshot = redact_diagnostics_snapshot(snapshot, &path_redactions);
    let diagnostics_dir = state.app_data_dir.join("diagnostics").join(format!(
        "glee-diagnostics-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    fs::create_dir_all(&diagnostics_dir)?;

    let summary_path = diagnostics_dir.join("summary.json");
    let summary_json = serde_json::to_vec_pretty(&export_snapshot).map_err(|error| {
        AppError::Runtime(format!("failed to serialize diagnostics summary: {error}"))
    })?;
    fs::write(&summary_path, summary_json)?;

    let settings_path = diagnostics_dir.join("settings.json");
    let settings_json = serde_json::to_vec_pretty(&export_snapshot.settings).map_err(|error| {
        AppError::Runtime(format!("failed to serialize settings snapshot: {error}"))
    })?;
    fs::write(&settings_path, settings_json)?;

    let mut runtime_log_note = "No runtime log was available.".to_string();
    let runtime_log_path = runtime_log_source.as_deref().and_then(|value| {
        let path = PathBuf::from(value);
        if path.exists() && path.is_file() {
            let destination = diagnostics_dir.join("runtime.log");
            match read_file_with_limit(
                &path,
                MAX_DIAGNOSTICS_LOG_EXPORT_BYTES,
                "runtime diagnostics log",
            ) {
                Ok(bytes) => {
                    let redacted_log = redact_diagnostics_text(
                        String::from_utf8_lossy(&bytes).as_ref(),
                        &path_redactions,
                    );
                    if fs::write(&destination, redacted_log.as_bytes()).is_ok() {
                        runtime_log_note =
                            "Runtime log: runtime.log (local paths redacted).".to_string();
                        Some(destination.to_string_lossy().to_string())
                    } else {
                        runtime_log_note = "Runtime log could not be copied.".to_string();
                        None
                    }
                }
                Err(error) => {
                    runtime_log_note = format!("Runtime log was not included: {error}");
                    None
                }
            }
        } else {
            None
        }
    });

    let notes_path = diagnostics_dir.join("README.txt");
    let mut notes = File::create(&notes_path)?;
    writeln!(notes, "Glee diagnostics bundle")?;
    writeln!(notes, "Generated: {}", chrono::Utc::now().to_rfc3339())?;
    writeln!(notes, "Summary: summary.json")?;
    writeln!(notes, "Settings: settings.json")?;
    writeln!(notes, "{runtime_log_note}")?;
    writeln!(
        notes,
        "Local filesystem paths are replaced with descriptive placeholders."
    )?;

    Ok(DiagnosticsExportResponse {
        directory: diagnostics_dir.to_string_lossy().to_string(),
        summary_path: summary_path.to_string_lossy().to_string(),
        runtime_log_path,
        database_backup_path: None,
    })
}

#[tauri::command]
async fn create_database_backup(
    state: tauri::State<'_, AppState>,
) -> AppResult<DatabaseBackupResponse> {
    let state = state.handles().await?;
    let path = run_db_maintenance_task(state.db.clone(), |database| {
        database.export_backup("manual")
    })
    .await?;
    Ok(DatabaseBackupResponse {
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn list_database_backups(
    state: tauri::State<'_, AppState>,
) -> AppResult<Vec<DatabaseBackupRecord>> {
    let state = state.handles().await?;
    run_db_task(state.db.clone(), |database| database.list_backups()).await
}

#[tauri::command]
async fn export_database_backup(
    state: tauri::State<'_, AppState>,
    input: ExportDatabaseBackupInput,
) -> AppResult<DatabaseBackupResponse> {
    let state = state.handles().await?;
    let file_name = normalize_non_empty(&input.file_name, "database backup file name")?;
    let destination = PathBuf::from(normalize_non_empty(&input.path, "backup location")?);
    let saved = run_db_task(state.db.clone(), move |database| {
        database.copy_backup_to(&file_name, &destination)
    })
    .await?;
    Ok(DatabaseBackupResponse {
        path: saved.to_string_lossy().to_string(),
    })
}

#[tauri::command]
async fn import_database_backup(
    state: tauri::State<'_, AppState>,
    input: ImportDatabaseBackupInput,
) -> AppResult<DatabaseBackupRecord> {
    let state = state.handles().await?;
    let source = PathBuf::from(normalize_non_empty(&input.path, "backup file path")?);
    run_db_maintenance_task(state.db.clone(), move |database| {
        database.import_backup_file(&source)
    })
    .await
}

#[tauri::command]
async fn restore_database_backup<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: RestoreDatabaseBackupInput,
) -> AppResult<DatabaseRestoreResponse> {
    let initialized = state.handles().await?;
    let file_name = normalize_non_empty(&input.file_name, "database backup file name")?;

    initialized.runtime_manager.stop().await?;
    if let Some(service) = initialized.embedding_service.as_ref() {
        service.stop().await?;
    }

    let restored = run_db_maintenance_task(initialized.db.clone(), move |database| {
        database.restore_backup(&file_name)
    })
    .await;
    let (restored_from, safety_backup_path) = match restored {
        Ok(paths) => paths,
        Err(error) => {
            if let Some(service) = initialized.embedding_service.as_ref() {
                service.resume();
            }
            return Err(error);
        }
    };

    let response = DatabaseRestoreResponse {
        restored_from: restored_from.to_string_lossy().to_string(),
        safety_backup_path: safety_backup_path.to_string_lossy().to_string(),
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(350)).await;
        app_handle.restart();
    });
    Ok(response)
}

fn schedule_message_embedding_index<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: Database,
    embedding_service: Option<EmbeddingService>,
    indexing_diagnostics: Arc<tokio::sync::Mutex<IndexingDiagnostics>>,
    message: MessageRecord,
) {
    if is_generation_failure_message(&message) {
        return;
    }
    let Some(service) = embedding_service else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        update_indexing_diagnostics(
            &indexing_diagnostics,
            IndexingHealthStatus::Pending,
            None,
            Some(message.id.clone()),
        )
        .await;
        match index_single_message_embedding(&app_handle, db, service, message.clone()).await {
            Ok(()) => {
                update_indexing_diagnostics(
                    &indexing_diagnostics,
                    IndexingHealthStatus::Healthy,
                    None,
                    Some(message.id),
                )
                .await;
            }
            Err(error) => {
                eprintln!("message embedding index update failed: {error}");
                update_indexing_diagnostics(
                    &indexing_diagnostics,
                    IndexingHealthStatus::Degraded,
                    Some(error.to_string()),
                    Some(message.id),
                )
                .await;
            }
        }
    });
}

async fn index_single_message_embedding(
    app_handle: &tauri::AppHandle<impl tauri::Runtime>,
    db: Database,
    embedding_service: EmbeddingService,
    message: MessageRecord,
) -> AppResult<()> {
    if message.content.trim().is_empty() {
        return Ok(());
    }
    if is_generation_failure_message(&message) {
        return Ok(());
    }
    if !message.role.trim().eq_ignore_ascii_case("user")
        && !message.role.trim().eq_ignore_ascii_case("assistant")
    {
        return Ok(());
    }

    let chunks = embedding_service
        .embed_chunks(app_handle, &message.content)
        .await?;
    let embedding_model_id = embedding_service.index_id();
    run_db_task(db, move |database| {
        if embedding_service.is_stopped() {
            return Ok(());
        }
        database.upsert_message_embeddings(&message, &embedding_model_id, &chunks)
    })
    .await
}

fn is_generation_failure_message(message: &MessageRecord) -> bool {
    message.role.trim().eq_ignore_ascii_case("assistant")
        && message
            .content
            .trim_start()
            .starts_with(GENERATION_FAILURE_PREFIX)
}

async fn resolve_semantic_memory_hits<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    db: Database,
    embedding_service: Option<EmbeddingService>,
    indexing_diagnostics: Arc<tokio::sync::Mutex<IndexingDiagnostics>>,
    chat_id: &str,
    query: &str,
    limit: usize,
) -> AppResult<Vec<MemorySnippetRecord>> {
    let Some(service) = embedding_service else {
        return Ok(Vec::new());
    };
    if query.trim().is_empty() || service.is_stopped() {
        return Ok(Vec::new());
    }
    let query_embedding = service.embed_text(app_handle, query).await?;
    let dimensions = query_embedding.len();
    let embedding_model_id = service.index_id();
    let query_chat_id = chat_id.to_string();
    let hits = run_db_task(db.clone(), move |database| {
        database.resolve_semantic_memory_snippets(
            &query_chat_id,
            &embedding_model_id,
            &query_embedding,
            limit,
            Database::RECALL_EXCLUDED_RECENT_MESSAGES,
        )
    })
    .await?;
    schedule_embedding_backfill(
        app_handle.clone(),
        db,
        service,
        indexing_diagnostics,
        chat_id.to_string(),
        dimensions,
    );
    Ok(hits)
}

fn schedule_embedding_backfill<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: Database,
    service: EmbeddingService,
    diagnostics: Arc<tokio::sync::Mutex<IndexingDiagnostics>>,
    chat_id: String,
    dimensions: usize,
) {
    let Some(reservation) = service.try_begin_backfill(&chat_id) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let _reservation = reservation;
        let _worker = service.backfill_slot().await;
        // Ok(Some(summary)) means the pass finished but skipped messages that failed.
        let result: AppResult<Option<String>> = async {
            if service.is_stopped() {
                return Ok(None);
            }
            let cleanup_chat = chat_id.clone();
            run_db_task(db.clone(), move |database| {
                database.prepare_embedding_backfill(&cleanup_chat, dimensions)
            })
            .await?;
            let mut previous_ids = Vec::new();
            // One message that cannot be indexed must not block the older ones behind it.
            let mut skipped_ids: Vec<String> = Vec::new();
            let mut last_skip_error = String::new();
            while !service.is_stopped() {
                let model_id = service.index_id();
                let target_chat = chat_id.clone();
                let skipped = skipped_ids.clone();
                let messages = run_db_task(db.clone(), move |database| {
                    database.list_messages_missing_embeddings(
                        &target_chat,
                        &model_id,
                        dimensions,
                        6,
                        &skipped,
                    )
                })
                .await?;
                if messages.is_empty() {
                    break;
                }
                let ids = messages
                    .iter()
                    .map(|message| message.id.clone())
                    .collect::<Vec<_>>();
                if ids == previous_ids {
                    return Err(AppError::Runtime(
                        "embedding backfill made no progress; retry on the next retrieval"
                            .to_string(),
                    ));
                }
                previous_ids = ids;
                update_indexing_diagnostics(
                    &diagnostics,
                    IndexingHealthStatus::Pending,
                    None,
                    None,
                )
                .await;
                for message in messages {
                    if service.is_stopped() {
                        return Ok(None);
                    }
                    let id = message.id.clone();
                    if let Err(error) = index_single_message_embedding(
                        &app_handle,
                        db.clone(),
                        service.clone(),
                        message,
                    )
                    .await
                    {
                        eprintln!("embedding backfill skipped message {id}: {error}");
                        last_skip_error = format!("message {id}: {error}");
                        skipped_ids.push(id);
                        continue;
                    }
                    update_indexing_diagnostics(
                        &diagnostics,
                        IndexingHealthStatus::Pending,
                        None,
                        Some(id),
                    )
                    .await;
                    tokio::task::yield_now().await;
                }
            }
            Ok(if skipped_ids.is_empty() {
                None
            } else {
                Some(format!(
                    "{} message(s) could not be indexed; last failure: {last_skip_error}",
                    skipped_ids.len()
                ))
            })
        }
        .await;
        if !service.is_stopped() {
            match result {
                Ok(None) => {
                    update_indexing_diagnostics(
                        &diagnostics,
                        IndexingHealthStatus::Healthy,
                        None,
                        None,
                    )
                    .await
                }
                Ok(Some(summary)) => {
                    update_indexing_diagnostics(
                        &diagnostics,
                        IndexingHealthStatus::Degraded,
                        Some(summary),
                        None,
                    )
                    .await
                }
                Err(error) => {
                    update_indexing_diagnostics(
                        &diagnostics,
                        IndexingHealthStatus::Degraded,
                        Some(error.to_string()),
                        None,
                    )
                    .await
                }
            }
        }
    });
}

fn merge_memory_snippets(
    lexical_hits: Vec<MemorySnippetRecord>,
    semantic_hits: Vec<MemorySnippetRecord>,
    limit: usize,
) -> Vec<MemorySnippetRecord> {
    if limit == 0 {
        return Vec::new();
    }

    let mut by_message_id = std::collections::HashMap::new();
    for hit in lexical_hits {
        by_message_id.insert(hit.message_id.clone(), hit);
    }

    for semantic in semantic_hits {
        if let Some(existing) = by_message_id.get_mut(&semantic.message_id) {
            let boosted =
                ((existing.score as f64 * 0.75_f64) + (semantic.score as f64 * 0.95_f64)) as i64;
            existing.score = existing.score.max(boosted).max(semantic.score);
            existing.content = semantic.content;
        } else {
            by_message_id.insert(semantic.message_id.clone(), semantic);
        }
    }

    let mut merged = by_message_id.into_values().collect::<Vec<_>>();
    merged.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| right.created_at.cmp(&left.created_at))
            .then_with(|| left.message_id.cmp(&right.message_id))
    });
    merged.truncate(limit);
    merged
}

async fn run_db_task<T, F>(database: Database, task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(Database) -> AppResult<T> + Send + 'static,
{
    let operation_lock = database.operation_lock();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .read()
            .map_err(|_| AppError::Runtime("database operation lock was poisoned".to_string()))?;
        task(database)
    })
    .await
    .map_err(|error| AppError::TaskJoin(error.to_string()))?
}

async fn run_db_maintenance_task<T, F>(database: Database, task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(Database) -> AppResult<T> + Send + 'static,
{
    let operation_lock = database.operation_lock();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = operation_lock
            .write()
            .map_err(|_| AppError::Runtime("database maintenance lock was poisoned".to_string()))?;
        task(database)
    })
    .await
    .map_err(|error| AppError::TaskJoin(error.to_string()))?
}

async fn build_diagnostics_snapshot(state: &InitializedAppState) -> AppResult<DiagnosticsSnapshot> {
    let runtime = state.runtime_manager.status().await?;
    let active_model =
        run_db_task(state.db.clone(), |database| database.get_active_model()).await?;
    let settings = run_db_task(state.db.clone(), |database| database.list_settings()).await?;
    let startup = build_startup_health_snapshot(state, active_model.as_ref()).await?;
    let mut recent_errors = startup
        .checks
        .iter()
        .filter(|check| check.status != HealthCheckStatus::Ok)
        .map(|check| format!("{}: {}", check.label, check.detail))
        .collect::<Vec<_>>();
    if let Some(runtime_error) = runtime.error.clone() {
        recent_errors.push(format!("Runtime: {runtime_error}"));
    }

    Ok(DiagnosticsSnapshot {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: state.resources.platform().to_string(),
        runtime,
        startup,
        settings,
        feature_exposure: feature_exposure(),
        recent_errors,
    })
}

fn diagnostics_path_redactions(snapshot: &DiagnosticsSnapshot) -> Vec<(String, String)> {
    let mut redactions = Vec::new();
    let known_paths = [
        (
            Some(snapshot.startup.database_path.as_str()),
            "<database-path>",
        ),
        (Some(snapshot.startup.backup_dir.as_str()), "<backup-dir>"),
        (
            snapshot.startup.last_migration_backup_path.as_deref(),
            "<migration-backup-path>",
        ),
        (
            Some(snapshot.startup.runtime_binary_path.as_str()),
            "<runtime-binary-path>",
        ),
        (
            snapshot.startup.active_model_path.as_deref(),
            "<active-model-path>",
        ),
        (
            snapshot.startup.embedding_model_path.as_deref(),
            "<embedding-model-path>",
        ),
        (snapshot.runtime.log_file.as_deref(), "<runtime-log-path>"),
        (
            snapshot
                .runtime
                .selection
                .as_ref()
                .map(|selection| selection.binary_path.as_str()),
            "<runtime-binary-path>",
        ),
        (
            Some(snapshot.startup.app_data_dir.as_str()),
            "<app-data-dir>",
        ),
    ];
    for (path, replacement) in known_paths {
        push_diagnostics_path_redaction(&mut redactions, path, replacement);
    }
    for check in &snapshot.startup.checks {
        push_diagnostics_path_redaction(&mut redactions, check.path.as_deref(), "<local-path>");
    }
    // Catch every other path that would reveal the account name or folder layout.
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok());
    push_diagnostics_path_redaction(&mut redactions, home.as_deref(), "<home>");
    let temp = std::env::temp_dir().to_string_lossy().to_string();
    push_diagnostics_path_redaction(
        &mut redactions,
        Some(temp.trim_end_matches(['/', '\\'])),
        "<temp>",
    );

    redactions.sort_by(|left, right| right.0.len().cmp(&left.0.len()));
    let mut seen = HashSet::new();
    redactions.retain(|(path, _)| path.len() > 1 && seen.insert(path.clone()));
    redactions
}

fn push_diagnostics_path_redaction(
    redactions: &mut Vec<(String, String)>,
    path: Option<&str>,
    replacement: &str,
) {
    let Some(path) = path.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let normalized = path.strip_prefix(r"\\?\").unwrap_or(path);
    for candidate in [
        path.to_string(),
        path.replace('\\', "/"),
        normalized.to_string(),
        normalized.replace('\\', "/"),
    ] {
        if !candidate.is_empty() {
            redactions.push((candidate, replacement.to_string()));
        }
    }
}

fn redact_diagnostics_text(value: &str, redactions: &[(String, String)]) -> String {
    redactions
        .iter()
        .fold(value.to_string(), |redacted, (path, replacement)| {
            redacted.replace(path, replacement)
        })
}

fn redact_diagnostics_snapshot(
    mut snapshot: DiagnosticsSnapshot,
    redactions: &[(String, String)],
) -> DiagnosticsSnapshot {
    snapshot.runtime.api_key = None;
    snapshot.runtime.error = snapshot
        .runtime
        .error
        .map(|value| redact_diagnostics_text(&value, redactions));
    snapshot.runtime.log_file = snapshot
        .runtime
        .log_file
        .as_ref()
        .map(|_| "<runtime-log-path>".to_string());
    if let Some(selection) = snapshot.runtime.selection.as_mut() {
        selection.binary_path = "<runtime-binary-path>".to_string();
        selection.fallback_reason = selection
            .fallback_reason
            .as_ref()
            .map(|value| redact_diagnostics_text(value, redactions));
        selection.backend_log_summary = selection
            .backend_log_summary
            .as_ref()
            .map(|value| redact_diagnostics_text(value, redactions));
    }

    snapshot.startup.app_data_dir = "<app-data-dir>".to_string();
    snapshot.startup.database_path = "<database-path>".to_string();
    snapshot.startup.backup_dir = "<backup-dir>".to_string();
    snapshot.startup.last_migration_backup_path = snapshot
        .startup
        .last_migration_backup_path
        .as_ref()
        .map(|_| "<migration-backup-path>".to_string());
    snapshot.startup.runtime_binary_path = "<runtime-binary-path>".to_string();
    snapshot.startup.active_model_path = snapshot
        .startup
        .active_model_path
        .as_ref()
        .map(|_| "<active-model-path>".to_string());
    snapshot.startup.embedding_model_path = snapshot
        .startup
        .embedding_model_path
        .as_ref()
        .map(|_| "<embedding-model-path>".to_string());
    snapshot.startup.indexing.last_error = snapshot
        .startup
        .indexing
        .last_error
        .as_ref()
        .map(|value| redact_diagnostics_text(value, redactions));
    for check in &mut snapshot.startup.checks {
        check.detail = redact_diagnostics_text(&check.detail, redactions);
        check.path = check.path.as_ref().map(|_| "<local-path>".to_string());
    }
    for setting in &mut snapshot.settings {
        setting.value = redact_diagnostics_text(&setting.value, redactions);
    }
    snapshot.recent_errors = snapshot
        .recent_errors
        .into_iter()
        .map(|value| redact_diagnostics_text(&value, redactions))
        .collect();
    snapshot
}

fn health_check(
    key: &str,
    label: &str,
    status: HealthCheckStatus,
    detail: String,
    path: Option<String>,
    required: bool,
) -> HealthCheckRecord {
    HealthCheckRecord {
        key: key.to_string(),
        label: label.to_string(),
        status,
        detail,
        path,
        required,
        recoverable: true,
    }
}

async fn build_startup_health_snapshot(
    state: &InitializedAppState,
    active_model: Option<&ModelRecord>,
) -> AppResult<StartupHealthSnapshot> {
    let checked_at = chrono::Utc::now().to_rfc3339();
    let writable_probe_result = probe_directory_writable(&state.app_data_dir);
    let database_exists = state.db.path().is_file();
    let resource_status = state.resources.status();
    let installed_runtimes = state.resources.installed_runtimes();
    let runtime_binary_path = runtime_selection::base_runtime(&installed_runtimes)
        .map(|runtime| runtime.entrypoint.to_string_lossy().to_string())
        .unwrap_or_default();
    let active_model_exists = active_model
        .map(|model| Path::new(&model.source_path).is_file())
        .unwrap_or(false);
    let embedding_model_path = state.resources.model_path(ModelRole::Embedding);
    let embedding_available = state
        .resources
        .installed_model_path(ModelRole::Embedding)
        .is_some();

    let mut checks = vec![
        health_check(
            "app_dir_writable",
            "App data folder",
            if writable_probe_result.is_ok() {
                HealthCheckStatus::Ok
            } else {
                HealthCheckStatus::Error
            },
            writable_probe_result
                .map(|_| "App data folder is writable.".to_string())
                .unwrap_or_else(|error| error),
            Some(state.app_data_dir.to_string_lossy().to_string()),
            true,
        ),
        health_check(
            "database",
            "Database",
            if database_exists {
                HealthCheckStatus::Ok
            } else {
                HealthCheckStatus::Error
            },
            if database_exists {
                "Database file is present.".to_string()
            } else {
                "Database file is missing or unreadable.".to_string()
            },
            Some(state.db.path().to_string_lossy().to_string()),
            true,
        ),
    ];
    let missing = resource_status
        .items
        .iter()
        .filter(|item| !item.installed && !item.optional)
        .map(|item| item.label.clone())
        .collect::<Vec<_>>();
    checks.push(health_check(
        "ai_resources",
        "AI files",
        if resource_status.ready {
            HealthCheckStatus::Ok
        } else {
            HealthCheckStatus::Error
        },
        if !resource_status.platform_supported {
            format!(
                "This computer ({}) is not supported yet.",
                resource_status.platform
            )
        } else if resource_status.ready {
            "The AI model and engine are installed and verified.".to_string()
        } else {
            format!(
                "Missing: {}. Restart Glee to download them again.",
                missing.join(", ")
            )
        },
        Some(state.resources.root().to_string_lossy().to_string()),
        true,
    ));
    checks.push(health_check(
        "active_model",
        "Active model",
        if active_model_exists {
            HealthCheckStatus::Ok
        } else {
            HealthCheckStatus::Warn
        },
        match active_model {
            Some(model) if active_model_exists => format!("Active model is ready: {}", model.name),
            Some(model) => format!("Active model file is missing: {}", model.source_path),
            None => "No active model is configured.".to_string(),
        },
        active_model.map(|model| model.source_path.clone()),
        false,
    ));
    checks.push(health_check(
        "vector_search",
        "Semantic memory search",
        if state.vector_search && embedding_available {
            HealthCheckStatus::Ok
        } else {
            HealthCheckStatus::Warn
        },
        if !state.vector_search {
            "Vector search is unavailable; memory falls back to keyword recall.".to_string()
        } else if embedding_available {
            "Semantic memory search is available.".to_string()
        } else {
            "The memory model is not installed; memory falls back to keyword recall.".to_string()
        },
        Some(embedding_model_path.to_string_lossy().to_string()),
        false,
    ));

    let indexing = state.indexing_diagnostics.lock().await.clone();
    let overall_status = if checks
        .iter()
        .any(|check| check.required && check.status == HealthCheckStatus::Error)
    {
        HealthCheckStatus::Error
    } else if checks
        .iter()
        .any(|check| check.status != HealthCheckStatus::Ok)
    {
        HealthCheckStatus::Warn
    } else {
        HealthCheckStatus::Ok
    };

    Ok(StartupHealthSnapshot {
        checked_at,
        overall_status,
        app_data_dir: state.app_data_dir.to_string_lossy().to_string(),
        database_path: state.db.path().to_string_lossy().to_string(),
        backup_dir: state.db.backup_dir().to_string_lossy().to_string(),
        last_migration_backup_path: state
            .db
            .last_migration_backup_path()
            .map(|path| path.to_string_lossy().to_string()),
        runtime_binary_path,
        sqlite_vec_available: state.vector_search,
        active_model_id: active_model.map(|model| model.id.clone()),
        active_model_path: active_model.map(|model| model.source_path.clone()),
        embedding_model_id: Some(state.resources.model_asset(ModelRole::Embedding).id.clone()),
        embedding_model_path: Some(embedding_model_path.to_string_lossy().to_string()),
        embedding_available,
        indexing,
        checks,
    })
}

fn probe_directory_writable(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("failed to create directory: {error}"))?;
    let probe_path = path.join(".glee-write-test");
    fs::write(&probe_path, b"ok")
        .map_err(|error| format!("failed to write probe file: {error}"))?;
    let _ = fs::remove_file(probe_path);
    Ok(())
}

fn feature_exposure() -> FeatureExposure {
    FeatureExposure {
        stable: vec![
            "model import".to_string(),
            "runtime controls".to_string(),
            "direct character chat".to_string(),
            "memory".to_string(),
            "presets".to_string(),
            "chat export".to_string(),
            "diagnostics export".to_string(),
            "database backup".to_string(),
        ],
        labs: vec![
            "group chat".to_string(),
            "character card import".to_string(),
            "semantic vector retrieval".to_string(),
        ],
    }
}

fn initial_indexing_diagnostics(
    sqlite_vec_available: bool,
    embedding_available: bool,
) -> IndexingDiagnostics {
    let updated_at = chrono::Utc::now().to_rfc3339();
    let (status, last_error) = match (sqlite_vec_available, embedding_available) {
        (true, true) => (IndexingHealthStatus::Healthy, None),
        (false, false) => (
            IndexingHealthStatus::Unavailable,
            Some("sqlite-vec extension and embedding model are both unavailable".to_string()),
        ),
        (false, true) => (
            IndexingHealthStatus::Degraded,
            Some("sqlite-vec extension is unavailable".to_string()),
        ),
        (true, false) => (
            IndexingHealthStatus::Degraded,
            Some("embedding model is unavailable".to_string()),
        ),
    };

    IndexingDiagnostics {
        status,
        updated_at,
        last_error,
        last_indexed_message_id: None,
    }
}

// A failed lookup degrades the indexing status without touching which message
// was indexed last.
async fn record_retrieval_failure(
    indexing_diagnostics: &Arc<tokio::sync::Mutex<IndexingDiagnostics>>,
    error: &AppError,
) {
    let mut diagnostics = indexing_diagnostics.lock().await;
    diagnostics.status = IndexingHealthStatus::Degraded;
    diagnostics.updated_at = chrono::Utc::now().to_rfc3339();
    diagnostics.last_error = Some(format!("semantic memory retrieval failed: {error}"));
}

async fn update_indexing_diagnostics(
    indexing_diagnostics: &Arc<tokio::sync::Mutex<IndexingDiagnostics>>,
    status: IndexingHealthStatus,
    last_error: Option<String>,
    last_indexed_message_id: Option<String>,
) {
    let mut diagnostics = indexing_diagnostics.lock().await;
    diagnostics.status = status;
    diagnostics.updated_at = chrono::Utc::now().to_rfc3339();
    diagnostics.last_error = last_error;
    diagnostics.last_indexed_message_id = last_indexed_message_id;
}

fn build_state(app_handle: &tauri::AppHandle) -> AppResult<InitializedAppState> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Path(format!("failed to resolve app data dir: {error}")))?;
    std::fs::create_dir_all(&app_data_dir)?;
    let resources = Resources::new(&app_data_dir)?;
    let vector_search = db::register_vector_extension();
    if !vector_search {
        eprintln!("sqlite-vec failed to register; semantic memory search is disabled");
    }

    let database_path = app_data_dir.join("glee.sqlite3");
    let backup_dir = database_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups");
    let database = Database::new(database_path.clone()).map_err(|error| {
        AppError::Runtime(format!(
            "database startup failed at {}: {error}. Restore from {} if the database is corrupt.",
            database_path.to_string_lossy(),
            backup_dir.to_string_lossy()
        ))
    })?;

    // The embedding model may still be downloading on first launch; the
    // service starts its runtime lazily once the files exist.
    let embedding_service = if vector_search {
        let embedding = resources.model_asset(ModelRole::Embedding);
        match EmbeddingService::new(
            EmbeddingServiceConfig {
                model_id: embedding.id.clone(),
                model_path: resources.model_path(ModelRole::Embedding),
                resources: resources.clone(),
            },
            &app_data_dir,
        ) {
            Ok(service) => Some(service),
            Err(error) => {
                eprintln!("failed to initialize embedding service: {error}");
                None
            }
        }
    } else {
        None
    };

    let indexing_diagnostics = Arc::new(tokio::sync::Mutex::new(initial_indexing_diagnostics(
        vector_search,
        resources
            .installed_model_path(ModelRole::Embedding)
            .is_some(),
    )));
    let runtime_manager = RuntimeManager::new_for_app_data_dir(&app_data_dir)?;
    Ok(InitializedAppState {
        db: database,
        runtime_manager,
        embedding_service,
        app_data_dir,
        resources,
        vector_search,
        indexing_diagnostics,
    })
}

fn canonicalize_model_path(path: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "model path cannot be empty".to_string(),
        ));
    }

    let raw_path = PathBuf::from(trimmed);
    if !raw_path.exists() || !raw_path.is_file() {
        return Err(AppError::Validation(format!(
            "model path is invalid: {trimmed}"
        )));
    }

    let extension = raw_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if extension.as_deref() != Some("gguf") {
        return Err(AppError::Validation(
            "model file must be a .gguf file".to_string(),
        ));
    }

    Ok(raw_path.canonicalize()?)
}

async fn import_model_record(
    db: Database,
    model_path: PathBuf,
    requested_name: Option<String>,
) -> AppResult<ModelRecord> {
    run_db_task(db, move |database| {
        let model_name = requested_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| infer_model_name(&model_path));
        let source_path = model_path.to_string_lossy().to_string();
        let sha256 = hash_file_sha256(&model_path)?;
        database.import_model(&model_name, &source_path, &sha256)
    })
    .await
}

struct ModelDownloadGuard;

impl ModelDownloadGuard {
    fn begin() -> AppResult<Self> {
        if MODEL_DOWNLOAD_ACTIVE.swap(true, Ordering::AcqRel) {
            return Err(AppError::Runtime(
                "a model download is already active".to_string(),
            ));
        }
        MODEL_DOWNLOAD_CANCELLED.store(false, Ordering::Release);
        Ok(Self)
    }
}

impl Drop for ModelDownloadGuard {
    fn drop(&mut self) {
        MODEL_DOWNLOAD_CANCELLED.store(false, Ordering::Release);
        MODEL_DOWNLOAD_ACTIVE.store(false, Ordering::Release);
    }
}

async fn download_model_to_temp<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    client: &reqwest::Client,
    url: &str,
    models_dir: &Path,
    temp_path: &Path,
    file_name: Option<&str>,
    attempt: u32,
) -> AppResult<String> {
    let mut response =
        client.get(url).send().await.map_err(|error| {
            AppError::Runtime(format!("model download request failed: {error}"))
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Runtime(format!(
            "model download returned HTTP {status}"
        )));
    }
    let total_bytes = response.content_length();
    if let Some(total_bytes) = total_bytes {
        if total_bytes > MODEL_DOWNLOAD_MAX_BYTES {
            return Err(AppError::Validation(format!(
                "model download is too large: {total_bytes} bytes exceeds {} bytes",
                MODEL_DOWNLOAD_MAX_BYTES
            )));
        }
        ensure_model_download_space(models_dir, total_bytes)?;
    } else {
        ensure_model_download_space(models_dir, MODEL_DOWNLOAD_MAX_BYTES)?;
    }

    let mut file = tokio::fs::File::create(temp_path).await?;
    let mut hasher = Sha256::new();
    let mut received = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| AppError::Runtime(format!("model download stream failed: {error}")))?
    {
        if MODEL_DOWNLOAD_CANCELLED.load(Ordering::Acquire) {
            return Err(AppError::Runtime("model download cancelled".to_string()));
        }
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| AppError::Runtime("model download size overflow".to_string()))?;
        if received > MODEL_DOWNLOAD_MAX_BYTES {
            return Err(AppError::Validation(format!(
                "model download exceeded {} bytes",
                MODEL_DOWNLOAD_MAX_BYTES
            )));
        }
        if let Some(total_bytes) = total_bytes {
            if received > total_bytes {
                return Err(AppError::Runtime(format!(
                    "model download exceeded declared Content-Length {total_bytes}"
                )));
            }
        }
        file.write_all(&chunk).await?;
        hasher.update(&chunk);
        emit_model_download_progress(
            app_handle,
            "downloading",
            file_name,
            received,
            total_bytes,
            attempt,
        );
    }
    file.flush().await?;
    drop(file);

    if let Some(total_bytes) = total_bytes {
        if received != total_bytes {
            return Err(AppError::Runtime(format!(
                "model download received {received} bytes, expected {total_bytes}"
            )));
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn emit_model_download_progress<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    phase: &str,
    file_name: Option<&str>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    attempt: u32,
) {
    let _ = app_handle.emit(
        MODEL_DOWNLOAD_PROGRESS_EVENT,
        serde_json::json!({
            "phase": phase,
            "fileName": file_name.unwrap_or("model.gguf"),
            "downloadedBytes": downloaded_bytes,
            "totalBytes": total_bytes,
            "attempt": attempt,
            "maxAttempts": MODEL_DOWNLOAD_ATTEMPTS,
        }),
    );
}

fn ensure_model_download_space(models_dir: &Path, required_bytes: u64) -> AppResult<()> {
    let required = required_bytes
        .checked_add(MODEL_DOWNLOAD_DISK_HEADROOM_BYTES)
        .ok_or_else(|| AppError::Runtime("model download disk-space check overflow".to_string()))?;
    let target = models_dir
        .canonicalize()
        .unwrap_or_else(|_| models_dir.to_path_buf());
    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .iter()
        .filter(|disk| target.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len());
    if let Some(disk) = disk {
        let available = disk.available_space();
        if available < required {
            return Err(AppError::Runtime(format!(
                "not enough free space for model download: {available} bytes available, {required} bytes required"
            )));
        }
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn normalize_model_download_url(url: &str) -> AppResult<String> {
    let normalized = normalize_non_empty(url, "model url")?;
    let parsed = reqwest::Url::parse(&normalized)
        .map_err(|error| AppError::Validation(format!("invalid model url: {error}")))?;
    if parsed.scheme() != "https" {
        return Err(AppError::Validation(
            "model download url must use https".to_string(),
        ));
    }
    Ok(parsed.to_string())
}

fn sanitize_model_download_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn infer_model_download_file_name(url: &str, name_hint: Option<&str>) -> AppResult<String> {
    let candidate = if let Some(name_hint) = name_hint {
        sanitize_model_download_name(name_hint)
    } else {
        let parsed = reqwest::Url::parse(url)
            .map_err(|error| AppError::Validation(format!("invalid model url: {error}")))?;
        let from_url = parsed
            .path_segments()
            .and_then(|mut segments| segments.rfind(|segment| !segment.is_empty()))
            .map(sanitize_model_download_name)
            .unwrap_or_default();
        from_url
    };

    let mut file_name = if candidate.is_empty() {
        "recommended-model.gguf".to_string()
    } else {
        candidate
    };
    if !file_name.to_ascii_lowercase().ends_with(".gguf") {
        file_name.push_str(".gguf");
    }
    Ok(file_name)
}

fn canonicalize_character_card_path(path: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "character card path cannot be empty".to_string(),
        ));
    }

    let raw_path = PathBuf::from(trimmed);
    if !raw_path.exists() || !raw_path.is_file() {
        return Err(AppError::Validation(format!(
            "character card path is invalid: {trimmed}"
        )));
    }

    Ok(raw_path.canonicalize()?)
}

fn canonicalize_local_image_path(path: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "image path cannot be empty".to_string(),
        ));
    }

    let raw_path = PathBuf::from(trimmed);
    if !raw_path.exists() || !raw_path.is_file() {
        return Err(AppError::Validation(format!(
            "image path is invalid: {trimmed}"
        )));
    }

    let extension = raw_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    match extension.as_deref() {
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp") => Ok(raw_path.canonicalize()?),
        _ => Err(AppError::Validation(
            "image file must be a PNG, JPG, JPEG, WEBP, GIF, or BMP file".to_string(),
        )),
    }
}

fn normalize_character_card_export_path(path: &str, default_extension: &str) -> AppResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "character card export path cannot be empty".to_string(),
        ));
    }

    let mut output_path = PathBuf::from(trimmed);
    if output_path.extension().is_none() {
        output_path.set_extension(default_extension);
    }

    let parent = output_path.parent().ok_or_else(|| {
        AppError::Validation(
            "character card export path must include a parent directory".to_string(),
        )
    })?;

    if !parent.exists() {
        return Err(AppError::Validation(format!(
            "character card export directory is invalid: {}",
            parent.display()
        )));
    }

    Ok(output_path)
}

fn infer_image_mime_type(path: &Path) -> AppResult<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    match extension.as_deref() {
        Some("png") => Ok("image/png"),
        Some("jpg" | "jpeg") => Ok("image/jpeg"),
        Some("webp") => Ok("image/webp"),
        Some("gif") => Ok("image/gif"),
        Some("bmp") => Ok("image/bmp"),
        _ => Err(AppError::Validation(
            "unsupported image file type".to_string(),
        )),
    }
}

fn read_file_with_limit(path: &Path, max_bytes: usize, label: &str) -> AppResult<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > max_bytes as u64 {
        return Err(AppError::Validation(format!(
            "{label} exceeds the {} MiB size limit",
            max_bytes / (1024 * 1024)
        )));
    }

    let file = File::open(path)?;
    let mut limited_reader = file.take(max_bytes as u64 + 1);
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes as u64) as usize);
    limited_reader.read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(AppError::Validation(format!(
            "{label} exceeds the {} MiB size limit",
            max_bytes / (1024 * 1024)
        )));
    }
    Ok(bytes)
}

fn import_character_card_from_path(path: &Path) -> AppResult<ImportedCharacterCard> {
    let bytes = read_file_with_limit(path, MAX_CHARACTER_CARD_FILE_BYTES, "character card")?;
    let fallback_name = infer_model_name(path);

    if is_png_file_bytes(&bytes) {
        return import_character_card_from_png(path, &bytes, &fallback_name);
    }

    import_character_card_from_json(&bytes, &fallback_name, None)
}

fn import_character_card_from_json(
    json_bytes: &[u8],
    fallback_name: &str,
    fallback_avatar: Option<String>,
) -> AppResult<ImportedCharacterCard> {
    if json_bytes.len() > MAX_CHARACTER_CARD_JSON_BYTES {
        return Err(AppError::Validation(format!(
            "character card JSON exceeds the {} MiB size limit",
            MAX_CHARACTER_CARD_JSON_BYTES / (1024 * 1024)
        )));
    }
    let value: Value = serde_json::from_slice(json_bytes)
        .map_err(|error| AppError::Validation(format!("invalid character card JSON: {error}")))?;
    map_character_card_value_v2(&value, fallback_name, fallback_avatar)
}

fn import_character_card_from_png(
    path: &Path,
    png_bytes: &[u8],
    fallback_name: &str,
) -> AppResult<ImportedCharacterCard> {
    let (metadata_keyword, card_payload) = extract_card_payload_from_png(png_bytes)?;
    let trimmed_payload = card_payload.trim();
    if trimmed_payload.len() > MAX_CHARACTER_CARD_METADATA_BYTES {
        return Err(AppError::Validation(format!(
            "character card metadata exceeds the {} MiB encoded size limit",
            MAX_CHARACTER_CARD_METADATA_BYTES / (1024 * 1024)
        )));
    }
    let decoded = match BASE64_STANDARD.decode(trimmed_payload) {
        Ok(decoded) => decoded,
        Err(_) if metadata_keyword == "ccv3" && trimmed_payload.starts_with('{') => {
            trimmed_payload.as_bytes().to_vec()
        }
        Err(error) => {
            return Err(AppError::Validation(format!(
                "invalid {metadata_keyword} metadata encoding: {error}"
            )))
        }
    };

    let mut imported = import_character_card_from_json(
        &decoded,
        fallback_name,
        Some(path.to_string_lossy().to_string()),
    )?;
    imported.avatar = path.to_string_lossy().to_string();
    Ok(imported)
}

fn is_png_file_bytes(bytes: &[u8]) -> bool {
    const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    bytes.len() >= PNG_SIGNATURE.len() && bytes[..PNG_SIGNATURE.len()] == PNG_SIGNATURE
}

fn extract_card_payload_from_png(png_bytes: &[u8]) -> AppResult<(String, String)> {
    if !is_png_file_bytes(png_bytes) {
        return Err(AppError::Validation(
            "character card PNG data is invalid".to_string(),
        ));
    }

    let mut chara_payload = None;
    let mut ccv3_payload = None;
    let mut cursor = 8_usize;
    while cursor + 8 <= png_bytes.len() {
        let length = u32::from_be_bytes([
            png_bytes[cursor],
            png_bytes[cursor + 1],
            png_bytes[cursor + 2],
            png_bytes[cursor + 3],
        ]) as usize;
        let chunk_type = &png_bytes[cursor + 4..cursor + 8];
        cursor += 8;

        if cursor + length + 4 > png_bytes.len() {
            return Err(AppError::Validation(
                "PNG chunk length is invalid".to_string(),
            ));
        }

        let chunk_data = &png_bytes[cursor..cursor + length];
        cursor += length + 4;

        if chunk_type == b"tEXt" {
            if let Some((keyword, payload)) = parse_card_text_chunk(chunk_data)? {
                if keyword == "ccv3" {
                    ccv3_payload = Some(payload);
                } else {
                    chara_payload = Some(payload);
                }
            }
        } else if chunk_type == b"iTXt" {
            if let Some((keyword, payload)) = parse_card_itxt_chunk(chunk_data)? {
                if keyword == "ccv3" {
                    ccv3_payload = Some(payload);
                } else {
                    chara_payload = Some(payload);
                }
            }
        } else if chunk_type == b"IEND" {
            break;
        }
    }

    ccv3_payload
        .map(|payload| ("ccv3".to_string(), payload))
        .or_else(|| chara_payload.map(|payload| ("chara".to_string(), payload)))
        .ok_or_else(|| {
            AppError::Validation("PNG card does not contain chara or ccv3 metadata".to_string())
        })
}

fn parse_card_text_chunk(chunk_data: &[u8]) -> AppResult<Option<(&'static str, String)>> {
    let keyword_end = if let Some(index) = chunk_data.iter().position(|byte| *byte == 0) {
        index
    } else {
        return Ok(None);
    };
    let keyword = std::str::from_utf8(&chunk_data[..keyword_end]).map_err(|error| {
        AppError::Validation(format!(
            "invalid tEXt chunk keyword in PNG metadata: {error}"
        ))
    })?;
    let keyword = match keyword {
        "chara" => "chara",
        "ccv3" => "ccv3",
        _ => return Ok(None),
    };

    let payload = String::from_utf8(chunk_data[keyword_end + 1..].to_vec()).map_err(|error| {
        AppError::Validation(format!(
            "invalid UTF-8 tEXt chunk payload in PNG metadata: {error}"
        ))
    })?;
    Ok(Some((keyword, payload)))
}

fn parse_card_itxt_chunk(chunk_data: &[u8]) -> AppResult<Option<(&'static str, String)>> {
    let keyword_end = if let Some(index) = chunk_data.iter().position(|byte| *byte == 0) {
        index
    } else {
        return Ok(None);
    };
    let keyword = std::str::from_utf8(&chunk_data[..keyword_end]).map_err(|error| {
        AppError::Validation(format!(
            "invalid iTXt chunk keyword in PNG metadata: {error}"
        ))
    })?;
    let keyword = match keyword {
        "chara" => "chara",
        "ccv3" => "ccv3",
        _ => return Ok(None),
    };

    let compression_flag = *chunk_data.get(keyword_end + 1).ok_or_else(|| {
        AppError::Validation("invalid iTXt chunk format in PNG metadata".to_string())
    })?;
    let compression_method = *chunk_data.get(keyword_end + 2).ok_or_else(|| {
        AppError::Validation("invalid iTXt chunk format in PNG metadata".to_string())
    })?;
    if compression_flag != 0 {
        return Err(AppError::Validation(format!(
            "compressed iTXt {keyword} metadata is not supported"
        )));
    }
    if compression_method != 0 {
        return Err(AppError::Validation(
            "unsupported iTXt compression method in PNG metadata".to_string(),
        ));
    }

    let mut cursor = keyword_end + 3;
    let language_end = chunk_data[cursor..]
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| AppError::Validation("invalid iTXt language field".to_string()))?
        + cursor;
    cursor = language_end + 1;

    let translated_end = chunk_data[cursor..]
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| AppError::Validation("invalid iTXt translated keyword field".to_string()))?
        + cursor;
    cursor = translated_end + 1;

    let payload = String::from_utf8(chunk_data[cursor..].to_vec()).map_err(|error| {
        AppError::Validation(format!(
            "invalid UTF-8 iTXt chunk payload in PNG metadata: {error}"
        ))
    })?;
    Ok(Some((keyword, payload)))
}

fn infer_model_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("model")
        .to_string()
}

fn hash_file_sha256(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8192];

    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

fn normalize_tags_json_input(
    tags: Option<Vec<String>>,
    tags_json: Option<String>,
) -> AppResult<Option<String>> {
    if let Some(tags) = tags {
        let normalized_tags = normalize_string_values(tags);
        return serde_json::to_string(&normalized_tags)
            .map(Some)
            .map_err(|error| {
                AppError::Validation(format!("failed to serialize tags into tags_json: {error}"))
            });
    }

    if let Some(tags_json) = tags_json {
        let trimmed = tags_json.trim();
        if trimmed.is_empty() {
            return Ok(Some("[]".to_string()));
        }

        let parsed: Value = serde_json::from_str(trimmed)
            .map_err(|error| AppError::Validation(format!("invalid tags_json value: {error}")))?;
        let tags = match parsed {
            Value::Array(values) => values
                .into_iter()
                .filter_map(|item| match item {
                    Value::String(tag) => Some(tag),
                    Value::Number(number) => Some(number.to_string()),
                    Value::Bool(boolean) => Some(boolean.to_string()),
                    _ => None,
                })
                .collect(),
            Value::String(raw_tags) => raw_tags
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
            Value::Null => Vec::new(),
            _ => {
                return Err(AppError::Validation(
                    "tags_json must be a JSON array or string".to_string(),
                ));
            }
        };

        let normalized_tags = normalize_string_values(tags);
        return serde_json::to_string(&normalized_tags)
            .map(Some)
            .map_err(|error| {
                AppError::Validation(format!("failed to serialize tags into tags_json: {error}"))
            });
    }

    Ok(None)
}

fn normalize_keywords_json_input(
    keywords: Option<Vec<String>>,
    keywords_json: Option<String>,
) -> AppResult<Option<String>> {
    if let Some(keywords) = keywords {
        let normalized_keywords = normalize_string_values(keywords);
        return serde_json::to_string(&normalized_keywords)
            .map(Some)
            .map_err(|error| {
                AppError::Validation(format!(
                    "failed to serialize keywords into keywords_json: {error}"
                ))
            });
    }

    if let Some(keywords_json) = keywords_json {
        let trimmed = keywords_json.trim();
        if trimmed.is_empty() {
            return Ok(Some("[]".to_string()));
        }

        let parsed: Value = serde_json::from_str(trimmed).map_err(|error| {
            AppError::Validation(format!("invalid keywords_json value: {error}"))
        })?;
        let keywords = match parsed {
            Value::Array(values) => values
                .into_iter()
                .filter_map(|item| match item {
                    Value::String(keyword) => Some(keyword),
                    Value::Number(number) => Some(number.to_string()),
                    Value::Bool(boolean) => Some(boolean.to_string()),
                    _ => None,
                })
                .collect(),
            Value::String(raw_keywords) => raw_keywords
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
            Value::Null => Vec::new(),
            _ => {
                return Err(AppError::Validation(
                    "keywords_json must be a JSON array or string".to_string(),
                ));
            }
        };

        let normalized_keywords = normalize_string_values(keywords);
        return serde_json::to_string(&normalized_keywords)
            .map(Some)
            .map_err(|error| {
                AppError::Validation(format!(
                    "failed to serialize keywords into keywords_json: {error}"
                ))
            });
    }

    Ok(None)
}

fn normalize_facts_json_input(
    facts: Option<Vec<String>>,
    facts_json: Option<String>,
) -> AppResult<Option<String>> {
    if let Some(facts) = facts {
        let normalized_facts = normalize_string_values(facts);
        return serde_json::to_string(&normalized_facts)
            .map(Some)
            .map_err(|error| {
                AppError::Validation(format!(
                    "failed to serialize facts into facts_json: {error}"
                ))
            });
    }

    if let Some(facts_json) = facts_json {
        let trimmed = facts_json.trim();
        if trimmed.is_empty() {
            return Ok(Some("[]".to_string()));
        }

        let parsed: Value = serde_json::from_str(trimmed)
            .map_err(|error| AppError::Validation(format!("invalid facts_json value: {error}")))?;
        let facts = match parsed {
            Value::Array(values) => values
                .into_iter()
                .filter_map(|item| match item {
                    Value::String(fact) => Some(fact),
                    Value::Number(number) => Some(number.to_string()),
                    Value::Bool(boolean) => Some(boolean.to_string()),
                    _ => None,
                })
                .collect(),
            Value::String(raw_facts) => raw_facts
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
            Value::Null => Vec::new(),
            _ => {
                return Err(AppError::Validation(
                    "facts_json must be a JSON array or string".to_string(),
                ));
            }
        };

        let normalized_facts = normalize_string_values(facts);
        return serde_json::to_string(&normalized_facts)
            .map(Some)
            .map_err(|error| {
                AppError::Validation(format!(
                    "failed to serialize facts into facts_json: {error}"
                ))
            });
    }

    Ok(None)
}

fn normalize_string_list_json_input(
    values: Option<Vec<String>>,
    values_json: Option<String>,
) -> AppResult<Option<String>> {
    if let Some(values) = values {
        let normalized_values = normalize_string_values(values);
        return serde_json::to_string(&normalized_values)
            .map(Some)
            .map_err(|error| {
                AppError::Validation(format!(
                    "failed to serialize string list into JSON: {error}"
                ))
            });
    }

    if let Some(values_json) = values_json {
        let trimmed = values_json.trim();
        if trimmed.is_empty() {
            return Ok(Some("[]".to_string()));
        }

        let parsed: Value = serde_json::from_str(trimmed).map_err(|error| {
            AppError::Validation(format!("invalid string-list JSON value: {error}"))
        })?;
        let values = match parsed {
            Value::Array(items) => items
                .into_iter()
                .filter_map(|item| match item {
                    Value::String(value) => Some(value),
                    Value::Number(value) => Some(value.to_string()),
                    Value::Bool(value) => Some(value.to_string()),
                    _ => None,
                })
                .collect(),
            Value::String(raw_values) => raw_values
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
            Value::Null => Vec::new(),
            _ => {
                return Err(AppError::Validation(
                    "string-list JSON must be a JSON array or string".to_string(),
                ));
            }
        };

        let normalized_values = normalize_string_values(values);
        return serde_json::to_string(&normalized_values)
            .map(Some)
            .map_err(|error| {
                AppError::Validation(format!(
                    "failed to serialize string list into JSON: {error}"
                ))
            });
    }

    Ok(None)
}

fn normalize_character_id_list(values: Vec<String>) -> AppResult<Vec<String>> {
    let normalized = normalize_string_values(values);
    if normalized.len() < 2 {
        return Err(AppError::Validation(
            "character_ids must include at least 2 ids".to_string(),
        ));
    }
    Ok(normalized)
}

fn normalize_string_values(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized_value = trimmed.to_string();
        if seen.insert(normalized_value.clone()) {
            normalized.push(normalized_value);
        }
    }
    normalized
}

fn normalize_context_scope(value: &str) -> AppResult<String> {
    let scope = normalize_non_empty(value, "scope")?.to_lowercase();
    match scope.as_str() {
        "global" | "character" => Ok(scope),
        _ => Err(AppError::Validation(
            "scope must be either global or character".to_string(),
        )),
    }
}

fn normalize_non_empty(value: &str, field_name: &str) -> AppResult<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(AppError::Validation(format!(
            "{field_name} cannot be empty"
        )));
    }
    Ok(normalized.to_string())
}

fn normalize_role(value: &str) -> AppResult<String> {
    let role = normalize_non_empty(value, "message role")?.to_lowercase();
    match role.as_str() {
        "system" | "user" | "assistant" | "tool" => Ok(role),
        _ => Err(AppError::Validation(format!(
            "invalid message role: {role}; expected system|user|assistant|tool"
        ))),
    }
}

fn normalize_runtime_extra_args(args: Vec<String>) -> Vec<String> {
    args.into_iter()
        .map(|arg| arg.trim().to_string())
        .filter(|arg| !arg.is_empty())
        .collect::<Vec<_>>()
}

fn validate_runtime_extra_args(args: &[String]) -> AppResult<()> {
    const RESERVED_FLAGS: &[&str] = &[
        "-m",
        "--model",
        "-mu",
        "--model-url",
        "--host",
        "--port",
        "--path",
        "--api-key",
        "--api-key-file",
        "--ssl-key-file",
        "--ssl-cert-file",
        "--webui",
        "--no-webui",
        "--metrics",
        "--slots",
        "--embedding",
        "--reranking",
        "--log-file",
        "--log-colors",
        "--log-prefix",
        "--log-timestamps",
        "--verbose",
        "--verbosity",
        "-v",
        "--spec-type",
        "--spec-draft-model",
        "--spec-draft-n-max",
        "--fit",
        "--parallel",
        "-c",
        "--ctx-size",
        "--cache-ram",
        "--no-warmup",
        "--warmup",
        "-ngl",
        "--n-gpu-layers",
        "--gpu-layers",
        "-dev",
        "--device",
        "--no-slots",
        "--cors-origins",
        "--api-prefix",
        "--media-path",
        "--models-dir",
        "--slot-save-path",
        "--props",
    ];

    for argument in args {
        let flag = argument
            .split_once('=')
            .map(|(name, _)| name)
            .unwrap_or(argument)
            .to_ascii_lowercase();
        if RESERVED_FLAGS.contains(&flag.as_str()) {
            return Err(AppError::Validation(format!(
                "runtime argument {argument:?} is managed by Glee and cannot be overridden"
            )));
        }
    }
    Ok(())
}

fn effective_runtime_gpu_layers(
    performance_mode: RuntimePerformanceMode,
    configured_gpu_layers: i64,
) -> AppResult<i64> {
    let configured_gpu_layers = normalize_runtime_gpu_layers(configured_gpu_layers)?;
    Ok(match performance_mode {
        RuntimePerformanceMode::Cpu | RuntimePerformanceMode::Auto => 0,
        RuntimePerformanceMode::Gpu => configured_gpu_layers,
    })
}

fn normalize_runtime_gpu_layers(value: i64) -> AppResult<i64> {
    if value < 0 {
        return Err(AppError::Validation(
            "runtime GPU layers must be greater than or equal to 0".to_string(),
        ));
    }
    Ok(value)
}

fn normalize_temperature_input(value: Option<f64>) -> AppResult<Option<f64>> {
    match value {
        Some(value) if !(0.0_f64..=2.0_f64).contains(&value) => Err(AppError::Validation(
            "temperature must be in the range [0.0, 2.0]".to_string(),
        )),
        Some(value) => Ok(Some(value)),
        None => Ok(None),
    }
}

fn normalize_top_p_input(value: Option<f64>) -> AppResult<Option<f64>> {
    match value {
        Some(value) if value <= 0.0_f64 || value > 1.0_f64 => Err(AppError::Validation(
            "top_p must be in the range (0.0, 1.0]".to_string(),
        )),
        Some(value) => Ok(Some(value)),
        None => Ok(None),
    }
}

fn normalize_max_tokens_input(value: Option<i64>) -> AppResult<Option<i64>> {
    match value {
        Some(value) if value <= 0 => Err(AppError::Validation(
            "max_tokens must be greater than 0".to_string(),
        )),
        Some(value) => Ok(Some(value)),
        None => Ok(None),
    }
}

fn normalize_repeat_penalty_input(value: Option<f64>) -> AppResult<Option<f64>> {
    match value {
        Some(value) if value <= 0.0_f64 => Err(AppError::Validation(
            "repeat_penalty must be greater than 0".to_string(),
        )),
        Some(value) => Ok(Some(value)),
        None => Ok(None),
    }
}

fn default_chat_title() -> String {
    format!("Chat {}", chrono::Utc::now().format("%Y-%m-%d %H:%M"))
}

fn default_group_chat_title() -> String {
    format!("Group {}", chrono::Utc::now().format("%Y-%m-%d %H:%M"))
}

#[cfg(target_os = "windows")]
fn apply_windows_window_region<R: tauri::Runtime>(window: &tauri::Window<R>) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn},
    };

    let hwnd = window
        .hwnd()
        .map_err(|error| format!("failed to read native window handle: {error}"))?;
    let hwnd = hwnd.0 as HWND;

    if window
        .is_maximized()
        .map_err(|error| format!("failed to read maximized state: {error}"))?
    {
        let result = unsafe { SetWindowRgn(hwnd, std::ptr::null_mut(), 1) };
        return (result != 0)
            .then_some(())
            .ok_or_else(|| "failed to clear native window region".to_string());
    }

    let size = window
        .inner_size()
        .map_err(|error| format!("failed to read native window size: {error}"))?;
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("failed to read window scale factor: {error}"))?;
    let corner_radius = (12.0 * scale_factor).round().max(1.0) as i32;
    let region = unsafe {
        CreateRoundRectRgn(
            0,
            0,
            size.width.saturating_add(1) as i32,
            size.height.saturating_add(1) as i32,
            corner_radius * 2,
            corner_radius * 2,
        )
    };
    if region.is_null() {
        return Err("failed to create native rounded window region".to_string());
    }

    if unsafe { SetWindowRgn(hwnd, region, 1) } == 0 {
        unsafe {
            DeleteObject(region);
        }
        return Err("failed to apply native rounded window region".to_string());
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(main_window) = app.get_webview_window("main") {
            if let Err(error) = main_window.unminimize() {
                eprintln!("failed to restore the existing Glee window: {error}");
            }
            if let Err(error) = main_window.show() {
                eprintln!("failed to show the existing Glee window: {error}");
            }
            if let Err(error) = main_window.set_focus() {
                eprintln!("failed to focus the existing Glee window: {error}");
            }
        }
    }));

    let window_shutdown = shutdown_started.clone();
    let app = builder
        .setup(|app| {
            app.manage(AppState::new(app.handle().clone()));
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                begin_shutdown(window.app_handle(), &window_shutdown);
            }

            #[cfg(target_os = "windows")]
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let Err(error) = apply_windows_window_region(window) {
                    eprintln!("failed to update window rounding: {error}");
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            resource_status,
            prepare_first_run_resources,
            cancel_first_run_provisioning,
            active_first_run_provisioning_job_id,
            updates::check_for_update,
            updates::download_update,
            updates::cancel_update_download,
            updates::install_update,
            updates::skip_update_version,
            updates::get_update_settings,
            updates::set_update_settings,
            bootstrap_state,
            list_models,
            import_model,
            download_model,
            cancel_model_download,
            set_active_model,
            list_characters,
            create_character,
            update_character,
            delete_character,
            list_persona_presets,
            create_persona_preset,
            update_persona_preset,
            delete_persona_preset,
            list_generation_presets,
            create_generation_preset,
            update_generation_preset,
            delete_generation_preset,
            list_context_entries,
            create_context_entry,
            update_context_entry,
            delete_context_entry,
            resolve_context_entries,
            resolve_memory_snippets,
            resolve_memory_snippets_batch,
            memory_service::list_memory_items,
            memory_service::create_memory_item,
            memory_service::update_memory_item,
            memory_service::delete_memory_item,
            memory_service::delete_memory_items_for,
            memory_service::get_memory_extraction_batch,
            memory_service::store_memory_extraction,
            import_character_card,
            export_character_card_json,
            export_character_card_png,
            read_local_image_data_url,
            save_text_file,
            list_chats,
            create_chat,
            create_group_chat,
            update_group_chat,
            delete_chat,
            clear_chat_history,
            delete_message,
            rename_chat,
            list_chat_participants,
            list_messages,
            get_chat_memory,
            upsert_chat_memory,
            get_auto_summary_batch,
            store_auto_summary,
            get_chat_preset_profile,
            upsert_chat_preset_profile,
            set_chat_persona,
            get_user_profile,
            upsert_user_profile,
            get_chat_relationship_state,
            upsert_chat_relationship_state,
            get_runtime_launch_settings,
            set_runtime_launch_settings,
            append_message,
            update_message,
            edit_message_and_truncate,
            branch_chat,
            start_runtime,
            stop_runtime,
            runtime_status,
            diagnostics_snapshot,
            export_diagnostics_bundle,
            create_database_backup,
            list_database_backups,
            restore_database_backup,
            export_database_backup,
            import_database_backup
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Glee application");

    app.run(move |app_handle, event| {
        // Cmd+Q on macOS and other app-level quits skip CloseRequested; stop the
        // local AI servers on every exit path.
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if !shutdown_started.load(Ordering::Acquire) {
                api.prevent_exit();
                begin_shutdown(app_handle, &shutdown_started);
            }
        }
    });
}

fn begin_shutdown<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>, started: &AtomicBool) {
    if started.swap(true, Ordering::AcqRel) {
        return;
    }
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(state) = app_handle.try_state::<AppState>() {
            if let Err(error) = state.shutdown().await {
                eprintln!("failed to stop local AI runtimes during shutdown: {error}");
            }
        }
        app_handle.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::{
        fs,
        future::Future,
        path::{Path, PathBuf},
        sync::Arc,
    };
    use uuid::Uuid;

    struct CommandSmokeHarness {
        state: AppState,
        root_dir: PathBuf,
    }

    impl CommandSmokeHarness {
        fn new() -> Self {
            let root_dir =
                std::env::temp_dir().join(format!("glee-command-smoke-{}", Uuid::new_v4()));
            fs::create_dir_all(&root_dir).expect("temp root should be created");

            let app_data_dir = root_dir.join("app-data");
            fs::create_dir_all(&app_data_dir).expect("app data dir should be created");

            let resources = Resources::new(&app_data_dir).expect("bundled manifest should load");
            let database =
                Database::new(app_data_dir.join("glee.sqlite3")).expect("db should initialize");
            let state = AppState::from_initialized(InitializedAppState {
                db: database,
                runtime_manager: RuntimeManager::new().expect("runtime manager should initialize"),
                embedding_service: None,
                app_data_dir,
                resources,
                vector_search: false,
                indexing_diagnostics: Arc::new(tokio::sync::Mutex::new(
                    initial_indexing_diagnostics(false, false),
                )),
            });

            Self { state, root_dir }
        }

        fn write_fixture(&self, relative_path: &str, bytes: &[u8]) -> PathBuf {
            let path = self.root_dir.join("fixtures").join(relative_path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("fixture parent should be created");
            }
            fs::write(&path, bytes).expect("fixture should be written");
            path
        }

        fn state(&self) -> &AppState {
            &self.state
        }
    }

    impl Drop for CommandSmokeHarness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root_dir);
        }
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    async fn db_task<T, F>(state: &AppState, task: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(Database) -> AppResult<T> + Send + 'static,
    {
        let state = state.handles().await?;
        run_db_task(state.db.clone(), task).await
    }

    fn find_by_id<T, F>(items: &[T], matches: F) -> &T
    where
        F: Fn(&T) -> bool,
    {
        items
            .iter()
            .find(|item| matches(item))
            .expect("record should exist")
    }

    fn fixture_path_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn trims_explicit_runtime_args_and_builds_settings_defaults() {
        assert_eq!(
            normalize_runtime_extra_args(Vec::new()),
            Vec::<String>::new()
        );
        assert_eq!(
            normalize_runtime_extra_args(vec!["  --ctx-size  ".to_string(), " 8192 ".to_string()]),
            vec!["--ctx-size".to_string(), "8192".to_string()]
        );
    }

    #[test]
    fn rejects_runtime_args_that_override_managed_lifecycle_controls() {
        for argument in [
            "--host",
            "--port=8080",
            "-m",
            "--model-url=https://example.invalid/model.gguf",
            "--api-key",
            "--ssl-key-file",
            "--log-file",
            "--device",
            "--no-slots",
            "--ctx-size",
            "-ngl",
            "--no-warmup",
        ] {
            assert!(matches!(
                validate_runtime_extra_args(&[argument.to_string()]),
                Err(AppError::Validation(_))
            ));
        }
        validate_runtime_extra_args(&[
            "--threads".to_string(),
            "4".to_string(),
            "--flash-attn".to_string(),
        ])
        .expect("non-managed tuning arguments should remain available");
    }

    #[test]
    fn runtime_performance_mode_controls_effective_manual_gpu_layers() {
        assert_eq!(
            effective_runtime_gpu_layers(RuntimePerformanceMode::Cpu, 42)
                .expect("CPU policy should resolve"),
            0
        );
        assert_eq!(
            effective_runtime_gpu_layers(RuntimePerformanceMode::Auto, 42)
                .expect("Auto policy should resolve"),
            0
        );
        assert_eq!(
            effective_runtime_gpu_layers(RuntimePerformanceMode::Gpu, 42)
                .expect("GPU policy should resolve"),
            42
        );
        assert!(effective_runtime_gpu_layers(RuntimePerformanceMode::Gpu, -1).is_err());
    }

    #[test]
    fn backend_runtime_launch_settings_smoke() {
        let harness = CommandSmokeHarness::new();

        let initial = block_on(db_task(harness.state(), |database| {
            database.get_runtime_launch_settings()
        }))
        .expect("runtime launch settings should resolve");
        assert!(initial.warmup_enabled);
        assert_eq!(initial.gpu_layers, 0);

        let updated = block_on(db_task(harness.state(), |database| {
            database.set_runtime_launch_settings(false, 8, RuntimePerformanceMode::Gpu)
        }))
        .expect("runtime launch settings should update");
        assert!(!updated.warmup_enabled);
        assert_eq!(updated.gpu_layers, 8);
        assert_eq!(updated.performance_mode, RuntimePerformanceMode::Gpu);

        let persisted = block_on(db_task(harness.state(), |database| {
            database.get_runtime_launch_settings()
        }))
        .expect("persisted runtime launch settings should resolve");
        assert!(!persisted.warmup_enabled);
        assert_eq!(persisted.gpu_layers, 8);
        assert_eq!(persisted.performance_mode, RuntimePerformanceMode::Gpu);

        let warmup_setting = block_on(db_task(harness.state(), |database| {
            database.get_setting("runtime_warmup_enabled")
        }))
        .expect("warmup setting should load")
        .expect("warmup setting should exist");
        assert_eq!(warmup_setting.value, "false");
    }

    fn memory_hit(id: &str, score: i64) -> MemorySnippetRecord {
        MemorySnippetRecord {
            message_id: id.to_string(),
            chat_id: "chat".to_string(),
            role: "user".to_string(),
            content: format!("content of {id}"),
            speaker_character_id: None,
            created_at: "2000-01-01T00:00:00Z".to_string(),
            score,
        }
    }

    #[test]
    fn merged_memory_ranks_strong_lexical_hits_above_weak_semantic_ones() {
        let merged = merge_memory_snippets(
            vec![memory_hit("lexical-strong", 120)],
            vec![
                memory_hit("semantic-weak", 62),
                memory_hit("semantic-good", 100),
            ],
            6,
        );

        let order = merged
            .iter()
            .map(|hit| hit.message_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            order,
            vec!["lexical-strong", "semantic-good", "semantic-weak"]
        );
    }

    #[test]
    fn merged_memory_boosts_hits_found_by_both_searches_and_respects_the_limit() {
        let merged = merge_memory_snippets(
            vec![memory_hit("shared", 70), memory_hit("lexical-only", 90)],
            vec![memory_hit("shared", 100), memory_hit("semantic-only", 95)],
            2,
        );

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].message_id, "shared");
        assert!(merged[0].score > 100);
        assert_eq!(
            merged
                .iter()
                .filter(|hit| hit.message_id == "shared")
                .count(),
            1
        );
    }

    #[test]
    fn bounded_file_reader_rejects_oversized_local_inputs() {
        let harness = CommandSmokeHarness::new();
        let oversized_path = harness.root_dir.join("oversized-image.png");
        let file = fs::File::create(&oversized_path).expect("oversized fixture should be created");
        file.set_len(MAX_LOCAL_IMAGE_FILE_BYTES as u64 + 1)
            .expect("oversized fixture length should be set");

        let error =
            read_file_with_limit(&oversized_path, MAX_LOCAL_IMAGE_FILE_BYTES, "local image")
                .expect_err("oversized image should be rejected");

        assert!(error.to_string().contains("32 MiB size limit"));
    }

    #[test]
    fn diagnostics_export_snapshot_removes_local_paths_from_nested_fields() {
        let harness = CommandSmokeHarness::new();
        let initialized = block_on(harness.state().handles()).expect("state should initialize");
        let mut snapshot = block_on(build_diagnostics_snapshot(&initialized))
            .expect("diagnostics snapshot should build");
        let private_root = harness.root_dir.to_string_lossy().to_string();
        let runtime_log = harness.root_dir.join("logs").join("runtime.log");
        snapshot.runtime.log_file = Some(runtime_log.to_string_lossy().to_string());
        snapshot.runtime.error = Some(format!("runtime failed below {private_root}"));
        snapshot.recent_errors.push(format!(
            "model could not be loaded from {private_root}/private/model.gguf"
        ));
        snapshot.startup.checks[0].detail = format!("write probe failed inside {private_root}");

        let redactions = diagnostics_path_redactions(&snapshot);
        let redacted = redact_diagnostics_snapshot(snapshot, &redactions);
        let serialized =
            serde_json::to_string(&redacted).expect("redacted diagnostics should serialize");

        assert!(!serialized.contains(&private_root));
        assert!(!serialized.contains(&private_root.replace('\\', "/")));
        assert!(serialized.contains("<app-data-dir>"));
        assert!(serialized.contains("<runtime-log-path>"));
        assert!(serialized.contains("<local-path>"));
    }

    async fn bootstrap_state_command(state: &AppState) -> AppResult<BootstrapStateResponse> {
        let state = state.handles().await?;
        let snapshot =
            run_db_task(state.db.clone(), |database| database.bootstrap_snapshot()).await?;
        let runtime = state.runtime_manager.status().await?;
        let active_model = snapshot
            .models
            .iter()
            .find(|model| model.is_active)
            .cloned();

        Ok(BootstrapStateResponse {
            models: snapshot.models,
            active_model,
            characters: snapshot.characters,
            chats: snapshot.chats,
            settings: snapshot.settings,
            user_profile: snapshot.user_profile,
            runtime,
        })
    }

    async fn list_models_command(state: &AppState) -> AppResult<Vec<ModelRecord>> {
        db_task(state, |database| database.list_models()).await
    }

    async fn import_model_command(
        state: &AppState,
        input: ImportModelInput,
    ) -> AppResult<ModelRecord> {
        db_task(state, move |database| {
            let model_path = canonicalize_model_path(&input.path)?;
            let model_name = input
                .name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
                .unwrap_or_else(|| infer_model_name(&model_path));
            let source_path = model_path.to_string_lossy().to_string();
            let sha256 = hash_file_sha256(&model_path)?;
            database.import_model(&model_name, &source_path, &sha256)
        })
        .await
    }

    async fn set_active_model_command(
        state: &AppState,
        model_id: String,
    ) -> AppResult<ModelRecord> {
        let model_id = normalize_non_empty(&model_id, "model id")?;
        db_task(state, move |database| database.set_active_model(&model_id)).await
    }

    async fn list_characters_command(state: &AppState) -> AppResult<Vec<CharacterRecord>> {
        db_task(state, |database| database.list_characters()).await
    }

    async fn create_character_command(
        state: &AppState,
        input: CreateCharacterInput,
    ) -> AppResult<CharacterRecord> {
        let name = normalize_non_empty(&input.name, "character name")?;
        let description = input.description.map(|value| value.trim().to_string());
        let personality = input.personality.map(|value| value.trim().to_string());
        let backstory = input.backstory.map(|value| value.trim().to_string());
        let scenario = input.scenario.map(|value| value.trim().to_string());
        let system_prompt = input.system_prompt.map(|value| value.trim().to_string());
        let post_history_instructions = input
            .post_history_instructions
            .map(|value| value.trim().to_string());
        let speech_style = input.speech_style.map(|value| value.trim().to_string());
        let greeting = input.greeting.map(|value| value.trim().to_string());
        let alternate_greetings_json = normalize_string_list_json_input(
            input.alternate_greetings,
            input.alternate_greetings_json,
        )?;
        let avatar = input.avatar.map(|value| value.trim().to_string());
        let tags_json = normalize_tags_json_input(input.tags, input.tags_json)?;
        let likes_json = normalize_string_list_json_input(input.likes, input.likes_json)?;
        let dislikes_json = normalize_string_list_json_input(input.dislikes, input.dislikes_json)?;
        let boundaries = input.boundaries.map(|value| value.trim().to_string());
        let creator_notes = input.creator_notes.map(|value| value.trim().to_string());
        let creator = input.creator.map(|value| value.trim().to_string());
        let character_version = input
            .character_version
            .map(|value| value.trim().to_string());
        let card_extensions_json = input
            .card_extensions_json
            .map(|value| value.trim().to_string());
        let example_dialogue = input.example_dialogue.map(|value| value.trim().to_string());

        db_task(state, move |database| {
            database.create_character(
                &name,
                description.as_deref(),
                personality.as_deref(),
                backstory.as_deref(),
                scenario.as_deref(),
                system_prompt.as_deref(),
                post_history_instructions.as_deref(),
                speech_style.as_deref(),
                greeting.as_deref(),
                alternate_greetings_json.as_deref(),
                avatar.as_deref(),
                tags_json.as_deref(),
                likes_json.as_deref(),
                dislikes_json.as_deref(),
                boundaries.as_deref(),
                creator_notes.as_deref(),
                creator.as_deref(),
                character_version.as_deref(),
                card_extensions_json.as_deref(),
                example_dialogue.as_deref(),
            )
        })
        .await
    }

    async fn update_character_command(
        state: &AppState,
        input: UpdateCharacterInput,
    ) -> AppResult<CharacterRecord> {
        let character_id = normalize_non_empty(&input.id, "character id")?;
        let name = input.name.map(|value| value.trim().to_string());
        let description = input.description.map(|value| value.trim().to_string());
        let personality = input.personality.map(|value| value.trim().to_string());
        let backstory = input.backstory.map(|value| value.trim().to_string());
        let scenario = input.scenario.map(|value| value.trim().to_string());
        let system_prompt = input.system_prompt.map(|value| value.trim().to_string());
        let post_history_instructions = input
            .post_history_instructions
            .map(|value| value.trim().to_string());
        let speech_style = input.speech_style.map(|value| value.trim().to_string());
        let greeting = input.greeting.map(|value| value.trim().to_string());
        let alternate_greetings_json = normalize_string_list_json_input(
            input.alternate_greetings,
            input.alternate_greetings_json,
        )?;
        let avatar = input.avatar.map(|value| value.trim().to_string());
        let tags_json = normalize_tags_json_input(input.tags, input.tags_json)?;
        let likes_json = normalize_string_list_json_input(input.likes, input.likes_json)?;
        let dislikes_json = normalize_string_list_json_input(input.dislikes, input.dislikes_json)?;
        let boundaries = input.boundaries.map(|value| value.trim().to_string());
        let creator_notes = input.creator_notes.map(|value| value.trim().to_string());
        let creator = input.creator.map(|value| value.trim().to_string());
        let character_version = input
            .character_version
            .map(|value| value.trim().to_string());
        let card_extensions_json = input
            .card_extensions_json
            .map(|value| value.trim().to_string());
        let example_dialogue = input.example_dialogue.map(|value| value.trim().to_string());

        db_task(state, move |database| {
            database.update_character(
                &character_id,
                name.as_deref(),
                description.as_deref(),
                personality.as_deref(),
                backstory.as_deref(),
                scenario.as_deref(),
                system_prompt.as_deref(),
                post_history_instructions.as_deref(),
                speech_style.as_deref(),
                greeting.as_deref(),
                alternate_greetings_json.as_deref(),
                avatar.as_deref(),
                tags_json.as_deref(),
                likes_json.as_deref(),
                dislikes_json.as_deref(),
                boundaries.as_deref(),
                creator_notes.as_deref(),
                creator.as_deref(),
                character_version.as_deref(),
                card_extensions_json.as_deref(),
                example_dialogue.as_deref(),
            )
        })
        .await
    }

    async fn import_character_card_command(
        state: &AppState,
        input: ImportCharacterCardInput,
    ) -> AppResult<CharacterRecord> {
        let path = canonicalize_character_card_path(&input.path)?;
        db_task(state, move |database| {
            let imported = import_character_card_from_path(&path)?;
            database.create_character_with_card_passthrough(
                &imported.name,
                Some(&imported.description),
                Some(&imported.personality),
                Some(&imported.backstory),
                Some(&imported.scenario),
                Some(&imported.system_prompt),
                Some(&imported.post_history_instructions),
                Some(&imported.speech_style),
                Some(&imported.greeting),
                Some(&imported.alternate_greetings_json),
                Some(&imported.avatar),
                Some(&imported.tags_json),
                Some(&imported.likes_json),
                Some(&imported.dislikes_json),
                Some(&imported.boundaries),
                Some(&imported.creator_notes),
                Some(&imported.creator),
                Some(&imported.character_version),
                Some(&imported.card_extensions_json),
                Some(&imported.card_passthrough_json),
                Some(&imported.example_dialogue),
            )
        })
        .await
    }

    async fn export_character_card_json_command(
        state: &AppState,
        input: ExportCharacterCardJsonInput,
    ) -> AppResult<CharacterCardExportResponse> {
        let character_id = normalize_non_empty(&input.character_id, "character id")?;
        let output_path = normalize_character_card_export_path(&input.path, "json")?;
        let character =
            db_task(state, move |database| database.get_character(&character_id)).await?;
        let payload = build_character_card_json(&character)?;
        let serialized = serde_json::to_string_pretty(&payload).map_err(|error| {
            AppError::Validation(format!("failed to serialize character card JSON: {error}"))
        })?;
        fs::write(&output_path, serialized)?;
        Ok(CharacterCardExportResponse {
            path: output_path.to_string_lossy().to_string(),
        })
    }

    async fn export_character_card_png_command(
        state: &AppState,
        input: ExportCharacterCardPngInput,
    ) -> AppResult<CharacterCardExportResponse> {
        let character_id = normalize_non_empty(&input.character_id, "character id")?;
        let output_path = normalize_character_card_export_path(&input.path, "png")?;
        let character =
            db_task(state, move |database| database.get_character(&character_id)).await?;
        let avatar_path = normalize_non_empty(&character.avatar, "character portrait path")?;
        let source_png = read_file_with_limit(
            Path::new(&avatar_path),
            MAX_CHARACTER_CARD_FILE_BYTES,
            "character portrait",
        )?;
        let encoded = build_png_card_bytes(&source_png, &character)?;
        fs::write(&output_path, encoded)?;
        Ok(CharacterCardExportResponse {
            path: output_path.to_string_lossy().to_string(),
        })
    }

    async fn list_chats_command(
        state: &AppState,
        character_id: Option<String>,
    ) -> AppResult<Vec<ChatRecord>> {
        let character_id = character_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        db_task(state, move |database| {
            database.list_chats(character_id.as_deref())
        })
        .await
    }

    async fn create_chat_command(
        state: &AppState,
        input: CreateChatInput,
    ) -> AppResult<ChatRecord> {
        let title = input
            .title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(default_chat_title);
        let character_id = input
            .character_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        db_task(state, move |database| {
            database.create_chat(&title, character_id.as_deref())
        })
        .await
    }

    async fn create_group_chat_command(
        state: &AppState,
        input: CreateGroupChatInput,
    ) -> AppResult<ChatRecord> {
        let title = input
            .title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(default_group_chat_title);
        let character_ids = normalize_character_id_list(input.character_ids)?;
        db_task(state, move |database| {
            database.create_group_chat(&title, &character_ids)
        })
        .await
    }

    async fn update_group_chat_command(
        state: &AppState,
        input: UpdateGroupChatInput,
    ) -> AppResult<ChatRecord> {
        let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
        let title = input
            .title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::Validation("group chat title cannot be empty".to_string()))?;
        let character_ids = normalize_character_id_list(input.character_ids)?;
        db_task(state, move |database| {
            database.update_group_chat(&chat_id, &title, &character_ids)
        })
        .await
    }

    async fn clear_chat_history_command(
        state: &AppState,
        chat_id: String,
    ) -> AppResult<ChatHistoryMutationRecord> {
        let chat_id = normalize_non_empty(&chat_id, "chat id")?;
        db_task(state, move |database| {
            database.clear_chat_history_mutation(&chat_id)
        })
        .await
    }

    async fn list_chat_participants_command(
        state: &AppState,
        chat_id: String,
    ) -> AppResult<Vec<CharacterRecord>> {
        let chat_id = normalize_non_empty(&chat_id, "chat id")?;
        db_task(state, move |database| {
            database.list_chat_participants(&chat_id)
        })
        .await
    }

    async fn list_messages_command(
        state: &AppState,
        chat_id: String,
    ) -> AppResult<Vec<MessageRecord>> {
        let chat_id = normalize_non_empty(&chat_id, "chat id")?;
        db_task(state, move |database| database.list_messages(&chat_id)).await
    }

    async fn append_message_command(
        state: &AppState,
        input: AppendMessageInput,
    ) -> AppResult<MessageRecord> {
        let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
        let role = normalize_role(&input.role)?;
        let content = normalize_non_empty(&input.content, "message content")?;
        let speaker_character_id = input
            .speaker_character_id
            .map(|value| value.trim().to_string());
        let expected_history_epoch = input.expected_history_epoch;

        db_task(state, move |database| {
            database.append_message_at_epoch(
                &chat_id,
                &role,
                &content,
                speaker_character_id.as_deref(),
                expected_history_epoch,
            )
        })
        .await
    }

    async fn update_message_command(
        state: &AppState,
        input: UpdateMessageInput,
    ) -> AppResult<MessageRecord> {
        let message_id = normalize_non_empty(&input.id, "message id")?;
        let content = normalize_non_empty(&input.content, "message content")?;
        let expected_history_epoch = input.expected_history_epoch;
        db_task(state, move |database| {
            database.update_message_at_epoch(&message_id, &content, expected_history_epoch)
        })
        .await
    }

    async fn branch_chat_command(
        state: &AppState,
        input: BranchChatInput,
    ) -> AppResult<ChatRecord> {
        let source_chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
        let anchor_message_id = normalize_non_empty(&input.anchor_message_id, "anchor message id")?;
        let title = input
            .title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        db_task(state, move |database| {
            database.branch_chat(&source_chat_id, &anchor_message_id, title.as_deref())
        })
        .await
    }

    async fn get_chat_memory_command(
        state: &AppState,
        chat_id: String,
    ) -> AppResult<ChatMemoryRecord> {
        let chat_id = normalize_non_empty(&chat_id, "chat id")?;
        db_task(state, move |database| database.get_chat_memory(&chat_id)).await
    }

    async fn upsert_chat_memory_command(
        state: &AppState,
        input: UpsertChatMemoryInput,
    ) -> AppResult<ChatMemoryRecord> {
        let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
        let summary = input.summary.map(|value| value.trim().to_string());
        let facts_json = normalize_facts_json_input(input.facts, input.facts_json)?;
        let expected_history_epoch = input.expected_history_epoch;

        db_task(state, move |database| {
            database.upsert_chat_memory_at_epoch(
                &chat_id,
                summary.as_deref(),
                facts_json.as_deref(),
                expected_history_epoch,
            )
        })
        .await
    }

    async fn resolve_memory_snippets_command(
        state: &AppState,
        input: ResolveMemorySnippetsInput,
    ) -> AppResult<Vec<MemorySnippetRecord>> {
        let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
        let query = normalize_non_empty(&input.query, "query")?;
        let limit = input.limit.unwrap_or(6).clamp(1, 12) as usize;
        let speaker_character_id = input
            .speaker_character_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let retrieval_hints = input
            .retrieval_hints
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        let lexical_hits = db_task(state, move |database| {
            database.resolve_memory_snippets(
                &chat_id,
                &query,
                limit,
                speaker_character_id.as_deref(),
                retrieval_hints.as_deref(),
                // The smoke chat is shorter than the recent-message window.
                0,
            )
        })
        .await?;

        Ok(merge_memory_snippets(lexical_hits, Vec::new(), limit))
    }

    async fn list_generation_presets_command(
        state: &AppState,
    ) -> AppResult<Vec<GenerationPresetRecord>> {
        db_task(state, |database| database.list_generation_presets()).await
    }

    async fn create_generation_preset_command(
        state: &AppState,
        input: CreateGenerationPresetInput,
    ) -> AppResult<GenerationPresetRecord> {
        let name = normalize_non_empty(&input.name, "generation preset name")?;
        let description = input.description.map(|value| value.trim().to_string());
        let temperature = normalize_temperature_input(input.temperature)?;
        let top_p = normalize_top_p_input(input.top_p)?;
        let max_tokens = normalize_max_tokens_input(input.max_tokens)?;
        let repeat_penalty = normalize_repeat_penalty_input(input.repeat_penalty)?;

        db_task(state, move |database| {
            database.create_generation_preset(
                &name,
                description.as_deref(),
                temperature,
                top_p,
                max_tokens,
                repeat_penalty,
            )
        })
        .await
    }

    async fn update_generation_preset_command(
        state: &AppState,
        input: UpdateGenerationPresetInput,
    ) -> AppResult<GenerationPresetRecord> {
        let preset_id = normalize_non_empty(&input.id, "generation preset id")?;
        let name = input.name.map(|value| value.trim().to_string());
        if name.as_ref().is_some_and(|value| value.is_empty()) {
            return Err(AppError::Validation(
                "generation preset name cannot be empty".to_string(),
            ));
        }
        let description = input.description.map(|value| value.trim().to_string());
        let temperature = normalize_temperature_input(input.temperature)?;
        let top_p = normalize_top_p_input(input.top_p)?;
        let max_tokens = normalize_max_tokens_input(input.max_tokens)?;
        let repeat_penalty = normalize_repeat_penalty_input(input.repeat_penalty)?;

        db_task(state, move |database| {
            database.update_generation_preset(
                &preset_id,
                name.as_deref(),
                description.as_deref(),
                temperature,
                top_p,
                max_tokens,
                repeat_penalty,
            )
        })
        .await
    }

    async fn delete_generation_preset_command(
        state: &AppState,
        preset_id: String,
    ) -> AppResult<()> {
        let preset_id = normalize_non_empty(&preset_id, "generation preset id")?;
        db_task(state, move |database| {
            database.delete_generation_preset(&preset_id)
        })
        .await
    }

    async fn get_chat_preset_profile_command(
        state: &AppState,
        chat_id: String,
    ) -> AppResult<ChatPresetProfileRecord> {
        let chat_id = normalize_non_empty(&chat_id, "chat id")?;
        db_task(state, move |database| {
            database.get_chat_preset_profile(&chat_id)
        })
        .await
    }

    async fn upsert_chat_preset_profile_command(
        state: &AppState,
        input: UpsertChatPresetProfileInput,
    ) -> AppResult<ChatPresetProfileRecord> {
        let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
        let generation_preset_id = input
            .generation_preset_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        db_task(state, move |database| {
            database.upsert_chat_preset_profile(&chat_id, generation_preset_id.as_deref())
        })
        .await
    }

    async fn get_user_profile_command(state: &AppState) -> AppResult<UserProfileRecord> {
        db_task(state, |database| database.get_user_profile()).await
    }

    async fn upsert_user_profile_command(
        state: &AppState,
        input: UpsertUserProfileInput,
    ) -> AppResult<UserProfileRecord> {
        let display_name = input.display_name.map(|value| value.trim().to_string());
        let about = input.about.map(|value| value.trim().to_string());
        let gender = input.gender.map(|value| value.trim().to_string());
        let avatar = input.avatar.map(|value| value.trim().to_string());
        let traits_json = normalize_string_list_json_input(input.traits, input.traits_json)?;
        let preferences = input.preferences.map(|value| value.trim().to_string());
        let boundaries = input.boundaries.map(|value| value.trim().to_string());

        db_task(state, move |database| {
            database.upsert_user_profile(UserProfilePatch {
                display_name: display_name.as_deref(),
                about: about.as_deref(),
                gender: gender.as_deref(),
                avatar: avatar.as_deref(),
                traits_json: traits_json.as_deref(),
                preferences: preferences.as_deref(),
                boundaries: boundaries.as_deref(),
            })
        })
        .await
    }

    async fn get_chat_relationship_state_command(
        state: &AppState,
        chat_id: String,
    ) -> AppResult<ChatRelationshipStateRecord> {
        let chat_id = normalize_non_empty(&chat_id, "chat id")?;
        db_task(state, move |database| {
            database.get_chat_relationship_state(&chat_id)
        })
        .await
    }

    async fn upsert_chat_relationship_state_command(
        state: &AppState,
        input: UpsertChatRelationshipStateInput,
    ) -> AppResult<ChatRelationshipStateRecord> {
        let chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
        let summary = input.summary.map(|value| value.trim().to_string());
        let current_scene = input.current_scene.map(|value| value.trim().to_string());
        let interaction_tone = input.interaction_tone.map(|value| value.trim().to_string());
        let character_state = input.character_state.map(|value| value.trim().to_string());
        let user_state = input.user_state.map(|value| value.trim().to_string());
        let user_role_name = input.user_role_name.map(|value| value.trim().to_string());
        let user_role_description = input
            .user_role_description
            .map(|value| value.trim().to_string());
        let expected_history_epoch = input.expected_history_epoch;

        db_task(state, move |database| {
            database.upsert_chat_relationship_state_at_epoch(
                &chat_id,
                summary.as_deref(),
                current_scene.as_deref(),
                interaction_tone.as_deref(),
                character_state.as_deref(),
                user_state.as_deref(),
                user_role_name.as_deref(),
                user_role_description.as_deref(),
                expected_history_epoch,
            )
        })
        .await
    }

    async fn list_context_entries_command(
        state: &AppState,
        character_id: Option<String>,
    ) -> AppResult<Vec<ContextEntryRecord>> {
        let character_id = character_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        db_task(state, move |database| {
            database.list_context_entries(character_id.as_deref())
        })
        .await
    }

    async fn create_context_entry_command(
        state: &AppState,
        input: CreateContextEntryInput,
    ) -> AppResult<ContextEntryRecord> {
        let scope = normalize_context_scope(&input.scope)?;
        let mut character_id = input
            .character_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if scope == "character" && character_id.is_none() {
            return Err(AppError::Validation(
                "character_id is required when scope is character".to_string(),
            ));
        }
        if scope == "global" {
            character_id = None;
        }

        let title = normalize_non_empty(&input.title, "context entry title")?;
        let content = input.content.trim().to_string();
        let keywords_json = normalize_keywords_json_input(input.keywords, input.keywords_json)?;

        db_task(state, move |database| {
            database.create_context_entry(
                &scope,
                character_id.as_deref(),
                &title,
                keywords_json.as_deref(),
                &content,
                input.enabled,
            )
        })
        .await
    }

    async fn update_context_entry_command(
        state: &AppState,
        input: UpdateContextEntryInput,
    ) -> AppResult<ContextEntryRecord> {
        let context_entry_id = normalize_non_empty(&input.id, "context entry id")?;
        let title = if let Some(value) = input.title {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                return Err(AppError::Validation(
                    "context entry title cannot be empty".to_string(),
                ));
            }
            Some(trimmed)
        } else {
            None
        };
        let keywords_json = normalize_keywords_json_input(input.keywords, input.keywords_json)?;
        let content = input.content.map(|value| value.trim().to_string());

        db_task(state, move |database| {
            database.update_context_entry(
                &context_entry_id,
                title.as_deref(),
                keywords_json.as_deref(),
                content.as_deref(),
                input.enabled,
            )
        })
        .await
    }

    async fn resolve_context_entries_command(
        state: &AppState,
        input: ResolveContextEntriesInput,
    ) -> AppResult<Vec<ContextEntryRecord>> {
        let character_ids = input
            .character_ids
            .map(normalize_string_values)
            .unwrap_or_default();
        let query = normalize_non_empty(&input.query, "query")?;
        let limit = input.limit.unwrap_or(6).clamp(1, 20) as usize;
        db_task(state, move |database| {
            database.resolve_context_entries(&character_ids, &query, limit)
        })
        .await
    }

    #[test]
    fn backend_command_smoke_bootstrap_and_model_import() {
        let harness = CommandSmokeHarness::new();

        let initial =
            block_on(bootstrap_state_command(harness.state())).expect("bootstrap should succeed");
        assert!(initial.models.is_empty());
        assert!(initial.active_model.is_none());
        assert!(initial
            .characters
            .iter()
            .any(|character| character.name == "Nova"));
        assert!(initial.chats.is_empty());
        assert_eq!(initial.runtime.state, crate::types::RuntimePhase::Stopped);

        let model_path = harness.write_fixture("smoke-model.gguf", b"mock-gguf-contents");
        let imported = block_on(import_model_command(
            harness.state(),
            ImportModelInput {
                path: fixture_path_string(&model_path),
                name: None,
            },
        ))
        .expect("model import should succeed");

        let expected_path = canonicalize_model_path(&fixture_path_string(&model_path))
            .expect("model path should canonicalize")
            .to_string_lossy()
            .to_string();
        let expected_sha256 = hash_file_sha256(&model_path).expect("hash should resolve");

        assert_eq!(imported.name, "smoke-model");
        assert_eq!(imported.source_path, expected_path);
        assert_eq!(imported.sha256, expected_sha256);
        assert!(imported.is_active);

        let second_model_path = harness.write_fixture("backup-model.gguf", b"backup-model");
        let second_model = block_on(import_model_command(
            harness.state(),
            ImportModelInput {
                path: fixture_path_string(&second_model_path),
                name: Some("Backup Model".to_string()),
            },
        ))
        .expect("second model import should succeed");
        assert!(!second_model.is_active);

        let activated = block_on(set_active_model_command(
            harness.state(),
            second_model.id.clone(),
        ))
        .expect("set_active_model should succeed");
        assert_eq!(activated.id, second_model.id);
        assert!(activated.is_active);

        let models =
            block_on(list_models_command(harness.state())).expect("list_models should succeed");
        assert_eq!(models.len(), 2);
        assert_eq!(models.iter().filter(|model| model.is_active).count(), 1);
        assert_eq!(
            models
                .iter()
                .find(|model| model.is_active)
                .map(|model| model.id.as_str()),
            Some(second_model.id.as_str())
        );

        let refreshed =
            block_on(bootstrap_state_command(harness.state())).expect("bootstrap should refresh");
        assert_eq!(
            refreshed
                .active_model
                .as_ref()
                .map(|model| model.id.as_str()),
            Some(second_model.id.as_str())
        );
        assert_eq!(refreshed.models.len(), 2);
        assert_eq!(
            refreshed
                .settings
                .iter()
                .find(|setting| setting.key == "active_model_id")
                .map(|setting| setting.value.as_str()),
            Some(second_model.id.as_str())
        );

        let runtime = block_on(async {
            let handles = harness
                .state()
                .handles()
                .await
                .expect("handles should resolve");
            handles.runtime_manager.status().await
        })
        .expect("runtime status should resolve");
        assert_eq!(runtime.state, crate::types::RuntimePhase::Stopped);
        assert!(runtime.error.is_none());
    }

    #[test]
    fn backend_command_smoke_character_chat_message_and_memory_flow() {
        let harness = CommandSmokeHarness::new();

        let created_character = block_on(create_character_command(
            harness.state(),
            CreateCharacterInput {
                name: "Ava".to_string(),
                description: Some("Mission lead".to_string()),
                personality: Some("Calm, decisive, and practical under pressure.".to_string()),
                backstory: None,
                scenario: None,
                system_prompt: Some("Stay calm and practical.".to_string()),
                post_history_instructions: None,
                speech_style: None,
                greeting: Some("Ready when you are.".to_string()),
                alternate_greetings_json: None,
                alternate_greetings: None,
                avatar: None,
                tags_json: None,
                tags: Some(vec!["mission".to_string(), "ops".to_string()]),
                likes_json: None,
                likes: None,
                dislikes_json: None,
                dislikes: None,
                boundaries: None,
                creator_notes: None,
                creator: None,
                character_version: None,
                card_extensions_json: None,
                example_dialogue: Some("User: Status?\nAva: Green.".to_string()),
            },
        ))
        .expect("create_character should succeed");
        assert_eq!(created_character.name, "Ava");
        assert_eq!(created_character.tags, vec!["mission", "ops"]);

        let updated_character = block_on(update_character_command(
            harness.state(),
            UpdateCharacterInput {
                id: created_character.id.clone(),
                name: Some("Ava Prime".to_string()),
                description: None,
                personality: None,
                backstory: None,
                scenario: None,
                system_prompt: None,
                post_history_instructions: None,
                speech_style: None,
                greeting: Some("Standing by.".to_string()),
                alternate_greetings_json: None,
                alternate_greetings: None,
                avatar: None,
                tags_json: None,
                tags: Some(vec!["mission".to_string(), "analysis".to_string()]),
                likes_json: None,
                likes: None,
                dislikes_json: None,
                dislikes: None,
                boundaries: None,
                creator_notes: None,
                creator: None,
                character_version: None,
                card_extensions_json: None,
                example_dialogue: None,
            },
        ))
        .expect("update_character should succeed");
        assert_eq!(updated_character.name, "Ava Prime");
        assert_eq!(updated_character.greeting, "Standing by.");
        assert_eq!(updated_character.tags, vec!["mission", "analysis"]);

        let characters = block_on(list_characters_command(harness.state()))
            .expect("list_characters should succeed");
        let listed_character = find_by_id(&characters, |record| record.id == updated_character.id);
        assert_eq!(listed_character.name, "Ava Prime");

        let chat = block_on(create_chat_command(
            harness.state(),
            CreateChatInput {
                title: Some("Launch Thread".to_string()),
                character_id: Some(updated_character.id.clone()),
            },
        ))
        .expect("create_chat should succeed");
        assert_eq!(chat.title, "Launch Thread");
        assert_eq!(
            chat.character_id.as_deref(),
            Some(updated_character.id.as_str())
        );
        assert_eq!(chat.chat_mode, "single");

        let chats = block_on(list_chats_command(
            harness.state(),
            Some(updated_character.id.clone()),
        ))
        .expect("list_chats should succeed");
        let listed_chat = find_by_id(&chats, |record| record.id == chat.id);
        assert_eq!(listed_chat.title, "Launch Thread");

        let participants = block_on(list_chat_participants_command(
            harness.state(),
            chat.id.clone(),
        ))
        .expect("list_chat_participants should succeed");
        assert_eq!(participants.len(), 1);
        assert_eq!(participants[0].id, updated_character.id);

        let user_message = block_on(append_message_command(
            harness.state(),
            AppendMessageInput {
                chat_id: chat.id.clone(),
                role: "user".to_string(),
                content: "We need the launch checklist before go-live.".to_string(),
                speaker_character_id: None,
                expected_history_epoch: None,
            },
        ))
        .expect("user append_message should succeed");
        let assistant_message = block_on(append_message_command(
            harness.state(),
            AppendMessageInput {
                chat_id: chat.id.clone(),
                role: "assistant".to_string(),
                content: "The launch checklist is in the mission binder.".to_string(),
                speaker_character_id: Some(updated_character.id.clone()),
                expected_history_epoch: None,
            },
        ))
        .expect("assistant append_message should succeed");

        let updated_assistant_message = block_on(update_message_command(
            harness.state(),
            UpdateMessageInput {
                id: assistant_message.id.clone(),
                content: "The launch checklist is in the updated mission binder.".to_string(),
                expected_history_epoch: None,
            },
        ))
        .expect("update_message should succeed");
        assert_eq!(
            updated_assistant_message.content,
            "The launch checklist is in the updated mission binder."
        );

        let branch = block_on(branch_chat_command(
            harness.state(),
            BranchChatInput {
                chat_id: chat.id.clone(),
                anchor_message_id: updated_assistant_message.id.clone(),
                title: Some("Launch Thread Branch".to_string()),
            },
        ))
        .expect("branch_chat should succeed");
        assert_eq!(branch.title, "Launch Thread Branch");
        assert_eq!(branch.chat_mode, "single");

        let branch_messages = block_on(list_messages_command(harness.state(), branch.id.clone()))
            .expect("branch messages should list");
        assert_eq!(branch_messages.len(), 2);
        assert_eq!(
            branch_messages[1].content,
            updated_assistant_message.content
        );

        let messages = block_on(list_messages_command(harness.state(), chat.id.clone()))
            .expect("list_messages should succeed");
        assert_eq!(messages.len(), 2);
        assert!(messages.iter().any(|message| message.id == user_message.id));
        assert!(messages
            .iter()
            .any(|message| message.id == updated_assistant_message.id));

        let initial_memory = block_on(get_chat_memory_command(harness.state(), chat.id.clone()))
            .expect("get_chat_memory should succeed");
        assert_eq!(initial_memory.summary, "");
        assert!(initial_memory.facts.is_empty());

        let updated_memory = block_on(upsert_chat_memory_command(
            harness.state(),
            UpsertChatMemoryInput {
                chat_id: chat.id.clone(),
                summary: Some("Ava tracks launch readiness and documentation.".to_string()),
                facts_json: None,
                facts: Some(vec![
                    "launch checklist".to_string(),
                    "mission binder".to_string(),
                ]),
                expected_history_epoch: None,
            },
        ))
        .expect("upsert_chat_memory should succeed");
        assert_eq!(
            updated_memory.summary,
            "Ava tracks launch readiness and documentation."
        );
        assert_eq!(
            updated_memory.facts,
            vec!["launch checklist", "mission binder"]
        );

        let persisted_memory = block_on(get_chat_memory_command(harness.state(), chat.id.clone()))
            .expect("persisted chat memory should load");
        assert_eq!(persisted_memory.summary, updated_memory.summary);
        assert_eq!(persisted_memory.facts, updated_memory.facts);

        let failed_reply = block_on(append_message_command(
            harness.state(),
            AppendMessageInput {
                chat_id: chat.id.clone(),
                role: "assistant".to_string(),
                content: format!(
                    "{GENERATION_FAILURE_PREFIX} Ava could not complete the launch checklist reply."
                ),
                speaker_character_id: Some(updated_character.id.clone()),
                expected_history_epoch: None,
            },
        ))
        .expect("generation failure event should remain visible in chat history");

        let snippets = block_on(resolve_memory_snippets_command(
            harness.state(),
            ResolveMemorySnippetsInput {
                chat_id: chat.id.clone(),
                query: "checklist binder".to_string(),
                limit: None,
                speaker_character_id: None,
                retrieval_hints: None,
            },
        ))
        .expect("resolve_memory_snippets should succeed");
        assert!(!snippets.is_empty());
        assert!(snippets
            .iter()
            .any(|snippet| snippet.content.to_lowercase().contains("checklist")));
        assert!(snippets
            .iter()
            .all(|snippet| snippet.message_id != failed_reply.id));

        block_on(clear_chat_history_command(harness.state(), chat.id.clone()))
            .expect("clear_chat_history should succeed");

        let cleared_messages = block_on(list_messages_command(harness.state(), chat.id.clone()))
            .expect("cleared messages should still list");
        assert!(cleared_messages.is_empty());

        let cleared_memory = block_on(get_chat_memory_command(harness.state(), chat.id.clone()))
            .expect("cleared chat memory should load");
        assert_eq!(cleared_memory.summary, "");
        assert!(cleared_memory.facts.is_empty());
    }

    #[test]
    fn backend_command_smoke_presets_context_and_profile_flow() {
        let harness = CommandSmokeHarness::new();

        let generation_baseline = block_on(list_generation_presets_command(harness.state()))
            .expect("list_generation_presets should succeed");

        let generation = block_on(create_generation_preset_command(
            harness.state(),
            CreateGenerationPresetInput {
                name: "Launch Low-Variance".to_string(),
                description: Some("Stable answers for checklists.".to_string()),
                temperature: Some(0.2),
                top_p: Some(0.8),
                max_tokens: Some(256),
                repeat_penalty: Some(1.05),
            },
        ))
        .expect("create_generation_preset should succeed");
        let updated_generation = block_on(update_generation_preset_command(
            harness.state(),
            UpdateGenerationPresetInput {
                id: generation.id.clone(),
                name: None,
                description: None,
                temperature: Some(0.35),
                top_p: None,
                max_tokens: Some(300),
                repeat_penalty: None,
            },
        ))
        .expect("update_generation_preset should succeed");
        assert_eq!(updated_generation.temperature, 0.35);
        assert_eq!(updated_generation.max_tokens, 300);

        let generations = block_on(list_generation_presets_command(harness.state()))
            .expect("list_generation_presets should refresh");
        assert_eq!(generations.len(), generation_baseline.len() + 1);
        let stored_generation =
            find_by_id(&generations, |record| record.id == updated_generation.id);
        assert_eq!(stored_generation.temperature, 0.35);

        let character = block_on(create_character_command(
            harness.state(),
            CreateCharacterInput {
                name: "Rook".to_string(),
                description: Some("Flight systems analyst".to_string()),
                personality: None,
                backstory: None,
                scenario: None,
                system_prompt: None,
                post_history_instructions: None,
                speech_style: None,
                greeting: None,
                alternate_greetings_json: None,
                alternate_greetings: None,
                avatar: None,
                tags_json: None,
                tags: None,
                likes_json: None,
                likes: None,
                dislikes_json: None,
                dislikes: None,
                boundaries: None,
                creator_notes: None,
                creator: None,
                character_version: None,
                card_extensions_json: None,
                example_dialogue: None,
            },
        ))
        .expect("create_character for presets should succeed");
        let chat = block_on(create_chat_command(
            harness.state(),
            CreateChatInput {
                title: Some("Profile Sync".to_string()),
                character_id: Some(character.id.clone()),
            },
        ))
        .expect("create_chat for profile should succeed");

        let initial_user_profile = block_on(get_user_profile_command(harness.state()))
            .expect("get_user_profile should succeed");
        assert_eq!(initial_user_profile.id, "default");
        assert!(initial_user_profile.display_name.is_empty());

        let user_profile = block_on(upsert_user_profile_command(
            harness.state(),
            UpsertUserProfileInput {
                display_name: Some("Ari".to_string()),
                about: Some("Indie creator building offline roleplay worlds.".to_string()),
                gender: Some("nonbinary".to_string()),
                avatar: Some("D:/Profiles/ari.png".to_string()),
                traits_json: None,
                traits: Some(vec!["curious".to_string(), "persistent".to_string()]),
                preferences: Some(
                    "Prefers slow-burn dialogue and emotionally grounded scenes.".to_string(),
                ),
                boundaries: Some("Avoid gore.".to_string()),
            },
        ))
        .expect("upsert_user_profile should succeed");
        assert_eq!(user_profile.display_name, "Ari");
        assert_eq!(user_profile.gender, "nonbinary");
        assert_eq!(user_profile.avatar, "D:/Profiles/ari.png");
        assert_eq!(user_profile.traits, vec!["curious", "persistent"]);
        assert_eq!(
            user_profile.preferences,
            "Prefers slow-burn dialogue and emotionally grounded scenes."
        );
        assert_eq!(user_profile.boundaries, "Avoid gore.");

        let persisted_user_profile = block_on(get_user_profile_command(harness.state()))
            .expect("persisted user profile should load");
        assert_eq!(persisted_user_profile.display_name, "Ari");
        assert_eq!(persisted_user_profile.gender, "nonbinary");
        assert_eq!(
            persisted_user_profile.preferences,
            "Prefers slow-burn dialogue and emotionally grounded scenes."
        );

        let initial_relationship = block_on(get_chat_relationship_state_command(
            harness.state(),
            chat.id.clone(),
        ))
        .expect("default relationship state should resolve");
        assert_eq!(initial_relationship.chat_id, chat.id);
        assert!(initial_relationship.summary.is_empty());
        assert!(initial_relationship.current_scene.is_empty());

        let relationship = block_on(upsert_chat_relationship_state_command(
            harness.state(),
            UpsertChatRelationshipStateInput {
                chat_id: chat.id.clone(),
                summary: Some(
                    "Rook trusts Ari as a steady collaborator during launch prep.".to_string(),
                ),
                current_scene: Some(
                    "They are reviewing the final launch procedure in a quiet control room."
                        .to_string(),
                ),
                interaction_tone: Some("Warm and focused.".to_string()),
                character_state: Some("Confident after the rehearsal.".to_string()),
                user_state: Some("Curious but steady.".to_string()),
                user_role_name: Some("Launch partner".to_string()),
                user_role_description: Some(
                    "Ari is the operator coordinating the final go-live checklist.".to_string(),
                ),
                expected_history_epoch: None,
            },
        ))
        .expect("upsert_chat_relationship_state should succeed");
        assert!(relationship.summary.contains("steady collaborator"));
        assert!(relationship.current_scene.contains("control room"));
        assert!(relationship.interaction_tone.contains("Warm"));
        assert_eq!(relationship.user_role_name, "Launch partner");
        assert!(relationship
            .user_role_description
            .contains("final go-live checklist"));

        let persisted_relationship = block_on(get_chat_relationship_state_command(
            harness.state(),
            chat.id.clone(),
        ))
        .expect("persisted relationship state should load");
        assert_eq!(persisted_relationship.summary, relationship.summary);
        assert_eq!(
            persisted_relationship.current_scene,
            relationship.current_scene
        );
        assert_eq!(
            persisted_relationship.interaction_tone,
            relationship.interaction_tone
        );
        assert_eq!(
            persisted_relationship.user_role_name,
            relationship.user_role_name
        );
        assert_eq!(
            persisted_relationship.user_role_description,
            relationship.user_role_description
        );

        let empty_profile = block_on(get_chat_preset_profile_command(
            harness.state(),
            chat.id.clone(),
        ))
        .expect("empty profile should resolve");
        assert_eq!(empty_profile.generation_preset_id, "");

        let profile = block_on(upsert_chat_preset_profile_command(
            harness.state(),
            UpsertChatPresetProfileInput {
                chat_id: chat.id.clone(),
                generation_preset_id: Some(updated_generation.id.clone()),
            },
        ))
        .expect("profile upsert should succeed");
        assert_eq!(profile.generation_preset_id, updated_generation.id);

        let persisted_profile = block_on(get_chat_preset_profile_command(
            harness.state(),
            chat.id.clone(),
        ))
        .expect("profile should persist");
        assert_eq!(
            persisted_profile.generation_preset_id,
            updated_generation.id
        );

        block_on(delete_generation_preset_command(
            harness.state(),
            updated_generation.id.clone(),
        ))
        .expect("delete_generation_preset should succeed");
        let profile_after_generation_delete = block_on(get_chat_preset_profile_command(
            harness.state(),
            chat.id.clone(),
        ))
        .expect("profile should survive generation delete");
        assert_eq!(profile_after_generation_delete.generation_preset_id, "");

        let global_entry = block_on(create_context_entry_command(
            harness.state(),
            CreateContextEntryInput {
                scope: "global".to_string(),
                character_id: None,
                title: "Base Manual".to_string(),
                keywords_json: None,
                keywords: Some(vec!["manual".to_string(), "shared".to_string()]),
                content: "Shared operating procedures.".to_string(),
                enabled: None,
            },
        ))
        .expect("create global context entry should succeed");
        let character_entry = block_on(create_context_entry_command(
            harness.state(),
            CreateContextEntryInput {
                scope: "character".to_string(),
                character_id: Some(character.id.clone()),
                title: "Launch Procedure".to_string(),
                keywords_json: None,
                keywords: Some(vec!["procedure".to_string(), "launch".to_string()]),
                content: "Private launch sequence for Rook.".to_string(),
                enabled: Some(true),
            },
        ))
        .expect("create character context entry should succeed");

        let global_only_entries = block_on(list_context_entries_command(harness.state(), None))
            .expect("list global context should succeed");
        assert!(global_only_entries
            .iter()
            .any(|entry| entry.id == global_entry.id));
        assert!(!global_only_entries
            .iter()
            .any(|entry| entry.id == character_entry.id));

        let scoped_entries = block_on(list_context_entries_command(
            harness.state(),
            Some(character.id.clone()),
        ))
        .expect("list scoped context should succeed");
        assert!(scoped_entries
            .iter()
            .any(|entry| entry.id == global_entry.id));
        assert!(scoped_entries
            .iter()
            .any(|entry| entry.id == character_entry.id));

        let updated_context = block_on(update_context_entry_command(
            harness.state(),
            UpdateContextEntryInput {
                id: character_entry.id.clone(),
                title: Some("Launch Procedure v2".to_string()),
                keywords_json: None,
                keywords: None,
                content: None,
                enabled: Some(false),
            },
        ))
        .expect("update_context_entry should succeed");
        assert_eq!(updated_context.title, "Launch Procedure v2");
        assert!(!updated_context.enabled);

        let hidden_results = block_on(resolve_context_entries_command(
            harness.state(),
            ResolveContextEntriesInput {
                character_ids: Some(vec![character.id.clone()]),
                query: "procedure".to_string(),
                limit: None,
            },
        ))
        .expect("resolve_context_entries should succeed");
        assert!(!hidden_results
            .iter()
            .any(|entry| entry.id == character_entry.id));

        let global_results = block_on(resolve_context_entries_command(
            harness.state(),
            ResolveContextEntriesInput {
                character_ids: Some(vec![character.id]),
                query: "manual".to_string(),
                limit: None,
            },
        ))
        .expect("resolve_context_entries should return the global match");
        assert!(!global_results.is_empty());
        assert_eq!(global_results[0].id, global_entry.id);
    }

    #[test]
    fn backend_command_smoke_character_card_and_group_chat_flow() {
        let harness = CommandSmokeHarness::new();
        let card_path = harness.write_fixture(
            "cards/nia.json",
            br#"{
  "data": {
    "name": "Nia",
    "description": "{{char}} is a launch operations analyst working with {{user}}.",
    "personality": "Warm and methodical with {{user}}.",
    "scenario": "<START>\n{{user}} corners {{char}} during a launch rehearsal.",
    "system_prompt": "Keep every step explicit for {{user}}.",
    "first_mes": "{{char}}: I have the checklist open for {{user}}.",
    "mes_example": "{{user}}: Status?\n{{char}}: Ready for review.",
    "tags": ["ops", "launch"]
  }
}"#,
        );

        let imported = block_on(import_character_card_command(
            harness.state(),
            ImportCharacterCardInput {
                path: fixture_path_string(&card_path),
            },
        ))
        .expect("import_character_card should succeed");
        assert_eq!(imported.name, "Nia");
        assert_eq!(
            imported.description,
            "{{char}} is a launch operations analyst working with {{user}}."
        );
        assert_eq!(
            imported.scenario,
            "<START>\n{{user}} corners {{char}} during a launch rehearsal."
        );
        assert_eq!(
            imported.greeting,
            "{{char}}: I have the checklist open for {{user}}."
        );
        assert_eq!(
            imported.example_dialogue,
            "{{user}}: Status?\n{{char}}: Ready for review."
        );
        assert_eq!(imported.tags, vec!["ops", "launch"]);

        let export_path = harness.root_dir.join("exports").join("nia-export.json");
        std::fs::create_dir_all(
            export_path
                .parent()
                .expect("export path should have a parent directory"),
        )
        .expect("export directory should create");
        let export_response = block_on(export_character_card_json_command(
            harness.state(),
            ExportCharacterCardJsonInput {
                character_id: imported.id.clone(),
                path: fixture_path_string(&export_path),
            },
        ))
        .expect("export_character_card_json should succeed");
        assert_eq!(PathBuf::from(&export_response.path), export_path);

        let exported_json =
            std::fs::read_to_string(&export_path).expect("exported json should exist");
        let exported_value: Value =
            serde_json::from_str(&exported_json).expect("exported json should parse");
        let exported_data = exported_value
            .get("data")
            .and_then(Value::as_object)
            .expect("exported data should exist");
        assert_eq!(
            exported_data.get("name").and_then(Value::as_str),
            Some("Nia")
        );
        assert_eq!(
            exported_data.get("personality").and_then(Value::as_str),
            Some("Warm and methodical with {{user}}.")
        );
        let exported_extensions = exported_data
            .get("extensions")
            .and_then(Value::as_object)
            .expect("extensions should exist");
        assert!(exported_extensions.contains_key("glee"));

        let portrait_png = BASE64_STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4R8AAAAASUVORK5CYII=")
            .expect("portrait fixture should decode");
        let portrait_path = harness.write_fixture("cards/nia-portrait.png", &portrait_png);
        let png_character = block_on(create_character_command(
            harness.state(),
            CreateCharacterInput {
                name: "Nia PNG".to_string(),
                description: Some("Launch operations analyst".to_string()),
                personality: Some("Warm and methodical".to_string()),
                backstory: Some("Former flight controller".to_string()),
                scenario: Some("you meet Nia in the launch bay".to_string()),
                system_prompt: Some("Stay in character.".to_string()),
                post_history_instructions: Some("Write Nia's next reply only.".to_string()),
                speech_style: Some("Measured and precise".to_string()),
                greeting: Some("Nia: Ready for review?".to_string()),
                alternate_greetings_json: None,
                alternate_greetings: Some(vec!["Nia: You made it.".to_string()]),
                avatar: Some(fixture_path_string(&portrait_path)),
                tags_json: None,
                tags: Some(vec!["ops".to_string()]),
                likes_json: None,
                likes: Some(vec!["clarity".to_string()]),
                dislikes_json: None,
                dislikes: Some(vec!["chaos".to_string()]),
                boundaries: Some("Avoid gore.".to_string()),
                creator_notes: Some("Internal note".to_string()),
                creator: Some("Glee".to_string()),
                character_version: Some("1.2".to_string()),
                card_extensions_json: Some("{\"risu\":{\"foo\":1}}".to_string()),
                example_dialogue: Some("User: Status?\nNia: Green.".to_string()),
            },
        ))
        .expect("png export character should create");

        let png_export_path = harness.root_dir.join("exports").join("nia-export.png");
        let png_export_response = block_on(export_character_card_png_command(
            harness.state(),
            ExportCharacterCardPngInput {
                character_id: png_character.id.clone(),
                path: fixture_path_string(&png_export_path),
            },
        ))
        .expect("export_character_card_png should succeed");
        assert_eq!(PathBuf::from(&png_export_response.path), png_export_path);

        let reimported_png = block_on(import_character_card_command(
            harness.state(),
            ImportCharacterCardInput {
                path: fixture_path_string(&png_export_path),
            },
        ))
        .expect("reimported png card should succeed");
        assert_eq!(reimported_png.name, "Nia PNG");
        assert_eq!(reimported_png.personality, "Warm and methodical");
        assert_eq!(reimported_png.creator, "Glee");

        let second_character = block_on(create_character_command(
            harness.state(),
            CreateCharacterInput {
                name: "Marek".to_string(),
                description: Some("Release pilot".to_string()),
                personality: None,
                backstory: None,
                scenario: None,
                system_prompt: None,
                post_history_instructions: None,
                speech_style: None,
                greeting: None,
                alternate_greetings_json: None,
                alternate_greetings: None,
                avatar: None,
                tags_json: None,
                tags: Some(vec!["pilot".to_string()]),
                likes_json: None,
                likes: None,
                dislikes_json: None,
                dislikes: None,
                boundaries: None,
                creator_notes: None,
                creator: None,
                character_version: None,
                card_extensions_json: None,
                example_dialogue: None,
            },
        ))
        .expect("second character should succeed");

        let group_chat = block_on(create_group_chat_command(
            harness.state(),
            CreateGroupChatInput {
                title: Some("Launch War Room".to_string()),
                character_ids: vec![imported.id.clone(), second_character.id.clone()],
            },
        ))
        .expect("create_group_chat should succeed");
        assert_eq!(group_chat.title, "Launch War Room");
        assert_eq!(group_chat.chat_mode, "group");
        assert_eq!(group_chat.participant_ids.len(), 2);

        let participants = block_on(list_chat_participants_command(
            harness.state(),
            group_chat.id.clone(),
        ))
        .expect("group participants should list");
        assert_eq!(participants.len(), 2);
        assert_eq!(participants[0].id, imported.id);
        assert_eq!(participants[1].id, second_character.id);

        let updated_group_chat = block_on(update_group_chat_command(
            harness.state(),
            UpdateGroupChatInput {
                chat_id: group_chat.id.clone(),
                title: Some("Launch Core Team".to_string()),
                character_ids: vec![second_character.id.clone(), imported.id.clone()],
            },
        ))
        .expect("update_group_chat should succeed");
        assert_eq!(updated_group_chat.title, "Launch Core Team");
        assert_eq!(
            updated_group_chat.participant_ids,
            vec![second_character.id.clone(), imported.id.clone()]
        );

        let chats_for_imported = block_on(list_chats_command(
            harness.state(),
            Some(imported.id.clone()),
        ))
        .expect("group chat should appear in imported character listing");
        assert!(chats_for_imported
            .iter()
            .any(|chat| chat.id == group_chat.id));
    }
}
