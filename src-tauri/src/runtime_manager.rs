use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    net::TcpListener,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessesToUpdate, Signal, System};
use tauri::{AppHandle, Manager};
use tokio::{process::Child, process::Command, sync::Mutex, time::sleep};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::{
    runtime_selection::annotate_selection_from_log,
    types::{RuntimePhase, RuntimeSelectionInfo, RuntimeStatusResponse},
};

const BASE_HEALTH_TIMEOUT: Duration = Duration::from_secs(90);
const WARMUP_HEALTH_TIMEOUT_BONUS: Duration = Duration::from_secs(120);
const GPU_OFFLOAD_HEALTH_TIMEOUT_BONUS: Duration = Duration::from_secs(30);
const MAX_HEALTH_TIMEOUT: Duration = Duration::from_secs(300);
const RUNTIME_LOG_RETENTION: usize = 8;
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
const RUNTIME_LOG_TAIL_BYTES: usize = 4096;
const RUNTIME_OWNER_RECORD_MAX_BYTES: u64 = 64 * 1024;
const RUNTIME_OWNER_RECORD_FILE: &str = "runtime-owner.json";
const EMBEDDING_RUNTIME_OWNER_RECORD_FILE: &str = "embedding-runtime-owner.json";
#[cfg(test)]
const DEFAULT_RUNTIME_LOG_LABEL: &str = "runtime";
const CHAT_RUNTIME_LOG_LABEL: &str = "chat";
const EMBEDDING_RUNTIME_LOG_LABEL: &str = "embedding";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone)]
pub struct RuntimeStartRequest {
    pub model_id: String,
    pub model_path: PathBuf,
    pub binary_path: PathBuf,
    pub extra_args: Vec<String>,
    pub selection: Option<RuntimeSelectionInfo>,
}

#[derive(Debug)]
struct RuntimeInner {
    child: Option<Child>,
    status: RuntimeStatusResponse,
    fingerprint: Option<RuntimeLaunchFingerprint>,
    generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeLaunchFingerprint {
    model_id: String,
    model_path: PathBuf,
    binary_path: PathBuf,
    effective_args: Vec<String>,
    selection: Option<RuntimeSelectionInfo>,
}

#[derive(Debug, Clone)]
struct RuntimeOwnership {
    instance_id: String,
    owner_pid: u32,
    owner_process_start_time: u64,
    record_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OwnedRuntimeProcessRecord {
    instance_id: String,
    owner_pid: u32,
    owner_process_start_time: u64,
    runtime_pid: u32,
    runtime_process_start_time: u64,
    binary_path: PathBuf,
    port: u16,
    started_at: String,
}

#[derive(Clone)]
pub struct RuntimeManager {
    inner: Arc<Mutex<RuntimeInner>>,
    operation: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
    ownership: Option<RuntimeOwnership>,
    log_label: &'static str,
    client: Client,
}

impl RuntimeManager {
    #[cfg(test)]
    pub fn new() -> AppResult<Self> {
        Self::with_ownership(None, DEFAULT_RUNTIME_LOG_LABEL)
    }

    pub fn new_for_app_data_dir(app_data_dir: &Path) -> AppResult<Self> {
        Self::new_owned(
            app_data_dir,
            RUNTIME_OWNER_RECORD_FILE,
            CHAT_RUNTIME_LOG_LABEL,
        )
    }

    pub fn new_for_embedding_app_data_dir(app_data_dir: &Path) -> AppResult<Self> {
        Self::new_owned(
            app_data_dir,
            EMBEDDING_RUNTIME_OWNER_RECORD_FILE,
            EMBEDDING_RUNTIME_LOG_LABEL,
        )
    }

    fn new_owned(
        app_data_dir: &Path,
        owner_record_file: &str,
        log_label: &'static str,
    ) -> AppResult<Self> {
        fs::create_dir_all(app_data_dir)?;
        let ownership = RuntimeOwnership::new(app_data_dir, owner_record_file)?;
        cleanup_stale_owned_runtime_process(&ownership.record_path);
        Self::with_ownership(Some(ownership), log_label)
    }

    fn with_ownership(
        ownership: Option<RuntimeOwnership>,
        log_label: &'static str,
    ) -> AppResult<Self> {
        let client = Client::builder().timeout(Duration::from_secs(2)).build()?;
        Ok(Self {
            inner: Arc::new(Mutex::new(RuntimeInner {
                child: None,
                status: RuntimeStatusResponse::stopped(),
                fingerprint: None,
                generation: 0,
            })),
            operation: Arc::new(Mutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
            ownership,
            log_label,
            client,
        })
    }

    pub async fn start(
        &self,
        app_handle: &AppHandle<impl tauri::Runtime>,
        request: RuntimeStartRequest,
    ) -> AppResult<RuntimeStatusResponse> {
        if !request.model_path.exists() || !request.model_path.is_file() {
            return Err(AppError::Validation(format!(
                "model path is invalid: {}",
                request.model_path.to_string_lossy()
            )));
        }
        if !request.binary_path.is_file() {
            return Err(AppError::Runtime(format!(
                "llama-server was not found at {}. Restart Glee to repair its AI engine.",
                request.binary_path.to_string_lossy()
            )));
        }

        let _operation = self.operation.lock().await;
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let binary = request.binary_path.clone();
        let fingerprint = RuntimeLaunchFingerprint {
            model_id: request.model_id.clone(),
            model_path: canonical_or_original(&request.model_path),
            binary_path: canonical_or_original(&binary),
            effective_args: request.extra_args.clone(),
            selection: request.selection.clone(),
        };

        let mut child_to_stop = None;
        {
            let mut state = self.inner.lock().await;
            if let Some(child) = state.child.as_mut() {
                if child.try_wait()?.is_none() {
                    if state.fingerprint.as_ref() == Some(&fingerprint) {
                        return Ok(state.status.clone());
                    }
                    child_to_stop = state.child.take();
                    state.status = RuntimeStatusResponse::stopped();
                    state.fingerprint = None;
                } else {
                    state.child = None;
                    state.status = RuntimeStatusResponse::stopped();
                    state.fingerprint = None;
                    self.remove_owned_process_record();
                }
            }
            state.generation = generation;
        }

        if let Some(mut child) = child_to_stop {
            if child.try_wait()?.is_none() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            self.remove_owned_process_record();
        }

        let port = select_free_port()?;
        let endpoint = format!("http://127.0.0.1:{port}");
        let log_dir = resolve_log_dir(app_handle).await?;
        prune_runtime_logs(&log_dir, self.log_label);
        let log_path = log_dir.join(format!(
            "llama-server-{}-{}-{}.log",
            self.log_label,
            Utc::now().format("%Y%m%d-%H%M%S"),
            Uuid::new_v4()
        ));
        let stdout = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        let stderr = stdout.try_clone()?;
        // Every launch gets a fresh key so other local programs and web pages
        // cannot use the server or read conversations from it.
        let api_key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let key_path = log_dir.join(format!("llama-server-{}.key", self.log_label));
        write_private_file(&key_path, api_key.as_bytes())?;

        let mut command = Command::new(&binary);
        command
            .arg("-m")
            .arg(&request.model_path)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--api-key-file")
            .arg(&key_path)
            .arg("--no-webui")
            .arg("--no-slots")
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if let Some(dir) = binary.parent() {
            command.current_dir(dir);
        }
        for arg in request
            .extra_args
            .iter()
            .filter(|arg| !arg.trim().is_empty())
        {
            command.arg(arg);
        }
        command.kill_on_drop(true);

        #[cfg(target_os = "windows")]
        {
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| AppError::Runtime(format!("failed to spawn llama-server: {error}")))?;
        let pid = child.id();
        let started_at = Utc::now().to_rfc3339();
        if let (Some(pid), Some(ownership)) = (pid, self.ownership.as_ref()) {
            if let Err(error) =
                write_owned_process_record(ownership, pid, &binary, port, started_at.clone())
            {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(error);
            }
        }
        let status = RuntimeStatusResponse {
            state: RuntimePhase::Starting,
            endpoint: Some(endpoint.clone()),
            port: Some(port),
            pid,
            model_id: Some(request.model_id),
            started_at: Some(started_at),
            log_file: Some(log_path.to_string_lossy().to_string()),
            error: None,
            selection: request.selection.clone(),
            api_key: Some(api_key),
        };

        {
            let mut state = self.inner.lock().await;
            state.child = Some(child);
            state.status = status;
            state.fingerprint = Some(fingerprint);
            state.generation = generation;
        }

        let health_timeout = runtime_health_timeout(&request.extra_args);
        self.wait_for_health(&endpoint, health_timeout, generation)
            .await?;

        let mut state = self.inner.lock().await;
        if state.generation != generation || self.generation.load(Ordering::Acquire) != generation {
            drop(state);
            self.terminate_cancelled(generation).await?;
            return Err(AppError::Runtime(
                "runtime start was cancelled by a newer lifecycle operation".to_string(),
            ));
        }
        state.status.state = RuntimePhase::Ready;
        state.status.error = None;
        if let Some(selection) = state.status.selection.as_mut() {
            annotate_selection_from_log(selection, &log_path);
        }
        Ok(state.status.clone())
    }

    pub async fn stop(&self) -> AppResult<RuntimeStatusResponse> {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let _operation = self.operation.lock().await;
        let child = {
            let mut state = self.inner.lock().await;
            let child = state.child.take();
            state.status = RuntimeStatusResponse::stopped();
            state.fingerprint = None;
            state.generation = generation;
            child
        };

        if let Some(mut child) = child {
            if child.try_wait()?.is_none() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        self.remove_owned_process_record();

        let state = self.inner.lock().await;
        Ok(state.status.clone())
    }

    pub async fn status(&self) -> AppResult<RuntimeStatusResponse> {
        let mut state = self.inner.lock().await;
        if let Some(child) = state.child.as_mut() {
            if let Some(exit_status) = child.try_wait()? {
                let message = format_runtime_exit_message(
                    &exit_status,
                    state.status.log_file.as_deref(),
                    false,
                );
                state.child = None;
                let mut stopped = RuntimeStatusResponse::stopped();
                stopped.log_file = state.status.log_file.clone();
                stopped.error = Some(message);
                stopped.selection = state.status.selection.clone();
                state.status = stopped;
                state.fingerprint = None;
                self.remove_owned_process_record();
            }
        }
        Ok(state.status.clone())
    }

    async fn wait_for_health(
        &self,
        endpoint: &str,
        health_timeout: Duration,
        generation: u64,
    ) -> AppResult<()> {
        let health_url = format!("{endpoint}/health");
        let deadline = Instant::now() + health_timeout;

        loop {
            if self.generation.load(Ordering::Acquire) != generation {
                self.terminate_cancelled(generation).await?;
                return Err(AppError::Runtime(
                    "runtime start was cancelled by a newer lifecycle operation".to_string(),
                ));
            }
            if let Ok(response) = self.client.get(&health_url).send().await {
                if response.status().is_success() {
                    return Ok(());
                }
            }

            {
                let mut state = self.inner.lock().await;
                if let Some(child) = state.child.as_mut() {
                    if let Some(exit_status) = child.try_wait()? {
                        state.child = None;
                        let message = format_runtime_exit_message(
                            &exit_status,
                            state.status.log_file.as_deref(),
                            true,
                        );
                        state.status.state = RuntimePhase::Error;
                        state.status.error = Some(message.clone());
                        state.fingerprint = None;
                        self.remove_owned_process_record();
                        return Err(AppError::Runtime(message));
                    }
                } else {
                    return Err(AppError::Runtime(
                        "llama-server process handle is missing".to_string(),
                    ));
                }
            }

            if Instant::now() >= deadline {
                let timeout_message = {
                    let state = self.inner.lock().await;
                    enrich_runtime_error_message(
                        format!(
                            "timed out waiting for llama-server /health endpoint after {}s",
                            health_timeout.as_secs()
                        ),
                        state.status.log_file.as_deref(),
                    )
                };
                self.terminate_with_error_locked(timeout_message.clone(), generation)
                    .await?;
                return Err(AppError::Runtime(timeout_message));
            }

            sleep(HEALTH_POLL_INTERVAL).await;
        }
    }

    #[cfg(test)]
    async fn terminate_with_error(&self, message: String) -> AppResult<()> {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let _operation = self.operation.lock().await;
        self.terminate_with_error_locked(message, generation).await
    }

    async fn terminate_with_error_locked(&self, message: String, generation: u64) -> AppResult<()> {
        let child = {
            let mut state = self.inner.lock().await;
            state.status.state = RuntimePhase::Error;
            state.status.error = Some(message);
            state.fingerprint = None;
            state.generation = generation;
            state.child.take()
        };

        if let Some(mut child) = child {
            if child.try_wait()?.is_none() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        self.remove_owned_process_record();

        Ok(())
    }

    async fn terminate_cancelled(&self, generation: u64) -> AppResult<()> {
        let child = {
            let mut state = self.inner.lock().await;
            if state.generation != generation {
                return Ok(());
            }
            let child = state.child.take();
            state.status = RuntimeStatusResponse::stopped();
            state.fingerprint = None;
            child
        };
        if let Some(mut child) = child {
            if child.try_wait()?.is_none() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
        self.remove_owned_process_record();
        Ok(())
    }

    fn remove_owned_process_record(&self) {
        let Some(ownership) = self.ownership.as_ref() else {
            return;
        };
        let Some(record) = read_owned_process_record(&ownership.record_path) else {
            return;
        };
        if record.instance_id == ownership.instance_id {
            let _ = fs::remove_file(&ownership.record_path);
        }
    }
}

fn runtime_health_timeout(extra_args: &[String]) -> Duration {
    let warmup_enabled = !extra_args
        .iter()
        .any(|arg| arg.trim().eq_ignore_ascii_case("--no-warmup"));
    let gpu_layers_requested = parse_gpu_layers(extra_args);

    let mut timeout = BASE_HEALTH_TIMEOUT;
    if warmup_enabled {
        timeout = timeout.saturating_add(WARMUP_HEALTH_TIMEOUT_BONUS);
    }
    if gpu_layers_requested != 0 || extra_args.iter().any(|arg| arg == "--device") {
        timeout = timeout.saturating_add(GPU_OFFLOAD_HEALTH_TIMEOUT_BONUS);
    }

    timeout.min(MAX_HEALTH_TIMEOUT)
}

fn parse_gpu_layers(extra_args: &[String]) -> i64 {
    let mut index = 0;
    while index < extra_args.len() {
        let current = extra_args[index].trim();
        if current.eq_ignore_ascii_case("-ngl") || current.eq_ignore_ascii_case("--n-gpu-layers") {
            return extra_args
                .get(index + 1)
                .and_then(|value| value.trim().parse::<i64>().ok())
                .unwrap_or(0);
        }
        index += 1;
    }
    0
}

impl RuntimeOwnership {
    fn new(app_data_dir: &Path, record_file: &str) -> AppResult<Self> {
        let owner_pid = std::process::id();
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(owner_pid)]), true);
        let owner_process_start_time = system
            .process(Pid::from_u32(owner_pid))
            .map(|process| process.start_time())
            .ok_or_else(|| {
                AppError::Runtime("failed to identify the Glee owner process".to_string())
            })?;
        Ok(Self {
            instance_id: Uuid::new_v4().to_string(),
            owner_pid,
            owner_process_start_time,
            record_path: app_data_dir.join(record_file),
        })
    }
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn write_owned_process_record(
    ownership: &RuntimeOwnership,
    runtime_pid: u32,
    binary_path: &Path,
    port: u16,
    started_at: String,
) -> AppResult<()> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(runtime_pid)]), true);
    let runtime_process_start_time = system
        .process(Pid::from_u32(runtime_pid))
        .map(|process| process.start_time())
        .ok_or_else(|| {
            AppError::Runtime(
                "spawned llama-server disappeared before ownership was recorded".to_string(),
            )
        })?;
    let record = OwnedRuntimeProcessRecord {
        instance_id: ownership.instance_id.clone(),
        owner_pid: ownership.owner_pid,
        owner_process_start_time: ownership.owner_process_start_time,
        runtime_pid,
        runtime_process_start_time,
        binary_path: canonical_or_original(binary_path),
        port,
        started_at,
    };
    let bytes = serde_json::to_vec_pretty(&record).map_err(|error| {
        AppError::Runtime(format!("failed to serialize runtime ownership: {error}"))
    })?;
    let temp_path = ownership
        .record_path
        .with_extension(format!("{}.tmp", ownership.instance_id));
    fs::write(&temp_path, bytes)?;
    if ownership.record_path.exists() {
        fs::remove_file(&ownership.record_path)?;
    }
    fs::rename(temp_path, &ownership.record_path)?;
    Ok(())
}

fn cleanup_stale_owned_runtime_process(record_path: &Path) {
    let Some(record) = read_owned_process_record(record_path) else {
        let _ = fs::remove_file(record_path);
        return;
    };

    let mut system = System::new();
    system.refresh_processes(
        ProcessesToUpdate::Some(&[
            Pid::from_u32(record.owner_pid),
            Pid::from_u32(record.runtime_pid),
        ]),
        true,
    );
    let owner_is_live = process_identity_matches(
        &system,
        record.owner_pid,
        record.owner_process_start_time,
        None,
    );
    if owner_is_live {
        return;
    }

    let runtime_binary = canonical_or_original(&record.binary_path);
    if process_identity_matches(
        &system,
        record.runtime_pid,
        record.runtime_process_start_time,
        Some(&runtime_binary),
    ) {
        if let Some(process) = system.process(Pid::from_u32(record.runtime_pid)) {
            if process.kill_with(Signal::Kill).is_none() {
                let _ = process.kill();
            }
        }
    }
    let _ = fs::remove_file(record_path);
}

fn read_owned_process_record(record_path: &Path) -> Option<OwnedRuntimeProcessRecord> {
    let metadata = fs::metadata(record_path).ok()?;
    if metadata.len() > RUNTIME_OWNER_RECORD_MAX_BYTES {
        return None;
    }
    let file = fs::File::open(record_path).ok()?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(RUNTIME_OWNER_RECORD_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > RUNTIME_OWNER_RECORD_MAX_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn process_identity_matches(
    system: &System,
    pid: u32,
    start_time: u64,
    executable: Option<&Path>,
) -> bool {
    let Some(process) = system.process(Pid::from_u32(pid)) else {
        return false;
    };
    if process.start_time() != start_time {
        return false;
    }
    match executable {
        None => true,
        Some(expected) => process
            .exe()
            .map(canonical_or_original)
            .is_some_and(|actual| actual == expected),
    }
}

async fn resolve_log_dir(app_handle: &AppHandle<impl tauri::Runtime>) -> AppResult<PathBuf> {
    let log_dir = match app_handle.path().app_log_dir() {
        Ok(path) => path,
        Err(_) => app_handle
            .path()
            .app_data_dir()
            .map_err(|error| AppError::Path(format!("failed to resolve app data dir: {error}")))?
            .join("logs"),
    };
    tokio::fs::create_dir_all(&log_dir).await?;
    Ok(log_dir)
}

/// Keeps the newest runtime logs for a role so a long-lived install does not
/// accumulate one log per launch forever.
fn prune_runtime_logs(log_dir: &Path, log_label: &str) {
    let prefix = format!("llama-server-{log_label}-");
    let Ok(entries) = fs::read_dir(log_dir) else {
        return;
    };
    let mut logs = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".log"))
        })
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect::<Vec<_>>();
    if logs.len() < RUNTIME_LOG_RETENTION {
        return;
    }
    logs.sort_by(|left, right| right.0.cmp(&left.0));
    for (_, path) in logs.into_iter().skip(RUNTIME_LOG_RETENTION - 1) {
        let _ = fs::remove_file(path);
    }
}

fn write_private_file(path: &Path, bytes: &[u8]) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)?;
    }
    #[cfg(not(unix))]
    fs::write(path, bytes)?;
    Ok(())
}

fn select_free_port() -> AppResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

fn format_runtime_exit_message(
    exit_status: &std::process::ExitStatus,
    log_file: Option<&str>,
    during_startup: bool,
) -> String {
    let phase = if during_startup {
        "during startup "
    } else {
        ""
    };

    #[cfg_attr(not(target_os = "windows"), allow(unused_mut))]
    let mut message = format!("llama-server exited {phase}with status {exit_status}.");

    #[cfg(target_os = "windows")]
    if let Some(code) = exit_status.code() {
        let windows_code = code as u32;
        if windows_code == 0xC0000135 {
            message.push_str(
                " Required Windows runtime DLLs are missing from the bundled llama.cpp runtime (0xC0000135 / STATUS_DLL_NOT_FOUND).",
            );
        }
    }

    enrich_runtime_error_message(message, log_file)
}

fn enrich_runtime_error_message(message: String, log_file: Option<&str>) -> String {
    let Some(path) = log_file.map(str::trim).filter(|path| !path.is_empty()) else {
        return message;
    };

    let mut enriched = format!("{message} Log: {path}");
    if let Some(tail) = read_runtime_log_tail(path) {
        enriched.push_str("\n\nRecent runtime log tail:\n");
        enriched.push_str(&tail);
    }
    enriched
}

fn read_runtime_log_tail(path: &str) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(RUNTIME_LOG_TAIL_BYTES as u64);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.take(RUNTIME_LOG_TAIL_BYTES as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    let tail = String::from_utf8_lossy(&bytes).trim().to_string();
    if tail.is_empty() {
        None
    } else {
        Some(tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RuntimePhase;
    use std::{env::temp_dir, fs, path::PathBuf};
    use uuid::Uuid;

    #[test]
    fn new_manager_starts_stopped() {
        let manager = RuntimeManager::new().expect("manager should initialize");
        let status = tauri::async_runtime::block_on(async { manager.status().await })
            .expect("status should resolve");
        assert_eq!(status.state, RuntimePhase::Stopped);
        assert!(status.error.is_none());
    }

    #[test]
    fn chat_and_embedding_runtimes_use_distinct_ownership_records() {
        let root = temp_dir().join(format!("glee-runtime-roles-{}", Uuid::new_v4()));
        let chat = RuntimeManager::new_for_app_data_dir(&root)
            .expect("chat runtime manager should initialize");
        let embedding = RuntimeManager::new_for_embedding_app_data_dir(&root)
            .expect("embedding runtime manager should initialize");

        assert_eq!(chat.log_label, CHAT_RUNTIME_LOG_LABEL);
        assert_eq!(embedding.log_label, EMBEDDING_RUNTIME_LOG_LABEL);
        assert_eq!(
            chat.ownership
                .as_ref()
                .and_then(|ownership| ownership.record_path.file_name())
                .and_then(|name| name.to_str()),
            Some(RUNTIME_OWNER_RECORD_FILE)
        );
        assert_eq!(
            embedding
                .ownership
                .as_ref()
                .and_then(|ownership| ownership.record_path.file_name())
                .and_then(|name| name.to_str()),
            Some(EMBEDDING_RUNTIME_OWNER_RECORD_FILE)
        );

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn stop_on_idle_manager_is_safe() {
        let manager = RuntimeManager::new().expect("manager should initialize");
        let status = tauri::async_runtime::block_on(async { manager.stop().await })
            .expect("stop should resolve");
        assert_eq!(status.state, RuntimePhase::Stopped);
    }

    #[test]
    fn terminate_with_error_sets_error_state() {
        let manager = RuntimeManager::new().expect("manager should initialize");
        tauri::async_runtime::block_on(async {
            manager
                .terminate_with_error("boom".to_string())
                .await
                .expect("terminate should resolve");
            let status = manager.status().await.expect("status should resolve");
            assert_eq!(status.state, RuntimePhase::Error);
            assert_eq!(status.error.as_deref(), Some("boom"));
        });
    }

    #[test]
    fn enriches_runtime_error_with_log_tail() {
        let log_path: PathBuf = temp_dir().join(format!("glee-runtime-log-{}.log", Uuid::new_v4()));
        fs::write(&log_path, "alpha\nbeta\nrecent line\n").expect("log file should be written");
        let message = enrich_runtime_error_message(
            "timed out waiting for llama-server /health endpoint".to_string(),
            Some(log_path.to_string_lossy().as_ref()),
        );
        fs::remove_file(&log_path).ok();

        assert!(message.contains("Log:"));
        assert!(message.contains("Recent runtime log tail:"));
        assert!(message.contains("recent line"));
    }

    #[test]
    fn prune_runtime_logs_keeps_only_recent_logs_for_the_role() {
        let root = temp_dir().join(format!("glee-runtime-logs-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("log dir should be created");
        for index in 0..12 {
            fs::write(
                root.join(format!("llama-server-chat-{index:02}.log")),
                b"log",
            )
            .expect("log should be written");
        }
        fs::write(root.join("llama-server-embedding-01.log"), b"log").expect("other role log");
        prune_runtime_logs(&root, "chat");
        let remaining = fs::read_dir(&root)
            .expect("log dir should be readable")
            .filter(|entry| {
                entry
                    .as_ref()
                    .is_ok_and(|entry| entry.file_name().to_string_lossy().contains("-chat-"))
            })
            .count();
        assert_eq!(remaining, RUNTIME_LOG_RETENTION - 1);
        assert!(root.join("llama-server-embedding-01.log").exists());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn select_free_port_returns_bindable_port() {
        let port = select_free_port().expect("port should resolve");
        let listener = TcpListener::bind(("127.0.0.1", port)).expect("port should be reusable");
        drop(listener);
    }

    #[test]
    fn runtime_health_timeout_stays_fast_without_warmup_or_gpu_offload() {
        let timeout = runtime_health_timeout(&[
            "--ctx-size".to_string(),
            "4096".to_string(),
            "--no-warmup".to_string(),
            "-ngl".to_string(),
            "0".to_string(),
        ]);
        assert_eq!(timeout, BASE_HEALTH_TIMEOUT);
    }

    #[test]
    fn runtime_health_timeout_extends_for_warmup_and_gpu_offload() {
        let timeout = runtime_health_timeout(&[
            "--ctx-size".to_string(),
            "4096".to_string(),
            "--device".to_string(),
            "Vulkan0".to_string(),
        ]);
        assert_eq!(
            timeout,
            BASE_HEALTH_TIMEOUT
                .saturating_add(WARMUP_HEALTH_TIMEOUT_BONUS)
                .saturating_add(GPU_OFFLOAD_HEALTH_TIMEOUT_BONUS)
        );
    }

    #[test]
    fn launch_fingerprint_changes_when_effective_settings_change() {
        let baseline = RuntimeLaunchFingerprint {
            model_id: "model-1".to_string(),
            model_path: PathBuf::from("model.gguf"),
            binary_path: PathBuf::from("llama-server"),
            effective_args: vec!["--ctx-size".to_string(), "4096".to_string()],
            selection: None,
        };
        let mut changed = baseline.clone();
        changed
            .effective_args
            .extend(["-ngl".to_string(), "8".to_string()]);

        assert_ne!(baseline, changed);
        assert_eq!(baseline, baseline.clone());
    }

    #[test]
    fn stale_cleanup_requires_exact_owner_and_runtime_process_identities() {
        let root = temp_dir().join(format!("glee-runtime-owner-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temporary owner directory should be created");
        let record_path = root.join(RUNTIME_OWNER_RECORD_FILE);
        let current_pid = std::process::id();
        let current_exe = std::env::current_exe().expect("current executable should resolve");
        let mut system = System::new_all();
        system.refresh_processes(ProcessesToUpdate::All, true);
        let current_start_time = system
            .process(Pid::from_u32(current_pid))
            .expect("current process should be visible")
            .start_time();
        let record = OwnedRuntimeProcessRecord {
            instance_id: Uuid::new_v4().to_string(),
            owner_pid: u32::MAX,
            owner_process_start_time: 0,
            runtime_pid: current_pid,
            runtime_process_start_time: current_start_time.saturating_add(1),
            binary_path: current_exe,
            port: 12345,
            started_at: Utc::now().to_rfc3339(),
        };
        fs::write(
            &record_path,
            serde_json::to_vec(&record).expect("ownership record should serialize"),
        )
        .expect("ownership record should be written");

        cleanup_stale_owned_runtime_process(&record_path);

        assert!(!record_path.exists());
        assert!(system.process(Pid::from_u32(current_pid)).is_some());
        fs::remove_dir_all(root).ok();
    }
}
