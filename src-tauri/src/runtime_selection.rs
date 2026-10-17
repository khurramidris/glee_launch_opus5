//! Chooses which installed llama.cpp runtime to launch and how much of the
//! model to offload to a GPU.
//!
//! - Apple Silicon: the Metal build, fully offloaded.
//! - Windows: the Vulkan build on a dedicated GPU with enough memory, found by
//!   asking that build to list its devices; otherwise the CPU build.
//! - Everything else: the CPU build.
//!
//! A GPU launch that fails is retried on the CPU runtime by the caller.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::{
    errors::{AppError, AppResult},
    resources::{InstalledRuntime, Resources},
    types::{RuntimePerformanceMode, RuntimeSelectionInfo},
};

/// Context window for the chat model. The frontend packs prompts to the same budget.
pub const CHAT_CONTEXT_SIZE: u32 = 8192;
/// Prompt-cache budget that lets llama-server keep recent conversations warm.
const PROMPT_CACHE_RAM_MIB: u32 = 512;
const DEVICE_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const MIN_AUTO_GPU_MEMORY_MIB: u64 = 3 * 1024;
const MIN_EXPLICIT_GPU_MEMORY_MIB: u64 = 1536;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeBackend {
    Cpu,
    Cuda,
    Vulkan,
    Metal,
}

impl RuntimeBackend {
    pub fn is_gpu(self) -> bool {
        !matches!(self, RuntimeBackend::Cpu)
    }

    fn priority(self) -> i32 {
        match self {
            RuntimeBackend::Cuda => 40,
            RuntimeBackend::Metal => 35,
            RuntimeBackend::Vulkan => 30,
            RuntimeBackend::Cpu => 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedGpuDevice {
    pub id: Option<String>,
    pub name: String,
    pub vendor: Option<String>,
    pub driver_version: Option<String>,
    pub total_vram_mb: Option<u64>,
    pub free_vram_mb: Option<u64>,
    #[serde(default)]
    pub supported_backends: Vec<RuntimeBackend>,
}

#[derive(Debug, Clone)]
pub struct RuntimeLaunchPlan {
    pub binary_path: PathBuf,
    pub backend: RuntimeBackend,
    /// `--device` / `-ngl` arguments for this plan.
    pub offload_args: Vec<String>,
    pub selection: RuntimeSelectionInfo,
}

/// Arguments every chat launch uses. Sampling defaults follow the model
/// author's non-thinking profile for Ternary Bonsai 2; requests may override
/// temperature, top-p, max tokens, and repeat penalty per preset.
pub fn chat_server_args(warmup_enabled: bool) -> Vec<String> {
    let mut args = [
        "--ctx-size",
        &CHAT_CONTEXT_SIZE.to_string(),
        "--parallel",
        "1",
        "--jinja",
        // Bonsai 2 is a thinking model; character replies should start immediately.
        "--reasoning",
        "off",
        "--temp",
        "0.7",
        "--top-p",
        "0.8",
        "--top-k",
        "20",
        "--min-p",
        "0",
        "--presence-penalty",
        "1.5",
        "--repeat-penalty",
        "1.0",
        "--cache-ram",
        &PROMPT_CACHE_RAM_MIB.to_string(),
    ]
    .iter()
    .map(|value| value.to_string())
    .collect::<Vec<_>>();
    if !warmup_enabled {
        args.push("--no-warmup".to_string());
    }
    args
}

/// Picks the runtime and offload settings for a chat launch.
pub async fn plan_chat_launch(
    resources: &Resources,
    mode: RuntimePerformanceMode,
    manual_gpu_layers: i64,
) -> AppResult<RuntimeLaunchPlan> {
    let installed = resources.installed_runtimes();
    let base = base_runtime(&installed)?;
    if mode == RuntimePerformanceMode::Cpu {
        return Ok(cpu_plan(base, mode, None, None));
    }

    let mut detected = Vec::new();
    let mut not_used_reason = None;
    let mut candidates = installed
        .iter()
        .filter(|runtime| runtime.asset.backend.is_gpu())
        .collect::<Vec<_>>();
    candidates.sort_by_key(|runtime| -runtime.asset.backend.priority());
    for runtime in candidates {
        match runtime.asset.backend {
            RuntimeBackend::Metal => {
                let device = DetectedGpuDevice {
                    id: Some("MTL0".to_string()),
                    name: "Apple GPU".to_string(),
                    vendor: Some("Apple".to_string()),
                    driver_version: None,
                    total_vram_mb: None,
                    free_vram_mb: None,
                    supported_backends: vec![RuntimeBackend::Metal],
                };
                return Ok(gpu_plan(
                    runtime,
                    mode,
                    None,
                    vec![device],
                    manual_gpu_layers,
                ));
            }
            RuntimeBackend::Vulkan | RuntimeBackend::Cuda => {
                let devices = probe_devices(&runtime.entrypoint).await;
                detected.extend(devices.iter().cloned());
                match choose_device(&devices, mode) {
                    Ok(device) => {
                        return Ok(gpu_plan(
                            runtime,
                            mode,
                            Some(device.clone()),
                            devices,
                            manual_gpu_layers,
                        ))
                    }
                    Err(reason) => not_used_reason = Some(reason),
                }
            }
            RuntimeBackend::Cpu => {}
        }
    }

    let reason = match (mode, not_used_reason) {
        (RuntimePerformanceMode::Gpu, Some(reason)) => Some(format!(
            "GPU acceleration was requested but is not available: {reason}"
        )),
        (RuntimePerformanceMode::Gpu, None) => Some(
            "GPU acceleration was requested but this computer has no supported GPU runtime."
                .to_string(),
        ),
        (_, reason) => reason,
    };
    let mut plan = cpu_plan(base, mode, None, reason);
    plan.selection.detected_gpus = detected;
    Ok(plan)
}

/// CPU plan used after a GPU launch fails.
pub fn cpu_fallback_plan(
    resources: &Resources,
    attempted: &RuntimeSelectionInfo,
    reason: String,
) -> AppResult<RuntimeLaunchPlan> {
    let installed = resources.installed_runtimes();
    let base = base_runtime(&installed)?;
    let mut plan = cpu_plan(
        base,
        attempted.performance_mode,
        Some(attempted.backend),
        Some(reason),
    );
    plan.selection.detected_gpus = attempted.detected_gpus.clone();
    Ok(plan)
}

/// The always-available runtime for this platform (CPU, or Metal on Apple Silicon).
pub fn base_runtime(installed: &[InstalledRuntime]) -> AppResult<&InstalledRuntime> {
    installed
        .iter()
        .filter(|runtime| !runtime.asset.optional)
        .min_by_key(|runtime| runtime.asset.backend.priority())
        .ok_or_else(|| {
            AppError::Runtime(
                "Glee's AI engine isn't installed yet. Restart Glee to finish setting it up."
                    .to_string(),
            )
        })
}

/// Offload arguments that keep a launch entirely on the CPU.
pub fn cpu_offload_args(backend: RuntimeBackend) -> Vec<String> {
    let mut args = vec!["-ngl".to_string(), "0".to_string()];
    if backend.is_gpu() {
        args.extend(["--device".to_string(), "none".to_string()]);
    }
    args
}

fn cpu_plan(
    runtime: &InstalledRuntime,
    mode: RuntimePerformanceMode,
    attempted_backend: Option<RuntimeBackend>,
    fallback_reason: Option<String>,
) -> RuntimeLaunchPlan {
    RuntimeLaunchPlan {
        binary_path: runtime.entrypoint.clone(),
        backend: RuntimeBackend::Cpu,
        offload_args: cpu_offload_args(runtime.asset.backend),
        selection: RuntimeSelectionInfo {
            performance_mode: mode,
            backend: RuntimeBackend::Cpu,
            attempted_backend,
            binary_path: runtime.entrypoint.to_string_lossy().to_string(),
            variant_id: Some(runtime.asset.id.clone()),
            runtime_version: Some(runtime.asset.version.clone()),
            requested_gpu_layers: 0,
            actual_gpu_layers: None,
            fallback_reason,
            detected_gpus: Vec::new(),
            backend_log_summary: None,
        },
    }
}

fn gpu_plan(
    runtime: &InstalledRuntime,
    mode: RuntimePerformanceMode,
    device: Option<DetectedGpuDevice>,
    detected_gpus: Vec<DetectedGpuDevice>,
    manual_gpu_layers: i64,
) -> RuntimeLaunchPlan {
    let mut offload_args = Vec::new();
    if let Some(id) = device.as_ref().and_then(|device| device.id.clone()) {
        if runtime.asset.backend != RuntimeBackend::Metal {
            offload_args.extend(["--device".to_string(), id]);
        }
    }
    // Without an explicit layer count llama.cpp offloads as many layers as fit.
    let requested_gpu_layers = if manual_gpu_layers > 0 {
        offload_args.extend(["-ngl".to_string(), manual_gpu_layers.to_string()]);
        manual_gpu_layers
    } else {
        -1
    };
    RuntimeLaunchPlan {
        binary_path: runtime.entrypoint.clone(),
        backend: runtime.asset.backend,
        offload_args,
        selection: RuntimeSelectionInfo {
            performance_mode: mode,
            backend: runtime.asset.backend,
            attempted_backend: None,
            binary_path: runtime.entrypoint.to_string_lossy().to_string(),
            variant_id: Some(runtime.asset.id.clone()),
            runtime_version: Some(runtime.asset.version.clone()),
            requested_gpu_layers,
            actual_gpu_layers: None,
            fallback_reason: None,
            detected_gpus,
            backend_log_summary: None,
        },
    }
}

/// Chooses the GPU to use, or explains why none qualifies.
pub fn choose_device(
    devices: &[DetectedGpuDevice],
    mode: RuntimePerformanceMode,
) -> Result<&DetectedGpuDevice, String> {
    if devices.is_empty() {
        return Err("no compatible GPU was found".to_string());
    }
    let minimum = if mode == RuntimePerformanceMode::Gpu {
        MIN_EXPLICIT_GPU_MEMORY_MIB
    } else {
        MIN_AUTO_GPU_MEMORY_MIB
    };
    let eligible = devices
        .iter()
        .filter(|device| {
            let class = classify_gpu(&device.name);
            let class_ok = match mode {
                RuntimePerformanceMode::Gpu => class != GpuClass::Software,
                _ => class == GpuClass::Dedicated,
            };
            class_ok && device.total_vram_mb.unwrap_or(0) >= minimum
        })
        .max_by_key(|device| {
            (
                device.free_vram_mb.unwrap_or(0),
                device.total_vram_mb.unwrap_or(0),
            )
        });
    eligible.ok_or_else(|| {
        let names = devices
            .iter()
            .map(|device| device.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        if mode == RuntimePerformanceMode::Gpu {
            format!("{names} does not have at least {minimum} MiB of memory")
        } else {
            format!(
                "{names} is integrated or has less than {} GB of memory, so Glee uses the CPU (choose GPU in Settings to override)",
                minimum / 1024
            )
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuClass {
    Dedicated,
    Integrated,
    Software,
}

/// Classifies a GPU from its driver description. Integrated GPUs report
/// shared system memory, so the name is the most reliable signal available
/// before a model is loaded.
pub fn classify_gpu(description: &str) -> GpuClass {
    let lower = description.to_ascii_lowercase();
    if [
        "llvmpipe",
        "swiftshader",
        "microsoft basic",
        "software",
        "lavapipe",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return GpuClass::Software;
    }
    if ["nvidia", "geforce", "quadro", "tesla", "rtx "]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return GpuClass::Dedicated;
    }
    if lower.contains("radeon") || lower.contains("amd") {
        let dedicated = lower.contains(" rx ")
            || lower.contains("rx ")
            || lower.contains("radeon pro")
            || lower.contains("firepro")
            || lower.contains("instinct");
        return if dedicated {
            GpuClass::Dedicated
        } else {
            GpuClass::Integrated
        };
    }
    if lower.contains("intel") {
        // Intel Arc A/B-series cards are dedicated; "Arc(TM) Graphics" alone is
        // the integrated GPU in Core Ultra processors.
        let compact = lower.replace("(tm)", "").replace("(r)", "");
        let dedicated = compact
            .split("arc")
            .nth(1)
            .map(|rest| {
                let mut chars = rest.trim_start().chars();
                matches!(chars.next(), Some('a' | 'b'))
                    && chars.next().is_some_and(|c| c.is_ascii_digit())
            })
            .unwrap_or(false);
        return if dedicated {
            GpuClass::Dedicated
        } else {
            GpuClass::Integrated
        };
    }
    if lower.contains("apple") {
        return GpuClass::Integrated;
    }
    GpuClass::Dedicated
}

static PROBE_CACHE: OnceLock<Mutex<HashMap<PathBuf, Vec<DetectedGpuDevice>>>> = OnceLock::new();

/// Runs `llama-server --list-devices` once per binary per session. A driver
/// that hangs or crashes during enumeration simply yields no devices, which
/// keeps Glee on the CPU.
pub async fn probe_devices(binary: &Path) -> Vec<DetectedGpuDevice> {
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(devices) = cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(binary)
    {
        return devices.clone();
    }
    let mut command = tokio::process::Command::new(binary);
    command
        .arg("--list-devices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(dir) = binary.parent() {
        command.current_dir(dir);
    }
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let devices = match tokio::time::timeout(DEVICE_PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => parse_device_list(&String::from_utf8_lossy(&output.stdout)),
        Ok(Err(error)) => {
            eprintln!("GPU probe could not start {}: {error}", binary.display());
            Vec::new()
        }
        Err(_) => {
            eprintln!("GPU probe timed out for {}", binary.display());
            Vec::new()
        }
    };
    cache
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(binary.to_path_buf(), devices.clone());
    devices
}

/// Parses `llama-server --list-devices`, whose lines look like
/// `  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11872 MiB free)`.
pub fn parse_device_list(text: &str) -> Vec<DetectedGpuDevice> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (id, rest) = line.split_once(": ")?;
            if id.is_empty() || id.contains(' ') {
                return None;
            }
            let open = rest.rfind(" (")?;
            let name = rest[..open].trim().to_string();
            let memory = rest[open + 2..].strip_suffix(')')?;
            let (total, free) = memory.split_once(", ")?;
            let total = total.strip_suffix(" MiB")?.trim().parse::<u64>().ok()?;
            let free = free.strip_suffix(" MiB free")?.trim().parse::<u64>().ok()?;
            let backend = if id.starts_with("Vulkan") {
                RuntimeBackend::Vulkan
            } else if id.starts_with("CUDA") {
                RuntimeBackend::Cuda
            } else if id.starts_with("MTL") || id.starts_with("Metal") {
                RuntimeBackend::Metal
            } else {
                return None;
            };
            Some(DetectedGpuDevice {
                id: Some(id.to_string()),
                vendor: gpu_vendor(&name),
                name,
                driver_version: None,
                total_vram_mb: Some(total),
                free_vram_mb: Some(free),
                supported_backends: vec![backend],
            })
        })
        .collect()
}

fn gpu_vendor(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    if ["nvidia", "geforce", "quadro", "tesla"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        Some("NVIDIA".to_string())
    } else if lower.contains("radeon") || lower.contains("amd") {
        Some("AMD".to_string())
    } else if lower.contains("intel") {
        Some("Intel".to_string())
    } else if lower.contains("apple") {
        Some("Apple".to_string())
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLayerOffload {
    pub offloaded: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogSummary {
    pub loaded_backends: Vec<RuntimeBackend>,
    pub primary_backend: Option<RuntimeBackend>,
    pub layer_offload: Option<RuntimeLayerOffload>,
    pub gpu_error: Option<String>,
}

pub fn annotate_selection_from_log(selection: &mut RuntimeSelectionInfo, log_path: &Path) {
    let Ok(log_text) = fs::read_to_string(log_path) else {
        return;
    };
    let summary = parse_runtime_log_summary(&log_text);
    selection.actual_gpu_layers = summary
        .layer_offload
        .as_ref()
        .map(|offload| i64::from(offload.offloaded));
    let mut parts = Vec::new();
    if !summary.loaded_backends.is_empty() {
        parts.push(format!(
            "loaded backends: {}",
            summary
                .loaded_backends
                .iter()
                .map(|backend| format!("{backend:?}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(offload) = &summary.layer_offload {
        parts.push(format!(
            "offloaded {}/{} layers",
            offload.offloaded, offload.total
        ));
    }
    if let Some(error) = &summary.gpu_error {
        parts.push(format!("gpu warning: {error}"));
    }
    selection.backend_log_summary = (!parts.is_empty()).then(|| parts.join("; "));
    if selection.backend.is_gpu() && selection.actual_gpu_layers == Some(0) {
        selection.fallback_reason.get_or_insert_with(|| {
            "GPU runtime started, but llama.cpp reported zero GPU-offloaded layers.".to_string()
        });
    }
}

pub fn parse_runtime_log_summary(log_text: &str) -> RuntimeLogSummary {
    let mut loaded_backends = Vec::new();
    let mut seen_backends = HashSet::new();
    let mut layer_offload = None;
    let mut gpu_error = None;

    for line in log_text.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_ascii_lowercase();
        for backend in backends_in_log_line(&lower) {
            if seen_backends.insert(backend) {
                loaded_backends.push(backend);
            }
        }
        if lower.contains("offloaded") && lower.contains("layers") {
            if let Some((offloaded, total)) = first_ascii_fraction(&lower) {
                layer_offload = Some(RuntimeLayerOffload { offloaded, total });
            }
        }
        if gpu_error.is_none() && looks_like_gpu_error(&lower) {
            gpu_error = Some(trimmed.to_string());
        }
    }

    let primary_backend = if layer_offload
        .as_ref()
        .is_some_and(|offload| offload.offloaded > 0)
    {
        loaded_backends
            .iter()
            .copied()
            .filter(|backend| backend.is_gpu())
            .max_by_key(|backend| backend.priority())
    } else if loaded_backends.contains(&RuntimeBackend::Cpu) {
        Some(RuntimeBackend::Cpu)
    } else {
        loaded_backends
            .iter()
            .copied()
            .max_by_key(|backend| backend.priority())
    };
    RuntimeLogSummary {
        loaded_backends,
        primary_backend,
        layer_offload,
        gpu_error,
    }
}

fn backends_in_log_line(lower: &str) -> Vec<RuntimeBackend> {
    let mut backends = Vec::new();
    let mentions = |name: &str| {
        lower.contains(&format!("ggml_{name}"))
            || lower.contains(&format!("ggml-{name}"))
            || lower.contains(&format!("{name} backend"))
            || (lower.contains("load_backend") && lower.contains(name))
    };
    if mentions("cuda") {
        backends.push(RuntimeBackend::Cuda);
    }
    if mentions("vulkan") {
        backends.push(RuntimeBackend::Vulkan);
    }
    if mentions("metal") {
        backends.push(RuntimeBackend::Metal);
    }
    if mentions("cpu") {
        backends.push(RuntimeBackend::Cpu);
    }
    backends
}

fn looks_like_gpu_error(lower: &str) -> bool {
    let mentions_gpu_backend = lower.contains("cuda")
        || lower.contains("vulkan")
        || lower.contains("metal")
        || lower.contains("gpu");
    mentions_gpu_backend
        && (lower.contains("out of memory")
            || lower.contains("no device")
            || lower.contains("failed")
            || lower.contains("could not load")
            || lower.contains("dll")
            || lower.contains("driver"))
}

fn first_ascii_fraction(value: &str) -> Option<(u32, u32)> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let numerator_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'/' {
            continue;
        }
        let denominator_start = index + 1;
        index = denominator_start;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if denominator_start == index {
            continue;
        }
        let numerator = value[numerator_start..denominator_start - 1]
            .parse::<u32>()
            .ok()?;
        let denominator = value[denominator_start..index].parse::<u32>().ok()?;
        return Some((numerator, denominator));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(name: &str, total: u64, free: u64) -> DetectedGpuDevice {
        DetectedGpuDevice {
            id: Some("Vulkan0".to_string()),
            name: name.to_string(),
            vendor: gpu_vendor(name),
            driver_version: None,
            total_vram_mb: Some(total),
            free_vram_mb: Some(free),
            supported_backends: vec![RuntimeBackend::Vulkan],
        }
    }

    #[test]
    fn parses_llama_server_device_list() {
        let text = "Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 (12288 MiB, 11872 MiB free)\n  Vulkan1: Intel(R) UHD Graphics 770 (16049 MiB, 16049 MiB free)\n";
        let devices = parse_device_list(text);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id.as_deref(), Some("Vulkan0"));
        assert_eq!(devices[0].name, "NVIDIA GeForce RTX 3060");
        assert_eq!(devices[0].total_vram_mb, Some(12288));
        assert_eq!(devices[0].free_vram_mb, Some(11872));
        assert_eq!(devices[1].vendor.as_deref(), Some("Intel"));
        assert!(parse_device_list("Available devices:\n  (none)\n").is_empty());
    }

    #[test]
    fn classifies_dedicated_integrated_and_software_gpus() {
        for name in [
            "NVIDIA GeForce RTX 4070",
            "AMD Radeon RX 7800 XT",
            "Intel(R) Arc(TM) A770 Graphics",
            "Intel(R) Arc(TM) B580 Graphics",
            "Quadro P2000",
        ] {
            assert_eq!(classify_gpu(name), GpuClass::Dedicated, "{name}");
        }
        for name in [
            "Intel(R) UHD Graphics 620",
            "Intel(R) Iris(R) Xe Graphics",
            "Intel(R) Arc(TM) Graphics",
            "AMD Radeon(TM) Graphics",
            "AMD Radeon 780M Graphics",
        ] {
            assert_eq!(classify_gpu(name), GpuClass::Integrated, "{name}");
        }
        assert_eq!(
            classify_gpu("llvmpipe (LLVM 17.0.6, 256 bits)"),
            GpuClass::Software
        );
    }

    #[test]
    fn auto_mode_only_uses_dedicated_gpus_with_enough_memory() {
        let integrated = device("Intel(R) Iris(R) Xe Graphics", 8192, 8192);
        let small = device("NVIDIA GeForce GT 1030", 2048, 1900);
        let good = device("NVIDIA GeForce RTX 3060", 12288, 11000);
        assert!(choose_device(
            std::slice::from_ref(&integrated),
            RuntimePerformanceMode::Auto
        )
        .is_err());
        assert!(choose_device(std::slice::from_ref(&small), RuntimePerformanceMode::Auto).is_err());
        assert_eq!(
            choose_device(
                &[integrated.clone(), good.clone()],
                RuntimePerformanceMode::Auto
            )
            .unwrap()
            .name,
            good.name
        );
        // An explicit GPU preference accepts integrated GPUs and smaller cards.
        assert!(choose_device(&[integrated], RuntimePerformanceMode::Gpu).is_ok());
        assert!(choose_device(&[small], RuntimePerformanceMode::Gpu).is_ok());
        assert!(choose_device(&[], RuntimePerformanceMode::Gpu).is_err());
    }

    #[test]
    fn chat_args_pin_context_thinking_and_sampling() {
        let args = chat_server_args(false);
        let joined = args.join(" ");
        assert!(joined.contains("--ctx-size 8192"));
        assert!(joined.contains("--parallel 1"));
        assert!(joined.contains("--reasoning off"));
        assert!(joined.contains("--presence-penalty 1.5"));
        assert!(args.contains(&"--no-warmup".to_string()));
        assert!(!chat_server_args(true).contains(&"--no-warmup".to_string()));
    }

    #[test]
    fn cpu_offload_disables_gpu_devices_on_gpu_builds() {
        assert_eq!(cpu_offload_args(RuntimeBackend::Cpu), vec!["-ngl", "0"]);
        assert_eq!(
            cpu_offload_args(RuntimeBackend::Metal),
            vec!["-ngl", "0", "--device", "none"]
        );
    }

    #[test]
    fn log_offload_parser_extracts_backend_and_layer_count() {
        let summary = parse_runtime_log_summary(
            "load_backend: loaded Vulkan backend from ggml-vulkan.dll\nload_tensors: offloaded 33/33 layers to GPU\n",
        );
        assert_eq!(summary.loaded_backends, vec![RuntimeBackend::Vulkan]);
        assert_eq!(
            summary.layer_offload,
            Some(RuntimeLayerOffload {
                offloaded: 33,
                total: 33
            })
        );
        assert_eq!(summary.primary_backend, Some(RuntimeBackend::Vulkan));
    }
}
