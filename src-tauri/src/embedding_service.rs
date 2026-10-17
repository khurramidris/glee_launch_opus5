use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::errors::{AppError, AppResult};
use crate::resources::Resources;
use crate::runtime_manager::{RuntimeManager, RuntimeStartRequest};
use crate::runtime_selection::{base_runtime, cpu_offload_args};
use crate::types::RuntimePhase;

const EMBEDDING_THREADS: &str = "2";
const EMBEDDING_MAX_CHARS_PER_CHUNK: usize = 700;

#[derive(Clone)]
pub struct EmbeddingServiceConfig {
    pub model_id: String,
    pub model_path: PathBuf,
    /// Supplies the llama.cpp runtime once first-run setup has installed it.
    pub resources: Resources,
}

#[derive(Clone)]
pub struct EmbeddingService {
    runtime_manager: RuntimeManager,
    client: Client,
    model_id: String,
    model_path: PathBuf,
    resources: Resources,
    work: Arc<EmbeddingWork>,
}

#[derive(Default)]
struct EmbeddingWork {
    stopped: AtomicBool,
    pending_queries: AtomicUsize,
    inference: tokio::sync::Mutex<()>,
    backfill: Arc<tokio::sync::Mutex<()>>,
    backfill_chats: Arc<Mutex<HashSet<String>>>,
}

pub(crate) struct BackfillReservation {
    chat_id: String,
    chats: Arc<Mutex<HashSet<String>>>,
}

impl Drop for BackfillReservation {
    fn drop(&mut self) {
        if let Ok(mut chats) = self.chats.lock() {
            chats.remove(&self.chat_id);
        }
    }
}

impl EmbeddingWork {
    fn reserve_backfill(&self, chat_id: &str) -> Option<BackfillReservation> {
        if self.stopped.load(Ordering::SeqCst) {
            return None;
        }
        let mut chats = self.backfill_chats.lock().ok()?;
        // Bound queued chats and coalesce repeated requests while a chat is indexing.
        if chats.len() >= 16 || !chats.insert(chat_id.to_string()) {
            return None;
        }
        Some(BackfillReservation {
            chat_id: chat_id.to_string(),
            chats: self.backfill_chats.clone(),
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct EmbeddingChunk {
    pub content: String,
    pub vector: Vec<f32>,
}

struct PendingQuery<'a>(&'a AtomicUsize);

impl Drop for PendingQuery<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) fn normalize_embedding(mut vector: Vec<f32>) -> AppResult<Vec<f32>> {
    if vector.is_empty() || vector.iter().any(|value| !value.is_finite()) {
        return Err(AppError::Validation(
            "embedding must contain finite values".to_string(),
        ));
    }
    // Accumulate in f64 so large finite f32 values cannot overflow the norm.
    let norm = vector
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if norm == 0.0 {
        return Err(AppError::Validation(
            "embedding cannot have zero length".to_string(),
        ));
    }
    for value in &mut vector {
        *value = (f64::from(*value) / norm) as f32;
    }
    Ok(vector)
}

#[derive(Debug, Serialize)]
struct EmbeddingRequestPayload<'a> {
    model: &'a str,
    input: &'a str,
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

fn split_text_for_embedding(text: &str, max_chars: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.chars().count() <= max_chars {
        return vec![trimmed.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();

    fn flush_chunk(chunks: &mut Vec<String>, current: &mut String) {
        let chunk = current.trim();
        if !chunk.is_empty() {
            chunks.push(chunk.to_string());
        }
        current.clear();
    }

    fn push_unit(chunks: &mut Vec<String>, current: &mut String, unit: &str, max_chars: usize) {
        let clean = unit.trim();
        if clean.is_empty() {
            return;
        }

        let separator = if current.is_empty() { 0 } else { 1 };
        if current.chars().count() + separator + clean.chars().count() <= max_chars {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(clean);
            return;
        }

        if !current.is_empty() {
            flush_chunk(chunks, current);
        }

        if clean.chars().count() <= max_chars {
            current.push_str(clean);
            return;
        }

        let mut overflow = String::new();
        for word in clean.split_whitespace() {
            let separator = if overflow.is_empty() { 0 } else { 1 };
            if overflow.chars().count() + separator + word.chars().count() <= max_chars {
                if !overflow.is_empty() {
                    overflow.push(' ');
                }
                overflow.push_str(word);
                continue;
            }

            if !overflow.is_empty() {
                chunks.push(overflow.trim().to_string());
                overflow.clear();
            }

            if word.chars().count() <= max_chars {
                overflow.push_str(word);
                continue;
            }

            let mut start = 0;
            let chars: Vec<char> = word.chars().collect();
            while start < chars.len() {
                let end = (start + max_chars).min(chars.len());
                let piece: String = chars[start..end].iter().collect();
                chunks.push(piece);
                start = end;
            }
        }

        if !overflow.is_empty() {
            current.push_str(overflow.trim());
        }
    }

    for paragraph in trimmed.split("\n\n") {
        let clean_paragraph = paragraph.trim();
        if clean_paragraph.is_empty() {
            continue;
        }

        let sentences = clean_paragraph
            .split_inclusive(['.', '!', '?', '\n'])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();

        if sentences.is_empty() {
            push_unit(&mut chunks, &mut current, clean_paragraph, max_chars);
        } else {
            for sentence in sentences {
                push_unit(&mut chunks, &mut current, sentence, max_chars);
            }
        }
    }

    flush_chunk(&mut chunks, &mut current);
    chunks
}

fn average_embeddings(vectors: Vec<Vec<f32>>) -> AppResult<Vec<f32>> {
    let mut iter = vectors.into_iter();
    let Some(first) = iter.next() else {
        return Err(AppError::Runtime(
            "embedding response did not include vector data".to_string(),
        ));
    };
    if first.is_empty() {
        return Err(AppError::Runtime(
            "embedding response did not include vector data".to_string(),
        ));
    }

    let dimensions = first.len();
    let mut sums = first;
    let mut count = 1_f32;

    for vector in iter {
        if vector.len() != dimensions {
            return Err(AppError::Runtime(
                "embedding response dimensions were inconsistent across chunks".to_string(),
            ));
        }
        for (index, value) in vector.into_iter().enumerate() {
            sums[index] += value;
        }
        count += 1.0;
    }

    for value in &mut sums {
        *value /= count;
    }

    normalize_embedding(sums)
}

impl EmbeddingService {
    pub fn new(config: EmbeddingServiceConfig, app_data_dir: &Path) -> AppResult<Self> {
        let runtime_manager = RuntimeManager::new_for_embedding_app_data_dir(app_data_dir)?;
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        Ok(Self {
            runtime_manager,
            client,
            model_id: config.model_id,
            model_path: config.model_path,
            resources: config.resources,
            work: Arc::new(EmbeddingWork::default()),
        })
    }

    pub fn index_id(&self) -> String {
        format!("{}:chunks-v2-l2", self.model_id)
    }

    pub fn is_stopped(&self) -> bool {
        self.work.stopped.load(Ordering::SeqCst)
    }

    pub fn resume(&self) {
        self.work.stopped.store(false, Ordering::SeqCst);
    }

    pub fn try_begin_backfill(&self, chat_id: &str) -> Option<BackfillReservation> {
        self.work.reserve_backfill(chat_id)
    }

    pub async fn backfill_slot(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.work.backfill.clone().lock_owned().await
    }

    /// Starts (or reuses) the embedding server and returns its endpoint and key.
    pub async fn ensure_runtime_endpoint<R: tauri::Runtime>(
        &self,
        app_handle: &AppHandle<R>,
    ) -> AppResult<(String, String)> {
        let installed = self.resources.installed_runtimes();
        let runtime = base_runtime(&installed)?;
        let mut extra_args = vec![
            "--embeddings".to_string(),
            "--pooling".to_string(),
            "cls".to_string(),
            "--parallel".to_string(),
            "1".to_string(),
            "-t".to_string(),
            EMBEDDING_THREADS.to_string(),
        ];
        extra_args.extend(cpu_offload_args(runtime.asset.backend));
        let status = self
            .runtime_manager
            .start(
                app_handle,
                RuntimeStartRequest {
                    model_id: self.model_id.clone(),
                    model_path: self.model_path.clone(),
                    binary_path: runtime.entrypoint.clone(),
                    extra_args,
                    selection: None,
                },
            )
            .await?;

        if status.state != RuntimePhase::Ready {
            return Err(AppError::Runtime(
                "embedding runtime did not enter ready state".to_string(),
            ));
        }

        let endpoint = status.endpoint.ok_or_else(|| {
            AppError::Runtime("embedding runtime endpoint was not provided".to_string())
        })?;
        Ok((endpoint, status.api_key.unwrap_or_default()))
    }

    pub async fn embed_text<R: tauri::Runtime>(
        &self,
        app_handle: &AppHandle<R>,
        text: &str,
    ) -> AppResult<Vec<f32>> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation(
                "embedding input text cannot be empty".to_string(),
            ));
        }
        self.work.pending_queries.fetch_add(1, Ordering::SeqCst);
        let _pending = PendingQuery(&self.work.pending_queries);
        let _inference = self.work.inference.lock().await;
        self.check_running()?;
        let (endpoint, api_key) = self.ensure_runtime_endpoint(app_handle).await?;
        let chunks = split_text_for_embedding(trimmed, EMBEDDING_MAX_CHARS_PER_CHUNK);
        let mut embeddings = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            embeddings.push(self.request_embedding(&endpoint, &api_key, &chunk).await?);
        }
        average_embeddings(embeddings)
    }

    pub async fn embed_chunks<R: tauri::Runtime>(
        &self,
        app_handle: &AppHandle<R>,
        text: &str,
    ) -> AppResult<Vec<EmbeddingChunk>> {
        let mut result = Vec::new();
        for content in split_text_for_embedding(text, EMBEDDING_MAX_CHARS_PER_CHUNK) {
            // Release the inference slot between chunks and let foreground queries go first.
            loop {
                self.check_running()?;
                let inference = self.work.inference.lock().await;
                if self.work.pending_queries.load(Ordering::SeqCst) != 0 {
                    drop(inference);
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                    continue;
                }
                self.check_running()?;
                let (endpoint, api_key) = self.ensure_runtime_endpoint(app_handle).await?;
                let vector = self
                    .request_embedding(&endpoint, &api_key, &content)
                    .await?;
                result.push(EmbeddingChunk { content, vector });
                break;
            }
        }
        Ok(result)
    }

    fn check_running(&self) -> AppResult<()> {
        if self.is_stopped() {
            return Err(AppError::Runtime(
                "embedding service is stopped".to_string(),
            ));
        }
        Ok(())
    }

    pub async fn stop(&self) -> AppResult<()> {
        self.work.stopped.store(true, Ordering::SeqCst);
        // Cancel runtime startup/in-flight HTTP before waiting for the inference slot.
        // A start racing with the first stop is cancelled on the next iteration.
        loop {
            self.runtime_manager.stop().await?;
            if self.work.inference.try_lock().is_ok() {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    async fn request_embedding(
        &self,
        endpoint: &str,
        api_key: &str,
        input: &str,
    ) -> AppResult<Vec<f32>> {
        let url = format!("{}/v1/embeddings", endpoint.trim_end_matches('/'));
        let response = self
            .client
            .post(url)
            .bearer_auth(api_key)
            .json(&EmbeddingRequestPayload {
                model: self.model_id.as_str(),
                input,
            })
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AppError::Runtime(format!(
                "embedding request failed ({status}): {}",
                body.chars().take(240).collect::<String>()
            )));
        }

        let payload: EmbeddingResponse = response.json().await?;
        let embedding = payload
            .data
            .into_iter()
            .next()
            .map(|entry| entry.embedding)
            .unwrap_or_default();

        if embedding.is_empty() {
            return Err(AppError::Runtime(
                "embedding response did not include vector data".to_string(),
            ));
        }

        normalize_embedding(embedding)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_embedding_input_stays_single_chunk() {
        let chunks = split_text_for_embedding("short input", 700);
        assert_eq!(chunks, vec!["short input".to_string()]);
    }

    #[test]
    fn long_embedding_input_splits_into_safe_chunks() {
        let text = "alpha beta gamma delta ".repeat(120);
        let chunks = split_text_for_embedding(&text, 80);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 80));
        assert!(chunks.join(" ").contains("alpha beta gamma"));
    }

    #[test]
    fn unicode_chunks_use_character_boundaries_consistently() {
        let text = "你好世界".repeat(30);
        let chunks = split_text_for_embedding(&text, 20);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 20));
        assert_eq!(chunks.concat(), text);
        assert_eq!(split_text_for_embedding("éééé", 4), vec!["éééé"]);
    }

    #[test]
    fn foreground_reservation_is_released_on_cancellation() {
        let work = EmbeddingWork::default();
        work.pending_queries.fetch_add(1, Ordering::SeqCst);
        let reservation = PendingQuery(&work.pending_queries);
        assert_eq!(work.pending_queries.load(Ordering::SeqCst), 1);
        drop(reservation);
        assert_eq!(work.pending_queries.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn background_jobs_are_deduplicated_bounded_and_released() {
        let work = EmbeddingWork::default();
        let first = work.reserve_backfill("chat-a").unwrap();
        assert!(work.reserve_backfill("chat-a").is_none());
        let others = (0..15)
            .map(|i| work.reserve_backfill(&format!("chat-{i}")).unwrap())
            .collect::<Vec<_>>();
        assert!(work.reserve_backfill("overflow").is_none());
        drop(first);
        assert!(work.reserve_backfill("chat-a").is_some());
        drop(others);
        assert!(work.backfill_chats.lock().unwrap().is_empty());
        work.stopped.store(true, Ordering::SeqCst);
        assert!(work.reserve_backfill("stopped").is_none());
    }

    #[test]
    fn stopped_service_rejects_work_and_can_resume_after_failed_restore() {
        let root =
            std::env::temp_dir().join(format!("glee-embedding-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let model_path = root.join("model.gguf");
        std::fs::write(&model_path, b"not loaded by this lifecycle test").unwrap();
        let service = EmbeddingService::new(
            EmbeddingServiceConfig {
                model_id: "test".into(),
                model_path,
                resources: Resources::new(&root).unwrap(),
            },
            &root,
        )
        .unwrap();
        tauri::async_runtime::block_on(async {
            service.stop().await.unwrap();
            assert!(service.is_stopped());
            assert!(service.check_running().is_err());
            assert!(service.try_begin_backfill("chat").is_none());
            service.resume();
            assert!(service.check_running().is_ok());
            assert!(service.try_begin_backfill("chat").is_some());
            service.stop().await.unwrap();
        });
        drop(service);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn averaged_embeddings_preserve_dimensions() {
        let averaged = average_embeddings(vec![vec![1.0, 3.0], vec![3.0, 5.0]])
            .expect("averaging should succeed");
        assert!((averaged[0] - 1.0 / 5.0_f32.sqrt()).abs() < 1e-6);
        assert!((averaged.iter().map(|v| v * v).sum::<f32>() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn invalid_vectors_are_rejected() {
        for vector in [vec![], vec![0.0, 0.0], vec![f32::NAN], vec![f32::INFINITY]] {
            assert!(normalize_embedding(vector).is_err());
        }
        assert!(average_embeddings(vec![vec![1.0], vec![1.0, 0.0]]).is_err());
        assert!(average_embeddings(vec![vec![1.0], vec![-1.0]]).is_err());
    }

    #[test]
    fn normalization_handles_large_finite_vectors() {
        let vector = normalize_embedding(vec![f32::MAX, f32::MAX]).unwrap();
        assert!((vector[0] - 0.5_f32.sqrt()).abs() < 1e-6);
    }
}
