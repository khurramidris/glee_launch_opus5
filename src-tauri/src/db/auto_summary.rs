use rusqlite::{params, OptionalExtension};

use crate::errors::{AppError, AppResult};
use crate::types::{AutoSummaryBatchRecord, ChatMemoryRecord, MessageRecord};

use super::memory::{map_chat_memory_row, CHAT_MEMORY_COLUMNS};
use super::messages::{assert_expected_epoch, map_message_row};
use super::{now_rfc3339, Database};

/// Newest messages left out of the summary because the prompt still carries them verbatim.
const RECENT_WINDOW_MESSAGES: i64 = 14;
/// Upper bound on message text handed to the summariser in a single call.
const BATCH_CHAR_BUDGET: usize = 6000;
/// Longest summary the machine may store.
const SUMMARY_MAX_CHARS: usize = 1600;

/// Messages that can contribute to a summary: real turns, not stored reply failures.
const ELIGIBLE_MESSAGES: &str = "chat_id = ?1
    AND LOWER(TRIM(role)) IN ('user', 'assistant')
    AND TRIM(content) <> ''
    AND content NOT LIKE ?2";

impl Database {
    /// Collects the next slice of older, not yet summarised messages (oldest first)
    /// together with the state the background summariser needs to decide whether to run.
    pub fn get_auto_summary_batch(&self, chat_id: &str) -> AppResult<AutoSummaryBatchRecord> {
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

        let memory = connection
            .query_row(
                &format!("SELECT {CHAT_MEMORY_COLUMNS} FROM chat_memory WHERE chat_id = ?1"),
                [id],
                map_chat_memory_row,
            )
            .optional()?;
        let previous_summary = memory
            .as_ref()
            .map(|record| record.summary.clone())
            .unwrap_or_default();
        let summarized_through_message_id = memory
            .as_ref()
            .and_then(|record| record.summarized_through_message_id.clone());
        let writable = summary_is_writable(memory.as_ref());

        let mut batch = AutoSummaryBatchRecord {
            chat_id: id.to_string(),
            history_epoch,
            writable,
            previous_summary,
            summarized_through_message_id,
            pending_count: 0,
            messages: Vec::new(),
        };
        if !writable {
            return Ok(batch);
        }

        let failure_pattern = format!("{}%", crate::GENERATION_FAILURE_PREFIX);

        // Everything at or below this row sits outside the recent window.
        let cutoff_rowid: Option<i64> = connection
            .query_row(
                &format!(
                    "SELECT rowid FROM messages WHERE {ELIGIBLE_MESSAGES}
                     ORDER BY rowid DESC LIMIT 1 OFFSET ?3"
                ),
                params![id, failure_pattern, RECENT_WINDOW_MESSAGES],
                |row| row.get(0),
            )
            .optional()?;
        let Some(cutoff_rowid) = cutoff_rowid else {
            return Ok(batch);
        };

        // A through-message that no longer exists restarts the cursor from the top.
        let through_rowid: i64 = match batch.summarized_through_message_id.as_deref() {
            Some(through_id) => connection
                .query_row(
                    "SELECT rowid FROM messages WHERE id = ?1 AND chat_id = ?2",
                    params![through_id, id],
                    |row| row.get(0),
                )
                .optional()?
                .unwrap_or(0),
            None => 0,
        };

        batch.pending_count = connection.query_row(
            &format!(
                "SELECT COUNT(1) FROM messages
                 WHERE {ELIGIBLE_MESSAGES} AND rowid > ?3 AND rowid <= ?4"
            ),
            params![id, failure_pattern, through_rowid, cutoff_rowid],
            |row| row.get(0),
        )?;
        if batch.pending_count == 0 {
            return Ok(batch);
        }

        let mut statement = connection.prepare(&format!(
            "SELECT id, chat_id, role, content, speaker_character_id, created_at
             FROM messages
             WHERE {ELIGIBLE_MESSAGES} AND rowid > ?3 AND rowid <= ?4
             ORDER BY rowid ASC"
        ))?;
        let rows = statement.query_map(
            params![id, failure_pattern, through_rowid, cutoff_rowid],
            map_message_row,
        )?;

        let mut used_chars = 0_usize;
        for row in rows {
            let mut message: MessageRecord = row?;
            let length = message.content.chars().count();
            if batch.messages.is_empty() {
                if length > BATCH_CHAR_BUDGET {
                    message.content = message.content.chars().take(BATCH_CHAR_BUDGET).collect();
                }
            } else if used_chars + length > BATCH_CHAR_BUDGET {
                break;
            }
            used_chars += message.content.chars().count();
            batch.messages.push(message);
        }

        Ok(batch)
    }

    /// Stores a machine-written summary. Returns `None` without writing when the
    /// summary belongs to the user or the write would move the cursor backwards.
    pub fn store_auto_summary_at_epoch(
        &self,
        chat_id: &str,
        summary: &str,
        through_message_id: &str,
        expected_history_epoch: Option<i64>,
    ) -> AppResult<Option<ChatMemoryRecord>> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }
        let through_id = through_message_id.trim();
        if through_id.is_empty() {
            return Err(AppError::Validation(
                "through message id cannot be empty".to_string(),
            ));
        }
        let clean_summary = clip_summary(summary);
        if clean_summary.is_empty() {
            return Err(AppError::Validation("summary cannot be empty".to_string()));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let history_epoch: Option<i64> = transaction
            .query_row(
                "SELECT history_epoch FROM chats WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(history_epoch) = history_epoch else {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        };
        assert_expected_epoch(id, history_epoch, expected_history_epoch)?;

        let through_rowid: Option<i64> = transaction
            .query_row(
                "SELECT rowid FROM messages WHERE id = ?1 AND chat_id = ?2",
                params![through_id, id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(through_rowid) = through_rowid else {
            return Err(AppError::NotFound(format!(
                "message {through_id} was not found in chat {id}"
            )));
        };

        let existing = transaction
            .query_row(
                &format!("SELECT {CHAT_MEMORY_COLUMNS} FROM chat_memory WHERE chat_id = ?1"),
                [id],
                map_chat_memory_row,
            )
            .optional()?;
        if !summary_is_writable(existing.as_ref()) {
            return Ok(None);
        }

        if let Some(previous_through) = existing
            .as_ref()
            .and_then(|record| record.summarized_through_message_id.as_deref())
        {
            let previous_rowid: Option<i64> = transaction
                .query_row(
                    "SELECT rowid FROM messages WHERE id = ?1 AND chat_id = ?2",
                    params![previous_through, id],
                    |row| row.get(0),
                )
                .optional()?;
            if previous_rowid.is_some_and(|rowid| rowid >= through_rowid) {
                return Ok(None);
            }
        }

        let now = now_rfc3339();
        transaction.execute(
            "
            INSERT INTO chat_memory (
                chat_id,
                summary,
                facts_json,
                updated_at,
                summary_auto,
                summarized_through_message_id
            )
            VALUES (?1, ?2, '[]', ?3, 1, ?4)
            ON CONFLICT(chat_id) DO UPDATE SET
                summary = excluded.summary,
                updated_at = excluded.updated_at,
                summary_auto = 1,
                summarized_through_message_id = excluded.summarized_through_message_id
            ",
            params![id, clean_summary, now, through_id],
        )?;

        let record = transaction.query_row(
            &format!("SELECT {CHAT_MEMORY_COLUMNS} FROM chat_memory WHERE chat_id = ?1"),
            [id],
            map_chat_memory_row,
        )?;
        transaction.commit()?;
        Ok(Some(record))
    }
}

/// The machine may write only when there is no summary yet or it wrote the current one.
fn summary_is_writable(memory: Option<&ChatMemoryRecord>) -> bool {
    memory.is_none_or(|record| record.summary.trim().is_empty() || record.summary_auto)
}

fn clip_summary(summary: &str) -> String {
    let trimmed = summary.trim();
    if trimmed.chars().count() <= SUMMARY_MAX_CHARS {
        return trimmed.to_string();
    }
    trimmed.chars().take(SUMMARY_MAX_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::{env, fs, path::PathBuf};
    use uuid::Uuid;

    fn test_db_path(name: &str) -> PathBuf {
        let root = env::temp_dir()
            .join("glee-tests")
            .join(format!("{}-{}", name, Uuid::new_v4()));
        fs::create_dir_all(&root).expect("test directory should exist");
        root.join("glee.sqlite3")
    }

    fn chat_with_messages(database: &Database, count: usize) -> (String, Vec<MessageRecord>) {
        let chat = database
            .create_chat("Summary chat", None)
            .expect("chat should create");
        let messages = (0..count)
            .map(|index| {
                let role = if index % 2 == 0 { "user" } else { "assistant" };
                database
                    .append_message_at_epoch(
                        &chat.id,
                        role,
                        &format!("message number {index}"),
                        None,
                        Some(0),
                    )
                    .expect("message should append")
            })
            .collect();
        (chat.id, messages)
    }

    #[test]
    fn batch_excludes_recent_window_and_returns_oldest_first() {
        let database = Database::new(test_db_path("auto-summary-window")).expect("db");
        let (chat_id, messages) = chat_with_messages(&database, 20);

        let batch = database
            .get_auto_summary_batch(&chat_id)
            .expect("batch should resolve");

        assert!(batch.writable);
        assert_eq!(batch.pending_count, 6);
        assert_eq!(batch.messages.len(), 6);
        assert_eq!(batch.messages[0].id, messages[0].id);
        assert_eq!(batch.messages[5].id, messages[5].id);
    }

    #[test]
    fn batch_is_empty_while_history_fits_in_recent_window() {
        let database = Database::new(test_db_path("auto-summary-short")).expect("db");
        let (chat_id, _) = chat_with_messages(&database, 14);

        let batch = database
            .get_auto_summary_batch(&chat_id)
            .expect("batch should resolve");

        assert_eq!(batch.pending_count, 0);
        assert!(batch.messages.is_empty());
    }

    #[test]
    fn batch_skips_failed_replies_and_resumes_after_stored_cursor() {
        let database = Database::new(test_db_path("auto-summary-cursor")).expect("db");
        let (chat_id, messages) = chat_with_messages(&database, 30);
        database
            .append_message_at_epoch(
                &chat_id,
                "assistant",
                &format!("{} boom", crate::GENERATION_FAILURE_PREFIX),
                None,
                Some(0),
            )
            .expect("failure message should append");

        let first = database
            .get_auto_summary_batch(&chat_id)
            .expect("batch should resolve");
        // 30 turns plus the failure leaves 16 older eligible turns outside the window.
        assert_eq!(first.pending_count, 16);
        assert!(first.messages.iter().all(|message| !message
            .content
            .starts_with(crate::GENERATION_FAILURE_PREFIX)));

        database
            .store_auto_summary_at_epoch(&chat_id, "first pass", &messages[9].id, Some(0))
            .expect("summary should store")
            .expect("summary should be written");

        let second = database
            .get_auto_summary_batch(&chat_id)
            .expect("batch should resolve");
        assert_eq!(second.pending_count, 6);
        assert_eq!(second.messages[0].id, messages[10].id);
        assert_eq!(second.previous_summary, "first pass");
        assert_eq!(
            second.summarized_through_message_id.as_deref(),
            Some(messages[9].id.as_str())
        );
    }

    #[test]
    fn batch_respects_character_budget_but_always_makes_progress() {
        let database = Database::new(test_db_path("auto-summary-budget")).expect("db");
        let chat = database.create_chat("Budget", None).expect("chat");
        let long_text = "x".repeat(2500);
        for index in 0..20 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            database
                .append_message_at_epoch(&chat.id, role, &long_text, None, Some(0))
                .expect("message should append");
        }

        let batch = database
            .get_auto_summary_batch(&chat.id)
            .expect("batch should resolve");
        assert_eq!(batch.pending_count, 6);
        assert_eq!(batch.messages.len(), 2);

        let oversized = database.create_chat("Oversized", None).expect("chat");
        let huge_text = "y".repeat(9000);
        for index in 0..15 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            database
                .append_message_at_epoch(&oversized.id, role, &huge_text, None, Some(0))
                .expect("message should append");
        }
        let batch = database
            .get_auto_summary_batch(&oversized.id)
            .expect("batch should resolve");
        assert_eq!(batch.messages.len(), 1);
        assert_eq!(batch.messages[0].content.chars().count(), BATCH_CHAR_BUDGET);
    }

    #[test]
    fn manual_summary_is_never_overwritten_by_the_machine() {
        let database = Database::new(test_db_path("auto-summary-manual")).expect("db");
        let (chat_id, messages) = chat_with_messages(&database, 24);
        database
            .upsert_chat_memory_at_epoch(&chat_id, Some("Written by hand"), None, Some(0))
            .expect("manual summary should save");

        let batch = database
            .get_auto_summary_batch(&chat_id)
            .expect("batch should resolve");
        assert!(!batch.writable);
        assert!(batch.messages.is_empty());

        let stored = database
            .store_auto_summary_at_epoch(&chat_id, "machine text", &messages[5].id, Some(0))
            .expect("store should not fail");
        assert!(stored.is_none());

        let memory = database.get_chat_memory(&chat_id).expect("memory");
        assert_eq!(memory.summary, "Written by hand");
        assert!(!memory.summary_auto);
        assert!(memory.summarized_through_message_id.is_none());
    }

    #[test]
    fn machine_writes_when_empty_and_may_rewrite_its_own_summary() {
        let database = Database::new(test_db_path("auto-summary-write")).expect("db");
        let (chat_id, messages) = chat_with_messages(&database, 24);

        let first = database
            .store_auto_summary_at_epoch(&chat_id, "  one  ", &messages[3].id, Some(0))
            .expect("store should succeed")
            .expect("empty summary is writable");
        assert_eq!(first.summary, "one");
        assert!(first.summary_auto);
        assert_eq!(
            first.summarized_through_message_id.as_deref(),
            Some(messages[3].id.as_str())
        );

        let second = database
            .store_auto_summary_at_epoch(&chat_id, "two", &messages[7].id, Some(0))
            .expect("store should succeed")
            .expect("own summary is writable");
        assert_eq!(second.summary, "two");

        let stale = database
            .store_auto_summary_at_epoch(&chat_id, "older", &messages[5].id, Some(0))
            .expect("store should succeed");
        assert!(stale.is_none());
        assert_eq!(database.get_chat_memory(&chat_id).unwrap().summary, "two");
    }

    #[test]
    fn manual_save_takes_ownership_and_clearing_restarts_the_cursor() {
        let database = Database::new(test_db_path("auto-summary-handover")).expect("db");
        let (chat_id, messages) = chat_with_messages(&database, 24);
        database
            .store_auto_summary_at_epoch(&chat_id, "machine", &messages[7].id, Some(0))
            .unwrap()
            .unwrap();

        // Saving facts alone, or the same summary text, keeps the machine in charge.
        let kept = database
            .upsert_chat_memory_at_epoch(&chat_id, None, Some("[\"a fact\"]"), Some(0))
            .unwrap();
        assert!(kept.summary_auto);
        let kept = database
            .upsert_chat_memory_at_epoch(&chat_id, Some("machine"), None, Some(0))
            .unwrap();
        assert!(kept.summary_auto);

        let edited = database
            .upsert_chat_memory_at_epoch(&chat_id, Some("machine, edited"), None, Some(0))
            .unwrap();
        assert!(!edited.summary_auto);
        assert!(edited.summarized_through_message_id.is_none());
        assert!(!database.get_auto_summary_batch(&chat_id).unwrap().writable);

        let cleared = database
            .upsert_chat_memory_at_epoch(&chat_id, Some(""), None, Some(0))
            .unwrap();
        assert!(cleared.summary.is_empty());
        let batch = database.get_auto_summary_batch(&chat_id).unwrap();
        assert!(batch.writable);
        assert_eq!(batch.messages[0].id, messages[0].id);
    }

    #[test]
    fn store_rejects_stale_epoch_and_foreign_messages() {
        let database = Database::new(test_db_path("auto-summary-guards")).expect("db");
        let (chat_id, messages) = chat_with_messages(&database, 20);
        let (_, other_messages) = chat_with_messages(&database, 2);

        let wrong_chat =
            database.store_auto_summary_at_epoch(&chat_id, "text", &other_messages[0].id, Some(0));
        assert!(matches!(wrong_chat, Err(AppError::NotFound(_))));

        let stale_epoch =
            database.store_auto_summary_at_epoch(&chat_id, "text", &messages[2].id, Some(3));
        assert!(matches!(stale_epoch, Err(AppError::Conflict(_))));

        let empty = database.store_auto_summary_at_epoch(&chat_id, "   ", &messages[2].id, None);
        assert!(matches!(empty, Err(AppError::Validation(_))));
    }

    #[test]
    fn migration_flags_legacy_summaries_as_machine_written_once() {
        let path = test_db_path("auto-summary-migration");
        let connection = Connection::open(&path).expect("fixture connection");
        connection
            .execute_batch(
                "
                PRAGMA foreign_keys = ON;
                PRAGMA user_version = 10;
                CREATE TABLE chats (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    character_id TEXT,
                    chat_mode TEXT NOT NULL DEFAULT 'single',
                    history_epoch INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE chat_memory (
                    chat_id TEXT PRIMARY KEY,
                    summary TEXT NOT NULL DEFAULT '',
                    facts_json TEXT NOT NULL DEFAULT '[]',
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
                );
                INSERT INTO chats (id, title, created_at, updated_at)
                VALUES ('with-summary', 'A', '2000-01-01', '2000-01-01'),
                       ('without-summary', 'B', '2000-01-01', '2000-01-01');
                INSERT INTO chat_memory (chat_id, summary, updated_at)
                VALUES ('with-summary', 'User: hello | Aria: hi', '2000-01-01'),
                       ('without-summary', '', '2000-01-01');
                ",
            )
            .expect("legacy fixture should initialize");
        drop(connection);

        let database = Database::new(path.clone()).expect("legacy db should migrate");
        let with_summary = database.get_chat_memory("with-summary").unwrap();
        assert!(with_summary.summary_auto);
        assert!(with_summary.summarized_through_message_id.is_none());
        assert!(
            !database
                .get_chat_memory("without-summary")
                .unwrap()
                .summary_auto
        );

        // A hand-written summary saved afterwards must survive the next start-up.
        database
            .upsert_chat_memory_at_epoch("with-summary", Some("Mine"), None, Some(0))
            .unwrap();
        drop(database);
        let reopened = Database::new(path).expect("migrated db should reopen");
        let memory = reopened.get_chat_memory("with-summary").unwrap();
        assert_eq!(memory.summary, "Mine");
        assert!(!memory.summary_auto);
    }
}
