//! First-run AI resources.
//!
//! Glee ships without model weights or inference binaries. The bundled
//! `resources/manifest.json` (compiled into the app) pins every file the app
//! needs: the chat model, the embedding model, and the llama.cpp runtime
//! archive for each supported platform. On first launch the missing files are
//! downloaded into the app data directory, verified by SHA-256, extracted when
//! they are archives, and recorded in `installed.json`. Later launches only
//! compare that record with cheap file metadata, so a 1+ GB model is hashed
//! once, not on every start.
//!
//! Each file is fetched from the configured mirrors first (for example a
//! Cloudflare R2 bucket laid out as `<mirror>/<sha256>/<file name>`) and then
//! from its upstream URL. Integrity never depends on the source: every byte is
//! checked against the pinned hash before it is used.

use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use reqwest::{header, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::{
    errors::{AppError, AppResult},
    types::{
        FirstRunPreparationResponse, FirstRunPreparationStatus, ResourceItemStatus,
        ResourceStatusResponse, RuntimeBackend,
    },
};

const BUNDLED_MANIFEST: &str = include_str!("../resources/manifest.json");
const MANIFEST_OVERRIDE_ENV: &str = "GLEE_RESOURCE_MANIFEST";
const RESOURCES_DIR_OVERRIDE_ENV: &str = "GLEE_RESOURCES_DIR";
const SUPPORTED_SCHEMA_VERSION: u32 = 1;
const INSTALLED_RECORD_FILE: &str = "installed.json";
const PROGRESS_EVENT: &str = "provisioning-progress";
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(200);
const DISK_HEADROOM_BYTES: u64 = 512 * 1024 * 1024;
/// Consecutive failed attempts per URL before moving to the next source. An
/// attempt that made progress resets the counter, so slow but working
/// connections are never abandoned.
const MAX_STALLED_ATTEMPTS: u32 = 4;
const STALE_PART_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
static ACTIVE_JOB: Mutex<Option<ActiveJob>> = Mutex::new(None);

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub mirrors: Vec<String>,
    pub models: Vec<ModelAsset>,
    pub runtimes: Vec<RuntimeAsset>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSource {
    pub file_name: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    Chat,
    Embedding,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelAsset {
    pub id: String,
    pub role: ModelRole,
    pub display_name: String,
    /// Platforms this file is meant for. Empty means "every platform without a
    /// more specific entry", which lets a platform use a different packing of
    /// the same model when its engine needs one.
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(flatten)]
    pub source: DownloadSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum ArchiveKind {
    #[serde(rename = "zip")]
    Zip,
    #[serde(rename = "tar.gz")]
    TarGz,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAsset {
    pub id: String,
    pub platform: String,
    pub backend: RuntimeBackend,
    #[serde(default)]
    pub optional: bool,
    pub version: String,
    pub archive: ArchiveKind,
    /// Path of `llama-server` inside the extracted archive.
    pub entrypoint: String,
    #[serde(flatten)]
    pub source: DownloadSource,
}

impl ResourceManifest {
    pub fn parse(json: &str) -> AppResult<Self> {
        let manifest: Self = serde_json::from_str(json).map_err(|error| {
            AppError::Validation(format!("resource manifest is not valid JSON: {error}"))
        })?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> AppResult<()> {
        if self.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(AppError::Validation(format!(
                "resource manifest schema {} is not supported (expected {SUPPORTED_SCHEMA_VERSION})",
                self.schema_version
            )));
        }
        for mirror in &self.mirrors {
            parse_download_url(mirror)?;
        }
        let mut seen_ids = std::collections::HashSet::new();
        for model in &self.models {
            validate_id(&model.id)?;
            if !seen_ids.insert(format!("model/{}", model.id)) {
                return Err(AppError::Validation(format!(
                    "duplicate model id {}",
                    model.id
                )));
            }
            model.source.validate()?;
        }
        for role in [ModelRole::Chat, ModelRole::Embedding] {
            let defaults = self
                .models
                .iter()
                .filter(|model| model.role == role && model.platforms.is_empty())
                .count();
            if defaults != 1 {
                return Err(AppError::Validation(format!(
                    "resource manifest must define exactly one default {role:?} model"
                )));
            }
            let mut claimed = std::collections::HashSet::new();
            for platform in self
                .models
                .iter()
                .filter(|model| model.role == role)
                .flat_map(|model| model.platforms.iter())
            {
                if !claimed.insert(platform) {
                    return Err(AppError::Validation(format!(
                        "{platform} has more than one {role:?} model"
                    )));
                }
            }
        }
        for runtime in &self.runtimes {
            validate_id(&runtime.id)?;
            if !seen_ids.insert(format!("runtime/{}", runtime.id)) {
                return Err(AppError::Validation(format!(
                    "duplicate runtime id {}",
                    runtime.id
                )));
            }
            runtime.source.validate()?;
            validate_relative_path(&runtime.entrypoint)?;
        }
        Ok(())
    }

    /// The model file a platform should use for a role.
    pub fn model_for(&self, role: ModelRole, platform: &str) -> &ModelAsset {
        self.models
            .iter()
            .find(|model| model.role == role && model.platforms.iter().any(|p| p == platform))
            .or_else(|| {
                self.models
                    .iter()
                    .find(|model| model.role == role && model.platforms.is_empty())
            })
            .expect("validated manifest defines a default model for every role")
    }

    pub fn runtimes_for(&self, platform: &str) -> Vec<&RuntimeAsset> {
        self.runtimes
            .iter()
            .filter(|runtime| runtime.platform == platform)
            .collect()
    }
}

impl DownloadSource {
    fn validate(&self) -> AppResult<()> {
        validate_file_name(&self.file_name)?;
        if self.size_bytes == 0 {
            return Err(AppError::Validation(format!(
                "{} must declare a positive sizeBytes",
                self.file_name
            )));
        }
        normalize_sha256(&self.sha256).map_err(|_| {
            AppError::Validation(format!(
                "{} must declare a pinned 64-character sha256",
                self.file_name
            ))
        })?;
        parse_download_url(&self.url)?;
        Ok(())
    }

    fn sha256(&self) -> String {
        normalize_sha256(&self.sha256).expect("validated manifest hash")
    }
}

// ---------------------------------------------------------------------------
// Installed state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledRecord {
    #[serde(default)]
    assets: BTreeMap<String, InstalledAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledAsset {
    sha256: String,
    size_bytes: u64,
    /// Path relative to the resources root.
    path: String,
    installed_at: String,
    #[serde(default)]
    modified_unix_ms: Option<u64>,
}

/// A runtime archive that is downloaded, verified, and extracted.
#[derive(Debug, Clone)]
pub struct InstalledRuntime {
    pub asset: RuntimeAsset,
    pub entrypoint: PathBuf,
}

#[derive(Clone)]
pub struct Resources {
    root: PathBuf,
    manifest: Arc<ResourceManifest>,
    platform: String,
    record_lock: Arc<Mutex<()>>,
}

impl Resources {
    pub fn new(app_data_dir: &Path) -> AppResult<Self> {
        let manifest = match std::env::var(MANIFEST_OVERRIDE_ENV) {
            Ok(path) if !path.trim().is_empty() => {
                let text = fs::read_to_string(path.trim()).map_err(|error| {
                    AppError::Runtime(format!(
                        "{MANIFEST_OVERRIDE_ENV} could not be read: {error}"
                    ))
                })?;
                ResourceManifest::parse(&text)?
            }
            _ => ResourceManifest::parse(BUNDLED_MANIFEST)?,
        };
        let root = match std::env::var(RESOURCES_DIR_OVERRIDE_ENV) {
            Ok(path) if !path.trim().is_empty() => PathBuf::from(path.trim()),
            _ => app_data_dir.join("resources"),
        };
        Ok(Self::with_manifest(root, manifest, current_platform()))
    }

    pub fn with_manifest(root: PathBuf, manifest: ResourceManifest, platform: String) -> Self {
        Self {
            root,
            manifest: Arc::new(manifest),
            platform,
            record_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn platform(&self) -> &str {
        &self.platform
    }

    pub fn platform_supported(&self) -> bool {
        self.manifest
            .runtimes_for(&self.platform)
            .iter()
            .any(|runtime| !runtime.optional)
    }

    pub fn model_asset(&self, role: ModelRole) -> &ModelAsset {
        self.manifest.model_for(role, &self.platform)
    }

    /// Where a model lives once installed, whether or not it exists yet.
    pub fn model_path(&self, role: ModelRole) -> PathBuf {
        self.root.join("models").join(
            &self
                .manifest
                .model_for(role, &self.platform)
                .source
                .file_name,
        )
    }

    /// The model path if the file is installed and unchanged since it was verified.
    pub fn installed_model_path(&self, role: ModelRole) -> Option<PathBuf> {
        let asset = self.manifest.model_for(role, &self.platform);
        let record = self.read_record();
        let installed = record.assets.get(&model_key(asset))?;
        let path = self.model_path(role);
        model_record_matches(installed, asset, &path).then_some(path)
    }

    pub fn runtime_dir(&self, runtime: &RuntimeAsset) -> PathBuf {
        self.root.join("runtimes").join(&runtime.id)
    }

    /// Runtimes for this platform whose archive is extracted and verified.
    pub fn installed_runtimes(&self) -> Vec<InstalledRuntime> {
        let record = self.read_record();
        self.manifest
            .runtimes_for(&self.platform)
            .into_iter()
            .filter_map(|runtime| {
                let installed = record.assets.get(&runtime_key(runtime))?;
                if installed.sha256 != runtime.source.sha256() {
                    return None;
                }
                let entrypoint = self.runtime_dir(runtime).join(&runtime.entrypoint);
                entrypoint.is_file().then(|| InstalledRuntime {
                    asset: runtime.clone(),
                    entrypoint,
                })
            })
            .collect()
    }

    pub fn status(&self) -> ResourceStatusResponse {
        let record = self.read_record();
        let mut items = Vec::new();
        for role in [ModelRole::Chat, ModelRole::Embedding] {
            let asset = self.manifest.model_for(role, &self.platform);
            let installed = record
                .assets
                .get(&model_key(asset))
                .is_some_and(|installed| {
                    model_record_matches(installed, asset, &self.model_path(role))
                });
            items.push(ResourceItemStatus {
                key: model_key(asset),
                label: model_label(asset),
                size_bytes: asset.source.size_bytes,
                installed,
                optional: false,
            });
        }
        for runtime in self.manifest.runtimes_for(&self.platform) {
            let installed = record
                .assets
                .get(&runtime_key(runtime))
                .is_some_and(|installed| {
                    installed.sha256 == runtime.source.sha256()
                        && self
                            .runtime_dir(runtime)
                            .join(&runtime.entrypoint)
                            .is_file()
                });
            items.push(ResourceItemStatus {
                key: runtime_key(runtime),
                label: runtime_label(runtime),
                size_bytes: runtime.source.size_bytes,
                installed,
                optional: runtime.optional,
            });
        }
        let platform_supported = self.platform_supported();
        let missing_required_bytes = items
            .iter()
            .filter(|item| !item.installed && !item.optional)
            .map(|item| item.size_bytes)
            .sum();
        let ready = platform_supported && items.iter().all(|item| item.installed || item.optional);
        let partial_required_bytes = self
            .required_sources()
            .iter()
            .zip(items.iter())
            .filter(|(_, item)| !item.installed && !item.optional)
            .map(|(source, _)| self.partial_bytes(source))
            .sum();
        ResourceStatusResponse {
            ready,
            platform: self.platform.clone(),
            platform_supported,
            missing_required_bytes,
            partial_required_bytes,
            items,
        }
    }

    /// Download sources in the same order as the items `status` reports.
    fn required_sources(&self) -> Vec<&DownloadSource> {
        let mut sources = Vec::new();
        for role in [ModelRole::Chat, ModelRole::Embedding] {
            sources.push(&self.manifest.model_for(role, &self.platform).source);
        }
        for runtime in self.manifest.runtimes_for(&self.platform) {
            sources.push(&runtime.source);
        }
        sources
    }

    /// Size of the unfinished download for `source` left by an earlier session.
    fn partial_bytes(&self, source: &DownloadSource) -> u64 {
        let complete = format!("{}-{}", &source.sha256()[..16], source.file_name);
        fs::metadata(self.downloads_dir().join(format!("{complete}.part")))
            .map(|metadata| metadata.len().min(source.size_bytes))
            .unwrap_or(0)
    }

    fn record_path(&self) -> PathBuf {
        self.root.join(INSTALLED_RECORD_FILE)
    }

    fn read_record(&self) -> InstalledRecord {
        fs::read(self.record_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn update_record(&self, update: impl FnOnce(&mut InstalledRecord)) -> AppResult<()> {
        let _guard = self
            .record_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut record = self.read_record();
        update(&mut record);
        fs::create_dir_all(&self.root)?;
        let bytes = serde_json::to_vec_pretty(&record).map_err(|error| {
            AppError::Runtime(format!("failed to serialize resource record: {error}"))
        })?;
        let temp = self
            .root
            .join(format!("{INSTALLED_RECORD_FILE}.{}.tmp", Uuid::new_v4()));
        fs::write(&temp, bytes)?;
        replace_file(&temp, &self.record_path())?;
        Ok(())
    }
}

fn model_record_matches(installed: &InstalledAsset, asset: &ModelAsset, path: &Path) -> bool {
    if installed.sha256 != asset.source.sha256() {
        return false;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    metadata.is_file()
        && metadata.len() == asset.source.size_bytes
        && (installed.modified_unix_ms.is_none()
            || installed.modified_unix_ms == modified_unix_ms(&metadata))
}

fn model_key(asset: &ModelAsset) -> String {
    format!("model/{}", asset.id)
}

fn runtime_key(asset: &RuntimeAsset) -> String {
    format!("runtime/{}", asset.id)
}

fn model_label(asset: &ModelAsset) -> String {
    match asset.role {
        ModelRole::Chat => format!("AI model ({})", asset.display_name),
        ModelRole::Embedding => "Memory model".to_string(),
    }
}

fn runtime_label(asset: &RuntimeAsset) -> String {
    match asset.backend {
        RuntimeBackend::Vulkan => "Graphics acceleration".to_string(),
        RuntimeBackend::Cuda => "NVIDIA acceleration".to_string(),
        RuntimeBackend::Metal | RuntimeBackend::Cpu => "AI engine".to_string(),
    }
}

pub fn current_platform() -> String {
    let os = std::env::consts::OS;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

// ---------------------------------------------------------------------------
// Preparation job
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ActiveJob {
    id: String,
    cancelled: Arc<AtomicBool>,
}

struct ActiveJobGuard {
    id: String,
}

impl Drop for ActiveJobGuard {
    fn drop(&mut self) {
        let mut active = ACTIVE_JOB.lock().unwrap_or_else(|error| error.into_inner());
        if active.as_ref().map(|job| job.id.as_str()) == Some(self.id.as_str()) {
            *active = None;
        }
    }
}

fn begin_job() -> AppResult<(ActiveJob, ActiveJobGuard)> {
    let mut active = ACTIVE_JOB.lock().unwrap_or_else(|error| error.into_inner());
    if active.is_some() {
        return Err(AppError::Conflict(
            "Glee is already preparing its AI resources.".to_string(),
        ));
    }
    let job = ActiveJob {
        id: Uuid::new_v4().to_string(),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    *active = Some(job.clone());
    let guard = ActiveJobGuard { id: job.id.clone() };
    Ok((job, guard))
}

/// Requests cancellation. `job_id` keeps a stale UI from cancelling a newer job.
pub fn cancel_active_job(job_id: Option<&str>) -> bool {
    let active = ACTIVE_JOB.lock().unwrap_or_else(|error| error.into_inner());
    let Some(active) = active.as_ref() else {
        return false;
    };
    if job_id.is_some_and(|expected| expected != active.id) {
        return false;
    }
    active.cancelled.store(true, Ordering::Release);
    true
}

pub fn active_job_id() -> Option<String> {
    ACTIVE_JOB
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|job| job.id.clone())
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProvisioningPhase {
    Planning,
    CheckingDisk,
    Downloading,
    Verifying,
    Installing,
    Ready,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisioningProgress {
    pub job_id: String,
    pub phase: ProvisioningPhase,
    pub current_file: Option<String>,
    pub file_bytes: u64,
    pub file_total_bytes: Option<u64>,
    pub aggregate_bytes: u64,
    pub aggregate_total_bytes: Option<u64>,
    pub completed_objects: usize,
    pub total_objects: usize,
    pub retry_count: u32,
    pub message: Option<String>,
}

/// Receives progress. The app forwards it to the WebView; tests record it.
pub trait ProgressSink: Send + Sync {
    fn emit(&self, progress: ProvisioningProgress);
}

pub struct AppProgressSink<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> ProgressSink for AppProgressSink<R> {
    fn emit(&self, progress: ProvisioningProgress) {
        let _ = self.0.emit(PROGRESS_EVENT, progress);
    }
}

enum WorkItem<'a> {
    Model(&'a ModelAsset),
    Runtime(&'a RuntimeAsset),
}

impl WorkItem<'_> {
    fn source(&self) -> &DownloadSource {
        match self {
            WorkItem::Model(asset) => &asset.source,
            WorkItem::Runtime(asset) => &asset.source,
        }
    }

    fn label(&self) -> String {
        match self {
            WorkItem::Model(asset) => model_label(asset),
            WorkItem::Runtime(asset) => runtime_label(asset),
        }
    }
}

struct Job<'a> {
    job: ActiveJob,
    sink: &'a dyn ProgressSink,
    total_objects: usize,
    aggregate_total: u64,
    completed_bytes: u64,
    completed_objects: usize,
}

impl Job<'_> {
    fn event(&self, phase: ProvisioningPhase) -> ProvisioningProgress {
        ProvisioningProgress {
            job_id: self.job.id.clone(),
            phase,
            current_file: None,
            file_bytes: 0,
            file_total_bytes: None,
            aggregate_bytes: self.completed_bytes,
            aggregate_total_bytes: Some(self.aggregate_total),
            completed_objects: self.completed_objects,
            total_objects: self.total_objects,
            retry_count: 0,
            message: None,
        }
    }

    fn emit(&self, event: ProvisioningProgress) {
        self.sink.emit(event);
    }

    fn ensure_not_cancelled(&self) -> AppResult<()> {
        if self.job.cancelled.load(Ordering::Acquire) {
            return Err(AppError::Download("Setup was cancelled.".to_string()));
        }
        Ok(())
    }
}

impl Resources {
    /// Downloads and installs every missing required resource for this
    /// platform, then the optional ones. Optional failures are reported in the
    /// response message but never fail setup.
    pub async fn prepare(&self, sink: &dyn ProgressSink) -> AppResult<FirstRunPreparationResponse> {
        if !self.platform_supported() {
            return Err(AppError::Download(format!(
                "Glee doesn't support this computer yet ({}).",
                self.platform
            )));
        }
        let (active, _guard) = begin_job()?;
        let record = self.read_record();

        let mut required = Vec::new();
        let mut optional = Vec::new();
        let mut reused = 0_usize;
        for runtime in self.manifest.runtimes_for(&self.platform) {
            let installed = record
                .assets
                .get(&runtime_key(runtime))
                .is_some_and(|installed| installed.sha256 == runtime.source.sha256())
                && self
                    .runtime_dir(runtime)
                    .join(&runtime.entrypoint)
                    .is_file();
            if installed {
                reused += 1;
            } else if runtime.optional {
                optional.push(WorkItem::Runtime(runtime));
            } else {
                required.push(WorkItem::Runtime(runtime));
            }
        }
        for role in [ModelRole::Chat, ModelRole::Embedding] {
            let asset = self.manifest.model_for(role, &self.platform);
            let path = self.model_path(role);
            let fast_match = record
                .assets
                .get(&model_key(asset))
                .is_some_and(|installed| model_record_matches(installed, asset, &path));
            if fast_match {
                reused += 1;
            } else {
                required.push(WorkItem::Model(asset));
            }
        }

        let work = required.iter().chain(optional.iter()).collect::<Vec<_>>();
        let mut job = Job {
            job: active,
            sink,
            total_objects: work.len(),
            aggregate_total: work.iter().map(|item| item.source().size_bytes).sum(),
            completed_bytes: 0,
            completed_objects: 0,
        };
        job.emit(job.event(ProvisioningPhase::Planning));

        let result = self.run_work(&mut job, &required, &optional).await;
        match result {
            Ok(optional_failures) => {
                self.cleanup_stale_files();
                let mut ready = job.event(ProvisioningPhase::Ready);
                ready.aggregate_bytes = job.aggregate_total;
                job.emit(ready);
                let downloaded = job.completed_objects;
                let mut message = if downloaded == 0 {
                    "Glee's AI resources are ready.".to_string()
                } else {
                    format!("Downloaded and verified {downloaded} AI resource file(s).")
                };
                if !optional_failures.is_empty() {
                    message.push_str(&format!(
                        " Optional components were skipped: {}.",
                        optional_failures.join("; ")
                    ));
                }
                Ok(FirstRunPreparationResponse {
                    status: FirstRunPreparationStatus::Ready,
                    resource_dir: self.root.to_string_lossy().to_string(),
                    downloaded_assets: downloaded,
                    reused_assets: reused,
                    total_assets: reused + work.len(),
                    message,
                })
            }
            Err(error) => {
                let cancelled = job.job.cancelled.load(Ordering::Acquire);
                let mut event = job.event(if cancelled {
                    ProvisioningPhase::Cancelled
                } else {
                    ProvisioningPhase::Failed
                });
                event.message = Some(error.to_string());
                job.emit(event);
                Err(error)
            }
        }
    }

    async fn run_work(
        &self,
        job: &mut Job<'_>,
        required: &[WorkItem<'_>],
        optional: &[WorkItem<'_>],
    ) -> AppResult<Vec<String>> {
        job.ensure_not_cancelled()?;
        job.emit(job.event(ProvisioningPhase::CheckingDisk));
        self.preflight_disk_space(required)?;

        let client = shared_http_client()?;
        for item in required {
            self.install_item(job, &client, item).await?;
        }
        let mut optional_failures = Vec::new();
        for item in optional {
            if let Err(error) = self.install_item(job, &client, item).await {
                job.ensure_not_cancelled()?;
                eprintln!("optional resource {} failed: {error}", item.label());
                optional_failures.push(item.label());
                job.aggregate_total = job.aggregate_total.saturating_sub(item.source().size_bytes);
            }
        }
        Ok(optional_failures)
    }

    async fn install_item(
        &self,
        job: &mut Job<'_>,
        client: &Client,
        item: &WorkItem<'_>,
    ) -> AppResult<()> {
        job.ensure_not_cancelled()?;
        let source = item.source();
        let label = item.label();
        match item {
            WorkItem::Model(asset) => {
                let destination = self.model_path(asset.role);
                // A file from an earlier version of the record (or a manual copy)
                // is reused when its hash still matches.
                let reuse = destination.is_file()
                    && fs::metadata(&destination)
                        .map(|metadata| metadata.len() == source.size_bytes)
                        .unwrap_or(false)
                    && {
                        let mut event = job.event(ProvisioningPhase::Verifying);
                        event.current_file = Some(label.clone());
                        job.emit(event);
                        hash_file_async(destination.clone()).await? == source.sha256()
                    };
                if !reuse {
                    let downloaded = self.download_verified(job, client, source, &label).await?;
                    fs::create_dir_all(destination.parent().expect("models dir"))?;
                    replace_file(&downloaded, &destination)?;
                }
                let modified = fs::metadata(&destination)
                    .ok()
                    .and_then(|metadata| modified_unix_ms(&metadata));
                let relative = relative_to(&self.root, &destination);
                let key = model_key(asset);
                let sha256 = source.sha256();
                let size_bytes = source.size_bytes;
                self.update_record(move |record| {
                    record.assets.insert(
                        key,
                        InstalledAsset {
                            sha256,
                            size_bytes,
                            path: relative,
                            installed_at: chrono::Utc::now().to_rfc3339(),
                            modified_unix_ms: modified,
                        },
                    );
                })?;
            }
            WorkItem::Runtime(asset) => {
                let archive = self.download_verified(job, client, source, &label).await?;
                let mut event = job.event(ProvisioningPhase::Installing);
                event.current_file = Some(label.clone());
                job.emit(event);
                let target = self.runtime_dir(asset);
                let runtime = (*asset).clone();
                let archive_for_task = archive.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    install_runtime_archive(&archive_for_task, &target, &runtime)
                })
                .await
                .map_err(|error| AppError::TaskJoin(error.to_string()))??;
                let _ = fs::remove_file(&archive);
                let relative = relative_to(&self.root, &self.runtime_dir(asset));
                let key = runtime_key(asset);
                let sha256 = source.sha256();
                let size_bytes = source.size_bytes;
                self.update_record(move |record| {
                    record.assets.insert(
                        key,
                        InstalledAsset {
                            sha256,
                            size_bytes,
                            path: relative,
                            installed_at: chrono::Utc::now().to_rfc3339(),
                            modified_unix_ms: None,
                        },
                    );
                })?;
            }
        }
        job.completed_bytes = job.completed_bytes.saturating_add(source.size_bytes);
        job.completed_objects += 1;
        Ok(())
    }

    fn downloads_dir(&self) -> PathBuf {
        self.root.join("downloads")
    }

    fn candidate_urls(&self, source: &DownloadSource) -> Vec<Url> {
        candidate_urls(&self.manifest.mirrors, source)
    }

    /// Downloads `source` into the downloads directory and returns the path of
    /// a complete file whose size and SHA-256 match the manifest.
    async fn download_verified(
        &self,
        job: &Job<'_>,
        client: &Client,
        source: &DownloadSource,
        label: &str,
    ) -> AppResult<PathBuf> {
        let downloads = self.downloads_dir();
        tokio::fs::create_dir_all(&downloads).await?;
        let expected = source.sha256();
        let complete = downloads.join(format!("{}-{}", &expected[..16], source.file_name));
        let part = complete.with_file_name(format!(
            "{}.part",
            complete
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("download")
        ));
        if complete.is_file()
            && fs::metadata(&complete).map(|m| m.len()).unwrap_or(0) == source.size_bytes
            && hash_file_async(complete.clone()).await? == expected
        {
            return Ok(complete);
        }

        let mut errors = Vec::new();
        for url in self.candidate_urls(source) {
            match self
                .download_from(job, client, &url, &part, source, label)
                .await
            {
                Ok(actual) if actual == expected => {
                    replace_file(&part, &complete)?;
                    return Ok(complete);
                }
                Ok(actual) => {
                    let _ = fs::remove_file(&part);
                    errors.push(format!(
                        "{}: content did not match the pinned checksum (got {actual})",
                        url.host_str().unwrap_or("source")
                    ));
                }
                Err(failure) => {
                    job.ensure_not_cancelled()?;
                    errors.push(format!(
                        "{}: {}",
                        url.host_str().unwrap_or("source"),
                        failure.message
                    ));
                }
            }
        }
        Err(AppError::Download(format!(
            "Glee couldn't download a file it needs ({}). Check your internet connection and try again. Details: {}",
            label,
            errors.join(" | ")
        )))
    }

    /// Fetches one URL with resume support. Returns the SHA-256 of the
    /// complete `.part` file.
    async fn download_from(
        &self,
        job: &Job<'_>,
        client: &Client,
        url: &Url,
        part: &Path,
        source: &DownloadSource,
        label: &str,
    ) -> Result<String, DownloadFailure> {
        let mut stalled_attempts = 0;
        let mut retry_count = 0;
        loop {
            if job.job.cancelled.load(Ordering::Acquire) {
                return Err(DownloadFailure::fatal("cancelled"));
            }
            let before = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
            match download_attempt(job, client, url, part, source, label, retry_count).await {
                Ok(hash) => return Ok(hash),
                Err(failure) if failure.retryable => {
                    let after = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
                    if after > before {
                        stalled_attempts = 0;
                    } else {
                        stalled_attempts += 1;
                    }
                    if stalled_attempts >= MAX_STALLED_ATTEMPTS {
                        return Err(failure);
                    }
                    retry_count += 1;
                    let delay = Duration::from_millis(750 * (1_u64 << stalled_attempts.min(4)));
                    cancellable_sleep(&job.job, delay).await?;
                }
                Err(failure) => return Err(failure),
            }
        }
    }

    fn preflight_disk_space(&self, required: &[WorkItem<'_>]) -> AppResult<()> {
        // Archives need room for the download and the extracted files.
        let needed = required
            .iter()
            .map(|item| match item {
                WorkItem::Model(asset) => asset.source.size_bytes,
                WorkItem::Runtime(asset) => asset.source.size_bytes.saturating_mul(4),
            })
            .fold(DISK_HEADROOM_BYTES, u64::saturating_add);
        fs::create_dir_all(&self.root)?;
        if let Some(available) = available_space_for(&self.root) {
            if available < needed {
                return Err(AppError::Download(format!(
                    "Glee needs about {} of free disk space to finish setup, but only {} is available. Free up some space and try again.",
                    format_bytes(needed),
                    format_bytes(available)
                )));
            }
        }
        Ok(())
    }

    /// Removes files that no longer belong to the current manifest: old model
    /// versions, superseded runtimes, and abandoned partial downloads.
    fn cleanup_stale_files(&self) {
        let mut wanted = std::collections::HashSet::new();
        for role in [ModelRole::Chat, ModelRole::Embedding] {
            wanted.insert(model_key(self.manifest.model_for(role, &self.platform)));
        }
        for runtime in &self.manifest.runtimes {
            wanted.insert(runtime_key(runtime));
        }
        let mut stale = Vec::new();
        let _ = self.update_record(|record| {
            record.assets.retain(|key, asset| {
                let keep = wanted.contains(key);
                if !keep {
                    stale.push(asset.path.clone());
                }
                keep
            });
        });
        for relative in stale {
            if validate_relative_path(&relative).is_err() {
                continue;
            }
            let path = self.root.join(&relative);
            if path.is_dir() {
                let _ = fs::remove_dir_all(&path);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
        if let Ok(entries) = fs::read_dir(self.downloads_dir()) {
            let now = SystemTime::now();
            for entry in entries.flatten() {
                let is_old = entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age > STALE_PART_MAX_AGE);
                if is_old {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

fn candidate_urls(mirrors: &[String], source: &DownloadSource) -> Vec<Url> {
    let mut urls = Vec::new();
    let sha256 = source.sha256();
    for mirror in mirrors {
        let mut base = mirror.trim().to_string();
        if !base.ends_with('/') {
            base.push('/');
        }
        if let Ok(url) = parse_download_url(&base).and_then(|base| {
            base.join(&format!("{sha256}/{}", source.file_name))
                .map_err(|error| AppError::Validation(error.to_string()))
        }) {
            urls.push(url);
        }
    }
    if let Ok(url) = parse_download_url(&source.url) {
        urls.push(url);
    }
    urls
}

// ---------------------------------------------------------------------------
// HTTP download
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct DownloadFailure {
    message: String,
    retryable: bool,
}

impl DownloadFailure {
    fn fatal(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn retry(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

fn shared_http_client() -> AppResult<Client> {
    HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(20))
                // No total timeout: a slow connection may need an hour for the
                // model. A stalled transfer is caught by the read timeout and
                // resumed with a Range request.
                .read_timeout(Duration::from_secs(45))
                .user_agent(format!("Glee/{}", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|error| error.to_string())
        })
        .clone()
        .map_err(|error| AppError::Runtime(format!("failed to build download client: {error}")))
}

async fn download_attempt(
    job: &Job<'_>,
    client: &Client,
    url: &Url,
    part: &Path,
    source: &DownloadSource,
    label: &str,
    retry_count: u32,
) -> Result<String, DownloadFailure> {
    let expected_size = source.size_bytes;
    let mut offset = tokio::fs::metadata(part)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if offset > expected_size {
        let _ = tokio::fs::remove_file(part).await;
        offset = 0;
    }
    if offset == expected_size {
        // A previous attempt finished the transfer but was interrupted before
        // the rename. Hash what is there.
        return hash_file_async(part.to_path_buf())
            .await
            .map_err(|error| DownloadFailure::retry(error.to_string()));
    }

    let mut request = client.get(url.clone());
    if offset > 0 {
        request = request.header(header::RANGE, format!("bytes={offset}-"));
    }
    let mut response = request.send().await.map_err(classify_request_error)?;
    let status = response.status();
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = tokio::fs::remove_file(part).await;
        return Err(DownloadFailure::retry("server rejected the resume range"));
    }
    if !status.is_success() {
        let message = format!("server returned HTTP {}", status.as_u16());
        return Err(if is_retryable_status(status) {
            DownloadFailure::retry(message)
        } else {
            DownloadFailure::fatal(message)
        });
    }
    let resumed = offset > 0 && status == StatusCode::PARTIAL_CONTENT;
    if resumed && !valid_content_range(response.headers(), offset, expected_size) {
        let _ = tokio::fs::remove_file(part).await;
        return Err(DownloadFailure::retry(
            "server returned an invalid Content-Range",
        ));
    }
    if !resumed {
        offset = 0; // Range was ignored; this body is the whole file.
    }
    if let Some(length) = response.content_length() {
        if length != expected_size - offset {
            return Err(DownloadFailure::fatal(format!(
                "server reported {length} bytes but {} were expected",
                expected_size - offset
            )));
        }
    }

    let mut hasher = Sha256::new();
    if resumed {
        let existing = part.to_path_buf();
        hasher = tauri::async_runtime::spawn_blocking(move || -> io::Result<Sha256> {
            let mut hasher = Sha256::new();
            let mut file = File::open(existing)?;
            let mut buffer = vec![0_u8; 1024 * 1024];
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            Ok(hasher)
        })
        .await
        .map_err(|error| DownloadFailure::retry(error.to_string()))?
        .map_err(|error| DownloadFailure::retry(error.to_string()))?;
    }

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if resumed {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(part)
        .await
        .map_err(|error| DownloadFailure::fatal(error.to_string()))?;
    let mut received = offset;
    if resumed {
        // Show the bytes kept from before right away, so a resumed download
        // continues from where it stopped instead of appearing to start over.
        let mut event = job.event(ProvisioningPhase::Downloading);
        event.current_file = Some(label.to_string());
        event.file_bytes = offset;
        event.file_total_bytes = Some(expected_size);
        event.aggregate_bytes = job.completed_bytes.saturating_add(offset);
        event.retry_count = retry_count;
        job.emit(event);
    }
    let mut last_emit = Instant::now() - PROGRESS_EVENT_INTERVAL;
    while let Some(chunk) = response.chunk().await.map_err(classify_request_error)? {
        if job.job.cancelled.load(Ordering::Acquire) {
            let _ = file.flush().await;
            return Err(DownloadFailure::fatal("cancelled"));
        }
        received = received.saturating_add(chunk.len() as u64);
        if received > expected_size {
            drop(file);
            let _ = tokio::fs::remove_file(part).await;
            return Err(DownloadFailure::fatal("download was larger than expected"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| DownloadFailure::fatal(error.to_string()))?;
        if last_emit.elapsed() >= PROGRESS_EVENT_INTERVAL || received == expected_size {
            last_emit = Instant::now();
            let mut event = job.event(ProvisioningPhase::Downloading);
            event.current_file = Some(label.to_string());
            event.file_bytes = received;
            event.file_total_bytes = Some(expected_size);
            event.aggregate_bytes = job.completed_bytes.saturating_add(received);
            event.retry_count = retry_count;
            job.emit(event);
        }
    }
    file.flush()
        .await
        .map_err(|error| DownloadFailure::retry(error.to_string()))?;
    file.sync_all()
        .await
        .map_err(|error| DownloadFailure::retry(error.to_string()))?;
    if received != expected_size {
        return Err(DownloadFailure::retry(format!(
            "connection closed after {} of {}",
            format_bytes(received),
            format_bytes(expected_size)
        )));
    }
    Ok(hex(&hasher.finalize()))
}

fn classify_request_error(error: reqwest::Error) -> DownloadFailure {
    // A connection that drops mid-transfer surfaces as a body or decode error;
    // both are resumable.
    let retryable = error.is_timeout()
        || error.is_connect()
        || error.is_body()
        || error.is_decode()
        || error.is_request();
    let message = if error.is_connect() {
        "could not connect".to_string()
    } else if error.is_timeout() {
        "the connection timed out".to_string()
    } else {
        error.to_string()
    };
    DownloadFailure { message, retryable }
}

fn is_retryable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

fn valid_content_range(headers: &header::HeaderMap, offset: u64, expected_size: u64) -> bool {
    let Some(value) = headers
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(rest) = value.strip_prefix("bytes ") else {
        return false;
    };
    let Some((range, total)) = rest.split_once('/') else {
        return false;
    };
    let Some((start, _end)) = range.split_once('-') else {
        return false;
    };
    start.trim().parse::<u64>().ok() == Some(offset)
        && (total.trim() == "*" || total.trim().parse::<u64>().ok() == Some(expected_size))
}

async fn cancellable_sleep(job: &ActiveJob, delay: Duration) -> Result<(), DownloadFailure> {
    let deadline = Instant::now() + delay;
    while Instant::now() < deadline {
        if job.cancelled.load(Ordering::Acquire) {
            return Err(DownloadFailure::fatal("cancelled"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Archive installation
// ---------------------------------------------------------------------------

fn install_runtime_archive(archive: &Path, target: &Path, runtime: &RuntimeAsset) -> AppResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::Path("runtime directory has no parent".to_string()))?;
    fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".staging-{}-{}", runtime.id, Uuid::new_v4()));
    fs::create_dir_all(&staging)?;
    let result = (|| -> AppResult<()> {
        match runtime.archive {
            ArchiveKind::Zip => extract_zip(archive, &staging)?,
            ArchiveKind::TarGz => extract_tar_gz(archive, &staging)?,
        }
        let entrypoint = staging.join(&runtime.entrypoint);
        if !entrypoint.is_file() {
            return Err(AppError::Download(format!(
                "the downloaded AI engine is missing {}",
                runtime.entrypoint
            )));
        }
        make_executable(&entrypoint)?;
        prepare_macos_binaries(&staging, &entrypoint);
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if target.exists() {
        fs::remove_dir_all(target)?;
    }
    fs::rename(&staging, target)?;
    Ok(())
}

fn extract_zip(archive: &Path, destination: &Path) -> AppResult<()> {
    let file = File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|error| {
        AppError::Download(format!(
            "the downloaded AI engine archive is damaged: {error}"
        ))
    })?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| {
            AppError::Download(format!(
                "the downloaded AI engine archive is damaged: {error}"
            ))
        })?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(AppError::Download(format!(
                "the AI engine archive contains an unsafe path: {:?}",
                entry.name()
            )));
        };
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&output)?;
        io::copy(&mut entry, &mut out)?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777))?;
        }
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, destination: &Path) -> AppResult<()> {
    let file = File::open(archive)?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        if path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(AppError::Download(format!(
                "the AI engine archive contains an unsafe path: {}",
                path.display()
            )));
        }
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            // Links must stay inside the archive (llama.cpp ships versioned
            // shared-library symlinks such as libllama.dylib -> libllama.0.dylib).
            let target = entry.link_name()?.ok_or_else(|| {
                AppError::Download("the AI engine archive has an empty link".to_string())
            })?;
            let resolved = path.parent().unwrap_or_else(|| Path::new("")).join(&target);
            if target.is_absolute() || !stays_within(&resolved) {
                return Err(AppError::Download(format!(
                    "the AI engine archive has a link that leaves its folder: {}",
                    path.display()
                )));
            }
        }
        // unpack_in re-checks that every written path stays under destination.
        if !entry.unpack_in(destination)? {
            return Err(AppError::Download(format!(
                "the AI engine archive contains an unsafe path: {}",
                path.display()
            )));
        }
    }
    Ok(())
}

/// True when a relative path never climbs above its starting directory.
fn stays_within(path: &Path) -> bool {
    let mut depth = 0_i32;
    for component in path.components() {
        match component {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    true
}

#[cfg(unix)]
fn make_executable(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> AppResult<()> {
    Ok(())
}

/// Downloads made by the app are not quarantined, but clear the attribute
/// defensively and repair a broken signature with an ad-hoc one so Apple
/// Silicon will load the binaries.
#[cfg(target_os = "macos")]
fn prepare_macos_binaries(root: &Path, entrypoint: &Path) {
    use std::process::Command;
    let _ = Command::new("xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(root)
        .output();
    let signature_ok = Command::new("codesign")
        .arg("--verify")
        .arg(entrypoint)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(true);
    if signature_ok {
        return;
    }
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if name.ends_with(".dylib") || path == entrypoint {
                    let _ = Command::new("codesign")
                        .args(["--force", "--sign", "-"])
                        .arg(&path)
                        .output();
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn prepare_macos_binaries(_root: &Path, _entrypoint: &Path) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_download_url(value: &str) -> AppResult<Url> {
    let url = Url::parse(value.trim())
        .map_err(|error| AppError::Validation(format!("invalid download URL {value}: {error}")))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    // Plain HTTP is only accepted for local test servers.
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(AppError::Validation(format!(
            "download URLs must use https: {value}"
        )));
    }
    if url
        .host_str()
        .is_none_or(|host| host.ends_with(".invalid") || host.ends_with(".example"))
    {
        return Err(AppError::Validation(format!(
            "download URL uses a placeholder host: {value}"
        )));
    }
    Ok(url)
}

fn validate_id(value: &str) -> AppResult<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || value.starts_with('.')
    {
        return Err(AppError::Validation(format!(
            "resource id {value:?} must use letters, digits, '.', '-' or '_'"
        )));
    }
    Ok(())
}

fn validate_file_name(value: &str) -> AppResult<()> {
    validate_id(value)
        .map_err(|_| AppError::Validation(format!("resource file name {value:?} is not safe")))
}

fn validate_relative_path(value: &str) -> AppResult<PathBuf> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('\\') {
        return Err(AppError::Validation(format!(
            "resource path {value:?} must be a non-empty forward-slash path"
        )));
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::Validation(format!(
            "resource path {value:?} must stay relative"
        )));
    }
    Ok(path)
}

fn normalize_sha256(value: &str) -> AppResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64
        || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
        || normalized.bytes().all(|byte| byte == b'0')
    {
        return Err(AppError::Validation(
            "SHA-256 must be a pinned 64-character hex string".to_string(),
        ));
    }
    Ok(normalized)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

async fn hash_file_async(path: PathBuf) -> AppResult<String> {
    tauri::async_runtime::spawn_blocking(move || hash_file(&path))
        .await
        .map_err(|error| AppError::TaskJoin(error.to_string()))?
        .map_err(AppError::from)
}

fn modified_unix_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// Atomically replaces `destination` with `source` (same volume).
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(_) if destination.exists() => {
            // Windows refuses to rename over an existing file.
            fs::remove_file(destination)?;
            fs::rename(source, destination)
        }
        Err(error) => Err(error),
    }
}

fn available_space_for(path: &Path) -> Option<u64> {
    let existing = path
        .ancestors()
        .find(|candidate| candidate.exists())
        .unwrap_or(path);
    let canonical = existing
        .canonicalize()
        .unwrap_or_else(|_| existing.to_path_buf());
    Disks::new_with_refreshed_list()
        .list()
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(|disk| disk.available_space())
}

pub fn format_bytes(value: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    let value = value as f64;
    if value >= GIB {
        format!("{:.1} GB", value / GIB)
    } else {
        format!("{:.0} MB", (value / MIB).max(1.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::atomic::AtomicUsize,
        thread,
    };

    const SHA_A: &str = "aa00000000000000000000000000000000000000000000000000000000000001";

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("glee-resources-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn sha_of(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    struct RecordingSink(Mutex<Vec<ProvisioningProgress>>);

    impl ProgressSink for RecordingSink {
        fn emit(&self, progress: ProvisioningProgress) {
            self.0.lock().unwrap().push(progress);
        }
    }

    /// Minimal HTTP/1.1 file server with Range support. Paths not in `files`
    /// return 404. `fail_first` makes the first request for each path drop
    /// the connection halfway through the body.
    struct TestServer {
        base: String,
        hits: Arc<AtomicUsize>,
        /// Every request as (path, requested range start).
        requests: Arc<Mutex<Vec<RequestLog>>>,
    }

    type RequestLog = (String, Option<usize>);

    impl TestServer {
        fn start(files: Vec<(String, Vec<u8>)>, fail_first: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!(
                "http://127.0.0.1:{}/",
                listener.local_addr().unwrap().port()
            );
            let files = Arc::new(files);
            let hits = Arc::new(AtomicUsize::new(0));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let failed = Arc::new(Mutex::new(std::collections::HashSet::new()));
            let server_hits = hits.clone();
            let server_requests = requests.clone();
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let files = files.clone();
                    let failed = failed.clone();
                    let hits = server_hits.clone();
                    let requests = server_requests.clone();
                    thread::spawn(move || {
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        let mut request_line = String::new();
                        if reader.read_line(&mut request_line).is_err() {
                            return;
                        }
                        let path = request_line
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or("/")
                            .trim_start_matches('/')
                            .to_string();
                        let mut range_start = None;
                        loop {
                            let mut line = String::new();
                            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                                break;
                            }
                            let lower = line.to_ascii_lowercase();
                            if let Some(value) = lower.strip_prefix("range: bytes=") {
                                range_start =
                                    value.trim().trim_end_matches('-').parse::<usize>().ok();
                            }
                        }
                        hits.fetch_add(1, Ordering::SeqCst);
                        requests.lock().unwrap().push((path.clone(), range_start));
                        let Some((_, body)) = files.iter().find(|(name, _)| *name == path) else {
                            let _ = stream.write_all(
                                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            );
                            return;
                        };
                        let start = range_start.unwrap_or(0).min(body.len());
                        let slice = &body[start..];
                        let header = if range_start.is_some() {
                            format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
                                slice.len(),
                                start,
                                body.len() - 1,
                                body.len()
                            )
                        } else {
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                slice.len()
                            )
                        };
                        let _ = stream.write_all(header.as_bytes());
                        let first_time = failed.lock().unwrap().insert(path.clone());
                        if fail_first && first_time {
                            let _ = stream.write_all(&slice[..slice.len() / 2]);
                            let _ = stream.flush();
                            return; // drop mid-body
                        }
                        let _ = stream.write_all(slice);
                    });
                }
            });
            Self {
                base,
                hits,
                requests,
            }
        }
    }

    fn tar_gz_with_symlink() -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let mut header = tar::Header::new_gnu();
        let body = b"#!/bin/sh\necho llama\n";
        header.set_size(body.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "pkg/llama-server", &body[..])
            .unwrap();
        let mut lib = tar::Header::new_gnu();
        lib.set_size(3);
        lib.set_mode(0o644);
        lib.set_cksum();
        builder
            .append_data(&mut lib, "pkg/libllama.0.2.0.dylib", &b"lib"[..])
            .unwrap();
        let mut link = tar::Header::new_gnu();
        link.set_entry_type(tar::EntryType::Symlink);
        link.set_size(0);
        link.set_mode(0o777);
        builder
            .append_link(&mut link, "pkg/libllama.dylib", "libllama.0.2.0.dylib")
            .unwrap();
        builder.into_inner().unwrap().finish().unwrap()
    }

    fn zip_bytes() -> Vec<u8> {
        let mut cursor = io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("llama-server.exe", options).unwrap();
            writer.write_all(b"MZ fake").unwrap();
            writer.start_file("ggml.dll", options).unwrap();
            writer.write_all(b"dll").unwrap();
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    fn manifest_json(server: &str, mirrors: &[&str], files: &[(&str, &[u8])]) -> String {
        let source = |name: &str| {
            let bytes = files.iter().find(|(file, _)| *file == name).unwrap().1;
            serde_json::json!({
                "fileName": name,
                "sizeBytes": bytes.len(),
                "sha256": sha_of(bytes),
                "url": format!("{server}upstream/{name}"),
            })
        };
        let mut chat = source("chat.gguf");
        chat["id"] = "chat-model".into();
        chat["role"] = "chat".into();
        chat["displayName"] = "Test Chat".into();
        let mut embedding = source("embed.gguf");
        embedding["id"] = "embed-model".into();
        embedding["role"] = "embedding".into();
        embedding["displayName"] = "Test Embed".into();
        let mut cpu = source("runtime-cpu.tar.gz");
        cpu["id"] = "test-cpu".into();
        cpu["platform"] = "test-x64".into();
        cpu["backend"] = "cpu".into();
        cpu["version"] = "b1".into();
        cpu["archive"] = "tar.gz".into();
        cpu["entrypoint"] = "pkg/llama-server".into();
        let mut gpu = source("runtime-gpu.zip");
        gpu["id"] = "test-gpu".into();
        gpu["platform"] = "test-x64".into();
        gpu["backend"] = "vulkan".into();
        gpu["optional"] = true.into();
        gpu["version"] = "b1".into();
        gpu["archive"] = "zip".into();
        gpu["entrypoint"] = "llama-server.exe".into();
        serde_json::json!({
            "schemaVersion": 1,
            "mirrors": mirrors,
            "models": [chat, embedding],
            "runtimes": [cpu, gpu],
        })
        .to_string()
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    /// `prepare` allows one job per process, so tests that run it take turns.
    static PREPARE_LOCK: Mutex<()> = Mutex::new(());

    fn prepare_lock() -> std::sync::MutexGuard<'static, ()> {
        PREPARE_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    #[test]
    fn bundled_manifest_parses_and_pins_every_supported_platform() {
        let manifest = ResourceManifest::parse(BUNDLED_MANIFEST).expect("bundled manifest");
        for platform in ["windows-x64", "macos-arm64", "macos-x64"] {
            assert!(
                manifest
                    .runtimes_for(platform)
                    .iter()
                    .any(|runtime| !runtime.optional),
                "{platform} needs a required runtime"
            );
        }
        assert_eq!(
            manifest.model_for(ModelRole::Chat, "windows-x64").role,
            ModelRole::Chat
        );
        assert!(manifest
            .mirrors
            .iter()
            .all(|mirror| mirror.starts_with("https://")));
    }

    #[test]
    fn manifest_rejects_unpinned_hashes_placeholder_hosts_and_unsafe_names() {
        let base = |sha: &str, url: &str, name: &str| {
            format!(
                r#"{{"schemaVersion":1,"models":[
                {{"id":"c","role":"chat","displayName":"C","fileName":"{name}","sizeBytes":1,"sha256":"{sha}","url":"{url}"}},
                {{"id":"e","role":"embedding","displayName":"E","fileName":"e.gguf","sizeBytes":1,"sha256":"{SHA_A}","url":"https://example.org/e"}}],
                "runtimes":[]}}"#
            )
        };
        assert!(ResourceManifest::parse(&base(SHA_A, "https://example.org/c", "c.gguf")).is_ok());
        assert!(
            ResourceManifest::parse(&base(&"0".repeat(64), "https://example.org/c", "c.gguf"))
                .is_err()
        );
        assert!(ResourceManifest::parse(&base(
            SHA_A,
            "https://downloads.glee.invalid/c",
            "c.gguf"
        ))
        .is_err());
        assert!(ResourceManifest::parse(&base(SHA_A, "http://example.org/c", "c.gguf")).is_err());
        assert!(
            ResourceManifest::parse(&base(SHA_A, "https://example.org/c", "../c.gguf")).is_err()
        );
        assert!(ResourceManifest::parse(&base(SHA_A, "http://127.0.0.1:9/c", "c.gguf")).is_ok());
    }

    #[test]
    fn platforms_can_use_a_different_packing_of_the_chat_model() {
        let mut json: serde_json::Value = serde_json::from_str(BUNDLED_MANIFEST).unwrap();
        let models = json["models"].as_array_mut().unwrap();
        let mut mac_only = models
            .iter()
            .find(|model| model["role"] == "chat")
            .unwrap()
            .clone();
        mac_only["id"] = "mac-only-chat".into();
        mac_only["sha256"] = SHA_A.into();
        mac_only["platforms"] = serde_json::json!(["macos-arm64"]);
        models.push(mac_only);
        let manifest = ResourceManifest::parse(&json.to_string()).unwrap();

        let mac = manifest.model_for(ModelRole::Chat, "macos-arm64");
        let windows = manifest.model_for(ModelRole::Chat, "windows-x64");
        assert_eq!(mac.id, "mac-only-chat");
        assert!(windows.platforms.is_empty());
        assert_ne!(mac.source.sha256, windows.source.sha256);
        assert_eq!(
            manifest.model_for(ModelRole::Embedding, "macos-arm64").id,
            manifest.model_for(ModelRole::Embedding, "windows-x64").id
        );
    }

    #[test]
    fn mirror_urls_are_content_addressed_and_tried_before_upstream() {
        let source = DownloadSource {
            file_name: "model.gguf".into(),
            size_bytes: 1,
            sha256: SHA_A.into(),
            url: "https://upstream.example.org/model.gguf".into(),
        };
        let urls = candidate_urls(&["https://cdn.example.org/glee".to_string()], &source);
        assert_eq!(
            urls.iter().map(Url::as_str).collect::<Vec<_>>(),
            vec![
                format!("https://cdn.example.org/glee/{SHA_A}/model.gguf").as_str(),
                "https://upstream.example.org/model.gguf",
            ]
        );
    }

    #[test]
    fn link_targets_must_stay_inside_the_archive() {
        assert!(stays_within(Path::new("pkg/libllama.0.dylib")));
        assert!(stays_within(Path::new("pkg/../pkg/lib.dylib")));
        assert!(!stays_within(Path::new("pkg/../../etc/passwd")));
        assert!(!stays_within(Path::new("/etc/passwd")));
    }

    #[test]
    fn prepare_downloads_falls_back_resumes_extracts_and_then_reuses() {
        let _serial = prepare_lock();
        let chat = b"chat model bytes ".repeat(4096);
        let embed = b"embedding model".repeat(512);
        let cpu = tar_gz_with_symlink();
        let gpu = zip_bytes();
        let files: Vec<(&str, &[u8])> = vec![
            ("chat.gguf", &chat),
            ("embed.gguf", &embed),
            ("runtime-cpu.tar.gz", &cpu),
            ("runtime-gpu.zip", &gpu),
        ];
        // Upstream only: the configured mirror has nothing, so every file must
        // fall back after a 404. The first response for each file is cut short
        // to exercise resume.
        let server = TestServer::start(
            files
                .iter()
                .map(|(name, bytes)| (format!("upstream/{name}"), bytes.to_vec()))
                .collect(),
            true,
        );
        let mirror = format!("{}mirror", server.base);
        let manifest =
            ResourceManifest::parse(&manifest_json(&server.base, &[mirror.as_str()], &files))
                .unwrap();
        let root = temp_dir("prepare");
        let resources = Resources::with_manifest(root.clone(), manifest, "test-x64".into());
        assert!(!resources.status().ready);
        assert_eq!(
            resources.status().missing_required_bytes,
            (chat.len() + embed.len() + cpu.len()) as u64
        );

        let sink = RecordingSink(Mutex::new(Vec::new()));
        let response = block_on(resources.prepare(&sink)).expect("prepare should succeed");
        assert_eq!(response.downloaded_assets, 4);
        let status = resources.status();
        assert!(status.ready, "{status:?}");
        assert!(status.items.iter().all(|item| item.installed));

        let chat_path = resources.installed_model_path(ModelRole::Chat).unwrap();
        assert_eq!(fs::read(chat_path).unwrap(), chat);
        let runtimes = resources.installed_runtimes();
        assert_eq!(runtimes.len(), 2);
        let cpu_runtime = runtimes
            .iter()
            .find(|runtime| runtime.asset.id == "test-cpu")
            .unwrap();
        assert!(cpu_runtime.entrypoint.ends_with("pkg/llama-server"));
        #[cfg(unix)]
        {
            let link = resources
                .runtime_dir(&cpu_runtime.asset)
                .join("pkg/libllama.dylib");
            assert_eq!(
                fs::read_link(&link).unwrap(),
                PathBuf::from("libllama.0.2.0.dylib")
            );
        }
        let events = sink.0.lock().unwrap();
        assert_eq!(events.last().unwrap().phase, ProvisioningPhase::Ready);
        assert!(events
            .iter()
            .any(|event| event.phase == ProvisioningPhase::Downloading));
        drop(events);
        assert!(
            !root.join("downloads").read_dir().unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part"))
        );

        // Second run: everything is reused without touching the network.
        let hits_before = server.hits.load(Ordering::SeqCst);
        let again = block_on(resources.prepare(&RecordingSink(Mutex::new(Vec::new())))).unwrap();
        assert_eq!(again.downloaded_assets, 0);
        assert_eq!(server.hits.load(Ordering::SeqCst), hits_before);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_new_session_resumes_the_partial_download_left_by_an_earlier_one() {
        let _serial = prepare_lock();
        let chat = b"chat model bytes ".repeat(4096);
        let embed = b"embedding model".repeat(512);
        let cpu = tar_gz_with_symlink();
        let gpu = zip_bytes();
        let files: Vec<(&str, &[u8])> = vec![
            ("chat.gguf", &chat),
            ("embed.gguf", &embed),
            ("runtime-cpu.tar.gz", &cpu),
            ("runtime-gpu.zip", &gpu),
        ];
        let server = TestServer::start(
            files
                .iter()
                .map(|(name, bytes)| (format!("upstream/{name}"), bytes.to_vec()))
                .collect(),
            false,
        );
        let manifest = ResourceManifest::parse(&manifest_json(&server.base, &[], &files)).unwrap();
        let root = temp_dir("restart-resume");

        // What an earlier session leaves behind when the app is closed
        // mid-download: the first part of the model in a `.part` file.
        let downloads = root.join("downloads");
        fs::create_dir_all(&downloads).unwrap();
        let already = chat.len() / 3;
        let part = downloads.join(format!("{}-chat.gguf.part", &sha_of(&chat)[..16]));
        fs::write(&part, &chat[..already]).unwrap();

        let resources = Resources::with_manifest(root.clone(), manifest, "test-x64".into());
        assert_eq!(resources.status().partial_required_bytes, already as u64);
        let sink = RecordingSink(Mutex::new(Vec::new()));
        block_on(resources.prepare(&sink)).expect("prepare should resume and finish");
        assert_eq!(resources.status().partial_required_bytes, 0);

        let chat_path = resources.installed_model_path(ModelRole::Chat).unwrap();
        assert_eq!(
            fs::read(chat_path).unwrap(),
            chat,
            "resumed file must be intact"
        );
        let requests = server.requests.lock().unwrap();
        let chat_requests = requests
            .iter()
            .filter(|(path, _)| path == "upstream/chat.gguf")
            .collect::<Vec<_>>();
        assert_eq!(chat_requests.len(), 1);
        assert_eq!(
            chat_requests[0].1,
            Some(already),
            "only the missing part should be requested"
        );
        // The first progress report already counts the bytes kept from before.
        let events = sink.0.lock().unwrap();
        let resumed_event = events
            .iter()
            .find(|event| {
                event.phase == ProvisioningPhase::Downloading && event.file_bytes == already as u64
            })
            .expect("progress should start from the bytes already on disk");
        assert!(resumed_event.aggregate_bytes >= already as u64);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn checksum_mismatch_fails_with_a_friendly_message_and_keeps_nothing() {
        let _serial = prepare_lock();
        let chat = b"real".to_vec();
        let embed = b"embed".to_vec();
        let cpu = tar_gz_with_symlink();
        let gpu = zip_bytes();
        let files: Vec<(&str, &[u8])> = vec![
            ("chat.gguf", &chat),
            ("embed.gguf", &embed),
            ("runtime-cpu.tar.gz", &cpu),
            ("runtime-gpu.zip", &gpu),
        ];
        let mut served = files
            .iter()
            .map(|(name, bytes)| (format!("upstream/{name}"), bytes.to_vec()))
            .collect::<Vec<_>>();
        served[0].1 = b"evil".to_vec(); // same size, different bytes
        let server = TestServer::start(served, false);
        let manifest = ResourceManifest::parse(&manifest_json(&server.base, &[], &files)).unwrap();
        let root = temp_dir("mismatch");
        let resources = Resources::with_manifest(root.clone(), manifest, "test-x64".into());
        let error = block_on(resources.prepare(&RecordingSink(Mutex::new(Vec::new()))))
            .expect_err("tampered model must be rejected");
        let message = error.to_string();
        assert!(message.starts_with("Glee couldn't download"), "{message}");
        assert!(message.contains("checksum"), "{message}");
        assert!(resources.installed_model_path(ModelRole::Chat).is_none());
        assert!(!resources.model_path(ModelRole::Chat).exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn unsupported_platform_reports_clearly() {
        let _serial = prepare_lock();
        let manifest = ResourceManifest::parse(BUNDLED_MANIFEST).unwrap();
        let resources =
            Resources::with_manifest(temp_dir("unsupported"), manifest, "plan9-mips".into());
        assert!(!resources.status().platform_supported);
        let error = block_on(resources.prepare(&RecordingSink(Mutex::new(Vec::new()))))
            .expect_err("unsupported platform");
        assert!(error.to_string().contains("doesn't support"));
    }
}
