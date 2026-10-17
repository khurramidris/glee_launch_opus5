//! A GPU launch can report healthy and still compute garbage, for example on a
//! virtualized GPU or with a driver bug. Before Glee trusts a GPU it asks the
//! model one question with an obvious answer, and remembers the verdict for
//! that engine, model, and set of GPUs so later launches skip the check.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::types::{RuntimeSelectionInfo, RuntimeStatusResponse};

/// Generous enough for first-run shader compilation on slow GPUs.
const CHECK_TIMEOUT: Duration = Duration::from_secs(120);
const CHECK_QUESTION: &str = "What is 2 + 2? Reply with only the number.";

#[derive(Debug, Default, Serialize, Deserialize)]
struct CheckRecords {
    #[serde(default)]
    results: BTreeMap<String, bool>,
}

/// Remembered GPU check results, stored as a small JSON file.
pub struct GpuCheckStore {
    path: PathBuf,
}

impl GpuCheckStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn get(&self, key: &str) -> Option<bool> {
        read_records(&self.path).results.get(key).copied()
    }

    pub fn put(&self, key: &str, passed: bool) {
        let mut records = read_records(&self.path);
        records.results.insert(key.to_string(), passed);
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(&records) {
            if let Err(error) = fs::write(&self.path, text) {
                eprintln!("could not save GPU check result: {error}");
            }
        }
    }
}

fn read_records(path: &Path) -> CheckRecords {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Identifies the engine build, model, and GPUs a check result applies to.
pub fn check_key(model_id: &str, selection: &RuntimeSelectionInfo) -> String {
    let mut gpus = selection
        .detected_gpus
        .iter()
        .map(|gpu| gpu.name.trim().to_string())
        .collect::<Vec<_>>();
    gpus.sort();
    format!(
        "{}|{}|{}|{}",
        selection.variant_id.as_deref().unwrap_or("unknown"),
        selection.runtime_version.as_deref().unwrap_or("unknown"),
        model_id,
        gpus.join(",")
    )
}

/// Asks the running server a trivial question and checks the answer.
pub async fn verify(status: &RuntimeStatusResponse) -> Result<(), String> {
    let endpoint = status
        .endpoint
        .as_deref()
        .ok_or_else(|| "the AI engine has no address".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .post(format!("{endpoint}/v1/chat/completions"))
        .json(&json!({
            "messages": [{ "role": "user", "content": CHECK_QUESTION }],
            "temperature": 0,
            "max_tokens": 8,
            "cache_prompt": false,
        }));
    if let Some(key) = status.api_key.as_deref() {
        request = request.bearer_auth(key);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "the AI engine answered with HTTP {}",
            response.status()
        ));
    }
    let body = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    let answer = body
        .pointer("/choices/0/message/content")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if answer_looks_right(answer) {
        Ok(())
    } else {
        Err(format!("unexpected answer {:?}", truncate(answer, 60)))
    }
}

/// True when the reply to [`CHECK_QUESTION`] says four.
pub fn answer_looks_right(answer: &str) -> bool {
    let answer = answer.to_lowercase();
    let starts_with_four = answer
        .trim_start_matches(|c: char| !c.is_alphanumeric())
        .split(|c: char| !c.is_alphanumeric())
        .next()
        .is_some_and(|word| word == "4" || word == "four");
    starts_with_four || answer.contains("= 4") || answer.contains("is 4")
}

fn truncate(text: &str, max_chars: usize) -> String {
    let mut out = text.chars().take(max_chars).collect::<String>();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_selection::{DetectedGpuDevice, RuntimeBackend};
    use crate::types::RuntimePerformanceMode;

    #[test]
    fn recognizes_correct_and_garbled_answers() {
        for good in ["4", " 4.", "**4**", "Four", "2 + 2 = 4", "The answer is 4."] {
            assert!(answer_looks_right(good), "{good:?} should pass");
        }
        for bad in ["", "/some text/", "/symbolic/", "44", "5", "<think>"] {
            assert!(!answer_looks_right(bad), "{bad:?} should fail");
        }
    }

    #[test]
    fn remembers_results_per_engine_model_and_gpu() {
        let dir = std::env::temp_dir().join(format!("glee-gpu-check-{}", uuid::Uuid::new_v4()));
        let store = GpuCheckStore::new(dir.join("gpu-checks.json"));
        let mut selection = RuntimeSelectionInfo {
            performance_mode: RuntimePerformanceMode::Auto,
            backend: RuntimeBackend::Metal,
            attempted_backend: None,
            binary_path: String::new(),
            variant_id: Some("macos-arm64-metal".to_string()),
            runtime_version: Some("b1".to_string()),
            requested_gpu_layers: -1,
            actual_gpu_layers: None,
            fallback_reason: None,
            detected_gpus: vec![DetectedGpuDevice {
                id: Some("MTL0".to_string()),
                name: "Apple GPU".to_string(),
                vendor: None,
                driver_version: None,
                total_vram_mb: None,
                free_vram_mb: None,
                supported_backends: vec![RuntimeBackend::Metal],
            }],
            backend_log_summary: None,
        };
        let key = check_key("model-a", &selection);
        assert_eq!(store.get(&key), None);
        store.put(&key, false);
        assert_eq!(store.get(&key), Some(false));

        selection.runtime_version = Some("b2".to_string());
        assert_eq!(store.get(&check_key("model-a", &selection)), None);
        assert_eq!(store.get(&check_key("model-b", &selection)), None);
        let _ = fs::remove_dir_all(dir);
    }
}
