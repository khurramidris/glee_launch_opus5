//! Tauri commands and background work for long-term memory items: CRUD for the
//! memory manager, recall during a reply, the extraction window/store pair the
//! frontend drives, and the embedding backfill that keeps item vectors current.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::db::{
    CreateMemoryItemInput, Database, DeleteMemoryItemsForInput, ListMemoryItemsInput,
    MemoryExtractionBatchRecord, MemoryExtractionOutcome, MemoryItemRecord, MemoryRetrievalRequest,
    StoreMemoryExtractionInput, UpdateMemoryItemInput, MEMORY_EXTRACTION_RELATED_ITEMS,
    RETRIEVAL_CHAR_BUDGET, RETRIEVAL_MAX_ITEMS,
};
use crate::embedding_service::EmbeddingService;
use crate::errors::{AppError, AppResult};
use crate::types::{MemorySnippetRecord, ResolveMemorySnippetsInput};
use crate::{normalize_non_empty, run_db_task, AppState, InitializedAppState};

/// Prefix of the `message_id` that marks a recalled memory item (as opposed to a chat message).
pub(crate) const MEMORY_ITEM_SNIPPET_PREFIX: &str = "memory-item:";
/// Role reported for recalled memory items.
const MEMORY_ITEM_SNIPPET_ROLE: &str = "memory";
/// Longest stretch of conversation embedded to find related items.
const RELATED_ITEMS_QUERY_CHARS: usize = 1500;
/// Items embedded per database round trip during a backfill.
const BACKFILL_BATCH: usize = 8;

static ITEM_BACKFILL_RUNNING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub(crate) async fn list_memory_items(
    state: tauri::State<'_, AppState>,
    input: Option<ListMemoryItemsInput>,
) -> AppResult<Vec<MemoryItemRecord>> {
    let state = state.handles().await?;
    let filter = input.unwrap_or_default();
    run_db_task(state.db.clone(), move |database| {
        database.list_memory_items(&filter)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_memory_item<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: CreateMemoryItemInput,
) -> AppResult<MemoryItemRecord> {
    let state = state.handles().await?;
    let record = run_db_task(state.db.clone(), move |database| {
        database.create_memory_item(&input)
    })
    .await?;
    schedule_item_embedding_backfill(app_handle, state.db, state.embedding_service);
    Ok(record)
}

#[tauri::command]
pub(crate) async fn update_memory_item<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: UpdateMemoryItemInput,
) -> AppResult<MemoryItemRecord> {
    let state = state.handles().await?;
    let record = run_db_task(state.db.clone(), move |database| {
        database.update_memory_item(&input)
    })
    .await?;
    schedule_item_embedding_backfill(app_handle, state.db, state.embedding_service);
    Ok(record)
}

#[tauri::command]
pub(crate) async fn delete_memory_item(
    state: tauri::State<'_, AppState>,
    memory_item_id: String,
) -> AppResult<()> {
    let state = state.handles().await?;
    let id = normalize_non_empty(&memory_item_id, "memory item id")?;
    run_db_task(state.db.clone(), move |database| {
        database.delete_memory_item(&id)
    })
    .await
}

/// Forgets everything for one character, one chat, or the `user` scope.
/// Returns the number of items removed.
#[tauri::command]
pub(crate) async fn delete_memory_items_for(
    state: tauri::State<'_, AppState>,
    input: DeleteMemoryItemsForInput,
) -> AppResult<u64> {
    let state = state.handles().await?;
    let removed = run_db_task(state.db.clone(), move |database| {
        database.delete_memory_items_for(&input)
    })
    .await?;
    Ok(removed as u64)
}

/// The next unprocessed slice of a chat for the extractor, with the existing
/// items it most resembles. `ready` is false until enough new messages exist.
#[tauri::command]
pub(crate) async fn get_memory_extraction_batch<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    chat_id: String,
) -> AppResult<MemoryExtractionBatchRecord> {
    let state = state.handles().await?;
    let chat_id = normalize_non_empty(&chat_id, "chat id")?;
    let window_chat = chat_id.clone();
    let mut batch = run_db_task(state.db.clone(), move |database| {
        database.get_memory_extraction_window(&window_chat)
    })
    .await?;
    if !batch.ready {
        return Ok(batch);
    }

    let text = related_items_query(&batch);
    let embedding = embed_best_effort(&app_handle, state.embedding_service.as_ref(), &text).await;
    batch.related_items = run_db_task(state.db.clone(), move |database| {
        database.related_memory_items(
            &chat_id,
            &text,
            embedding
                .as_ref()
                .map(|(model_id, vector)| (model_id.as_str(), vector.as_slice())),
            MEMORY_EXTRACTION_RELATED_ITEMS,
        )
    })
    .await?;
    Ok(batch)
}

/// Applies one extraction run. New and changed items are embedded first so
/// duplicates are caught by meaning, not just wording; without the embedding
/// runtime the lexical checks still apply and the backfill indexes them later.
#[tauri::command]
pub(crate) async fn store_memory_extraction<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    input: StoreMemoryExtractionInput,
) -> AppResult<MemoryExtractionOutcome> {
    let state = state.handles().await?;
    let mut input = input;
    input.chat_id = normalize_non_empty(&input.chat_id, "chat id")?;
    input.through_message_id = normalize_non_empty(&input.through_message_id, "message id")?;

    if let Some(service) = state.embedding_service.as_ref() {
        let model_id = service.index_id();
        let mut embedded_any = false;
        for addition in input
            .add
            .iter_mut()
            .take(crate::db::MEMORY_EXTRACTION_MAX_ADDS)
        {
            if let Some((_, vector)) =
                embed_best_effort(&app_handle, Some(service), &addition.content).await
            {
                addition.embedding = Some(vector);
                embedded_any = true;
            }
        }
        for change in input.update.iter_mut() {
            if let Some(content) = change.content.clone() {
                if let Some((_, vector)) =
                    embed_best_effort(&app_handle, Some(service), &content).await
                {
                    change.embedding = Some(vector);
                    embedded_any = true;
                }
            }
        }
        if embedded_any {
            input.embedding_model_id = Some(model_id);
        }
    }

    let outcome = run_db_task(state.db.clone(), move |database| {
        database.store_memory_extraction(&input)
    })
    .await?;
    schedule_item_embedding_backfill(app_handle, state.db, state.embedding_service);
    Ok(outcome)
}

fn related_items_query(batch: &MemoryExtractionBatchRecord) -> String {
    let joined = batch
        .messages
        .iter()
        .map(|message| message.content.trim())
        .collect::<Vec<_>>()
        .join("\n");
    let total = joined.chars().count();
    // The newest text says most about what the extractor is about to see.
    joined
        .chars()
        .skip(total.saturating_sub(RELATED_ITEMS_QUERY_CHARS))
        .collect()
}

async fn embed_best_effort<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    service: Option<&EmbeddingService>,
    text: &str,
) -> Option<(String, Vec<f32>)> {
    let service = service?;
    if service.is_stopped() || text.trim().is_empty() {
        return None;
    }
    match service.embed_text(app_handle, text).await {
        Ok(vector) => Some((service.index_id(), vector)),
        Err(error) => {
            eprintln!("memory item embedding skipped: {error}");
            None
        }
    }
}

/// Recalls memory items for every responder of a turn. Failures are logged and
/// answered with no items: message recall must still serve the turn.
pub(crate) async fn resolve_item_snippets<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    state: &InitializedAppState,
    inputs: &[ResolveMemorySnippetsInput],
    chat_id: &str,
    query: &str,
) -> Vec<Vec<MemorySnippetRecord>> {
    let empty = || inputs.iter().map(|_| Vec::new()).collect::<Vec<_>>();
    let gate_chat = chat_id.to_string();
    match run_db_task(state.db.clone(), move |database| {
        database.has_recallable_memory_items(&gate_chat)
    })
    .await
    {
        Ok(true) => {}
        Ok(false) => return empty(),
        Err(error) => {
            eprintln!("memory item lookup failed: {error}");
            return empty();
        }
    }

    // One query vector serves every responder in the turn.
    let embedding = embed_best_effort(app_handle, state.embedding_service.as_ref(), query).await;
    schedule_item_embedding_backfill(
        app_handle.clone(),
        state.db.clone(),
        state.embedding_service.clone(),
    );

    let speakers = inputs
        .iter()
        .map(|input| input.speaker_character_id.clone())
        .collect::<Vec<_>>();
    let chat_id = chat_id.to_string();
    let query = query.to_string();
    let result = run_db_task(state.db.clone(), move |database| {
        item_snippets_for_speakers(&database, &chat_id, &query, &speakers, embedding)
    })
    .await;
    match result {
        Ok(snippets) => snippets,
        Err(error) => {
            eprintln!("memory item recall failed: {error}");
            empty()
        }
    }
}

fn item_snippets_for_speakers(
    database: &Database,
    chat_id: &str,
    query: &str,
    speakers: &[Option<String>],
    embedding: Option<(String, Vec<f32>)>,
) -> AppResult<Vec<Vec<MemorySnippetRecord>>> {
    speakers
        .iter()
        .map(|speaker| {
            let items = database.retrieve_memory_items(&MemoryRetrievalRequest {
                chat_id,
                speaker_character_id: speaker.as_deref(),
                query,
                query_embedding: embedding
                    .as_ref()
                    .map(|(model_id, vector)| (model_id.as_str(), vector.as_slice())),
                max_items: RETRIEVAL_MAX_ITEMS,
                char_budget: RETRIEVAL_CHAR_BUDGET,
            })?;
            Ok(items
                .into_iter()
                .map(|entry| item_snippet(&entry.item, chat_id, entry.score))
                .collect())
        })
        .collect()
}

pub(crate) fn item_snippet(
    item: &MemoryItemRecord,
    chat_id: &str,
    score: f64,
) -> MemorySnippetRecord {
    MemorySnippetRecord {
        message_id: format!("{MEMORY_ITEM_SNIPPET_PREFIX}{}", item.id),
        chat_id: chat_id.to_string(),
        role: MEMORY_ITEM_SNIPPET_ROLE.to_string(),
        content: item.content.clone(),
        speaker_character_id: None,
        created_at: item.updated_at.clone(),
        score: (score.min(1000.0) * 100.0).round() as i64,
    }
}

/// Embeds every active item that has no vector from the current model. One
/// pass runs at a time; later calls return immediately and the running pass
/// re-lists until nothing is missing.
pub(crate) fn schedule_item_embedding_backfill<R: tauri::Runtime>(
    app_handle: tauri::AppHandle<R>,
    db: Database,
    service: Option<EmbeddingService>,
) {
    let Some(service) = service else {
        return;
    };
    if service.is_stopped() {
        return;
    }
    if ITEM_BACKFILL_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = backfill_item_embeddings(&app_handle, &db, &service).await {
            eprintln!("memory item indexing stopped: {error}");
        }
        ITEM_BACKFILL_RUNNING.store(false, Ordering::Release);
    });
}

async fn backfill_item_embeddings<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    db: &Database,
    service: &EmbeddingService,
) -> AppResult<()> {
    while !service.is_stopped() {
        let model_id = service.index_id();
        let list_model = model_id.clone();
        let items = run_db_task(db.clone(), move |database| {
            database.list_memory_items_missing_embeddings(&list_model, BACKFILL_BATCH)
        })
        .await?;
        if items.is_empty() {
            return Ok(());
        }
        let mut stored_any = false;
        let mut last_error: Option<AppError> = None;
        for item in items {
            if service.is_stopped() {
                return Ok(());
            }
            match service.embed_text(app_handle, &item.content).await {
                Ok(vector) => {
                    let store_model = model_id.clone();
                    let content = item.content.clone();
                    let id = item.id.clone();
                    run_db_task(db.clone(), move |database| {
                        database.set_memory_item_embedding_for_content(
                            &id,
                            &store_model,
                            &vector,
                            &content,
                        )
                    })
                    .await?;
                    stored_any = true;
                }
                Err(error) => last_error = Some(error),
            }
            tokio::task::yield_now().await;
        }
        if !stored_any {
            return Err(last_error.unwrap_or_else(|| {
                AppError::Runtime("memory item indexing made no progress".to_string())
            }));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::UpdateMemoryItemInput;
    use uuid::Uuid;

    fn database() -> (Database, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("glee-memory-service-{}", Uuid::new_v4()));
        (Database::new(root.join("glee.sqlite3")).unwrap(), root)
    }

    fn character(database: &Database, name: &str) -> String {
        database
            .create_character(
                name, None, None, None, None, None, None, None, None, None, None, None, None, None,
                None, None, None, None, None, None,
            )
            .unwrap()
            .id
    }

    fn user_item(database: &Database, content: &str) -> MemoryItemRecord {
        database
            .create_memory_item(&CreateMemoryItemInput {
                scope: "user".to_string(),
                character_id: None,
                chat_id: None,
                kind: None,
                content: content.to_string(),
                importance: None,
                pinned: None,
                source_message_id: None,
            })
            .unwrap()
    }

    #[test]
    fn recalled_items_are_labelled_so_the_prompt_can_tell_them_apart() {
        let (database, root) = database();
        let item = user_item(&database, "Sam is allergic to peanuts");
        let snippet = item_snippet(&item, "chat-1", 0.5);
        assert_eq!(snippet.message_id, format!("memory-item:{}", item.id));
        assert_eq!(snippet.role, "memory");
        assert_eq!(snippet.chat_id, "chat-1");
        assert_eq!(snippet.score, 50);
        assert!(snippet.speaker_character_id.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn each_speaker_gets_only_their_own_items() {
        let (database, root) = database();
        let ada = character(&database, "Ada");
        let bea = character(&database, "Bea");
        let chat = database
            .create_group_chat("group", &[ada.clone(), bea.clone()])
            .unwrap();
        user_item(&database, "Sam collects antique maps");
        for (owner, text) in [
            (&ada, "Ada hides a secret map in the attic"),
            (&bea, "Bea sketched a secret map of the harbor"),
        ] {
            database
                .create_memory_item(&CreateMemoryItemInput {
                    scope: "character".to_string(),
                    character_id: Some(owner.clone()),
                    chat_id: None,
                    kind: None,
                    content: text.to_string(),
                    importance: None,
                    pinned: None,
                    source_message_id: None,
                })
                .unwrap();
        }

        let snippets = item_snippets_for_speakers(
            &database,
            &chat.id,
            "Where is the map?",
            &[Some(ada.clone()), Some(bea.clone())],
            None,
        )
        .unwrap();
        assert_eq!(snippets.len(), 2);
        let texts = |index: usize| {
            snippets[index]
                .iter()
                .map(|snippet| snippet.content.clone())
                .collect::<Vec<_>>()
        };
        assert!(texts(0).iter().any(|text| text.starts_with("Ada")));
        assert!(!texts(0).iter().any(|text| text.starts_with("Bea")));
        assert!(texts(1).iter().any(|text| text.starts_with("Bea")));
        assert!(!texts(1).iter().any(|text| text.starts_with("Ada")));
        assert!(texts(0).iter().any(|text| text.starts_with("Sam")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn gate_reports_whether_a_chat_can_recall_anything() {
        let (database, root) = database();
        let ada = character(&database, "Ada");
        let chat = database.create_chat("one", Some(&ada)).unwrap();
        assert!(!database.has_recallable_memory_items(&chat.id).unwrap());
        let item = user_item(&database, "Sam likes green tea");
        assert!(database.has_recallable_memory_items(&chat.id).unwrap());
        database
            .update_memory_item(&UpdateMemoryItemInput {
                id: item.id,
                content: None,
                importance: None,
                pinned: None,
                archived: Some(true),
                kind: None,
                scope: None,
                character_id: None,
                chat_id: None,
            })
            .unwrap();
        assert!(!database.has_recallable_memory_items(&chat.id).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_vectors_are_not_stored_for_edited_items() {
        let (database, root) = database();
        let item = user_item(&database, "Sam likes green tea");
        assert!(!database
            .set_memory_item_embedding_for_content(
                &item.id,
                "m",
                &[1.0, 0.0],
                "Sam likes black tea"
            )
            .unwrap());
        assert!(database
            .set_memory_item_embedding_for_content(&item.id, "m", &[1.0, 0.0], &item.content)
            .unwrap());
        assert!(database
            .list_memory_items_missing_embeddings("m", 5)
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn related_items_query_keeps_the_newest_text() {
        let batch = MemoryExtractionBatchRecord {
            chat_id: "c".to_string(),
            history_epoch: 0,
            ready: true,
            pending_count: 2,
            last_message_id: None,
            participants: Vec::new(),
            messages: vec![
                crate::types::MessageRecord {
                    id: "a".to_string(),
                    chat_id: "c".to_string(),
                    role: "user".to_string(),
                    content: "o".repeat(RELATED_ITEMS_QUERY_CHARS),
                    speaker_character_id: None,
                    created_at: "2000-01-01T00:00:00Z".to_string(),
                },
                crate::types::MessageRecord {
                    id: "b".to_string(),
                    chat_id: "c".to_string(),
                    role: "assistant".to_string(),
                    content: "newest".to_string(),
                    speaker_character_id: None,
                    created_at: "2000-01-01T00:00:01Z".to_string(),
                },
            ],
            related_items: Vec::new(),
        };
        let query = related_items_query(&batch);
        assert_eq!(query.chars().count(), RELATED_ITEMS_QUERY_CHARS);
        assert!(query.ends_with("newest"));
    }
}
