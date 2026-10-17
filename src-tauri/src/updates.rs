//! Update notifications and one-click installer downloads.
//!
//! Glee is not code-signed yet, so it cannot use the signed Tauri updater.
//! Instead each published GitHub release carries a small `latest.json`
//! manifest. The app fetches it (nothing about the user is sent), compares the
//! version with the running one, and on request downloads the installer for
//! this platform, verifies its size and SHA-256, and opens it with the system
//! default handler. All network traffic lives in this module so the frontend
//! can later be pointed at `tauri-plugin-updater` without changing its shape.
//!
//! The manifest location comes from the bundled `resources/update-source.json`
//! (empty in development builds, which disables checks) or the
//! `GLEE_UPDATE_MANIFEST_URL` environment variable. Every URL in the manifest
//! must be https and point at GitHub, the configured resource mirrors, or the
//! host the manifest itself came from.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use reqwest::{header, redirect, Client, StatusCode, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::errors::{AppError, AppResult};

const BUNDLED_SOURCE: &str = include_str!("../resources/update-source.json");
const BUNDLED_RESOURCE_MANIFEST: &str = include_str!("../resources/manifest.json");
const MANIFEST_URL_ENV: &str = "GLEE_UPDATE_MANIFEST_URL";
const SUPPORTED_SCHEMA_VERSION: u32 = 1;
const PROGRESS_EVENT: &str = "update-download-progress";
const PROGRESS_EVENT_INTERVAL: Duration = Duration::from_millis(200);
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_NOTES_CHARS: usize = 8000;
const MAX_INSTALLER_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_STALLED_ATTEMPTS: u32 = 3;
const MAX_REDIRECTS: usize = 5;
const DEFAULT_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "*.githubusercontent.com",
];
const AUTO_CHECK_KEY: &str = "updates.autoCheck";
const SKIPPED_VERSION_KEY: &str = "updates.skippedVersion";

static ACTIVE_DOWNLOAD: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);
static DOWNLOADED_INSTALLER: Mutex<Option<PathBuf>> = Mutex::new(None);

// ---------------------------------------------------------------- types

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAssetInfo {
    pub file_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub notes: String,
    pub page_url: String,
    pub asset: Option<UpdateAssetInfo>,
    pub release_date: Option<String>,
    /// The running version is older than the release's `minSupportedVersion`.
    pub mandatory: bool,
    /// A newer release exists but the user chose to skip it.
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub auto_check: bool,
    pub skipped_version: Option<String>,
    pub current_version: String,
    /// False when this build has no update source (development builds).
    pub updates_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsInput {
    pub auto_check: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    /// The installer must replace files that are in use, so the app has to
    /// quit once it is open (Windows).
    pub should_quit: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    /// `downloading`, `verifying`, `done`, or `cancelled`.
    pub phase: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    schema_version: u32,
    version: String,
    release_date: Option<String>,
    notes: Option<String>,
    min_supported_version: Option<String>,
    page_url: String,
    #[serde(default)]
    assets: BTreeMap<String, RawAsset>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAsset {
    file_name: String,
    url: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone)]
struct Release {
    version: Version,
    release_date: Option<String>,
    notes: String,
    min_supported: Option<Version>,
    page_url: String,
    asset: Option<Asset>,
}

#[derive(Debug, Clone)]
struct Asset {
    file_name: String,
    url: Url,
    size_bytes: u64,
    sha256: String,
}

// ------------------------------------------------------- source and hosts

/// Where the manifest lives and which hosts it may reference.
#[derive(Debug, Clone)]
struct UpdateSource {
    manifest_url: Url,
    policy: HostPolicy,
}

#[derive(Debug, Clone)]
struct HostPolicy {
    hosts: Vec<String>,
    /// Plain http is accepted only for a loopback manifest (tests, local dev).
    allow_loopback_http: bool,
}

impl HostPolicy {
    fn allows(&self, url: &Url) -> bool {
        let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
            return false;
        };
        let scheme_ok = match url.scheme() {
            "https" => true,
            "http" => self.allow_loopback_http && is_loopback(&host),
            _ => false,
        };
        scheme_ok
            && self
                .hosts
                .iter()
                .any(|pattern| match pattern.strip_prefix("*.") {
                    Some(suffix) => host.ends_with(&format!(".{suffix}")),
                    None => *pattern == host,
                })
    }
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

impl UpdateSource {
    /// `None` when update checks are disabled for this build.
    fn resolve() -> AppResult<Option<Self>> {
        let configured = match std::env::var(MANIFEST_URL_ENV) {
            Ok(value) if !value.trim().is_empty() => value,
            _ => {
                let bundled: serde_json::Value =
                    serde_json::from_str(BUNDLED_SOURCE).map_err(|error| {
                        AppError::Runtime(format!("bundled update source is invalid: {error}"))
                    })?;
                bundled
                    .get("manifestUrl")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string()
            }
        };
        Self::from_url(&configured, &bundled_mirror_hosts())
    }

    fn from_url(manifest_url: &str, mirror_hosts: &[String]) -> AppResult<Option<Self>> {
        let manifest_url = manifest_url.trim();
        if manifest_url.is_empty() {
            return Ok(None);
        }
        let url = Url::parse(manifest_url)
            .map_err(|_| AppError::Download("The update address is not valid.".to_string()))?;
        let host = url
            .host_str()
            .map(str::to_ascii_lowercase)
            .ok_or_else(|| AppError::Download("The update address has no host.".to_string()))?;
        let mut hosts: Vec<String> = DEFAULT_HOSTS.iter().map(|host| host.to_string()).collect();
        hosts.extend(mirror_hosts.iter().cloned());
        hosts.push(host.clone());
        let policy = HostPolicy {
            hosts,
            allow_loopback_http: url.scheme() == "http" && is_loopback(&host),
        };
        if !policy.allows(&url) {
            return Err(AppError::Download(
                "The update address must use https.".to_string(),
            ));
        }
        Ok(Some(Self {
            manifest_url: url,
            policy,
        }))
    }
}

fn bundled_mirror_hosts() -> Vec<String> {
    let value: serde_json::Value =
        serde_json::from_str(BUNDLED_RESOURCE_MANIFEST).unwrap_or_default();
    value
        .get("mirrors")
        .and_then(|mirrors| mirrors.as_array())
        .into_iter()
        .flatten()
        .filter_map(|mirror| mirror.as_str())
        .filter_map(|mirror| Url::parse(mirror).ok())
        .filter_map(|url| url.host_str().map(str::to_ascii_lowercase))
        .collect()
}

fn build_client(policy: &HostPolicy, total_timeout: Option<Duration>) -> AppResult<Client> {
    let redirect_policy = policy.clone();
    let mut builder = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .user_agent(format!("Glee/{}", env!("CARGO_PKG_VERSION")))
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if redirect_policy.allows(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("redirect to a host that is not allowed")
            }
        }));
    if let Some(timeout) = total_timeout {
        builder = builder.timeout(timeout);
    }
    builder
        .build()
        .map_err(|error| AppError::Runtime(format!("failed to build update client: {error}")))
}

// -------------------------------------------------------------- manifest

fn current_version() -> Version {
    Version::parse(env!("CARGO_PKG_VERSION")).expect("package version is valid semver")
}

fn platform_key() -> Option<&'static str> {
    if cfg!(target_os = "windows") {
        Some("windows-x64")
    } else if cfg!(target_os = "macos") {
        Some("macos-universal")
    } else {
        None
    }
}

fn malformed(detail: &str) -> AppError {
    AppError::Download(format!("The update information was not valid ({detail})."))
}

fn parse_version(value: &str) -> Option<Version> {
    Version::parse(value.trim().trim_start_matches('v')).ok()
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_safe_file_name(value: &str, extension: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && value.to_ascii_lowercase().ends_with(extension)
}

fn parse_manifest(json: &str, policy: &HostPolicy, platform: Option<&str>) -> AppResult<Release> {
    let raw: RawManifest =
        serde_json::from_str(json).map_err(|_| malformed("it is not a Glee update file"))?;
    if raw.schema_version != SUPPORTED_SCHEMA_VERSION {
        return Err(malformed("unsupported format"));
    }
    let version = parse_version(&raw.version).ok_or_else(|| malformed("bad version"))?;
    let min_supported = match raw.min_supported_version.as_deref() {
        Some(value) => Some(parse_version(value).ok_or_else(|| malformed("bad minimum version"))?),
        None => None,
    };
    let page_url = Url::parse(&raw.page_url)
        .ok()
        .filter(|url| policy.allows(url))
        .ok_or_else(|| malformed("bad page address"))?;
    let release_date = raw
        .release_date
        .map(|value| value.trim().chars().take(40).collect::<String>())
        .filter(|value| !value.is_empty());
    let notes: String = raw
        .notes
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .take(MAX_NOTES_CHARS)
        .collect();

    let asset = match platform.and_then(|key| raw.assets.get(key).map(|asset| (key, asset))) {
        Some((key, asset)) => {
            let extension = if key.starts_with("windows") {
                ".exe"
            } else {
                ".dmg"
            };
            if !is_safe_file_name(&asset.file_name, extension) {
                return Err(malformed("unsafe installer name"));
            }
            let url = Url::parse(&asset.url)
                .ok()
                .filter(|url| policy.allows(url))
                .ok_or_else(|| malformed("installer address is not allowed"))?;
            if asset.size_bytes == 0 || asset.size_bytes > MAX_INSTALLER_BYTES {
                return Err(malformed("bad installer size"));
            }
            if !is_sha256_hex(&asset.sha256) {
                return Err(malformed("bad checksum"));
            }
            Some(Asset {
                file_name: asset.file_name.clone(),
                url,
                size_bytes: asset.size_bytes,
                sha256: asset.sha256.to_ascii_lowercase(),
            })
        }
        None => None,
    };

    Ok(Release {
        version,
        release_date,
        notes,
        min_supported,
        page_url: page_url.to_string(),
        asset,
    })
}

async fn fetch_release(source: &UpdateSource, platform: Option<&str>) -> AppResult<Release> {
    let client = build_client(&source.policy, Some(Duration::from_secs(20)))?;
    let mut response = client
        .get(source.manifest_url.clone())
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| request_error(&error))?;
    if !response.status().is_success() {
        return Err(AppError::Download(format!(
            "The update server answered with HTTP {}.",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MANIFEST_BYTES as u64)
    {
        return Err(malformed("it is too large"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| request_error(&error))?
    {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_MANIFEST_BYTES {
            return Err(malformed("it is too large"));
        }
    }
    let json = String::from_utf8(body).map_err(|_| malformed("not text"))?;
    parse_manifest(&json, &source.policy, platform)
}

fn request_error(error: &reqwest::Error) -> AppError {
    let message = if error.is_connect() {
        "Could not reach the update server."
    } else if error.is_timeout() {
        "The update server took too long to answer."
    } else {
        "The update server could not be read."
    };
    AppError::Download(message.to_string())
}

// ------------------------------------------------------------ evaluation

#[derive(Debug, Clone, Default)]
struct StoredSettings {
    auto_check: Option<bool>,
    skipped_version: Option<String>,
}

impl StoredSettings {
    fn auto_check(&self) -> bool {
        self.auto_check.unwrap_or(true)
    }
}

fn evaluate(
    release: &Release,
    current: &Version,
    settings: &StoredSettings,
    manual: bool,
) -> UpdateInfo {
    let newer = release.version > *current;
    let mandatory = newer
        && release
            .min_supported
            .as_ref()
            .is_some_and(|minimum| current < minimum);
    let skipped = newer
        && !mandatory
        && settings
            .skipped_version
            .as_deref()
            .and_then(parse_version)
            .is_some_and(|skipped| skipped == release.version);
    UpdateInfo {
        available: newer && (manual || !skipped),
        current_version: current.to_string(),
        latest_version: release.version.to_string(),
        notes: release.notes.clone(),
        page_url: release.page_url.clone(),
        asset: release.asset.as_ref().map(|asset| UpdateAssetInfo {
            file_name: asset.file_name.clone(),
            size_bytes: asset.size_bytes,
        }),
        release_date: release.release_date.clone(),
        mandatory,
        skipped,
    }
}

fn up_to_date(current: &Version) -> UpdateInfo {
    UpdateInfo {
        available: false,
        current_version: current.to_string(),
        latest_version: current.to_string(),
        notes: String::new(),
        page_url: String::new(),
        asset: None,
        release_date: None,
        mandatory: false,
        skipped: false,
    }
}

async fn check(
    source: Option<&UpdateSource>,
    settings: &StoredSettings,
    manual: bool,
) -> AppResult<UpdateInfo> {
    let current = current_version();
    let Some(source) = source else {
        return Ok(up_to_date(&current));
    };
    if !manual && !settings.auto_check() {
        return Ok(up_to_date(&current));
    }
    let release = fetch_release(source, platform_key()).await?;
    Ok(evaluate(&release, &current, settings, manual))
}

// -------------------------------------------------------------- download

pub trait UpdateProgressSink: Send + Sync {
    fn emit(&self, progress: UpdateDownloadProgress);
}

struct AppSink<R: Runtime>(AppHandle<R>);

impl<R: Runtime> UpdateProgressSink for AppSink<R> {
    fn emit(&self, progress: UpdateDownloadProgress) {
        let _ = self.0.emit(PROGRESS_EVENT, progress);
    }
}

struct DownloadGuard;

impl DownloadGuard {
    fn begin() -> AppResult<(Arc<AtomicBool>, Self)> {
        let mut active = ACTIVE_DOWNLOAD
            .lock()
            .map_err(|_| AppError::Runtime("update state was poisoned".to_string()))?;
        if active.is_some() {
            return Err(AppError::Conflict(
                "An update is already downloading.".to_string(),
            ));
        }
        let flag = Arc::new(AtomicBool::new(false));
        *active = Some(flag.clone());
        Ok((flag, Self))
    }
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
            *active = None;
        }
    }
}

fn downloads_dir() -> PathBuf {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE")
    } else {
        None
    }
    .or_else(|| std::env::var_os("HOME"))
    .map(PathBuf::from);
    home.map(|home| home.join("Downloads"))
        .filter(|path| path.is_dir())
        .unwrap_or_else(std::env::temp_dir)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn hash_file(path: &Path) -> std::io::Result<(Sha256, u64)> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut total = 0_u64;
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Ok((hasher, total));
        }
        total += read as u64;
        hasher.update(&buffer[..read]);
    }
}

struct DownloadFailure {
    message: String,
    retryable: bool,
}

fn cancelled_error() -> AppError {
    AppError::Download("The update download was cancelled.".to_string())
}

/// Downloads `asset` into `directory` and returns the verified installer
/// path. A verified file that is already there is reused.
async fn download_asset(
    client: &Client,
    asset: &Asset,
    directory: &Path,
    cancel: &AtomicBool,
    sink: &dyn UpdateProgressSink,
) -> AppResult<PathBuf> {
    tokio::fs::create_dir_all(directory).await?;
    let destination = directory.join(&asset.file_name);
    let part = directory.join(format!("{}.part", asset.file_name));
    let total = asset.size_bytes;
    let emit = |downloaded: u64, phase: &'static str| {
        sink.emit(UpdateDownloadProgress {
            downloaded_bytes: downloaded,
            total_bytes: total,
            phase,
        })
    };

    if let Ok((hasher, size)) = hash_file(&destination).await {
        if size == total && hex(&hasher.finalize()) == asset.sha256 {
            emit(total, "done");
            return Ok(destination);
        }
        let _ = tokio::fs::remove_file(&destination).await;
    }

    let mut stalled = 0_u32;
    let digest = loop {
        if cancel.load(Ordering::Acquire) {
            emit(0, "cancelled");
            return Err(cancelled_error());
        }
        let before = tokio::fs::metadata(&part)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        match download_attempt(client, asset, &part, cancel, sink).await {
            Ok(digest) => break digest,
            Err(failure) if failure.message == "cancelled" => {
                emit(before, "cancelled");
                return Err(cancelled_error());
            }
            Err(failure) => {
                let after = tokio::fs::metadata(&part)
                    .await
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                if after > before {
                    stalled = 0;
                } else {
                    stalled += 1;
                }
                if !failure.retryable || stalled >= MAX_STALLED_ATTEMPTS {
                    return Err(AppError::Download(format!(
                        "The update could not be downloaded ({}). Check your connection and try again.",
                        failure.message
                    )));
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    };

    emit(total, "verifying");
    if digest != asset.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(AppError::Download(
            "The downloaded update failed its integrity check and was deleted. Please try again."
                .to_string(),
        ));
    }
    if tokio::fs::rename(&part, &destination).await.is_err() {
        let _ = tokio::fs::remove_file(&destination).await;
        tokio::fs::rename(&part, &destination).await?;
    }
    emit(total, "done");
    Ok(destination)
}

async fn download_attempt(
    client: &Client,
    asset: &Asset,
    part: &Path,
    cancel: &AtomicBool,
    sink: &dyn UpdateProgressSink,
) -> Result<String, DownloadFailure> {
    let fatal = |message: &str| DownloadFailure {
        message: message.to_string(),
        retryable: false,
    };
    let retry = |message: String| DownloadFailure {
        message,
        retryable: true,
    };
    let total = asset.size_bytes;
    let mut offset = tokio::fs::metadata(part)
        .await
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if offset > total {
        let _ = tokio::fs::remove_file(part).await;
        offset = 0;
    }
    if offset == total {
        // An earlier attempt got every byte but stopped before verifying.
        let (hasher, _) = hash_file(part)
            .await
            .map_err(|error| retry(error.to_string()))?;
        return Ok(hex(&hasher.finalize()));
    }

    let mut request = client.get(asset.url.clone());
    if offset > 0 {
        request = request.header(header::RANGE, format!("bytes={offset}-"));
    }
    let mut response = request.send().await.map_err(|error| DownloadFailure {
        message: if error.is_connect() {
            "could not connect".to_string()
        } else if error.is_timeout() {
            "the connection timed out".to_string()
        } else {
            "the request failed".to_string()
        },
        retryable: !error.is_redirect(),
    })?;
    let status = response.status();
    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        let _ = tokio::fs::remove_file(part).await;
        return Err(retry("the server rejected the resume range".to_string()));
    }
    if !status.is_success() {
        let message = format!("server returned HTTP {}", status.as_u16());
        return Err(DownloadFailure {
            retryable: status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS,
            message,
        });
    }
    let resumed = offset > 0 && status == StatusCode::PARTIAL_CONTENT;
    if resumed && !content_range_starts_at(response.headers(), offset) {
        let _ = tokio::fs::remove_file(part).await;
        return Err(retry("the server sent an invalid range".to_string()));
    }
    if !resumed {
        offset = 0;
    }
    if response
        .content_length()
        .is_some_and(|length| length != total - offset)
    {
        return Err(fatal("the server reported an unexpected size"));
    }

    let mut hasher = Sha256::new();
    if resumed {
        hasher = hash_file(part)
            .await
            .map_err(|error| retry(error.to_string()))?
            .0;
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
        .map_err(|error| fatal(&error.to_string()))?;

    let mut received = offset;
    let mut last_emit = Instant::now() - PROGRESS_EVENT_INTERVAL;
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        retry(if error.is_timeout() {
            "the connection timed out".to_string()
        } else {
            "the connection was interrupted".to_string()
        })
    })? {
        if cancel.load(Ordering::Acquire) {
            let _ = file.flush().await;
            return Err(fatal("cancelled"));
        }
        received += chunk.len() as u64;
        if received > total {
            drop(file);
            let _ = tokio::fs::remove_file(part).await;
            return Err(fatal("the download was larger than expected"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| fatal(&error.to_string()))?;
        if last_emit.elapsed() >= PROGRESS_EVENT_INTERVAL || received == total {
            last_emit = Instant::now();
            sink.emit(UpdateDownloadProgress {
                downloaded_bytes: received,
                total_bytes: total,
                phase: "downloading",
            });
        }
    }
    file.flush()
        .await
        .map_err(|error| retry(error.to_string()))?;
    file.sync_all()
        .await
        .map_err(|error| retry(error.to_string()))?;
    if received != total {
        return Err(retry("the connection closed early".to_string()));
    }
    Ok(hex(&hasher.finalize()))
}

fn content_range_starts_at(headers: &header::HeaderMap, offset: u64) -> bool {
    headers
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
        .and_then(|value| value.split_once('-'))
        .and_then(|(start, _)| start.trim().parse::<u64>().ok())
        == Some(offset)
}

// --------------------------------------------------------------- install

fn should_quit_after_install() -> bool {
    cfg!(windows)
}

/// The program and arguments that open `path` with the OS default handler.
fn opener_command(path: &Path) -> (&'static str, Vec<std::ffi::OsString>) {
    let path = path.as_os_str().to_owned();
    if cfg!(windows) {
        ("cmd", vec!["/C".into(), "start".into(), "".into(), path])
    } else if cfg!(target_os = "macos") {
        ("open", vec![path])
    } else {
        ("xdg-open", vec![path])
    }
}

fn open_installer(path: &Path) -> AppResult<()> {
    let (program, args) = opener_command(path);
    let mut command = std::process::Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::Download(format!("Could not open the installer: {error}")))
}

/// Only the file this module verified may be launched.
fn validate_installer_path(candidate: &str, recorded: Option<&Path>) -> AppResult<PathBuf> {
    let recorded = recorded.ok_or_else(|| {
        AppError::Validation("There is no downloaded update to install.".to_string())
    })?;
    if Path::new(candidate) != recorded {
        return Err(AppError::Validation(
            "That file is not the downloaded update.".to_string(),
        ));
    }
    if !recorded.is_file() {
        return Err(AppError::NotFound(
            "The downloaded update is no longer there. Download it again.".to_string(),
        ));
    }
    Ok(recorded.to_path_buf())
}

// -------------------------------------------------------------- settings

fn parse_flag(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

async fn load_stored_settings(
    state: &tauri::State<'_, crate::AppState>,
) -> AppResult<StoredSettings> {
    let handles = state.handles().await?;
    crate::run_db_task(handles.db.clone(), |database| {
        Ok(StoredSettings {
            auto_check: database
                .get_setting(AUTO_CHECK_KEY)?
                .and_then(|setting| parse_flag(&setting.value)),
            skipped_version: database
                .get_setting(SKIPPED_VERSION_KEY)?
                .map(|setting| setting.value)
                .filter(|value| !value.trim().is_empty()),
        })
    })
    .await
}

fn settings_record(stored: &StoredSettings, enabled: bool) -> UpdateSettings {
    UpdateSettings {
        auto_check: stored.auto_check(),
        skipped_version: stored.skipped_version.clone(),
        current_version: current_version().to_string(),
        updates_enabled: enabled,
    }
}

// -------------------------------------------------------------- commands

#[tauri::command]
pub async fn check_for_update(
    state: tauri::State<'_, crate::AppState>,
    manual: Option<bool>,
) -> AppResult<UpdateInfo> {
    let settings = load_stored_settings(&state).await?;
    let source = UpdateSource::resolve()?;
    check(source.as_ref(), &settings, manual.unwrap_or(false)).await
}

#[tauri::command]
pub async fn download_update(app_handle: AppHandle) -> AppResult<String> {
    let source = UpdateSource::resolve()?.ok_or_else(|| {
        AppError::Download("Updates are not available in this build.".to_string())
    })?;
    // The asset is read from the manifest again; the frontend never supplies
    // a URL.
    let release = fetch_release(&source, platform_key()).await?;
    if release.version <= current_version() {
        return Err(AppError::Download(
            "Glee is already up to date.".to_string(),
        ));
    }
    let asset = release.asset.ok_or_else(|| {
        AppError::Download("This release has no installer for your system.".to_string())
    })?;
    let (cancel, _guard) = DownloadGuard::begin()?;
    let client = build_client(&source.policy, None)?;
    let path = download_asset(
        &client,
        &asset,
        &downloads_dir(),
        &cancel,
        &AppSink(app_handle),
    )
    .await?;
    if let Ok(mut recorded) = DOWNLOADED_INSTALLER.lock() {
        *recorded = Some(path.clone());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn cancel_update_download() -> AppResult<bool> {
    let active = ACTIVE_DOWNLOAD
        .lock()
        .map_err(|_| AppError::Runtime("update state was poisoned".to_string()))?;
    Ok(match active.as_ref() {
        Some(flag) => {
            flag.store(true, Ordering::Release);
            true
        }
        None => false,
    })
}

#[tauri::command]
pub async fn install_update(path: String) -> AppResult<InstallOutcome> {
    let recorded = DOWNLOADED_INSTALLER
        .lock()
        .map_err(|_| AppError::Runtime("update state was poisoned".to_string()))?
        .clone();
    let installer = validate_installer_path(&path, recorded.as_deref())?;
    open_installer(&installer)?;
    Ok(InstallOutcome {
        should_quit: should_quit_after_install(),
    })
}

#[tauri::command]
pub async fn skip_update_version(
    state: tauri::State<'_, crate::AppState>,
    version: String,
) -> AppResult<UpdateSettings> {
    let parsed = parse_version(&version)
        .ok_or_else(|| AppError::Validation("version is not valid".to_string()))?;
    let handles = state.handles().await?;
    crate::run_db_task(handles.db.clone(), move |database| {
        database.set_setting(SKIPPED_VERSION_KEY, &parsed.to_string())
    })
    .await?;
    get_update_settings(state).await
}

#[tauri::command]
pub async fn get_update_settings(
    state: tauri::State<'_, crate::AppState>,
) -> AppResult<UpdateSettings> {
    let stored = load_stored_settings(&state).await?;
    Ok(settings_record(&stored, UpdateSource::resolve()?.is_some()))
}

#[tauri::command]
pub async fn set_update_settings(
    state: tauri::State<'_, crate::AppState>,
    input: UpdateSettingsInput,
) -> AppResult<UpdateSettings> {
    if let Some(auto_check) = input.auto_check {
        let handles = state.handles().await?;
        crate::run_db_task(handles.db.clone(), move |database| {
            database.set_setting(AUTO_CHECK_KEY, if auto_check { "true" } else { "false" })
        })
        .await?;
    }
    get_update_settings(state).await
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
    use uuid::Uuid;

    struct RecordingSink(Mutex<Vec<UpdateDownloadProgress>>);

    impl UpdateProgressSink for RecordingSink {
        fn emit(&self, progress: UpdateDownloadProgress) {
            self.0.lock().unwrap().push(progress);
        }
    }

    impl RecordingSink {
        fn new() -> Self {
            Self(Mutex::new(Vec::new()))
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("glee-updates-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn sha_of(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    /// Minimal HTTP/1.1 server with Range support. `/redirect` answers with a
    /// redirect to a host outside the allow-list.
    struct TestServer {
        base: String,
        hits: Arc<AtomicUsize>,
    }

    impl TestServer {
        fn start(files: Vec<(String, Vec<u8>)>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = format!(
                "http://127.0.0.1:{}/",
                listener.local_addr().unwrap().port()
            );
            let files = Arc::new(files);
            let hits = Arc::new(AtomicUsize::new(0));
            let server_hits = hits.clone();
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let files = files.clone();
                    let hits = server_hits.clone();
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
                        if path == "redirect" {
                            let _ = stream.write_all(
                                b"HTTP/1.1 302 Found\r\nLocation: http://evil.example/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            );
                            return;
                        }
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
                        let _ = stream.write_all(slice);
                    });
                }
            });
            Self { base, hits }
        }

        fn url(&self, path: &str) -> String {
            format!("{}{path}", self.base)
        }
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn loopback_policy() -> HostPolicy {
        HostPolicy {
            hosts: vec!["127.0.0.1".to_string(), "github.com".to_string()],
            allow_loopback_http: true,
        }
    }

    fn github_policy() -> HostPolicy {
        UpdateSource::from_url(
            "https://github.com/example/glee/releases/latest/download/latest.json",
            &[],
        )
        .unwrap()
        .unwrap()
        .policy
    }

    fn manifest_json(version: &str, asset_url: &str, bytes: &[u8]) -> serde_json::Value {
        let asset = |name: &str| {
            serde_json::json!({
                "fileName": name,
                "url": asset_url,
                "sizeBytes": bytes.len(),
                "sha256": sha_of(bytes),
            })
        };
        serde_json::json!({
            "schemaVersion": 1,
            "version": version,
            "releaseDate": "2000-01-01T00:00:00Z",
            "notes": "- Faster replies",
            "pageUrl": "https://github.com/example/glee/releases/tag/v9.0.0",
            "assets": {
                "windows-x64": asset("Glee_9.0.0_x64-setup.exe"),
                "macos-universal": asset("Glee_9.0.0_universal.dmg"),
            },
        })
    }

    fn release_for(version: &str, min: Option<&str>) -> Release {
        let mut json = manifest_json(
            version,
            "https://github.com/example/glee/releases/download/v9/x.exe",
            b"x",
        );
        if let Some(min) = min {
            json["minSupportedVersion"] = min.into();
        }
        parse_manifest(&json.to_string(), &github_policy(), Some("windows-x64")).unwrap()
    }

    #[test]
    fn bundled_source_is_valid_and_disabled_by_default() {
        let value: serde_json::Value = serde_json::from_str(BUNDLED_SOURCE).unwrap();
        assert!(value["manifestUrl"].is_string());
        assert!(UpdateSource::from_url("", &[]).unwrap().is_none());
        assert!(Version::parse(env!("CARGO_PKG_VERSION")).is_ok());
    }

    #[test]
    fn newer_equal_and_older_versions_are_told_apart() {
        let current = Version::parse("1.0.0").unwrap();
        let settings = StoredSettings::default();
        assert!(evaluate(&release_for("1.1.0", None), &current, &settings, false).available);
        assert!(
            evaluate(
                &release_for("1.0.1-beta.1", None),
                &current,
                &settings,
                false
            )
            .available
        );
        assert!(!evaluate(&release_for("1.0.0", None), &current, &settings, false).available);
        assert!(!evaluate(&release_for("0.9.0", None), &current, &settings, false).available);
        let info = evaluate(&release_for("1.1.0", None), &current, &settings, false);
        assert_eq!(info.latest_version, "1.1.0");
        assert_eq!(info.notes, "- Faster replies");
        assert_eq!(
            info.asset.unwrap().file_name,
            "Glee_9.0.0_x64-setup.exe".to_string()
        );
    }

    #[test]
    fn mandatory_follows_the_minimum_supported_version() {
        let settings = StoredSettings::default();
        let release = release_for("2.0.0", Some("1.5.0"));
        assert!(
            evaluate(
                &release,
                &Version::parse("1.4.0").unwrap(),
                &settings,
                false
            )
            .mandatory
        );
        assert!(
            !evaluate(
                &release,
                &Version::parse("1.5.0").unwrap(),
                &settings,
                false
            )
            .mandatory
        );
        let up_to_date = evaluate(
            &release,
            &Version::parse("2.0.0").unwrap(),
            &settings,
            false,
        );
        assert!(!up_to_date.mandatory && !up_to_date.available);
    }

    #[test]
    fn skipped_versions_are_hidden_unless_checked_manually_or_mandatory() {
        let current = Version::parse("1.0.0").unwrap();
        let settings = StoredSettings {
            auto_check: None,
            skipped_version: Some("1.1.0".to_string()),
        };
        let release = release_for("1.1.0", None);
        let automatic = evaluate(&release, &current, &settings, false);
        assert!(!automatic.available && automatic.skipped);
        assert!(evaluate(&release, &current, &settings, true).available);
        let newer = release_for("1.2.0", None);
        assert!(evaluate(&newer, &current, &settings, false).available);
        let forced = release_for("1.1.0", Some("1.0.5"));
        let info = evaluate(&forced, &current, &settings, false);
        assert!(info.mandatory && info.available && !info.skipped);
    }

    #[test]
    fn malformed_manifests_are_rejected() {
        let policy = github_policy();
        let parse = |text: &str| parse_manifest(text, &policy, Some("windows-x64"));
        assert!(parse("not json").is_err());
        assert!(parse("{}").is_err());
        let good = manifest_json(
            "1.2.3",
            "https://github.com/example/glee/releases/download/v1/x.exe",
            b"abc",
        );
        assert!(parse(&good.to_string()).is_ok());
        for (field, value) in [
            ("version", serde_json::json!("not-a-version")),
            ("schemaVersion", serde_json::json!(2)),
            ("minSupportedVersion", serde_json::json!("x")),
            ("pageUrl", serde_json::json!("http://github.com/a")),
        ] {
            let mut broken = good.clone();
            broken[field] = value;
            assert!(parse(&broken.to_string()).is_err(), "{field}");
        }
        for (field, value) in [
            ("sha256", serde_json::json!("zz")),
            ("sizeBytes", serde_json::json!(0)),
            ("sizeBytes", serde_json::json!(MAX_INSTALLER_BYTES + 1)),
            ("fileName", serde_json::json!("../evil.exe")),
            ("fileName", serde_json::json!("setup.msi")),
        ] {
            let mut broken = good.clone();
            broken["assets"]["windows-x64"][field] = value;
            assert!(parse(&broken.to_string()).is_err(), "{field}");
        }
    }

    #[test]
    fn urls_outside_the_allow_list_are_rejected() {
        let policy = github_policy();
        for url in [
            "https://evil.example/x.exe",
            "http://github.com/x.exe",
            "https://github.com.evil.example/x.exe",
            "https://notgithubusercontent.com/x.exe",
            "ftp://github.com/x.exe",
        ] {
            let json = manifest_json("1.2.3", url, b"abc");
            assert!(
                parse_manifest(&json.to_string(), &policy, Some("windows-x64")).is_err(),
                "{url}"
            );
        }
        for url in [
            "https://github.com/a/b/releases/download/v1/x.exe",
            "https://objects.githubusercontent.com/x.exe",
            "https://release-assets.githubusercontent.com/x.exe",
        ] {
            let json = manifest_json("1.2.3", url, b"abc");
            assert!(parse_manifest(&json.to_string(), &policy, Some("windows-x64")).is_ok());
        }
        let mirror = UpdateSource::from_url(
            "https://github.com/a/b/releases/latest/download/latest.json",
            &["downloads.example.com".to_string()],
        )
        .unwrap()
        .unwrap();
        let json = manifest_json("1.2.3", "https://downloads.example.com/x.exe", b"abc");
        assert!(parse_manifest(&json.to_string(), &mirror.policy, Some("windows-x64")).is_ok());
        assert!(UpdateSource::from_url("http://github.com/x.json", &[]).is_err());
    }

    #[test]
    fn notes_are_capped_and_stripped_of_control_characters() {
        let mut json = manifest_json(
            "1.2.3",
            "https://github.com/a/b/releases/download/v1/x.exe",
            b"abc",
        );
        json["notes"] = format!("hello\u{0007}\nworld{}", "x".repeat(MAX_NOTES_CHARS)).into();
        let release =
            parse_manifest(&json.to_string(), &github_policy(), Some("windows-x64")).unwrap();
        assert!(release.notes.starts_with("hello\nworld"));
        assert_eq!(release.notes.chars().count(), MAX_NOTES_CHARS);
    }

    #[test]
    fn fetches_the_manifest_and_enforces_the_size_cap_and_redirect_rules() {
        let bytes = b"installer";
        let probe = TestServer::start(vec![]);
        let json = manifest_json("9.0.0", &probe.url("installer.exe"), bytes).to_string();
        let big = format!("{{\"pad\":\"{}\"}}", "a".repeat(MAX_MANIFEST_BYTES));
        let server = TestServer::start(vec![
            ("latest.json".to_string(), json.into_bytes()),
            ("big.json".to_string(), big.into_bytes()),
        ]);
        let source = |path: &str| {
            UpdateSource::from_url(&server.url(path), &[])
                .unwrap()
                .unwrap()
        };
        let settings = StoredSettings::default();

        let info = block_on(check(Some(&source("latest.json")), &settings, false)).unwrap();
        assert!(info.available);
        assert_eq!(info.latest_version, "9.0.0");
        assert_eq!(info.current_version, env!("CARGO_PKG_VERSION"));

        assert!(block_on(check(Some(&source("big.json")), &settings, false)).is_err());
        assert!(block_on(check(Some(&source("missing.json")), &settings, false)).is_err());
        assert!(block_on(check(Some(&source("redirect")), &settings, false)).is_err());

        let off = StoredSettings {
            auto_check: Some(false),
            skipped_version: None,
        };
        let hits = server.hits.load(Ordering::SeqCst);
        let silent = block_on(check(Some(&source("latest.json")), &off, false)).unwrap();
        assert!(!silent.available);
        assert_eq!(server.hits.load(Ordering::SeqCst), hits);
        assert!(
            block_on(check(Some(&source("latest.json")), &off, true))
                .unwrap()
                .available
        );
        assert!(!block_on(check(None, &settings, true)).unwrap().available);
    }

    fn asset_for(server: &TestServer, bytes: &[u8]) -> Asset {
        Asset {
            file_name: "Glee_9.0.0_x64-setup.exe".to_string(),
            url: Url::parse(&server.url("installer.exe")).unwrap(),
            size_bytes: bytes.len() as u64,
            sha256: sha_of(bytes),
        }
    }

    fn payload() -> Vec<u8> {
        (0..300_000_u32).map(|value| (value % 251) as u8).collect()
    }

    #[test]
    fn downloads_and_verifies_the_installer() {
        let bytes = payload();
        let server = TestServer::start(vec![("installer.exe".to_string(), bytes.clone())]);
        let asset = asset_for(&server, &bytes);
        let dir = temp_dir("ok");
        let sink = RecordingSink::new();
        let client = build_client(&loopback_policy(), None).unwrap();
        let path = block_on(download_asset(
            &client,
            &asset,
            &dir,
            &AtomicBool::new(false),
            &sink,
        ))
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(!dir.join("Glee_9.0.0_x64-setup.exe.part").exists());
        let events = sink.0.lock().unwrap();
        assert_eq!(events.last().unwrap().phase, "done");
        assert!(events.iter().any(|event| event.phase == "verifying"));

        // A verified file is reused without another request.
        drop(events);
        let hits = server.hits.load(Ordering::SeqCst);
        block_on(download_asset(
            &client,
            &asset,
            &dir,
            &AtomicBool::new(false),
            &sink,
        ))
        .unwrap();
        assert_eq!(server.hits.load(Ordering::SeqCst), hits);
    }

    #[test]
    fn checksum_mismatch_is_rejected_and_nothing_is_kept() {
        let bytes = payload();
        let server = TestServer::start(vec![("installer.exe".to_string(), bytes.clone())]);
        let mut asset = asset_for(&server, &bytes);
        asset.sha256 = sha_of(b"something else");
        let dir = temp_dir("mismatch");
        let client = build_client(&loopback_policy(), None).unwrap();
        let error = block_on(download_asset(
            &client,
            &asset,
            &dir,
            &AtomicBool::new(false),
            &RecordingSink::new(),
        ))
        .unwrap_err();
        assert!(error.to_string().contains("integrity check"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn resumes_from_a_partial_file() {
        let bytes = payload();
        let server = TestServer::start(vec![("installer.exe".to_string(), bytes.clone())]);
        let asset = asset_for(&server, &bytes);
        let dir = temp_dir("resume");
        std::fs::write(
            dir.join("Glee_9.0.0_x64-setup.exe.part"),
            &bytes[..bytes.len() / 3],
        )
        .unwrap();
        let sink = RecordingSink::new();
        let client = build_client(&loopback_policy(), None).unwrap();
        let path = block_on(download_asset(
            &client,
            &asset,
            &dir,
            &AtomicBool::new(false),
            &sink,
        ))
        .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        let first = sink.0.lock().unwrap()[0].downloaded_bytes;
        assert!(first > (bytes.len() / 3) as u64);
    }

    #[test]
    fn cancel_stops_the_download_and_keeps_the_partial_file() {
        let bytes = payload();
        let server = TestServer::start(vec![("installer.exe".to_string(), bytes.clone())]);
        let asset = asset_for(&server, &bytes);
        let dir = temp_dir("cancel");
        let sink = RecordingSink::new();
        let client = build_client(&loopback_policy(), None).unwrap();
        let error = block_on(download_asset(
            &client,
            &asset,
            &dir,
            &AtomicBool::new(true),
            &sink,
        ))
        .unwrap_err();
        assert!(error.to_string().contains("cancelled"));
        assert!(!dir.join("Glee_9.0.0_x64-setup.exe").exists());
        assert_eq!(sink.0.lock().unwrap().last().unwrap().phase, "cancelled");
    }

    #[test]
    fn only_the_downloaded_file_can_be_installed() {
        let dir = temp_dir("install");
        let file = dir.join("Glee_9.0.0_x64-setup.exe");
        std::fs::write(&file, b"x").unwrap();
        let text = file.to_string_lossy().into_owned();
        assert_eq!(validate_installer_path(&text, Some(&file)).unwrap(), file);
        assert!(validate_installer_path(&text, None).is_err());
        assert!(validate_installer_path("/somewhere/else.exe", Some(&file)).is_err());
        std::fs::remove_file(&file).unwrap();
        assert!(validate_installer_path(&text, Some(&file)).is_err());

        let (program, args) = opener_command(Path::new("/tmp/Glee.dmg"));
        assert!(!program.is_empty());
        assert_eq!(args.last().unwrap(), "/tmp/Glee.dmg");
        assert_eq!(should_quit_after_install(), cfg!(windows));
    }
}
