use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};
use uuid::Uuid;

use crate::embedding_service::{normalize_embedding, EmbeddingChunk};
use crate::errors::{AppError, AppResult};
use crate::types::{ChatHistoryMutationRecord, MemorySnippetRecord, MessageRecord};

use super::{now_rfc3339, Database};

impl Database {
    pub fn list_messages(&self, chat_id: &str) -> AppResult<Vec<MessageRecord>> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let connection = self.open_connection()?;
        let exists: i64 =
            connection.query_row("SELECT COUNT(1) FROM chats WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        }

        let mut statement = connection.prepare(
            "SELECT id, chat_id, role, content, speaker_character_id, created_at FROM messages WHERE chat_id = ?1 ORDER BY rowid ASC",
        )?;
        let rows = statement.query_map([id], map_message_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn clear_chat_history_mutation(
        &self,
        chat_id: &str,
    ) -> AppResult<ChatHistoryMutationRecord> {
        let clean_chat_id = chat_id.trim();
        if clean_chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let current_epoch: Option<i64> = transaction
            .query_row(
                "SELECT history_epoch FROM chats WHERE id = ?1",
                [clean_chat_id],
                |row| row.get(0),
            )
            .optional()?;
        if current_epoch.is_none() {
            return Err(AppError::NotFound(format!(
                "chat {clean_chat_id} was not found"
            )));
        }

        transaction.execute("DELETE FROM messages WHERE chat_id = ?1", [clean_chat_id])?;
        transaction.execute(
            "DELETE FROM chat_memory WHERE chat_id = ?1",
            [clean_chat_id],
        )?;
        transaction.execute(
            "DELETE FROM chat_relationship_states WHERE chat_id = ?1",
            [clean_chat_id],
        )?;
        // Only this chat's own memories go; user and character memories outlive it.
        transaction.execute(
            "DELETE FROM memory_items WHERE scope = 'chat' AND chat_id = ?1",
            [clean_chat_id],
        )?;
        transaction.execute(
            "DELETE FROM memory_extraction_state WHERE chat_id = ?1",
            [clean_chat_id],
        )?;
        let updated_at = now_rfc3339();
        transaction.execute(
            "UPDATE chats SET history_epoch = history_epoch + 1, updated_at = ?1 WHERE id = ?2",
            params![updated_at, clean_chat_id],
        )?;
        let history_epoch = transaction.query_row(
            "SELECT history_epoch FROM chats WHERE id = ?1",
            [clean_chat_id],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        self.delete_chat_vectors_best_effort(clean_chat_id);
        Ok(ChatHistoryMutationRecord {
            chat_id: clean_chat_id.to_string(),
            history_epoch,
            updated_at,
            messages: Vec::new(),
        })
    }

    pub fn append_message_at_epoch(
        &self,
        chat_id: &str,
        role: &str,
        content: &str,
        speaker_character_id: Option<&str>,
        expected_history_epoch: Option<i64>,
    ) -> AppResult<MessageRecord> {
        let clean_chat_id = chat_id.trim();
        if clean_chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let clean_role = role.trim().to_lowercase();
        if clean_role.is_empty() {
            return Err(AppError::Validation(
                "message role cannot be empty".to_string(),
            ));
        }

        let clean_content = content.trim();
        if clean_content.is_empty() {
            return Err(AppError::Validation(
                "message content cannot be empty".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let chat = transaction
            .query_row(
                "SELECT character_id, chat_mode, history_epoch FROM chats WHERE id = ?1",
                [clean_chat_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;
        let (chat_character_id, chat_mode, history_epoch) = if let Some(chat) = chat {
            chat
        } else {
            return Err(AppError::NotFound(format!(
                "chat {clean_chat_id} was not found"
            )));
        };
        assert_expected_epoch(clean_chat_id, history_epoch, expected_history_epoch)?;

        let clean_speaker_character_id = if let Some(speaker_character_id) = speaker_character_id {
            let id = speaker_character_id.trim();
            if id.is_empty() {
                return Err(AppError::Validation(
                    "speaker_character_id cannot be empty when provided".to_string(),
                ));
            }

            let character_exists: i64 = transaction.query_row(
                "SELECT COUNT(1) FROM characters WHERE id = ?1",
                [id],
                |row| row.get(0),
            )?;
            if character_exists == 0 {
                return Err(AppError::NotFound(format!("character {id} was not found")));
            }

            let participant_count: i64 = transaction.query_row(
                "SELECT COUNT(1) FROM chat_participants WHERE chat_id = ?1 AND character_id = ?2",
                params![clean_chat_id, id],
                |row| row.get(0),
            )?;

            let is_single_match = chat_mode.eq_ignore_ascii_case("single")
                && chat_character_id
                    .as_deref()
                    .map(|v| v == id)
                    .unwrap_or(false);
            if participant_count == 0 && !is_single_match {
                return Err(AppError::Validation(format!(
                    "speaker_character_id {id} is not a participant in chat {clean_chat_id}"
                )));
            }

            Some(id.to_string())
        } else {
            None
        };

        let message_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        transaction.execute(
            "INSERT INTO messages (id, chat_id, role, content, speaker_character_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![message_id, clean_chat_id, clean_role, clean_content, clean_speaker_character_id.as_deref(), now],
        )?;
        transaction.execute(
            "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
            params![now, clean_chat_id],
        )?;

        let message = transaction.query_row(
            "SELECT id, chat_id, role, content, speaker_character_id, created_at FROM messages WHERE id = ?1",
            [message_id.as_str()],
            map_message_row,
        )?;

        transaction.commit()?;
        Ok(message)
    }

    pub fn update_message_at_epoch(
        &self,
        message_id: &str,
        content: &str,
        expected_history_epoch: Option<i64>,
    ) -> AppResult<MessageRecord> {
        let id = message_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "message id cannot be empty".to_string(),
            ));
        }

        let clean_content = content.trim();
        if clean_content.is_empty() {
            return Err(AppError::Validation(
                "message content cannot be empty".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let message_chat: Option<(String, i64)> = transaction
            .query_row(
                "SELECT messages.chat_id, chats.history_epoch FROM messages INNER JOIN chats ON chats.id = messages.chat_id WHERE messages.id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (chat_id, history_epoch) = if let Some(message_chat) = message_chat {
            message_chat
        } else {
            return Err(AppError::NotFound(format!("message {id} was not found")));
        };
        assert_expected_epoch(&chat_id, history_epoch, expected_history_epoch)?;

        transaction.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2",
            params![clean_content, id],
        )?;
        let now = now_rfc3339();
        transaction.execute(
            "
            INSERT INTO message_embedding_invalidations (message_id, invalidated_at)
            VALUES (?1, ?2)
            ON CONFLICT(message_id) DO UPDATE SET invalidated_at = excluded.invalidated_at
            ",
            params![id, now],
        )?;
        transaction.execute(
            "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
            params![now, chat_id],
        )?;

        let updated = transaction.query_row(
            "SELECT id, chat_id, role, content, speaker_character_id, created_at FROM messages WHERE id = ?1",
            [id],
            map_message_row,
        )?;

        transaction.commit()?;
        Ok(updated)
    }

    pub fn edit_message_and_truncate(
        &self,
        message_id: &str,
        content: &str,
        expected_history_epoch: i64,
    ) -> AppResult<ChatHistoryMutationRecord> {
        let id = message_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "message id cannot be empty".to_string(),
            ));
        }
        let clean_content = content.trim();
        if clean_content.is_empty() {
            return Err(AppError::Validation(
                "message content cannot be empty".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let target: Option<(String, i64, i64)> = transaction
            .query_row(
                "SELECT messages.chat_id, messages.rowid, chats.history_epoch FROM messages INNER JOIN chats ON chats.id = messages.chat_id WHERE messages.id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (chat_id, target_rowid, history_epoch) =
            target.ok_or_else(|| AppError::NotFound(format!("message {id} was not found")))?;
        assert_expected_epoch(&chat_id, history_epoch, Some(expected_history_epoch))?;

        transaction.execute(
            "UPDATE messages SET content = ?1 WHERE id = ?2",
            params![clean_content, id],
        )?;
        transaction.execute(
            "
            INSERT INTO message_embedding_invalidations (message_id, invalidated_at)
            VALUES (?1, ?2)
            ON CONFLICT(message_id) DO UPDATE SET invalidated_at = excluded.invalidated_at
            ",
            params![id, now_rfc3339()],
        )?;
        transaction.execute(
            "DELETE FROM messages WHERE chat_id = ?1 AND rowid > ?2",
            params![chat_id, target_rowid],
        )?;
        transaction.execute("DELETE FROM chat_memory WHERE chat_id = ?1", [&chat_id])?;
        transaction.execute(
            "DELETE FROM chat_relationship_states WHERE chat_id = ?1",
            [&chat_id],
        )?;
        let updated_at = now_rfc3339();
        transaction.execute(
            "UPDATE chats SET history_epoch = history_epoch + 1, updated_at = ?1 WHERE id = ?2",
            params![updated_at, chat_id],
        )?;
        let next_epoch = history_epoch + 1;
        let messages = {
            let mut statement = transaction.prepare(
                "SELECT id, chat_id, role, content, speaker_character_id, created_at FROM messages WHERE chat_id = ?1 ORDER BY rowid ASC",
            )?;
            let rows = statement.query_map([&chat_id], map_message_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        transaction.commit()?;
        self.delete_chat_vectors_best_effort(&chat_id);
        Ok(ChatHistoryMutationRecord {
            chat_id,
            history_epoch: next_epoch,
            updated_at,
            messages,
        })
    }

    pub fn list_messages_missing_embeddings(
        &self,
        chat_id: &str,
        embedding_model_id: &str,
        embedding_dimensions: usize,
        limit: usize,
        skip_message_ids: &[String],
    ) -> AppResult<Vec<MessageRecord>> {
        let clean_chat_id = chat_id.trim();
        if clean_chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }
        let clean_model_id = embedding_model_id.trim();
        if clean_model_id.is_empty() {
            return Err(AppError::Validation(
                "embedding model id cannot be empty".to_string(),
            ));
        }
        let max_results = limit.clamp(1, 64);
        // Messages the caller gave up on stay "missing"; fetch past them so they
        // cannot crowd older messages out of the batch.
        let fetch_limit = max_results + skip_message_ids.len();

        let Some(connection) = self.open_vec_connection()? else {
            return Ok(Vec::new());
        };
        Self::ensure_vec_table(&connection, embedding_dimensions)?;

        let sql = "
            SELECT messages.id, messages.chat_id, messages.role, messages.content, messages.speaker_character_id, messages.created_at
            FROM messages
            LEFT JOIN message_embedding_invalidations AS invalidations ON invalidations.message_id = messages.id
            WHERE messages.chat_id = ?1
              AND LOWER(TRIM(messages.role)) IN ('user', 'assistant')
              AND messages.content NOT LIKE ?4
              AND TRIM(messages.content) != ''
              AND (
                    NOT EXISTS (SELECT 1 FROM message_embedding_chunk_status AS indexed
                        WHERE indexed.message_id = messages.id AND indexed.embedding_model_id = ?2
                          AND indexed.dimensions = ?5)
                    OR invalidations.message_id IS NOT NULL
                  )
            ORDER BY messages.created_at DESC, messages.id DESC
            LIMIT ?3
            ";

        let mut statement = connection.prepare(sql)?;
        let failure_pattern = format!("{}%", crate::GENERATION_FAILURE_PREFIX);
        let rows = statement.query_map(
            params![
                clean_chat_id,
                clean_model_id,
                fetch_limit as i64,
                failure_pattern,
                embedding_dimensions as i64
            ],
            map_message_row,
        )?;
        let mut messages = Vec::new();
        for row in rows {
            let message = row?;
            if !skip_message_ids.contains(&message.id) {
                messages.push(message);
            }
        }
        messages.truncate(max_results);
        Ok(messages)
    }

    pub fn upsert_message_embeddings(
        &self,
        message: &MessageRecord,
        embedding_model_id: &str,
        chunks: &[EmbeddingChunk],
    ) -> AppResult<()> {
        let clean_model_id = embedding_model_id.trim();
        if clean_model_id.is_empty() {
            return Err(AppError::Validation(
                "embedding model id cannot be empty".to_string(),
            ));
        }
        if chunks.is_empty() {
            return Err(AppError::Validation(
                "embedding vector cannot be empty".to_string(),
            ));
        }

        let dimensions = chunks[0].vector.len();
        let vectors = chunks
            .iter()
            .map(|chunk| {
                if chunk.vector.len() != dimensions || chunk.content.trim().is_empty() {
                    return Err(AppError::Validation(
                        "invalid embedding chunk dimensions or content".to_string(),
                    ));
                }
                normalize_embedding(chunk.vector.clone())
            })
            .collect::<AppResult<Vec<_>>>()?;
        let Some(mut connection) = self.open_vec_connection()? else {
            return Ok(());
        };
        let table_name = Self::ensure_vec_table(&connection, dimensions)?;

        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current_content = transaction
            .query_row(
                "SELECT content FROM messages WHERE id = ?1",
                [message.id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if current_content.as_deref() != Some(message.content.as_str()) {
            return Ok(());
        }
        delete_message_vectors(&transaction, &message.id)?;

        let insert_sql = format!(
            "INSERT INTO {table_name} (chunk_id, message_id, embedding, embedding_model_id, chat_id, content) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        );
        for (index, (chunk, vector)) in chunks.iter().zip(vectors).enumerate() {
            let vector_json = serde_json::to_string(&vector).map_err(|error| {
                AppError::Validation(format!("failed to serialize embedding vector: {error}"))
            })?;
            transaction.execute(
                &insert_sql,
                params![
                    format!("{}:{index}", message.id),
                    message.id,
                    vector_json,
                    clean_model_id,
                    message.chat_id,
                    chunk.content
                ],
            )?;
        }
        transaction.execute(
            "INSERT INTO message_embedding_chunk_status (message_id, embedding_model_id, dimensions)
             VALUES (?1, ?2, ?3) ON CONFLICT(message_id) DO UPDATE SET
             embedding_model_id = excluded.embedding_model_id, dimensions = excluded.dimensions",
            params![message.id, clean_model_id, dimensions as i64],
        )?;
        transaction.execute(
            "DELETE FROM message_embedding_invalidations WHERE message_id = ?1",
            [message.id.as_str()],
        )?;

        transaction.commit()?;
        Ok(())
    }

    pub fn prepare_embedding_backfill(&self, chat_id: &str, dimensions: usize) -> AppResult<()> {
        let Some(connection) = self.open_vec_connection()? else {
            return Ok(());
        };
        let table_name = Self::ensure_vec_table(&connection, dimensions)?;
        // One cleanup per background job; foreground lookups never scan stale rows.
        super::cleanup_stale_vec_rows(&connection, &table_name, chat_id)
    }

    /// Vector recall over a chat's history. Hits farther than
    /// `SEMANTIC_MAX_L2_DISTANCE` are unrelated text and are dropped; the newest
    /// `exclude_recent_messages` messages and the latest user message are skipped
    /// because the prompt already carries them.
    pub fn resolve_semantic_memory_snippets(
        &self,
        chat_id: &str,
        embedding_model_id: &str,
        query_embedding: &[f32],
        limit: usize,
        exclude_recent_messages: usize,
    ) -> AppResult<Vec<MemorySnippetRecord>> {
        let clean_chat_id = chat_id.trim();
        if clean_chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }
        let clean_model_id = embedding_model_id.trim();
        if clean_model_id.is_empty() {
            return Err(AppError::Validation(
                "embedding model id cannot be empty".to_string(),
            ));
        }
        if query_embedding.is_empty() {
            return Ok(Vec::new());
        }

        let max_results = limit.clamp(1, 24);
        let Some(connection) = self.open_vec_connection()? else {
            return Ok(Vec::new());
        };
        let table_name = Self::ensure_vec_table(&connection, query_embedding.len())?;
        let query_embedding = normalize_embedding(query_embedding.to_vec())?;
        let query_json = serde_json::to_string(&query_embedding).map_err(|error| {
            AppError::Validation(format!(
                "failed to serialize query embedding vector: {error}"
            ))
        })?;

        let sql = format!(
            "
            SELECT messages.id, messages.chat_id, messages.role, {table_name}.content, messages.speaker_character_id, messages.created_at, distance
            FROM {table_name}
            INNER JOIN messages ON messages.id = {table_name}.message_id
            LEFT JOIN message_embedding_invalidations AS invalidations ON invalidations.message_id = messages.id
            WHERE {table_name}.embedding MATCH ?1
              AND k = ?2
              AND {table_name}.chat_id = ?3
              AND {table_name}.embedding_model_id = ?4
              AND LOWER(TRIM(messages.role)) IN ('user', 'assistant')
              AND messages.content NOT LIKE ?5
              AND invalidations.message_id IS NULL
            ORDER BY distance ASC
            "
        );

        let mut statement = connection.prepare(&sql)?;
        let failure_pattern = format!("{}%", crate::GENERATION_FAILURE_PREFIX);
        let excluded_ids = super::memory::recall_excluded_message_ids(
            &connection,
            clean_chat_id,
            exclude_recent_messages,
        )?;
        let mut candidate_limit = max_results * 8;
        loop {
            let rows = statement.query_map(
                params![
                    query_json,
                    candidate_limit as i64,
                    clean_chat_id,
                    clean_model_id,
                    failure_pattern
                ],
                |row| {
                    let distance: f64 = row.get(6)?;
                    Ok((
                        distance,
                        MemorySnippetRecord {
                            message_id: row.get(0)?,
                            chat_id: row.get(1)?,
                            role: row.get(2)?,
                            content: row.get(3)?,
                            speaker_character_id: row.get(4)?,
                            created_at: row.get(5)?,
                            score: semantic_score(distance),
                        },
                    ))
                },
            )?;

            // Several nearby chunks can belong to one message. Keep its strongest passage.
            // Rows arrive nearest first, so the first one past the cutoff ends the scan.
            let mut row_count = 0;
            let mut past_cutoff = false;
            let mut seen = std::collections::HashSet::new();
            let mut snippets = Vec::new();
            for row in rows {
                let (distance, snippet) = row?;
                row_count += 1;
                if !distance.is_finite() || distance > SEMANTIC_MAX_L2_DISTANCE {
                    past_cutoff = true;
                    break;
                }
                if excluded_ids.contains(&snippet.message_id) {
                    continue;
                }
                if seen.insert(snippet.message_id.clone()) {
                    snippets.push(snippet);
                    if snippets.len() == max_results {
                        break;
                    }
                }
            }
            if snippets.len() == max_results
                || past_cutoff
                || row_count < candidate_limit
                || candidate_limit >= 4096
            {
                return Ok(snippets);
            }
            // sqlite-vec v0.1.6 caps k at 4096; bound pathological long-message scans.
            candidate_limit = (candidate_limit * 2).min(4096);
        }
    }

    fn delete_chat_vectors_best_effort(&self, chat_id: &str) {
        let result = (|| -> AppResult<()> {
            let Some(mut connection) = self.open_vec_connection()? else {
                return Ok(());
            };
            let transaction = connection.transaction()?;
            delete_chat_vectors(&transaction, chat_id)?;
            transaction.commit()?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("deferred sqlite-vec cleanup for chat {chat_id}: {error}");
        }
    }
}

/// Farthest L2 distance a semantic hit may have. The embedding model
/// (bge-small-en-v1.5) emits unit-length vectors, so L2 distance relates to
/// cosine similarity as L2^2 = 2 - 2 * cosine. 0.95 keeps hits with a cosine
/// of about 0.55 or better; anything weaker is unrelated text that only looks
/// close because every chunk of a small chat sits somewhere in the space.
pub(crate) const SEMANTIC_MAX_L2_DISTANCE: f64 = 0.95;
const SEMANTIC_SCORE_FLOOR: f64 = 60.0;
const SEMANTIC_SCORE_CEILING: f64 = 140.0;

/// Maps a semantic distance onto the lexical score scale: a hit at the cutoff
/// scores like a modest lexical match and an exact match like a strong one, so
/// merged results rank by relevance instead of every vector hit leading.
fn semantic_score(distance: f64) -> i64 {
    if !distance.is_finite() {
        return 0;
    }
    let cosine = 1.0_f64 - (distance.max(0.0_f64).powi(2) / 2.0_f64);
    let cutoff_cosine = 1.0_f64 - (SEMANTIC_MAX_L2_DISTANCE.powi(2) / 2.0_f64);
    let relevance = ((cosine - cutoff_cosine) / (1.0_f64 - cutoff_cosine)).clamp(0.0_f64, 1.0_f64);
    (SEMANTIC_SCORE_FLOOR + relevance * (SEMANTIC_SCORE_CEILING - SEMANTIC_SCORE_FLOOR)).round()
        as i64
}

pub(super) fn assert_expected_epoch(
    chat_id: &str,
    actual: i64,
    expected: Option<i64>,
) -> AppResult<()> {
    if let Some(expected) = expected {
        if expected != actual {
            return Err(AppError::Conflict(format!(
                "stale history epoch for chat {chat_id}: expected {expected}, current {actual}"
            )));
        }
    }
    Ok(())
}

fn delete_chat_vectors(transaction: &rusqlite::Transaction<'_>, chat_id: &str) -> AppResult<()> {
    for table_name in vector_table_names(transaction)? {
        let sql = format!("DELETE FROM {table_name} WHERE chat_id = ?1");
        transaction.execute(&sql, [chat_id])?;
    }
    Ok(())
}

pub(super) fn delete_message_vectors(
    transaction: &rusqlite::Transaction<'_>,
    message_id: &str,
) -> AppResult<()> {
    for table_name in vector_table_names(transaction)? {
        let sql = format!("DELETE FROM {table_name} WHERE message_id = ?1");
        transaction.execute(&sql, [message_id])?;
    }
    Ok(())
}

fn vector_table_names(transaction: &rusqlite::Transaction<'_>) -> AppResult<Vec<String>> {
    let table_names = {
        let mut statement = transaction.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND (name GLOB 'message_embedding_vec_[0-9]*' OR name GLOB 'message_embedding_chunk_vec_[0-9]*') AND sql LIKE '%USING vec0(%'",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    table_names
        .into_iter()
        .map(|table_name| {
            table_name
                .strip_prefix("message_embedding_vec_")
                .or_else(|| table_name.strip_prefix("message_embedding_chunk_vec_"))
                .filter(|suffix| {
                    !suffix.is_empty() && suffix.chars().all(|value| value.is_ascii_digit())
                })
                .map(|_| table_name.clone())
                .ok_or_else(|| {
                    AppError::Validation(format!("invalid vector table name {table_name}"))
                })
        })
        .collect()
}

pub(super) fn map_message_row(row: &Row<'_>) -> rusqlite::Result<MessageRecord> {
    Ok(MessageRecord {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        speaker_character_id: row.get(4)?,
        created_at: row.get(5)?,
    })
}

#[cfg(test)]
mod vector_tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        db: Database,
        root: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("glee-chunk-test-{}", Uuid::new_v4()));
            assert!(
                super::super::register_vector_extension(),
                "the statically linked sqlite-vec extension must register"
            );
            let db = Database::new(root.join("test.sqlite3")).unwrap();
            Self { db, root }
        }
        // Assistant turns, so the latest-user-message exclusion never hides them.
        fn message(&self, chat: &str, content: &str) -> MessageRecord {
            self.db
                .append_message_at_epoch(chat, "assistant", content, None, None)
                .unwrap()
        }
        fn user_message(&self, chat: &str, content: &str) -> MessageRecord {
            self.db
                .append_message_at_epoch(chat, "user", content, None, None)
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    fn chunk(content: &str, vector: &[f32]) -> EmbeddingChunk {
        EmbeddingChunk {
            content: content.into(),
            vector: vector.to_vec(),
        }
    }

    #[test]
    fn retrieves_specific_passages_with_chat_and_model_isolation() {
        let f = Fixture::new();
        let chat = f.db.create_chat("one", None).unwrap();
        let other = f.db.create_chat("two", None).unwrap();
        let message = f.message(&chat.id, "I love hiking. My cat is named Luna.");
        f.db.upsert_message_embeddings(
            &message,
            "bge:chunks-v2-l2",
            &[
                chunk("I love hiking.", &[10.0, 0.0]),
                chunk("My cat is named Luna.", &[0.0, 10.0]),
            ],
        )
        .unwrap();
        let second = f.message(&chat.id, "My dog is named Rex.");
        f.db.upsert_message_embeddings(
            &second,
            "bge:chunks-v2-l2",
            &[chunk(&second.content, &[0.2, 0.8])],
        )
        .unwrap();
        let private = f.message(&other.id, "private cat memory");
        f.db.upsert_message_embeddings(
            &private,
            "bge:chunks-v2-l2",
            &[chunk(&private.content, &[0.0, 1.0])],
        )
        .unwrap();
        let hits = f
            .db
            .resolve_semantic_memory_snippets(&chat.id, "bge:chunks-v2-l2", &[0.0, 100.0], 6, 0)
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "My cat is named Luna.");
        assert_eq!(hits[0].score, 140);
        assert!(hits.iter().all(|hit| hit.chat_id == chat.id));
        assert!(f
            .db
            .resolve_semantic_memory_snippets(&chat.id, "another-model", &[0.0, 1.0], 6, 0)
            .unwrap()
            .is_empty());
        assert!(f
            .db
            .list_messages_missing_embeddings(&chat.id, "bge:chunks-v2-l2", 2, 6, &[])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn edits_reject_stale_embeddings_and_clear_deletes_all_chunks() {
        let f = Fixture::new();
        let chat = f.db.create_chat("edit", None).unwrap();
        let old = f.message(&chat.id, "old fact");
        f.db.upsert_message_embeddings(&old, "v2", &[chunk("old fact", &[1.0, 0.0])])
            .unwrap();
        let edited =
            f.db.update_message_at_epoch(&old.id, "new fact", None)
                .unwrap();
        f.db.upsert_message_embeddings(&old, "v2", &[chunk("old fact", &[1.0, 0.0])])
            .unwrap();
        assert!(f
            .db
            .resolve_semantic_memory_snippets(&chat.id, "v2", &[1.0, 0.0], 6, 0)
            .unwrap()
            .is_empty());
        assert_eq!(
            f.db.list_messages_missing_embeddings(&chat.id, "v2", 2, 6, &[])
                .unwrap()
                .len(),
            1
        );
        f.db.upsert_message_embeddings(&edited, "v2", &[chunk("new fact", &[0.0, 1.0])])
            .unwrap();
        assert_eq!(
            f.db.resolve_semantic_memory_snippets(&chat.id, "v2", &[0.0, 1.0], 6, 0)
                .unwrap()[0]
                .content,
            "new fact"
        );
        f.db.clear_chat_history_mutation(&chat.id).unwrap();
        f.db.upsert_message_embeddings(&edited, "v2", &[chunk("new fact", &[0.0, 1.0])])
            .unwrap();
        let c = f.db.open_vec_connection().unwrap().unwrap();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM message_embedding_chunk_vec_2",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn legacy_vectors_are_rebuilt_without_mixing_spaces_and_invalid_chunks_are_atomic() {
        let f = Fixture::new();
        let chat = f.db.create_chat("legacy", None).unwrap();
        let message = f.message(&chat.id, "saved text");
        let c = f.db.open_vec_connection().unwrap().unwrap();
        c.execute_batch("CREATE VIRTUAL TABLE message_embedding_vec_2 USING vec0(message_id TEXT PRIMARY KEY, embedding FLOAT[2], embedding_model_id TEXT, chat_id TEXT);").unwrap();
        c.execute(
            "INSERT INTO message_embedding_vec_2 VALUES (?1, '[0.2,0.3]', 'bge', ?2)",
            params![message.id, chat.id],
        )
        .unwrap();
        assert!(f
            .db
            .resolve_semantic_memory_snippets(&chat.id, "v2", &[1.0, 0.0], 6, 0)
            .unwrap()
            .is_empty());
        assert_eq!(
            f.db.list_messages_missing_embeddings(&chat.id, "v2", 2, 6, &[])
                .unwrap()
                .len(),
            1
        );
        f.db.upsert_message_embeddings(&message, "v2", &[chunk("saved text", &[1.0, 0.0])])
            .unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM message_embedding_vec_2", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        for invalid in [vec![0.0, 0.0], vec![f32::NAN, 1.0], vec![1.0]] {
            assert!(f
                .db
                .upsert_message_embeddings(
                    &message,
                    "v2",
                    &[chunk("good", &[1.0, 0.0]), chunk("bad", &invalid)]
                )
                .is_err());
        }
        assert_eq!(
            f.db.resolve_semantic_memory_snippets(&chat.id, "v2", &[1.0, 0.0], 6, 0)
                .unwrap()[0]
                .content,
            "saved text"
        );
        assert_eq!(
            f.db.list_messages(&chat.id).unwrap()[0].content,
            "saved text"
        );
    }

    #[test]
    fn many_chunks_of_one_message_do_not_hide_other_messages() {
        let f = Fixture::new();
        let chat = f.db.create_chat("diversity", None).unwrap();
        let long = f.message(&chat.id, "long message");
        let chunks = (0..60)
            .map(|i| chunk(&format!("passage {i}"), &[1.0, 0.0]))
            .collect::<Vec<_>>();
        f.db.upsert_message_embeddings(&long, "v2", &chunks)
            .unwrap();
        let other = f.message(&chat.id, "another relevant memory");
        f.db.upsert_message_embeddings(&other, "v2", &[chunk(&other.content, &[0.9, 0.1])])
            .unwrap();
        let hits =
            f.db.resolve_semantic_memory_snippets(&chat.id, "v2", &[1.0, 0.0], 2, 0)
                .unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].message_id, long.id);
        assert_eq!(hits[1].message_id, other.id);
    }

    #[test]
    fn chunk_vectors_survive_backup_restore_without_overwriting_chat_history() {
        let f = Fixture::new();
        let chat = f.db.create_chat("backup", None).unwrap();
        let original = f.message(&chat.id, "original fact");
        f.db.upsert_message_embeddings(&original, "v2", &[chunk("original fact", &[1.0, 0.0])])
            .unwrap();
        let backup = f.db.export_backup("manual").unwrap();
        let edited =
            f.db.update_message_at_epoch(&original.id, "changed fact", None)
                .unwrap();
        f.db.upsert_message_embeddings(&edited, "v2", &[chunk("changed fact", &[0.0, 1.0])])
            .unwrap();
        f.db.restore_backup(backup.file_name().unwrap().to_str().unwrap())
            .unwrap();
        let hits =
            f.db.resolve_semantic_memory_snippets(&chat.id, "v2", &[1.0, 0.0], 6, 0)
                .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "original fact");
        assert_eq!(
            f.db.list_messages(&chat.id).unwrap()[0].content,
            "original fact"
        );
    }

    #[test]
    fn semantic_recall_skips_recent_messages_and_the_latest_user_message() {
        let f = Fixture::new();
        let chat = f.db.create_chat("one", None).unwrap();
        let old = f.message(&chat.id, "My cat is named Luna.");
        f.db.upsert_message_embeddings(&old, "v2", &[chunk(&old.content, &[1.0, 0.0])])
            .unwrap();
        let recent = f.message(&chat.id, "My cat is named Luna and she sleeps all day.");
        f.db.upsert_message_embeddings(&recent, "v2", &[chunk(&recent.content, &[1.0, 0.0])])
            .unwrap();
        let latest_user = f.user_message(&chat.id, "Tell me about my cat.");
        f.db.upsert_message_embeddings(
            &latest_user,
            "v2",
            &[chunk(&latest_user.content, &[1.0, 0.0])],
        )
        .unwrap();

        let ids = |recent_excluded: usize| -> Vec<String> {
            let mut ids = f
                .db
                .resolve_semantic_memory_snippets(&chat.id, "v2", &[1.0, 0.0], 6, recent_excluded)
                .unwrap()
                .into_iter()
                .map(|hit| hit.message_id)
                .collect::<Vec<_>>();
            ids.sort();
            ids
        };

        // The latest user message is never recalled, even with no recency window.
        let mut everything_else = vec![old.id.clone(), recent.id.clone()];
        everything_else.sort();
        assert_eq!(ids(0), everything_else);
        // The newest messages are skipped as well.
        assert_eq!(ids(2), vec![old.id.clone()]);
        assert!(ids(3).is_empty());
    }

    #[test]
    fn default_recent_window_hides_a_short_chat_entirely() {
        let f = Fixture::new();
        let chat = f.db.create_chat("one", None).unwrap();
        for index in 0..Database::RECALL_EXCLUDED_RECENT_MESSAGES {
            let message = f.message(&chat.id, &format!("Fact number {index} about harbors."));
            f.db.upsert_message_embeddings(&message, "v2", &[chunk(&message.content, &[1.0, 0.0])])
                .unwrap();
        }
        let older = f.db.list_messages(&chat.id).unwrap();
        assert_eq!(older.len(), Database::RECALL_EXCLUDED_RECENT_MESSAGES);
        assert!(f
            .db
            .resolve_semantic_memory_snippets(
                &chat.id,
                "v2",
                &[1.0, 0.0],
                6,
                Database::RECALL_EXCLUDED_RECENT_MESSAGES,
            )
            .unwrap()
            .is_empty());

        // One more message pushes the oldest out of the window.
        let newest = f.message(&chat.id, "Something newer.");
        f.db.upsert_message_embeddings(&newest, "v2", &[chunk(&newest.content, &[0.0, 1.0])])
            .unwrap();
        let hits =
            f.db.resolve_semantic_memory_snippets(
                &chat.id,
                "v2",
                &[1.0, 0.0],
                6,
                Database::RECALL_EXCLUDED_RECENT_MESSAGES,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, older[0].id);
    }

    #[test]
    fn semantic_recall_drops_unrelated_chunks_below_the_similarity_floor() {
        let f = Fixture::new();
        let chat = f.db.create_chat("one", None).unwrap();
        // Unit vectors at known angles to the query [1, 0]: cosine 0.8, 0.5, 0.0.
        let related = f.message(&chat.id, "Related passage.");
        let borderline = f.message(&chat.id, "Borderline passage.");
        let unrelated = f.message(&chat.id, "Unrelated passage.");
        f.db.upsert_message_embeddings(&related, "v2", &[chunk(&related.content, &[0.8, 0.6])])
            .unwrap();
        f.db.upsert_message_embeddings(
            &borderline,
            "v2",
            &[chunk(&borderline.content, &[0.5, 0.866_025_4])],
        )
        .unwrap();
        f.db.upsert_message_embeddings(&unrelated, "v2", &[chunk(&unrelated.content, &[0.0, 1.0])])
            .unwrap();

        let hits =
            f.db.resolve_semantic_memory_snippets(&chat.id, "v2", &[1.0, 0.0], 6, 0)
                .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message_id, related.id);
        assert!(hits[0].score > 60 && hits[0].score < 140);
    }

    #[test]
    fn semantic_scores_fall_between_the_floor_and_ceiling() {
        assert_eq!(semantic_score(0.0), 140);
        assert_eq!(semantic_score(SEMANTIC_MAX_L2_DISTANCE), 60);
        assert_eq!(semantic_score(SEMANTIC_MAX_L2_DISTANCE + 0.2), 60);
        let near = semantic_score(0.3);
        let far = semantic_score(0.7);
        assert!(140 > near && near > far && far > 60);
        assert_eq!(semantic_score(f64::NAN), 0);
    }

    #[test]
    fn backfill_listing_skips_messages_the_caller_gave_up_on() {
        let f = Fixture::new();
        let chat = f.db.create_chat("one", None).unwrap();
        let oldest = f.message(&chat.id, "Oldest message.");
        let middle = f.message(&chat.id, "Middle message.");
        let newest = f.message(&chat.id, "Newest message.");

        let all =
            f.db.list_messages_missing_embeddings(&chat.id, "v2", 2, 2, &[])
                .unwrap();
        assert_eq!(
            all.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
            vec![newest.id.clone(), middle.id.clone()]
        );
        let skipping =
            f.db.list_messages_missing_embeddings(
                &chat.id,
                "v2",
                2,
                2,
                std::slice::from_ref(&newest.id),
            )
            .unwrap();
        assert_eq!(
            skipping.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
            vec![middle.id.clone(), oldest.id.clone()]
        );
    }
}
