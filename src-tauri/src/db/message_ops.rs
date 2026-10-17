//! Small chat edits that do not rewrite the rest of the conversation:
//! removing a single message and renaming a chat.

use rusqlite::{params, OptionalExtension};

use crate::errors::{AppError, AppResult};
use crate::types::{ChatHistoryMutationRecord, ChatRecord};

use super::messages::{assert_expected_epoch, delete_message_vectors, map_message_row};
use super::{now_rfc3339, Database};

impl Database {
    /// Removes one message and bumps the chat's history epoch so in-flight replies
    /// built on the old history are discarded. A machine-written summary that
    /// already covers the message is dropped too and rebuilt later.
    pub fn delete_message(
        &self,
        message_id: &str,
        expected_history_epoch: i64,
    ) -> AppResult<ChatHistoryMutationRecord> {
        let id = message_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "message id cannot be empty".to_string(),
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

        // Rows at or before the summary cursor were folded into a machine summary.
        let covered_by_summary: bool = transaction
            .query_row(
                "
                SELECT 1
                FROM chat_memory
                LEFT JOIN messages AS cursor ON cursor.id = chat_memory.summarized_through_message_id
                WHERE chat_memory.chat_id = ?1
                  AND chat_memory.summary_auto = 1
                  AND (cursor.rowid IS NULL OR cursor.rowid >= ?2)
                  AND chat_memory.summarized_through_message_id IS NOT NULL
                ",
                params![chat_id, target_rowid],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if covered_by_summary {
            transaction.execute(
                "UPDATE chat_memory SET summary = '', summary_auto = 0, summarized_through_message_id = NULL WHERE chat_id = ?1",
                [&chat_id],
            )?;
        }

        delete_message_vectors(&transaction, id)?;
        transaction.execute(
            "DELETE FROM message_embedding_invalidations WHERE message_id = ?1",
            [id],
        )?;
        transaction.execute("DELETE FROM messages WHERE id = ?1", [id])?;
        let updated_at = now_rfc3339();
        transaction.execute(
            "UPDATE chats SET history_epoch = history_epoch + 1, updated_at = ?1 WHERE id = ?2",
            params![updated_at, chat_id],
        )?;
        let messages = {
            let mut statement = transaction.prepare(
                "SELECT id, chat_id, role, content, speaker_character_id, created_at FROM messages WHERE chat_id = ?1 ORDER BY rowid ASC",
            )?;
            let rows = statement.query_map([&chat_id], map_message_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        transaction.commit()?;
        Ok(ChatHistoryMutationRecord {
            chat_id,
            history_epoch: history_epoch + 1,
            updated_at,
            messages,
        })
    }

    pub fn rename_chat(&self, chat_id: &str, title: &str) -> AppResult<ChatRecord> {
        let id = chat_id.trim();
        let clean_title = title.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }
        if clean_title.is_empty() {
            return Err(AppError::Validation(
                "chat title cannot be empty".to_string(),
            ));
        }
        let updated = self.open_connection()?.execute(
            "UPDATE chats SET title = ?1 WHERE id = ?2",
            params![clean_title, id],
        )?;
        if updated == 0 {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        }
        self.list_chats(None)?
            .into_iter()
            .find(|chat| chat.id == id)
            .ok_or_else(|| AppError::NotFound(format!("chat {id} was not found")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn deleting_a_message_bumps_the_epoch_and_keeps_the_rest() {
        let dir = std::env::temp_dir().join(format!("glee-message-ops-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let database = Database::new(dir.join("glee.sqlite3")).unwrap();
        database.init().unwrap();
        let character = database
            .create_character(
                "Ada", None, None, None, None, None, None, None, None, None, None, None, None,
                None, None, None, None, None, None, None,
            )
            .unwrap();
        let chat = database.create_chat("Hello", Some(&character.id)).unwrap();
        let first = database
            .append_message_at_epoch(&chat.id, "user", "one", None, None)
            .unwrap();
        let second = database
            .append_message_at_epoch(&chat.id, "assistant", "two", Some(&character.id), None)
            .unwrap();
        let epoch = chat.history_epoch;

        assert!(database.delete_message(&first.id, epoch + 5).is_err());
        let mutation = database.delete_message(&first.id, epoch).unwrap();
        assert_eq!(mutation.history_epoch, epoch + 1);
        assert_eq!(mutation.messages.len(), 1);
        assert_eq!(mutation.messages[0].id, second.id);

        let renamed = database.rename_chat(&chat.id, "  New name ").unwrap();
        assert_eq!(renamed.title, "New name");
        assert!(database.rename_chat(&chat.id, "   ").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
