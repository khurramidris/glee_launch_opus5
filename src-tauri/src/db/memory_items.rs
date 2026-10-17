//! Long-term memory items: short third-person statements that outlive a single
//! chat. Scope decides who may recall one: `user` items are shared with every
//! character, `character` items belong to one character (all of its chats), and
//! `chat` items stay in the chat that produced them.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, Transaction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::types::MessageRecord;

use super::memory::{
    dice_similarity_score, normalize_content_for_dedupe, tokenize_similarity_terms,
};
use super::messages::{assert_expected_epoch, map_message_row};
use super::{now_rfc3339, Database};

pub(crate) const MEMORY_SCOPES: [&str; 3] = ["user", "character", "chat"];
pub(crate) const MEMORY_KINDS: [&str; 5] =
    ["fact", "preference", "event", "relationship", "promise"];

/// Longest text a user may store in one item.
const MAX_CONTENT_CHARS_MANUAL: usize = 500;
/// Longest text the background extractor may store in one item.
pub(crate) const MAX_CONTENT_CHARS_EXTRACTED: usize = 200;
const MIN_CONTENT_CHARS: usize = 3;
/// Active items kept per owner (user, one character, or one chat); extraction stops adding past it.
const MAX_ITEMS_PER_OWNER: i64 = 400;

/// New messages in a chat before the extractor looks at it again.
pub(crate) const MEMORY_EXTRACTION_MIN_PENDING: i64 = 6;
/// Newest unprocessed text handed to the extractor in one run.
pub(crate) const MEMORY_EXTRACTION_WINDOW_CHARS: usize = 3500;
/// Items one extraction run may add.
pub(crate) const MEMORY_EXTRACTION_MAX_ADDS: usize = 6;
/// Existing items shown to the extractor so it can update instead of repeating.
pub(crate) const MEMORY_EXTRACTION_RELATED_ITEMS: usize = 12;
/// Cosine similarity above which two items count as the same memory.
pub(crate) const DUPLICATE_COSINE: f64 = 0.9;
/// Token-set overlap above which two items count as the same memory.
const DUPLICATE_DICE: f64 = 0.8;

/// Items injected into a single reply.
pub(crate) const RETRIEVAL_MAX_ITEMS: usize = 6;
/// Characters of item text injected into a single reply.
pub(crate) const RETRIEVAL_CHAR_BUDGET: usize = 600;
/// Vectors farther than this (L2, unit length) are unrelated text for item recall.
const ITEM_MAX_L2_DISTANCE: f64 = 0.9;
/// Share of an item's key words a query must hit before lexical recall accepts it.
const LEXICAL_MIN_OVERLAP: f64 = 0.375;
/// Days for an unused item's recency weight to halve.
const RECENCY_HALF_LIFE_DAYS: f64 = 45.0;
/// Reported score of a pinned item, which is selected regardless of relevance.
const PINNED_SCORE: f64 = 1000.0;
const RECENT_CONTEXT_MESSAGES: i64 = 4;
const RECENT_CONTEXT_WEIGHT: f64 = 0.5;

const ITEM_COLUMNS: &str = "id, scope, character_id, chat_id, kind, content, importance, pinned, source_message_id, created_at, updated_at, last_recalled_at, recall_count, archived";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryItemRecord {
    pub id: String,
    pub scope: String,
    pub character_id: Option<String>,
    pub chat_id: Option<String>,
    pub kind: String,
    pub content: String,
    pub importance: i64,
    pub pinned: bool,
    pub source_message_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_recalled_at: Option<String>,
    pub recall_count: i64,
    pub archived: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListMemoryItemsInput {
    pub scope: Option<String>,
    pub character_id: Option<String>,
    pub chat_id: Option<String>,
    #[serde(default)]
    pub include_archived: bool,
    /// Everything a chat can recall: user items, its participants' own items, its chat items.
    pub visible_in_chat: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMemoryItemInput {
    pub scope: String,
    pub character_id: Option<String>,
    pub chat_id: Option<String>,
    pub kind: Option<String>,
    pub content: String,
    pub importance: Option<i64>,
    pub pinned: Option<bool>,
    pub source_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMemoryItemInput {
    pub id: String,
    pub content: Option<String>,
    pub importance: Option<i64>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
    pub kind: Option<String>,
    pub scope: Option<String>,
    pub character_id: Option<String>,
    pub chat_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeleteMemoryItemsForInput {
    pub scope: Option<String>,
    pub character_id: Option<String>,
    pub chat_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryParticipantRecord {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionBatchRecord {
    pub chat_id: String,
    pub history_epoch: i64,
    /// True once enough new messages piled up for an extraction run.
    pub ready: bool,
    pub pending_count: i64,
    pub last_message_id: Option<String>,
    pub participants: Vec<MemoryParticipantRecord>,
    pub messages: Vec<MessageRecord>,
    pub related_items: Vec<MemoryItemRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionAdd {
    pub scope: String,
    pub character_id: Option<String>,
    pub kind: Option<String>,
    pub content: String,
    pub importance: Option<i64>,
    #[serde(skip)]
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryExtractionUpdate {
    pub id: String,
    pub content: Option<String>,
    pub importance: Option<i64>,
    #[serde(skip)]
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreMemoryExtractionInput {
    pub chat_id: String,
    pub through_message_id: String,
    #[serde(default)]
    pub expected_history_epoch: Option<i64>,
    #[serde(default)]
    pub add: Vec<MemoryExtractionAdd>,
    #[serde(default)]
    pub update: Vec<MemoryExtractionUpdate>,
    #[serde(default)]
    pub remove: Vec<String>,
    /// Index id of the embedding model that produced the `embedding` fields.
    #[serde(skip)]
    pub embedding_model_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryExtractionOutcome {
    pub added: Vec<MemoryItemRecord>,
    pub updated: Vec<MemoryItemRecord>,
    pub removed: Vec<String>,
    pub skipped: usize,
}

pub struct MemoryRetrievalRequest<'a> {
    pub chat_id: &'a str,
    pub speaker_character_id: Option<&'a str>,
    pub query: &'a str,
    /// Query vector and the index id of the model that produced it.
    pub query_embedding: Option<(&'a str, &'a [f32])>,
    pub max_items: usize,
    pub char_budget: usize,
}

#[derive(Debug, Clone)]
pub struct RetrievedMemoryItem {
    pub item: MemoryItemRecord,
    pub score: f64,
}

struct Candidate {
    item: MemoryItemRecord,
    embedding: Option<Vec<f32>>,
}

struct RankingContext {
    /// Query terms with their weight: 1 for the latest message, less for recent context.
    query_weights: HashMap<String, f64>,
    /// Names and filler that appear in nearly every item and say nothing about relevance.
    ignore_terms: HashSet<String>,
    query_embedding: Option<Vec<f32>>,
}

impl Database {
    pub fn list_memory_items(
        &self,
        filter: &ListMemoryItemsInput,
    ) -> AppResult<Vec<MemoryItemRecord>> {
        let connection = self.open_connection()?;
        let mut conditions: Vec<String> = Vec::new();
        let mut values: Vec<String> = Vec::new();

        if let Some(scope) = clean_optional(filter.scope.as_deref()) {
            validate_scope(&scope)?;
            values.push(scope);
            conditions.push(format!("scope = ?{}", values.len()));
        }
        if let Some(character_id) = clean_optional(filter.character_id.as_deref()) {
            values.push(character_id);
            conditions.push(format!("character_id = ?{}", values.len()));
        }
        if let Some(chat_id) = clean_optional(filter.chat_id.as_deref()) {
            values.push(chat_id);
            conditions.push(format!("chat_id = ?{}", values.len()));
        }
        if let Some(chat_id) = clean_optional(filter.visible_in_chat.as_deref()) {
            values.push(chat_id);
            conditions.push(visible_in_chat_condition(values.len()));
        }
        if !filter.include_archived {
            conditions.push("archived = 0".to_string());
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };
        let mut statement = connection.prepare(&format!(
            "SELECT {ITEM_COLUMNS} FROM memory_items {where_clause}
             ORDER BY pinned DESC, importance DESC, updated_at DESC, id ASC"
        ))?;
        let rows = statement.query_map(params_from_iter(values.iter()), map_item_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    #[cfg(test)]
    pub fn get_memory_item(&self, id: &str) -> AppResult<MemoryItemRecord> {
        let connection = self.open_connection()?;
        fetch_item(&connection, id.trim())?
            .ok_or_else(|| AppError::NotFound(format!("memory item {} was not found", id.trim())))
    }

    pub fn create_memory_item(&self, input: &CreateMemoryItemInput) -> AppResult<MemoryItemRecord> {
        let content = clean_content(&input.content, MAX_CONTENT_CHARS_MANUAL)?;
        let kind = resolve_kind(input.kind.as_deref())?;
        let importance = resolve_importance(input.importance)?;

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let (scope, character_id, chat_id) = resolve_owner(
            &transaction,
            &input.scope,
            input.character_id.as_deref(),
            input.chat_id.as_deref(),
        )?;

        // Saying the same thing twice to the same owner keeps the first item.
        let normalized = normalize_content_for_dedupe(&content);
        let existing = list_owner_items(
            &transaction,
            &scope,
            character_id.as_deref(),
            chat_id.as_deref(),
        )?
        .into_iter()
        .find(|item| normalize_content_for_dedupe(&item.content) == normalized);
        if let Some(existing) = existing {
            transaction.execute(
                "UPDATE memory_items SET archived = 0, pinned = MAX(pinned, ?2), importance = MAX(importance, ?3), updated_at = ?4 WHERE id = ?1",
                params![
                    existing.id,
                    i64::from(input.pinned.unwrap_or(false)),
                    importance,
                    now_rfc3339()
                ],
            )?;
            let record = fetch_item(&transaction, &existing.id)?
                .ok_or_else(|| AppError::NotFound("memory item vanished".to_string()))?;
            transaction.commit()?;
            return Ok(record);
        }

        let record = insert_item(
            &transaction,
            &NewItem {
                scope,
                character_id,
                chat_id,
                kind,
                content,
                importance,
                pinned: input.pinned.unwrap_or(false),
                source_message_id: clean_optional(input.source_message_id.as_deref()),
            },
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn update_memory_item(&self, input: &UpdateMemoryItemInput) -> AppResult<MemoryItemRecord> {
        let id = input.id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "memory item id cannot be empty".to_string(),
            ));
        }
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let existing = fetch_item(&transaction, id)?
            .ok_or_else(|| AppError::NotFound(format!("memory item {id} was not found")))?;

        let content = match input.content.as_deref() {
            Some(raw) => clean_content(raw, MAX_CONTENT_CHARS_MANUAL)?,
            None => existing.content.clone(),
        };
        let kind = match input.kind.as_deref() {
            Some(_) => resolve_kind(input.kind.as_deref())?,
            None => existing.kind.clone(),
        };
        let importance = match input.importance {
            Some(_) => resolve_importance(input.importance)?,
            None => existing.importance,
        };
        let pinned = input.pinned.unwrap_or(existing.pinned);
        let archived = input.archived.unwrap_or(existing.archived);

        let (scope, character_id, chat_id) = if input.scope.is_some() {
            let requested_scope = input.scope.as_deref().unwrap_or_default();
            resolve_owner(
                &transaction,
                requested_scope,
                input
                    .character_id
                    .as_deref()
                    .or(existing.character_id.as_deref()),
                input.chat_id.as_deref().or(existing.chat_id.as_deref()),
            )?
        } else {
            (
                existing.scope.clone(),
                existing.character_id.clone(),
                existing.chat_id.clone(),
            )
        };

        transaction.execute(
            "UPDATE memory_items
             SET scope = ?2, character_id = ?3, chat_id = ?4, kind = ?5, content = ?6,
                 importance = ?7, pinned = ?8, archived = ?9, updated_at = ?10
             WHERE id = ?1",
            params![
                id,
                scope,
                character_id,
                chat_id,
                kind,
                content,
                importance,
                i64::from(pinned),
                i64::from(archived),
                now_rfc3339()
            ],
        )?;
        if content != existing.content {
            // The stored vector describes the old wording.
            transaction.execute(
                "DELETE FROM memory_item_embeddings WHERE item_id = ?1",
                [id],
            )?;
        }
        let record = fetch_item(&transaction, id)?
            .ok_or_else(|| AppError::NotFound(format!("memory item {id} was not found")))?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn delete_memory_item(&self, id: &str) -> AppResult<()> {
        let clean_id = id.trim();
        if clean_id.is_empty() {
            return Err(AppError::Validation(
                "memory item id cannot be empty".to_string(),
            ));
        }
        let affected = self
            .open_connection()?
            .execute("DELETE FROM memory_items WHERE id = ?1", [clean_id])?;
        if affected == 0 {
            return Err(AppError::NotFound(format!(
                "memory item {clean_id} was not found"
            )));
        }
        Ok(())
    }

    /// Forgets everything one owner holds. Exactly one of a character, a chat,
    /// or the `user` scope must be named. Returns how many items were removed.
    pub fn delete_memory_items_for(&self, input: &DeleteMemoryItemsForInput) -> AppResult<usize> {
        let scope = clean_optional(input.scope.as_deref());
        let character_id = clean_optional(input.character_id.as_deref());
        let chat_id = clean_optional(input.chat_id.as_deref());
        let connection = self.open_connection()?;
        match (scope, character_id, chat_id) {
            (None, Some(character_id), None) => Ok(connection.execute(
                "DELETE FROM memory_items WHERE scope = 'character' AND character_id = ?1",
                [character_id],
            )?),
            (None, None, Some(chat_id)) => Ok(connection.execute(
                "DELETE FROM memory_items WHERE scope = 'chat' AND chat_id = ?1",
                [chat_id],
            )?),
            (Some(scope), None, None) if scope == "user" => {
                Ok(connection.execute("DELETE FROM memory_items WHERE scope = 'user'", [])?)
            }
            _ => Err(AppError::Validation(
                "name exactly one of a character id, a chat id, or the user scope".to_string(),
            )),
        }
    }

    /// Stores the vector for an item without checking its text; tests only.
    #[cfg(test)]
    pub fn set_memory_item_embedding(
        &self,
        item_id: &str,
        embedding_model_id: &str,
        vector: &[f32],
    ) -> AppResult<()> {
        let connection = self.open_connection()?;
        store_embedding(&connection, item_id.trim(), embedding_model_id, vector)
    }

    /// Like `set_memory_item_embedding`, but only when the item still has the
    /// text the vector was computed from. Returns whether it was stored.
    pub fn set_memory_item_embedding_for_content(
        &self,
        item_id: &str,
        embedding_model_id: &str,
        vector: &[f32],
        content: &str,
    ) -> AppResult<bool> {
        let connection = self.open_connection()?;
        let current = fetch_item(&connection, item_id.trim())?;
        match current {
            Some(item) if item.content == content && !item.archived => {
                store_embedding(&connection, &item.id, embedding_model_id, vector)?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Whether the chat can recall any item at all; a cheap gate before embedding a query.
    pub fn has_recallable_memory_items(&self, chat_id: &str) -> AppResult<bool> {
        let connection = self.open_connection()?;
        let found: Option<i64> = connection
            .query_row(
                &format!(
                    "SELECT 1 FROM memory_items WHERE archived = 0 AND {} LIMIT 1",
                    visible_in_chat_condition(1)
                ),
                [chat_id.trim()],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    /// Active items without a vector from the given model, newest first.
    pub fn list_memory_items_missing_embeddings(
        &self,
        embedding_model_id: &str,
        limit: usize,
    ) -> AppResult<Vec<MemoryItemRecord>> {
        let connection = self.open_connection()?;
        let mut statement = connection.prepare(&format!(
            "SELECT {ITEM_COLUMNS} FROM memory_items
             WHERE archived = 0
               AND NOT EXISTS (
                   SELECT 1 FROM memory_item_embeddings
                   WHERE item_id = memory_items.id AND embedding_model_id = ?1
               )
             ORDER BY updated_at DESC, id ASC
             LIMIT ?2"
        ))?;
        let rows = statement.query_map(
            params![embedding_model_id, limit.min(i64::MAX as usize) as i64],
            map_item_row,
        )?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    /// Items the speaker may recall for this turn, best first. Pinned items in
    /// scope always lead; the rest are ranked by relevance to the query,
    /// importance, and how recently they mattered. Selected items are marked
    /// as recalled.
    pub fn retrieve_memory_items(
        &self,
        request: &MemoryRetrievalRequest<'_>,
    ) -> AppResult<Vec<RetrievedMemoryItem>> {
        let selected = self.rank_memory_items_at(request, Utc::now())?;
        if !selected.is_empty() {
            let ids = selected
                .iter()
                .map(|entry| entry.item.id.clone())
                .collect::<Vec<_>>();
            self.mark_memory_items_recalled(&ids)?;
        }
        Ok(selected)
    }

    fn rank_memory_items_at(
        &self,
        request: &MemoryRetrievalRequest<'_>,
        now: DateTime<Utc>,
    ) -> AppResult<Vec<RetrievedMemoryItem>> {
        let chat_id = request.chat_id.trim();
        if chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }
        let connection = self.open_connection()?;
        let chat: Option<(Option<String>, String)> = connection
            .query_row(
                "SELECT character_id, chat_mode FROM chats WHERE id = ?1",
                [chat_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((chat_character_id, chat_mode)) = chat else {
            return Err(AppError::NotFound(format!("chat {chat_id} was not found")));
        };
        // A group chat never falls back to a default speaker: nobody else's
        // private memories may leak into this turn.
        let speaker = clean_optional(request.speaker_character_id).or_else(|| {
            if chat_mode.eq_ignore_ascii_case("single") {
                chat_character_id
            } else {
                None
            }
        });

        let mut ignore_terms: HashSet<String> = HashSet::new();
        ignore_terms.insert("user".to_string());
        let user_name: Option<String> = connection
            .query_row(
                "SELECT display_name FROM user_profiles LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        for name in user_name.into_iter().chain(
            participants_of(&connection, chat_id)?
                .into_iter()
                .map(|p| p.name),
        ) {
            ignore_terms.extend(tokenize_similarity_terms(&name.to_lowercase()));
        }

        let failure_pattern = format!("{}%", crate::GENERATION_FAILURE_PREFIX);
        let recent_context = {
            let mut statement = connection.prepare(
                "SELECT content FROM messages
                 WHERE chat_id = ?1 AND LOWER(TRIM(role)) IN ('user', 'assistant') AND content NOT LIKE ?2
                 ORDER BY rowid DESC LIMIT ?3",
            )?;
            let rows = statement.query_map(
                params![chat_id, failure_pattern, RECENT_CONTEXT_MESSAGES],
                |row| row.get::<_, String>(0),
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut query_weights: HashMap<String, f64> = HashMap::new();
        for term in tokenize_similarity_terms(&request.query.to_lowercase()) {
            query_weights.insert(term, 1.0);
        }
        for text in &recent_context {
            for term in tokenize_similarity_terms(&text.to_lowercase()) {
                query_weights.entry(term).or_insert(RECENT_CONTEXT_WEIGHT);
            }
        }

        let (model_id, query_embedding) = match request.query_embedding {
            Some((model_id, vector)) => (model_id.to_string(), normalized_vector(vector)),
            None => (String::new(), None),
        };

        let mut statement = connection.prepare(&format!(
            "SELECT {}, embeddings.embedding
             FROM memory_items
             LEFT JOIN memory_item_embeddings AS embeddings
                ON embeddings.item_id = memory_items.id AND embeddings.embedding_model_id = ?3
             WHERE archived = 0
               AND (scope = 'user'
                    OR (scope = 'chat' AND chat_id = ?1)
                    OR (scope = 'character' AND character_id = ?2))",
            prefixed_columns("memory_items")
        ))?;
        let rows = statement.query_map(params![chat_id, speaker, model_id], |row| {
            let item = map_item_row(row)?;
            let blob: Option<Vec<u8>> = row.get(14)?;
            Ok(Candidate {
                item,
                embedding: blob.map(|bytes| decode_vector(&bytes)),
            })
        })?;
        let candidates = rows.collect::<Result<Vec<_>, _>>()?;

        let context = RankingContext {
            query_weights,
            ignore_terms,
            query_embedding,
        };
        Ok(rank_candidates(
            candidates,
            &context,
            now,
            request.max_items,
            request.char_budget,
        ))
    }

    fn mark_memory_items_recalled(&self, ids: &[String]) -> AppResult<()> {
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let stamp = now_rfc3339();
        for id in ids {
            transaction.execute(
                "UPDATE memory_items SET last_recalled_at = ?2, recall_count = recall_count + 1 WHERE id = ?1",
                params![id, stamp],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// The newest unprocessed slice of a chat plus whether enough new messages
    /// piled up to be worth a model call. `related_items` stays empty here; the
    /// caller fills it once it knows whether embeddings are available.
    pub fn get_memory_extraction_window(
        &self,
        chat_id: &str,
    ) -> AppResult<MemoryExtractionBatchRecord> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }
        let connection = self.open_connection()?;
        let history_epoch: Option<i64> = connection
            .query_row(
                "SELECT history_epoch FROM chats WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(history_epoch) = history_epoch else {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        };

        let cursor: Option<(String, String)> = connection
            .query_row(
                "SELECT through_message_id, through_created_at FROM memory_extraction_state WHERE chat_id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        // A cursor message that was deleted falls back to its timestamp.
        let after_rowid: i64 = match cursor {
            Some((message_id, created_at)) => {
                let rowid: Option<i64> = connection
                    .query_row(
                        "SELECT rowid FROM messages WHERE id = ?1 AND chat_id = ?2",
                        params![message_id, id],
                        |row| row.get(0),
                    )
                    .optional()?;
                match rowid {
                    Some(rowid) => rowid,
                    None => connection.query_row(
                        "SELECT COALESCE(MAX(rowid), 0) FROM messages WHERE chat_id = ?1 AND created_at <= ?2",
                        params![id, created_at],
                        |row| row.get(0),
                    )?,
                }
            }
            None => 0,
        };

        let failure_pattern = format!("{}%", crate::GENERATION_FAILURE_PREFIX);
        let pending_count: i64 = connection.query_row(
            &format!("SELECT COUNT(1) FROM messages WHERE {ELIGIBLE_MESSAGES} AND rowid > ?3"),
            params![id, failure_pattern, after_rowid],
            |row| row.get(0),
        )?;
        let mut batch = MemoryExtractionBatchRecord {
            chat_id: id.to_string(),
            history_epoch,
            ready: pending_count >= MEMORY_EXTRACTION_MIN_PENDING,
            pending_count,
            last_message_id: None,
            participants: participants_of(&connection, id)?,
            messages: Vec::new(),
            related_items: Vec::new(),
        };
        if !batch.ready {
            return Ok(batch);
        }

        let mut statement = connection.prepare(&format!(
            "SELECT id, chat_id, role, content, speaker_character_id, created_at
             FROM messages WHERE {ELIGIBLE_MESSAGES} AND rowid > ?3
             ORDER BY rowid DESC"
        ))?;
        let rows =
            statement.query_map(params![id, failure_pattern, after_rowid], map_message_row)?;
        let mut used_chars = 0_usize;
        for row in rows {
            let mut message: MessageRecord = row?;
            let length = message.content.chars().count();
            if batch.messages.is_empty() {
                if length > MEMORY_EXTRACTION_WINDOW_CHARS {
                    message.content = message
                        .content
                        .chars()
                        .take(MEMORY_EXTRACTION_WINDOW_CHARS)
                        .collect();
                }
            } else if used_chars + length > MEMORY_EXTRACTION_WINDOW_CHARS {
                break;
            }
            used_chars += message.content.chars().count();
            batch.messages.push(message);
        }
        batch.messages.reverse();
        batch.last_message_id = batch.messages.last().map(|message| message.id.clone());
        Ok(batch)
    }

    /// The items most likely to overlap with `text`, so the extractor can
    /// update them instead of adding a second copy. A short list is returned whole.
    pub fn related_memory_items(
        &self,
        chat_id: &str,
        text: &str,
        embedding: Option<(&str, &[f32])>,
        limit: usize,
    ) -> AppResult<Vec<MemoryItemRecord>> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }
        let connection = self.open_connection()?;
        let (model_id, query_vector) = match embedding {
            Some((model_id, vector)) => (model_id.to_string(), normalized_vector(vector)),
            None => (String::new(), None),
        };
        let mut statement = connection.prepare(&format!(
            "SELECT {}, embeddings.embedding
             FROM memory_items
             LEFT JOIN memory_item_embeddings AS embeddings
                ON embeddings.item_id = memory_items.id AND embeddings.embedding_model_id = ?2
             WHERE archived = 0 AND {}
             ORDER BY pinned DESC, importance DESC, updated_at DESC, id ASC",
            prefixed_columns("memory_items"),
            visible_in_chat_condition(1)
        ))?;
        let rows = statement.query_map(params![id, model_id], |row| {
            let item = map_item_row(row)?;
            let blob: Option<Vec<u8>> = row.get(14)?;
            Ok(Candidate {
                item,
                embedding: blob.map(|bytes| decode_vector(&bytes)),
            })
        })?;
        let candidates = rows.collect::<Result<Vec<_>, _>>()?;
        if candidates.len() <= limit {
            return Ok(candidates.into_iter().map(|c| c.item).collect());
        }

        let text_terms: HashSet<String> = tokenize_similarity_terms(&text.to_lowercase())
            .into_iter()
            .collect();
        let mut scored = candidates
            .into_iter()
            .filter_map(|candidate| {
                let terms: HashSet<String> =
                    tokenize_similarity_terms(&candidate.item.content.to_lowercase())
                        .into_iter()
                        .collect();
                let lexical = if terms.is_empty() {
                    0.0
                } else {
                    terms.intersection(&text_terms).count() as f64 / terms.len() as f64
                };
                let semantic = match (&query_vector, &candidate.embedding) {
                    (Some(query), Some(vector)) if query.len() == vector.len() => {
                        dot(query, vector).max(0.0)
                    }
                    _ => 0.0,
                };
                let score = lexical.max(semantic);
                (score > 0.0).then_some((score, candidate.item))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| {
            right
                .0
                .partial_cmp(&left.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.1.id.cmp(&right.1.id))
        });
        Ok(scored
            .into_iter()
            .take(limit)
            .map(|(_, item)| item)
            .collect())
    }

    /// Applies one extraction run atomically and advances the chat's cursor.
    /// Entries that name an item the chat cannot see, or a pinned item, are
    /// skipped so a confused model cannot touch what the user protected.
    pub fn store_memory_extraction(
        &self,
        input: &StoreMemoryExtractionInput,
    ) -> AppResult<MemoryExtractionOutcome> {
        let chat_id = input.chat_id.trim();
        if chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }
        let through_id = input.through_message_id.trim();
        if through_id.is_empty() {
            return Err(AppError::Validation(
                "through message id cannot be empty".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let history_epoch: Option<i64> = transaction
            .query_row(
                "SELECT history_epoch FROM chats WHERE id = ?1",
                [chat_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(history_epoch) = history_epoch else {
            return Err(AppError::NotFound(format!("chat {chat_id} was not found")));
        };
        assert_expected_epoch(chat_id, history_epoch, input.expected_history_epoch)?;
        let through: Option<(i64, String)> = transaction
            .query_row(
                "SELECT rowid, created_at FROM messages WHERE id = ?1 AND chat_id = ?2",
                params![through_id, chat_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((through_rowid, through_created_at)) = through else {
            return Err(AppError::NotFound(format!(
                "message {through_id} was not found in chat {chat_id}"
            )));
        };
        // Never move the cursor backwards.
        let current_rowid: Option<i64> = transaction
            .query_row(
                "SELECT messages.rowid FROM memory_extraction_state
                 INNER JOIN messages ON messages.id = memory_extraction_state.through_message_id
                 WHERE memory_extraction_state.chat_id = ?1",
                [chat_id],
                |row| row.get(0),
            )
            .optional()?;

        let participant_ids = participants_of(&transaction, chat_id)?
            .into_iter()
            .map(|participant| participant.id)
            .collect::<HashSet<_>>();
        let model_id = input.embedding_model_id.clone().unwrap_or_default();
        let mut known = load_visible_items(&transaction, chat_id, &model_id)?;
        let mut outcome = MemoryExtractionOutcome::default();

        for raw_id in &input.remove {
            let id = raw_id.trim();
            match known.iter_mut().find(|entry| entry.item.id == id) {
                Some(entry) if !entry.item.pinned && !entry.item.archived => {
                    transaction.execute(
                        "UPDATE memory_items SET archived = 1, updated_at = ?2 WHERE id = ?1",
                        params![id, now_rfc3339()],
                    )?;
                    entry.item.archived = true;
                    outcome.removed.push(id.to_string());
                }
                _ => outcome.skipped += 1,
            }
        }

        for change in &input.update {
            let id = change.id.trim();
            let Some(position) = known.iter().position(|entry| entry.item.id == id) else {
                outcome.skipped += 1;
                continue;
            };
            if known[position].item.pinned || known[position].item.archived {
                outcome.skipped += 1;
                continue;
            }
            let content = match change.content.as_deref() {
                Some(raw) => match clean_content(raw, MAX_CONTENT_CHARS_EXTRACTED) {
                    Ok(content) => content,
                    Err(_) => {
                        outcome.skipped += 1;
                        continue;
                    }
                },
                None => known[position].item.content.clone(),
            };
            let importance = change
                .importance
                .map(|value| value.clamp(1, 5))
                .unwrap_or(known[position].item.importance);
            let duplicate_of_other = known.iter().enumerate().any(|(other, entry)| {
                other != position
                    && !entry.item.archived
                    && normalize_content_for_dedupe(&entry.item.content)
                        == normalize_content_for_dedupe(&content)
            });
            if duplicate_of_other {
                outcome.skipped += 1;
                continue;
            }
            transaction.execute(
                "UPDATE memory_items SET content = ?2, importance = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, content, importance, now_rfc3339()],
            )?;
            if content != known[position].item.content {
                transaction.execute(
                    "DELETE FROM memory_item_embeddings WHERE item_id = ?1",
                    [id],
                )?;
                known[position].embedding = None;
                if let (Some(vector), false) = (change.embedding.as_deref(), model_id.is_empty()) {
                    store_embedding(&transaction, id, &model_id, vector)?;
                    known[position].embedding = normalized_vector(vector);
                }
            }
            known[position].item = fetch_item(&transaction, id)?
                .ok_or_else(|| AppError::NotFound("memory item vanished".to_string()))?;
            outcome.updated.push(known[position].item.clone());
        }

        for candidate in input.add.iter().take(MEMORY_EXTRACTION_MAX_ADDS) {
            let Some(addition) = prepare_addition(candidate, chat_id, &participant_ids) else {
                outcome.skipped += 1;
                continue;
            };
            let new_vector = match (candidate.embedding.as_deref(), model_id.is_empty()) {
                (Some(vector), false) => normalized_vector(vector),
                _ => None,
            };

            match find_duplicate(&known, &addition, new_vector.as_deref()) {
                Some(position) => {
                    let same_owner = known[position].item.scope == addition.scope
                        && known[position].item.character_id == addition.character_id
                        && known[position].item.chat_id == addition.chat_id;
                    let entry = &known[position];
                    if !same_owner
                        || entry.item.archived
                        || entry.item.pinned
                        || entry.item.content == addition.content
                    {
                        // Already known (or deliberately forgotten): nothing to add.
                        if same_owner
                            && !entry.item.archived
                            && !entry.item.pinned
                            && addition.importance > entry.item.importance
                        {
                            let id = entry.item.id.clone();
                            transaction.execute(
                                "UPDATE memory_items SET importance = ?2, updated_at = ?3 WHERE id = ?1",
                                params![id, addition.importance, now_rfc3339()],
                            )?;
                            known[position].item =
                                fetch_item(&transaction, &id)?.ok_or_else(|| {
                                    AppError::NotFound("memory item vanished".to_string())
                                })?;
                            outcome.updated.push(known[position].item.clone());
                        } else {
                            outcome.skipped += 1;
                        }
                        continue;
                    }
                    // The new wording replaces the old one for the same owner.
                    let id = entry.item.id.clone();
                    let importance = entry.item.importance.max(addition.importance);
                    transaction.execute(
                        "UPDATE memory_items SET content = ?2, importance = ?3, updated_at = ?4 WHERE id = ?1",
                        params![id, addition.content, importance, now_rfc3339()],
                    )?;
                    transaction.execute(
                        "DELETE FROM memory_item_embeddings WHERE item_id = ?1",
                        [id.as_str()],
                    )?;
                    known[position].embedding = None;
                    if let Some(vector) = new_vector.as_deref() {
                        store_embedding(&transaction, &id, &model_id, vector)?;
                        known[position].embedding = Some(vector.to_vec());
                    }
                    known[position].item = fetch_item(&transaction, &id)?
                        .ok_or_else(|| AppError::NotFound("memory item vanished".to_string()))?;
                    outcome.updated.push(known[position].item.clone());
                }
                None => {
                    let active_for_owner = known
                        .iter()
                        .filter(|entry| {
                            !entry.item.archived
                                && entry.item.scope == addition.scope
                                && entry.item.character_id == addition.character_id
                                && entry.item.chat_id == addition.chat_id
                        })
                        .count() as i64;
                    if active_for_owner >= MAX_ITEMS_PER_OWNER {
                        outcome.skipped += 1;
                        continue;
                    }
                    let record = insert_item(
                        &transaction,
                        &NewItem {
                            scope: addition.scope.clone(),
                            character_id: addition.character_id.clone(),
                            chat_id: addition.chat_id.clone(),
                            kind: addition.kind.clone(),
                            content: addition.content.clone(),
                            importance: addition.importance,
                            pinned: false,
                            source_message_id: Some(through_id.to_string()),
                        },
                    )?;
                    if let Some(vector) = new_vector.as_deref() {
                        store_embedding(&transaction, &record.id, &model_id, vector)?;
                    }
                    known.push(KnownItem {
                        item: record.clone(),
                        embedding: new_vector,
                    });
                    outcome.added.push(record);
                }
            }
        }
        outcome.skipped += input.add.len().saturating_sub(MEMORY_EXTRACTION_MAX_ADDS);

        if current_rowid.is_none_or(|current| through_rowid >= current) {
            transaction.execute(
                "INSERT INTO memory_extraction_state (chat_id, through_message_id, through_created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(chat_id) DO UPDATE SET
                    through_message_id = excluded.through_message_id,
                    through_created_at = excluded.through_created_at,
                    updated_at = excluded.updated_at",
                params![chat_id, through_id, through_created_at, now_rfc3339()],
            )?;
        }
        transaction.commit()?;
        Ok(outcome)
    }
}

/// Messages that can feed extraction: real turns, not stored reply failures.
const ELIGIBLE_MESSAGES: &str = "chat_id = ?1
    AND LOWER(TRIM(role)) IN ('user', 'assistant')
    AND TRIM(content) <> ''
    AND content NOT LIKE ?2";

struct NewItem {
    scope: String,
    character_id: Option<String>,
    chat_id: Option<String>,
    kind: String,
    content: String,
    importance: i64,
    pinned: bool,
    source_message_id: Option<String>,
}

struct KnownItem {
    item: MemoryItemRecord,
    embedding: Option<Vec<f32>>,
}

struct Addition {
    scope: String,
    character_id: Option<String>,
    chat_id: Option<String>,
    kind: String,
    content: String,
    importance: i64,
}

fn prepare_addition(
    candidate: &MemoryExtractionAdd,
    chat_id: &str,
    participant_ids: &HashSet<String>,
) -> Option<Addition> {
    let content = clean_content(&candidate.content, MAX_CONTENT_CHARS_EXTRACTED).ok()?;
    let kind = resolve_kind(candidate.kind.as_deref()).unwrap_or_else(|_| "fact".to_string());
    let importance = candidate.importance.map_or(3, |value| value.clamp(1, 5));
    let scope = candidate.scope.trim().to_lowercase();
    let (character_id, chat_id) = match scope.as_str() {
        "user" => (None, None),
        "chat" => (None, Some(chat_id.to_string())),
        "character" => {
            let character_id = clean_optional(candidate.character_id.as_deref())?;
            if !participant_ids.contains(&character_id) {
                return None;
            }
            (Some(character_id), None)
        }
        _ => return None,
    };
    Some(Addition {
        scope,
        character_id,
        chat_id,
        kind,
        content,
        importance,
    })
}

/// Position of an item that already says the same thing, if any.
fn find_duplicate(
    known: &[KnownItem],
    addition: &Addition,
    vector: Option<&[f32]>,
) -> Option<usize> {
    let normalized = normalize_content_for_dedupe(&addition.content);
    let terms: HashSet<String> = tokenize_similarity_terms(&addition.content.to_lowercase())
        .into_iter()
        .collect();
    known.iter().position(|entry| {
        if normalize_content_for_dedupe(&entry.item.content) == normalized {
            return true;
        }
        let other_terms: HashSet<String> =
            tokenize_similarity_terms(&entry.item.content.to_lowercase())
                .into_iter()
                .collect();
        if dice_similarity_score(&terms, &other_terms) >= DUPLICATE_DICE {
            return true;
        }
        match (vector, entry.embedding.as_deref()) {
            (Some(left), Some(right)) if left.len() == right.len() => {
                dot(left, right) > DUPLICATE_COSINE
            }
            _ => false,
        }
    })
}

fn load_visible_items(
    connection: &Connection,
    chat_id: &str,
    embedding_model_id: &str,
) -> AppResult<Vec<KnownItem>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {}, embeddings.embedding
         FROM memory_items
         LEFT JOIN memory_item_embeddings AS embeddings
            ON embeddings.item_id = memory_items.id AND embeddings.embedding_model_id = ?2
         WHERE {}
         ORDER BY created_at ASC, id ASC",
        prefixed_columns("memory_items"),
        visible_in_chat_condition(1)
    ))?;
    let rows = statement.query_map(params![chat_id, embedding_model_id], |row| {
        let item = map_item_row(row)?;
        let blob: Option<Vec<u8>> = row.get(14)?;
        Ok(KnownItem {
            item,
            embedding: blob.map(|bytes| decode_vector(&bytes)),
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn participants_of(
    connection: &Connection,
    chat_id: &str,
) -> AppResult<Vec<MemoryParticipantRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, name FROM characters
         WHERE id IN (
             SELECT character_id FROM chat_participants WHERE chat_id = ?1
             UNION
             SELECT character_id FROM chats WHERE id = ?1 AND character_id IS NOT NULL
         )
         ORDER BY name COLLATE NOCASE ASC, id ASC",
    )?;
    let rows = statement.query_map([chat_id], |row| {
        Ok(MemoryParticipantRecord {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

/// SQL condition (over `memory_items` columns) for items a chat can recall.
fn visible_in_chat_condition(param_index: usize) -> String {
    format!(
        "(scope = 'user'
          OR (scope = 'chat' AND chat_id = ?{param_index})
          OR (scope = 'character' AND character_id IN (
                SELECT character_id FROM chat_participants WHERE chat_id = ?{param_index}
                UNION
                SELECT character_id FROM chats WHERE id = ?{param_index} AND character_id IS NOT NULL)))"
    )
}

fn prefixed_columns(table: &str) -> String {
    ITEM_COLUMNS
        .split(", ")
        .map(|column| format!("{table}.{column}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn map_item_row(row: &Row<'_>) -> rusqlite::Result<MemoryItemRecord> {
    Ok(MemoryItemRecord {
        id: row.get(0)?,
        scope: row.get(1)?,
        character_id: row.get(2)?,
        chat_id: row.get(3)?,
        kind: row.get(4)?,
        content: row.get(5)?,
        importance: row.get(6)?,
        pinned: row.get::<_, i64>(7)? != 0,
        source_message_id: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_recalled_at: row.get(11)?,
        recall_count: row.get(12)?,
        archived: row.get::<_, i64>(13)? != 0,
    })
}

fn fetch_item(connection: &Connection, id: &str) -> AppResult<Option<MemoryItemRecord>> {
    connection
        .query_row(
            &format!("SELECT {ITEM_COLUMNS} FROM memory_items WHERE id = ?1"),
            [id],
            map_item_row,
        )
        .optional()
        .map_err(AppError::from)
}

fn list_owner_items(
    connection: &Connection,
    scope: &str,
    character_id: Option<&str>,
    chat_id: Option<&str>,
) -> AppResult<Vec<MemoryItemRecord>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {ITEM_COLUMNS} FROM memory_items
         WHERE scope = ?1 AND character_id IS ?2 AND chat_id IS ?3"
    ))?;
    let rows = statement.query_map(params![scope, character_id, chat_id], map_item_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
}

fn insert_item(transaction: &Transaction<'_>, item: &NewItem) -> AppResult<MemoryItemRecord> {
    let id = Uuid::new_v4().to_string();
    let now = now_rfc3339();
    transaction.execute(
        "INSERT INTO memory_items
            (id, scope, character_id, chat_id, kind, content, importance, pinned, source_message_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            item.scope,
            item.character_id,
            item.chat_id,
            item.kind,
            item.content,
            item.importance,
            i64::from(item.pinned),
            item.source_message_id,
            now
        ],
    )?;
    fetch_item(transaction, &id)?
        .ok_or_else(|| AppError::NotFound("memory item vanished".to_string()))
}

/// Validates a scope with its owner and returns the owner columns to store.
fn resolve_owner(
    connection: &Connection,
    scope: &str,
    character_id: Option<&str>,
    chat_id: Option<&str>,
) -> AppResult<(String, Option<String>, Option<String>)> {
    let scope = scope.trim().to_lowercase();
    validate_scope(&scope)?;
    match scope.as_str() {
        "user" => Ok((scope, None, None)),
        "character" => {
            let id = clean_optional(character_id).ok_or_else(|| {
                AppError::Validation("a character memory needs a character id".to_string())
            })?;
            let exists: i64 = connection.query_row(
                "SELECT COUNT(1) FROM characters WHERE id = ?1",
                [id.as_str()],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(AppError::NotFound(format!("character {id} was not found")));
            }
            Ok((scope, Some(id), None))
        }
        _ => {
            let id = clean_optional(chat_id)
                .ok_or_else(|| AppError::Validation("a chat memory needs a chat id".to_string()))?;
            let exists: i64 = connection.query_row(
                "SELECT COUNT(1) FROM chats WHERE id = ?1",
                [id.as_str()],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(AppError::NotFound(format!("chat {id} was not found")));
            }
            Ok((scope, None, Some(id)))
        }
    }
}

fn validate_scope(scope: &str) -> AppResult<()> {
    if MEMORY_SCOPES.contains(&scope) {
        Ok(())
    } else {
        Err(AppError::Validation(format!(
            "memory scope must be one of {}",
            MEMORY_SCOPES.join(", ")
        )))
    }
}

fn resolve_kind(kind: Option<&str>) -> AppResult<String> {
    match clean_optional(kind) {
        None => Ok("fact".to_string()),
        Some(kind) => {
            let kind = kind.to_lowercase();
            if MEMORY_KINDS.contains(&kind.as_str()) {
                Ok(kind)
            } else {
                Err(AppError::Validation(format!(
                    "memory kind must be one of {}",
                    MEMORY_KINDS.join(", ")
                )))
            }
        }
    }
}

fn resolve_importance(importance: Option<i64>) -> AppResult<i64> {
    match importance {
        None => Ok(3),
        Some(value) if (1..=5).contains(&value) => Ok(value),
        Some(_) => Err(AppError::Validation(
            "memory importance must be between 1 and 5".to_string(),
        )),
    }
}

fn clean_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Collapses whitespace, drops list markers, and clips to `max_chars`.
fn clean_content(raw: &str, max_chars: usize) -> AppResult<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_start_matches(['-', '*', '\u{2022}']).trim();
    if trimmed.chars().count() < MIN_CONTENT_CHARS {
        return Err(AppError::Validation(
            "memory content is too short".to_string(),
        ));
    }
    Ok(trimmed
        .chars()
        .take(max_chars)
        .collect::<String>()
        .trim_end()
        .to_string())
}

fn store_embedding(
    connection: &Connection,
    item_id: &str,
    embedding_model_id: &str,
    vector: &[f32],
) -> AppResult<()> {
    let Some(normalized) = normalized_vector(vector) else {
        return Err(AppError::Validation(
            "embedding must contain finite, non-zero values".to_string(),
        ));
    };
    let bytes = normalized
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect::<Vec<u8>>();
    let exists: i64 = connection.query_row(
        "SELECT COUNT(1) FROM memory_items WHERE id = ?1",
        [item_id],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Err(AppError::NotFound(format!(
            "memory item {item_id} was not found"
        )));
    }
    connection.execute(
        "INSERT INTO memory_item_embeddings (item_id, embedding_model_id, dimensions, embedding)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(item_id) DO UPDATE SET
            embedding_model_id = excluded.embedding_model_id,
            dimensions = excluded.dimensions,
            embedding = excluded.embedding",
        params![item_id, embedding_model_id, normalized.len() as i64, bytes],
    )?;
    Ok(())
}

fn decode_vector(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

fn normalized_vector(vector: &[f32]) -> Option<Vec<f32>> {
    if vector.is_empty() || vector.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let norm = vector
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if norm == 0.0 {
        return None;
    }
    Some(
        vector
            .iter()
            .map(|value| (f64::from(*value) / norm) as f32)
            .collect(),
    )
}

fn dot(left: &[f32], right: &[f32]) -> f64 {
    left.iter()
        .zip(right)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum()
}

fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

/// How much of an item's weight survives its age. Important items keep most
/// of it; pinned items never fade.
fn decay_factor(item: &MemoryItemRecord, now: DateTime<Utc>) -> f64 {
    if item.pinned {
        return 1.0;
    }
    let anchor = [
        parse_time(&item.updated_at),
        item.last_recalled_at.as_deref().and_then(parse_time),
    ]
    .into_iter()
    .flatten()
    .max();
    let age_days = anchor.map_or(0.0, |anchor| {
        ((now - anchor).num_seconds() as f64 / 86_400.0).max(0.0)
    });
    let floor = 0.5 + 0.1 * (item.importance - 1) as f64;
    floor + (1.0 - floor) * 0.5_f64.powf(age_days / RECENCY_HALF_LIFE_DAYS)
}

fn importance_weight(importance: i64) -> f64 {
    0.7 + 0.15 * (importance - 1) as f64
}

/// How well an item matches the turn, 0 when it does not match at all.
fn relevance(candidate: &Candidate, context: &RankingContext) -> f64 {
    let terms: HashSet<String> = tokenize_similarity_terms(&candidate.item.content.to_lowercase())
        .into_iter()
        .filter(|term| !context.ignore_terms.contains(term))
        .collect();
    let lexical = if terms.is_empty() {
        0.0
    } else {
        let matched: f64 = terms
            .iter()
            .filter_map(|term| context.query_weights.get(term))
            .sum();
        (matched / terms.len().clamp(1, 2) as f64).min(1.0)
    };
    let lexical_relevance = if lexical >= LEXICAL_MIN_OVERLAP {
        0.8 * lexical
    } else {
        0.0
    };

    let min_cosine = 1.0 - ITEM_MAX_L2_DISTANCE.powi(2) / 2.0;
    let semantic_relevance = match (&context.query_embedding, &candidate.embedding) {
        (Some(query), Some(vector)) if query.len() == vector.len() => {
            let cosine = dot(query, vector);
            if cosine >= min_cosine {
                let span = (cosine - min_cosine) / (1.0 - min_cosine);
                (0.3 + 0.7 * span.min(1.0) + 0.15 * lexical).min(1.0)
            } else {
                0.0
            }
        }
        _ => 0.0,
    };
    lexical_relevance.max(semantic_relevance)
}

fn rank_candidates(
    candidates: Vec<Candidate>,
    context: &RankingContext,
    now: DateTime<Utc>,
    max_items: usize,
    char_budget: usize,
) -> Vec<RetrievedMemoryItem> {
    let mut pinned: Vec<MemoryItemRecord> = Vec::new();
    let mut ranked: Vec<(f64, MemoryItemRecord)> = Vec::new();
    for candidate in candidates {
        if candidate.item.archived {
            continue;
        }
        if candidate.item.pinned {
            pinned.push(candidate.item);
            continue;
        }
        let relevance = relevance(&candidate, context);
        if relevance <= 0.0 {
            continue;
        }
        let usage = 1.0 + 0.02 * candidate.item.recall_count.clamp(0, 10) as f64;
        let score = relevance
            * importance_weight(candidate.item.importance)
            * decay_factor(&candidate.item, now)
            * usage;
        ranked.push((score, candidate.item));
    }
    pinned.sort_by(|left, right| {
        right
            .importance
            .cmp(&left.importance)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    ranked.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.1.updated_at.cmp(&left.1.updated_at))
            .then_with(|| left.1.id.cmp(&right.1.id))
    });

    let mut selected: Vec<RetrievedMemoryItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut used_chars = 0_usize;
    let ordered = pinned
        .into_iter()
        .map(|item| (PINNED_SCORE, item))
        .chain(ranked);
    for (score, item) in ordered {
        if selected.len() >= max_items {
            break;
        }
        if !seen.insert(normalize_content_for_dedupe(&item.content)) {
            continue;
        }
        let length = item.content.chars().count();
        if !selected.is_empty() && used_chars + length > char_budget {
            continue;
        }
        used_chars += length;
        selected.push(RetrievedMemoryItem { item, score });
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        db: Database,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("glee-memory-items-test-{}", Uuid::new_v4()));
            let db = Database::new(root.join("test.sqlite3")).unwrap();
            Self { db, root }
        }

        fn character(&self, name: &str) -> String {
            self.db
                .create_character(
                    name, None, None, None, None, None, None, None, None, None, None, None, None,
                    None, None, None, None, None, None, None,
                )
                .unwrap()
                .id
        }

        fn item(
            &self,
            scope: &str,
            character_id: Option<&str>,
            chat_id: Option<&str>,
            content: &str,
        ) -> MemoryItemRecord {
            self.db
                .create_memory_item(&CreateMemoryItemInput {
                    scope: scope.to_string(),
                    character_id: character_id.map(str::to_string),
                    chat_id: chat_id.map(str::to_string),
                    kind: None,
                    content: content.to_string(),
                    importance: None,
                    pinned: None,
                    source_message_id: None,
                })
                .unwrap()
        }

        fn retrieve(
            &self,
            chat_id: &str,
            speaker: Option<&str>,
            query: &str,
        ) -> Vec<MemoryItemRecord> {
            self.db
                .retrieve_memory_items(&MemoryRetrievalRequest {
                    chat_id,
                    speaker_character_id: speaker,
                    query,
                    query_embedding: None,
                    max_items: RETRIEVAL_MAX_ITEMS,
                    char_budget: RETRIEVAL_CHAR_BUDGET,
                })
                .unwrap()
                .into_iter()
                .map(|entry| entry.item)
                .collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn record(id: &str, content: &str, importance: i64, updated_at: &str) -> MemoryItemRecord {
        MemoryItemRecord {
            id: id.to_string(),
            scope: "user".to_string(),
            character_id: None,
            chat_id: None,
            kind: "fact".to_string(),
            content: content.to_string(),
            importance,
            pinned: false,
            source_message_id: None,
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
            last_recalled_at: None,
            recall_count: 0,
            archived: false,
        }
    }

    fn context(query: &str, embedding: Option<Vec<f32>>) -> RankingContext {
        RankingContext {
            query_weights: tokenize_similarity_terms(query)
                .into_iter()
                .map(|term| (term, 1.0))
                .collect(),
            ignore_terms: HashSet::new(),
            query_embedding: embedding,
        }
    }

    fn at(value: &str) -> DateTime<Utc> {
        parse_time(value).unwrap()
    }

    fn ids(entries: &[RetrievedMemoryItem]) -> Vec<&str> {
        entries.iter().map(|entry| entry.item.id.as_str()).collect()
    }

    #[test]
    fn crud_round_trip_and_validation() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let created = f.item(
            "character",
            Some(&ada),
            None,
            "  - Ada promised to teach Sam chess ",
        );
        assert_eq!(created.content, "Ada promised to teach Sam chess");
        assert_eq!(created.importance, 3);
        assert_eq!(created.kind, "fact");
        assert!(!created.pinned);

        let updated =
            f.db.update_memory_item(&UpdateMemoryItemInput {
                id: created.id.clone(),
                content: Some("Ada promised to teach Sam chess on Sunday".to_string()),
                importance: Some(5),
                pinned: Some(true),
                archived: None,
                kind: Some("promise".to_string()),
                scope: None,
                character_id: None,
                chat_id: None,
            })
            .unwrap();
        assert_eq!(updated.kind, "promise");
        assert_eq!(updated.importance, 5);
        assert!(updated.pinned);

        // Same text again for the same owner returns the existing item.
        let again = f.item(
            "character",
            Some(&ada),
            None,
            "Ada promised to teach Sam chess on sunday",
        );
        assert_eq!(again.id, created.id);

        assert!(f
            .db
            .create_memory_item(&CreateMemoryItemInput {
                scope: "planet".to_string(),
                character_id: None,
                chat_id: None,
                kind: None,
                content: "Nope nope".to_string(),
                importance: None,
                pinned: None,
                source_message_id: None,
            })
            .is_err());
        assert!(f
            .db
            .create_memory_item(&CreateMemoryItemInput {
                scope: "character".to_string(),
                character_id: None,
                chat_id: None,
                kind: None,
                content: "Missing owner".to_string(),
                importance: None,
                pinned: None,
                source_message_id: None,
            })
            .is_err());
        assert!(f
            .db
            .update_memory_item(&UpdateMemoryItemInput {
                id: created.id.clone(),
                content: None,
                importance: Some(9),
                pinned: None,
                archived: None,
                kind: None,
                scope: None,
                character_id: None,
                chat_id: None,
            })
            .is_err());

        f.db.delete_memory_item(&created.id).unwrap();
        assert!(matches!(
            f.db.delete_memory_item(&created.id),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn moving_an_item_between_scopes_checks_the_owner() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let item = f.item("chat", None, Some(&chat.id), "The team met at the harbor");
        let moved =
            f.db.update_memory_item(&UpdateMemoryItemInput {
                id: item.id.clone(),
                content: None,
                importance: None,
                pinned: None,
                archived: None,
                kind: None,
                scope: Some("user".to_string()),
                character_id: None,
                chat_id: None,
            })
            .unwrap();
        assert_eq!(moved.scope, "user");
        assert!(moved.chat_id.is_none());

        let error = f.db.update_memory_item(&UpdateMemoryItemInput {
            id: item.id,
            content: None,
            importance: None,
            pinned: None,
            archived: None,
            kind: None,
            scope: Some("character".to_string()),
            character_id: None,
            chat_id: None,
        });
        assert!(matches!(error, Err(AppError::Validation(_))));
    }

    #[test]
    fn list_filters_scope_owner_and_archived() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let bea = f.character("Bea");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        f.item("user", None, None, "Sam is allergic to peanuts");
        f.item("character", Some(&ada), None, "Ada owns a brass telescope");
        f.item("character", Some(&bea), None, "Bea keeps bees");
        let chat_item = f.item(
            "chat",
            None,
            Some(&chat.id),
            "The trip is planned for spring",
        );
        f.db.update_memory_item(&UpdateMemoryItemInput {
            id: chat_item.id.clone(),
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

        let list = |filter: ListMemoryItemsInput| f.db.list_memory_items(&filter).unwrap().len();
        assert_eq!(list(ListMemoryItemsInput::default()), 3);
        assert_eq!(
            list(ListMemoryItemsInput {
                include_archived: true,
                ..Default::default()
            }),
            4
        );
        assert_eq!(
            list(ListMemoryItemsInput {
                scope: Some("character".to_string()),
                character_id: Some(bea.clone()),
                ..Default::default()
            }),
            1
        );
        // Ada's chat sees the user item and Ada's own item, never Bea's.
        let visible =
            f.db.list_memory_items(&ListMemoryItemsInput {
                visible_in_chat: Some(chat.id.clone()),
                ..Default::default()
            })
            .unwrap();
        let texts = visible
            .iter()
            .map(|i| i.content.as_str())
            .collect::<Vec<_>>();
        assert_eq!(visible.len(), 2);
        assert!(texts.contains(&"Ada owns a brass telescope"));
        assert!(!texts.contains(&"Bea keeps bees"));
    }

    #[test]
    fn forget_commands_remove_only_the_named_owner() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let bea = f.character("Bea");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        f.item("user", None, None, "Sam lives near the coast");
        f.item("character", Some(&ada), None, "Ada owns a brass telescope");
        f.item("character", Some(&bea), None, "Bea keeps bees");
        f.item(
            "chat",
            None,
            Some(&chat.id),
            "The trip is planned for spring",
        );

        assert_eq!(
            f.db.delete_memory_items_for(&DeleteMemoryItemsForInput {
                character_id: Some(ada.clone()),
                ..Default::default()
            })
            .unwrap(),
            1
        );
        assert_eq!(
            f.db.delete_memory_items_for(&DeleteMemoryItemsForInput {
                chat_id: Some(chat.id.clone()),
                ..Default::default()
            })
            .unwrap(),
            1
        );
        let rest =
            f.db.list_memory_items(&ListMemoryItemsInput::default())
                .unwrap();
        assert_eq!(rest.len(), 2);
        assert!(f
            .db
            .delete_memory_items_for(&DeleteMemoryItemsForInput::default())
            .is_err());
        assert!(f
            .db
            .delete_memory_items_for(&DeleteMemoryItemsForInput {
                character_id: Some(bea),
                chat_id: Some(chat.id),
                ..Default::default()
            })
            .is_err());
        assert_eq!(
            f.db.delete_memory_items_for(&DeleteMemoryItemsForInput {
                scope: Some("user".to_string()),
                ..Default::default()
            })
            .unwrap(),
            1
        );
    }

    #[test]
    fn deleting_a_character_or_chat_cascades() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let user = f.item("user", None, None, "Sam lives near the coast");
        let own = f.item("character", Some(&ada), None, "Ada owns a brass telescope");
        let scoped = f.item(
            "chat",
            None,
            Some(&chat.id),
            "The trip is planned for spring",
        );
        f.db.set_memory_item_embedding(&own.id, "model", &[1.0, 0.0])
            .unwrap();
        f.db.set_memory_item_embedding(&scoped.id, "model", &[0.0, 1.0])
            .unwrap();

        f.db.delete_chat(&chat.id).unwrap();
        assert!(f.db.get_memory_item(&scoped.id).is_err());
        assert!(f.db.get_memory_item(&own.id).is_ok());

        f.db.delete_character(&ada).unwrap();
        assert!(f.db.get_memory_item(&own.id).is_err());
        assert!(f.db.get_memory_item(&user.id).is_ok());

        let connection = f.db.open_connection().unwrap();
        let orphans: i64 = connection
            .query_row("SELECT COUNT(1) FROM memory_item_embeddings", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(orphans, 0);
    }

    #[test]
    fn clearing_history_drops_chat_items_only() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let other = f.db.create_chat("two", Some(&ada)).unwrap();
        let user = f.item("user", None, None, "Sam lives near the coast");
        let own = f.item("character", Some(&ada), None, "Ada owns a brass telescope");
        let scoped = f.item(
            "chat",
            None,
            Some(&chat.id),
            "The trip is planned for spring",
        );
        let kept = f.item("chat", None, Some(&other.id), "The picnic is on Friday");

        f.db.clear_chat_history_mutation(&chat.id).unwrap();
        assert!(f.db.get_memory_item(&scoped.id).is_err());
        for survivor in [&user.id, &own.id, &kept.id] {
            assert!(f.db.get_memory_item(survivor).is_ok());
        }
    }

    #[test]
    fn group_chats_never_recall_another_characters_private_memories() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let bea = f.character("Bea");
        let chat =
            f.db.create_group_chat("group", &[ada.clone(), bea.clone()])
                .unwrap();
        f.item("user", None, None, "Sam collects antique maps");
        f.item(
            "character",
            Some(&ada),
            None,
            "Ada hides a secret map in the attic",
        );
        f.item(
            "character",
            Some(&bea),
            None,
            "Bea sketched a secret map of the harbor",
        );
        f.item(
            "chat",
            None,
            Some(&chat.id),
            "The group is searching for the old map",
        );

        let for_ada = f.retrieve(&chat.id, Some(&ada), "Where is the map?");
        let texts = for_ada
            .iter()
            .map(|i| i.content.as_str())
            .collect::<Vec<_>>();
        assert!(texts.contains(&"Ada hides a secret map in the attic"));
        assert!(texts.contains(&"Sam collects antique maps"));
        assert!(texts.contains(&"The group is searching for the old map"));
        assert!(!texts.iter().any(|text| text.starts_with("Bea")));

        let for_bea = f.retrieve(&chat.id, Some(&bea), "Where is the map?");
        assert!(for_bea.iter().any(|i| i.content.starts_with("Bea")));
        assert!(!for_bea.iter().any(|i| i.content.starts_with("Ada")));

        // Without a named speaker a group chat gets no character-scope items.
        let nobody = f.retrieve(&chat.id, None, "Where is the map?");
        assert!(!nobody.iter().any(|i| i.scope == "character"));
    }

    #[test]
    fn single_chats_fall_back_to_their_character_and_cross_chats() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let first = f.db.create_chat("one", Some(&ada)).unwrap();
        let second = f.db.create_chat("two", Some(&ada)).unwrap();
        f.item("character", Some(&ada), None, "Ada owns a brass telescope");
        f.item(
            "chat",
            None,
            Some(&first.id),
            "The telescope arrived on Tuesday",
        );

        let in_second = f.retrieve(&second.id, None, "Tell me about the telescope");
        assert_eq!(in_second.len(), 1);
        assert_eq!(in_second[0].content, "Ada owns a brass telescope");
    }

    #[test]
    fn retrieval_ignores_names_and_marks_recalled() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        f.item("user", None, None, "Sam is allergic to peanuts");

        // A name alone is not a reason to surface an allergy.
        f.db.upsert_user_profile(crate::db::UserProfilePatch {
            display_name: Some("Sam"),
            ..Default::default()
        })
        .unwrap();
        assert!(f
            .retrieve(&chat.id, None, "Hello Sam, how was your day?")
            .is_empty());

        let hits = f.retrieve(&chat.id, None, "Can you pass the peanuts please?");
        assert_eq!(hits.len(), 1);
        let stored = f.db.get_memory_item(&hits[0].id).unwrap();
        assert_eq!(stored.recall_count, 1);
        assert!(stored.last_recalled_at.is_some());
    }

    #[test]
    fn pinned_items_always_lead() {
        let candidates = vec![
            Candidate {
                item: record(
                    "a",
                    "Sam enjoys hiking trails in autumn",
                    3,
                    "2000-01-01T00:00:00Z",
                ),
                embedding: None,
            },
            Candidate {
                item: MemoryItemRecord {
                    pinned: true,
                    ..record(
                        "b",
                        "Never mention the lighthouse fire",
                        2,
                        "2000-01-01T00:00:00Z",
                    )
                },
                embedding: None,
            },
        ];
        let ranked = rank_candidates(
            candidates,
            &context("hiking trails", None),
            at("2000-01-02T00:00:00Z"),
            6,
            600,
        );
        assert_eq!(ids(&ranked), vec!["b", "a"]);
    }

    #[test]
    fn ranking_weighs_importance_and_recency() {
        let now = at("2000-06-01T00:00:00Z");
        let candidates = vec![
            Candidate {
                item: record(
                    "low",
                    "Sam likes green tea in the morning",
                    1,
                    "2000-05-31T00:00:00Z",
                ),
                embedding: None,
            },
            Candidate {
                item: record(
                    "high",
                    "Sam likes green tea with honey",
                    5,
                    "2000-05-31T00:00:00Z",
                ),
                embedding: None,
            },
            Candidate {
                item: record(
                    "stale",
                    "Sam likes green tea after dinner",
                    3,
                    "2000-01-01T00:00:00Z",
                ),
                embedding: None,
            },
            Candidate {
                item: record(
                    "fresh",
                    "Sam likes green tea before bed",
                    3,
                    "2000-05-31T00:00:00Z",
                ),
                embedding: None,
            },
        ];
        let ranked = rank_candidates(candidates, &context("green tea", None), now, 6, 600);
        let order = ids(&ranked);
        assert_eq!(order[0], "high");
        assert!(
            order.iter().position(|id| *id == "fresh") < order.iter().position(|id| *id == "stale")
        );
        assert!(
            order.iter().position(|id| *id == "fresh") < order.iter().position(|id| *id == "low")
        );
    }

    #[test]
    fn important_items_never_fully_decay() {
        let ancient = record("x", "Sam is allergic to peanuts", 5, "1990-01-01T00:00:00Z");
        let decay = decay_factor(&ancient, at("2000-01-01T00:00:00Z"));
        assert!((0.89..=1.0).contains(&decay));
        let minor = record("y", "Sam saw a bird", 1, "1990-01-01T00:00:00Z");
        let minor_decay = decay_factor(&minor, at("2000-01-01T00:00:00Z"));
        assert!((0.5..0.51).contains(&minor_decay));
        let mut recalled = minor.clone();
        recalled.last_recalled_at = Some("1999-12-31T00:00:00Z".to_string());
        assert!(decay_factor(&recalled, at("2000-01-01T00:00:00Z")) > 0.9);
    }

    #[test]
    fn budget_and_count_caps_apply() {
        let long = |index: usize| {
            record(
                &format!("id{index}"),
                &format!(
                    "Sam hiked the northern ridge trail number {index} {}",
                    "x".repeat(160)
                ),
                3,
                "2000-01-01T00:00:00Z",
            )
        };
        let candidates = (0..10)
            .map(|index| Candidate {
                item: long(index),
                embedding: None,
            })
            .collect::<Vec<_>>();
        let ranked = rank_candidates(
            candidates,
            &context("northern ridge trail", None),
            at("2000-01-02T00:00:00Z"),
            6,
            600,
        );
        let used: usize = ranked
            .iter()
            .map(|entry| entry.item.content.chars().count())
            .sum();
        assert!(ranked.len() <= 3, "{} items", ranked.len());
        assert!(used <= 600);

        let many = (0..10)
            .map(|index| Candidate {
                item: record(
                    &format!("m{index}"),
                    &format!("Sam hiked ridge {index}"),
                    3,
                    "2000-01-01T00:00:00Z",
                ),
                embedding: None,
            })
            .collect::<Vec<_>>();
        let capped = rank_candidates(
            many,
            &context("hiked ridge", None),
            at("2000-01-02T00:00:00Z"),
            6,
            600,
        );
        assert_eq!(capped.len(), 6);
    }

    #[test]
    fn semantic_similarity_respects_the_floor() {
        let near = Candidate {
            item: record("near", "Sam avoids nuts", 3, "2000-01-01T00:00:00Z"),
            embedding: Some(vec![1.0, 0.0]),
        };
        let far = Candidate {
            item: record("far", "Sam owns a bicycle", 3, "2000-01-01T00:00:00Z"),
            embedding: Some(vec![0.0, 1.0]),
        };
        let ranked = rank_candidates(
            vec![near, far],
            &context("snack ideas", Some(vec![1.0, 0.0])),
            at("2000-01-02T00:00:00Z"),
            6,
            600,
        );
        assert_eq!(ids(&ranked), vec!["near"]);
    }

    #[test]
    fn stored_vectors_drive_retrieval() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let near = f.item("user", None, None, "Sam avoids nuts");
        let far = f.item("user", None, None, "Sam owns a bicycle");
        f.db.set_memory_item_embedding(&near.id, "m1", &[3.0, 0.0])
            .unwrap();
        f.db.set_memory_item_embedding(&far.id, "m1", &[0.0, 2.0])
            .unwrap();

        let ask = |model: &str| {
            f.db.retrieve_memory_items(&MemoryRetrievalRequest {
                chat_id: &chat.id,
                speaker_character_id: None,
                query: "snack ideas",
                query_embedding: Some((model, &[1.0, 0.0])),
                max_items: 6,
                char_budget: 600,
            })
            .unwrap()
        };
        let hits = ask("m1");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].item.id, near.id);
        // Vectors from another model are never compared.
        assert!(ask("other").is_empty());

        let missing = f.db.list_memory_items_missing_embeddings("m1", 10).unwrap();
        assert!(missing.is_empty());
        let missing =
            f.db.list_memory_items_missing_embeddings("other", 10)
                .unwrap();
        assert_eq!(missing.len(), 2);

        // Editing the text drops the stale vector.
        f.db.update_memory_item(&UpdateMemoryItemInput {
            id: near.id.clone(),
            content: Some("Sam avoids dairy".to_string()),
            importance: None,
            pinned: None,
            archived: None,
            kind: None,
            scope: None,
            character_id: None,
            chat_id: None,
        })
        .unwrap();
        let missing = f.db.list_memory_items_missing_embeddings("m1", 10).unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].id, near.id);
    }

    fn add(scope: &str, character_id: Option<&str>, content: &str) -> MemoryExtractionAdd {
        MemoryExtractionAdd {
            scope: scope.to_string(),
            character_id: character_id.map(str::to_string),
            kind: Some("fact".to_string()),
            content: content.to_string(),
            importance: Some(3),
            embedding: None,
        }
    }

    fn extraction(
        chat_id: &str,
        through: &str,
        adds: Vec<MemoryExtractionAdd>,
    ) -> StoreMemoryExtractionInput {
        StoreMemoryExtractionInput {
            chat_id: chat_id.to_string(),
            through_message_id: through.to_string(),
            expected_history_epoch: None,
            add: adds,
            update: Vec::new(),
            remove: Vec::new(),
            embedding_model_id: None,
        }
    }

    fn seed_messages(f: &Fixture, chat_id: &str, count: usize) -> Vec<MessageRecord> {
        (0..count)
            .map(|index| {
                f.db.append_message_at_epoch(
                    chat_id,
                    if index % 2 == 0 { "user" } else { "assistant" },
                    &format!("Message number {index} about the harbor"),
                    None,
                    None,
                )
                .unwrap()
            })
            .collect()
    }

    #[test]
    fn extraction_window_waits_for_enough_messages_and_tracks_the_cursor() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let messages = seed_messages(&f, &chat.id, 5);
        let early = f.db.get_memory_extraction_window(&chat.id).unwrap();
        assert!(!early.ready);
        assert_eq!(early.pending_count, 5);
        assert!(early.messages.is_empty());
        assert_eq!(early.participants.len(), 1);

        let more = seed_messages(&f, &chat.id, 3);
        let batch = f.db.get_memory_extraction_window(&chat.id).unwrap();
        assert!(batch.ready);
        assert_eq!(batch.messages.len(), 8);
        assert_eq!(batch.messages[0].id, messages[0].id);
        assert_eq!(batch.last_message_id.as_deref(), Some(more[2].id.as_str()));

        f.db.store_memory_extraction(&extraction(
            &chat.id,
            more[2].id.as_str(),
            vec![add("user", None, "Sam loves the harbor")],
        ))
        .unwrap();
        let after = f.db.get_memory_extraction_window(&chat.id).unwrap();
        assert!(!after.ready);
        assert_eq!(after.pending_count, 0);

        // A deleted cursor message falls back to its timestamp, not the whole chat.
        f.db.delete_message(&more[2].id, after.history_epoch)
            .unwrap();
        let after_delete = f.db.get_memory_extraction_window(&chat.id).unwrap();
        assert_eq!(after_delete.pending_count, 0);
    }

    #[test]
    fn extraction_window_is_the_newest_slice_within_the_char_budget() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let filler = "w".repeat(900);
        for index in 0..8 {
            f.db.append_message_at_epoch(
                &chat.id,
                if index % 2 == 0 { "user" } else { "assistant" },
                &format!("{index} {filler}"),
                None,
                None,
            )
            .unwrap();
        }
        let batch = f.db.get_memory_extraction_window(&chat.id).unwrap();
        assert!(batch.ready);
        assert_eq!(batch.pending_count, 8);
        let total: usize = batch
            .messages
            .iter()
            .map(|m| m.content.chars().count())
            .sum();
        assert!(total <= MEMORY_EXTRACTION_WINDOW_CHARS);
        assert!(batch.messages.len() < 8);
        assert!(batch.messages.last().unwrap().content.starts_with("7 "));
    }

    #[test]
    fn extraction_dedupes_and_merges_into_existing_items() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let messages = seed_messages(&f, &chat.id, 6);
        let last = messages.last().unwrap().id.clone();

        let first =
            f.db.store_memory_extraction(&extraction(
                &chat.id,
                &last,
                vec![
                    add("user", None, "Sam is allergic to peanuts"),
                    add("character", Some(&ada), "Ada promised to teach Sam chess"),
                    add("chat", None, "The harbor trip is planned for spring"),
                    add(
                        "character",
                        Some("not-a-participant"),
                        "Someone else knows this",
                    ),
                    add("galaxy", None, "Invalid scope entry"),
                    add("user", None, "x"),
                ],
            ))
            .unwrap();
        assert_eq!(first.added.len(), 3);
        assert_eq!(first.skipped, 3);

        // Equal text and close paraphrases fold into the existing items.
        let second =
            f.db.store_memory_extraction(&extraction(
                &chat.id,
                &last,
                vec![
                    add("user", None, "sam is allergic to  peanuts"),
                    add("user", None, "Sam is severely allergic to peanuts"),
                ],
            ))
            .unwrap();
        assert!(second.added.is_empty());
        let items =
            f.db.list_memory_items(&ListMemoryItemsInput {
                scope: Some("user".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].content, "Sam is severely allergic to peanuts");
    }

    #[test]
    fn extraction_dedupes_by_embedding_similarity() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let messages = seed_messages(&f, &chat.id, 6);
        let last = messages.last().unwrap().id.clone();

        let with_vector = |scope: &str, content: &str, vector: Vec<f32>| MemoryExtractionAdd {
            embedding: Some(vector),
            ..add(scope, None, content)
        };
        let mut first = extraction(
            &chat.id,
            &last,
            vec![with_vector(
                "user",
                "Sam dreads peanut exposure",
                vec![1.0, 0.1, 0.0],
            )],
        );
        first.embedding_model_id = Some("m1".to_string());
        assert_eq!(f.db.store_memory_extraction(&first).unwrap().added.len(), 1);

        let mut second = extraction(
            &chat.id,
            &last,
            vec![
                with_vector("user", "Nuts make Sam very sick", vec![1.0, 0.2, 0.0]),
                with_vector("user", "Sam rides a bicycle to work", vec![0.0, 0.0, 1.0]),
            ],
        );
        second.embedding_model_id = Some("m1".to_string());
        let outcome = f.db.store_memory_extraction(&second).unwrap();
        assert_eq!(outcome.added.len(), 1);
        assert_eq!(outcome.updated.len(), 1);
        assert_eq!(outcome.updated[0].content, "Nuts make Sam very sick");
        assert_eq!(
            f.db.list_memory_items(&ListMemoryItemsInput::default())
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn extraction_updates_and_removes_respect_pins_and_visibility() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let bea = f.character("Bea");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let messages = seed_messages(&f, &chat.id, 6);
        let last = messages.last().unwrap().id.clone();

        let editable = f.item("user", None, None, "Sam works at the bakery");
        let obsolete = f.item("user", None, None, "Sam lives in the old town");
        let pinned = f.item("user", None, None, "Sam never wants spoilers");
        f.db.update_memory_item(&UpdateMemoryItemInput {
            id: pinned.id.clone(),
            content: None,
            importance: None,
            pinned: Some(true),
            archived: None,
            kind: None,
            scope: None,
            character_id: None,
            chat_id: None,
        })
        .unwrap();
        let foreign = f.item("character", Some(&bea), None, "Bea keeps bees");

        let mut input = extraction(&chat.id, &last, Vec::new());
        input.update = vec![
            MemoryExtractionUpdate {
                id: editable.id.clone(),
                content: Some("Sam works at the library".to_string()),
                importance: Some(4),
                embedding: None,
            },
            MemoryExtractionUpdate {
                id: pinned.id.clone(),
                content: Some("Sam loves spoilers".to_string()),
                importance: None,
                embedding: None,
            },
            MemoryExtractionUpdate {
                id: foreign.id.clone(),
                content: Some("Bea keeps wasps".to_string()),
                importance: None,
                embedding: None,
            },
        ];
        input.remove = vec![
            obsolete.id.clone(),
            pinned.id.clone(),
            foreign.id.clone(),
            "missing".to_string(),
        ];
        let outcome = f.db.store_memory_extraction(&input).unwrap();
        assert_eq!(outcome.updated.len(), 1);
        assert_eq!(outcome.updated[0].content, "Sam works at the library");
        assert_eq!(outcome.updated[0].importance, 4);
        assert_eq!(outcome.removed, vec![obsolete.id.clone()]);
        assert_eq!(outcome.skipped, 5);

        assert!(f.db.get_memory_item(&obsolete.id).unwrap().archived);
        assert_eq!(
            f.db.get_memory_item(&pinned.id).unwrap().content,
            "Sam never wants spoilers"
        );
        assert_eq!(
            f.db.get_memory_item(&foreign.id).unwrap().content,
            "Bea keeps bees"
        );

        // An item the extractor archived is not resurrected by a repeat.
        let again =
            f.db.store_memory_extraction(&extraction(
                &chat.id,
                &last,
                vec![add("user", None, "Sam lives in the old town")],
            ))
            .unwrap();
        assert!(again.added.is_empty());
        assert!(f.db.get_memory_item(&obsolete.id).unwrap().archived);
    }

    #[test]
    fn extraction_rejects_stale_epochs_and_caps_additions() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        let messages = seed_messages(&f, &chat.id, 6);
        let last = messages.last().unwrap().id.clone();

        let mut stale = extraction(
            &chat.id,
            &last,
            vec![add("user", None, "Sam likes harbors")],
        );
        stale.expected_history_epoch = Some(chat.history_epoch + 3);
        assert!(matches!(
            f.db.store_memory_extraction(&stale),
            Err(AppError::Conflict(_))
        ));
        assert!(f
            .db
            .store_memory_extraction(&extraction(&chat.id, "missing", Vec::new()))
            .is_err());

        let many = [
            "Sam visited Lisbon last summer",
            "Sam adopted a grey cat",
            "Sam plays the cello on weekends",
            "Sam dislikes crowded elevators",
            "Sam trains for a spring marathon",
            "Sam bakes sourdough bread",
            "Sam collects vintage postcards",
            "Sam fears deep water",
            "Sam studies astronomy at night",
        ]
        .iter()
        .map(|content| add("user", None, content))
        .collect::<Vec<_>>();
        let outcome =
            f.db.store_memory_extraction(&extraction(&chat.id, &last, many))
                .unwrap();
        assert_eq!(outcome.added.len(), MEMORY_EXTRACTION_MAX_ADDS);
        assert_eq!(outcome.skipped, 3);
    }

    #[test]
    fn related_items_return_everything_when_short_and_the_best_when_long() {
        let f = Fixture::new();
        let ada = f.character("Ada");
        let chat = f.db.create_chat("one", Some(&ada)).unwrap();
        f.item("user", None, None, "Sam is allergic to peanuts");
        let few =
            f.db.related_memory_items(&chat.id, "anything at all", None, 3)
                .unwrap();
        assert_eq!(few.len(), 1);

        for index in 0..4 {
            f.item(
                "user",
                None,
                None,
                &format!("Sam visited place {index} long ago"),
            );
        }
        let best =
            f.db.related_memory_items(&chat.id, "he mentioned peanuts again", None, 2)
                .unwrap();
        assert_eq!(best[0].content, "Sam is allergic to peanuts");
    }

    #[test]
    fn schema_matches_the_documented_contract() {
        let f = Fixture::new();
        let connection = f.db.open_connection().unwrap();
        let mut statement = connection
            .prepare("PRAGMA table_info(memory_items)")
            .unwrap();
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for expected in [
            "id",
            "scope",
            "character_id",
            "chat_id",
            "kind",
            "content",
            "importance",
            "pinned",
            "source_message_id",
            "created_at",
            "updated_at",
            "last_recalled_at",
            "recall_count",
            "archived",
        ] {
            assert!(
                columns.iter().any(|column| column == expected),
                "{expected}"
            );
        }
        // Scope and owner columns must agree, and values stay in range.
        let invalid = [
            "INSERT INTO memory_items (id, scope, kind, content, created_at, updated_at) VALUES ('a', 'character', 'fact', 'x', 't', 't')",
            "INSERT INTO memory_items (id, scope, kind, content, created_at, updated_at) VALUES ('b', 'planet', 'fact', 'x', 't', 't')",
            "INSERT INTO memory_items (id, scope, kind, content, created_at, updated_at) VALUES ('c', 'user', 'mood', 'x', 't', 't')",
            "INSERT INTO memory_items (id, scope, kind, content, importance, created_at, updated_at) VALUES ('d', 'user', 'fact', 'x', 9, 't', 't')",
        ];
        for sql in invalid {
            assert!(connection.execute(sql, []).is_err(), "{sql}");
        }
    }
}
