use rusqlite::{params, OptionalExtension, Row};

use crate::errors::{AppError, AppResult};
use crate::types::ChatRelationshipStateRecord;

use super::messages::assert_expected_epoch;
use super::{now_rfc3339, Database};

impl Database {
    pub fn get_chat_relationship_state(
        &self,
        chat_id: &str,
    ) -> AppResult<ChatRelationshipStateRecord> {
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

        let record = connection
            .query_row(
                "
                SELECT chat_id, summary, current_scene, interaction_tone, character_state, user_state, user_role_name, user_role_description, updated_at
                FROM chat_relationship_states
                WHERE chat_id = ?1
                ",
                [id],
                map_chat_relationship_state_row,
            )
            .optional()?;

        Ok(record.unwrap_or(ChatRelationshipStateRecord {
            chat_id: id.to_string(),
            summary: String::new(),
            current_scene: String::new(),
            interaction_tone: String::new(),
            character_state: String::new(),
            user_state: String::new(),
            user_role_name: String::new(),
            user_role_description: String::new(),
            updated_at: String::new(),
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_chat_relationship_state_at_epoch(
        &self,
        chat_id: &str,
        summary: Option<&str>,
        current_scene: Option<&str>,
        interaction_tone: Option<&str>,
        character_state: Option<&str>,
        user_state: Option<&str>,
        user_role_name: Option<&str>,
        user_role_description: Option<&str>,
        expected_history_epoch: Option<i64>,
    ) -> AppResult<ChatRelationshipStateRecord> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
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

        let existing = transaction
            .query_row(
                "
                SELECT chat_id, summary, current_scene, interaction_tone, character_state, user_state, user_role_name, user_role_description, updated_at
                FROM chat_relationship_states
                WHERE chat_id = ?1
                ",
                [id],
                map_chat_relationship_state_row,
            )
            .optional()?;

        let existing = existing.unwrap_or(ChatRelationshipStateRecord {
            chat_id: id.to_string(),
            summary: String::new(),
            current_scene: String::new(),
            interaction_tone: String::new(),
            character_state: String::new(),
            user_state: String::new(),
            user_role_name: String::new(),
            user_role_description: String::new(),
            updated_at: String::new(),
        });
        let now = now_rfc3339();
        let next_summary = summary
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(existing.summary);
        let next_current_scene = current_scene
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(existing.current_scene);
        let next_interaction_tone = interaction_tone
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(existing.interaction_tone);
        let next_character_state = character_state
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(existing.character_state);
        let next_user_state = user_state
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(existing.user_state);
        let next_user_role_name = user_role_name
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(existing.user_role_name);
        let next_user_role_description = user_role_description
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(existing.user_role_description);

        transaction.execute(
            "
            INSERT INTO chat_relationship_states (
                chat_id, summary, current_scene, interaction_tone, character_state, user_state, user_role_name, user_role_description, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(chat_id) DO UPDATE SET
                summary = excluded.summary,
                current_scene = excluded.current_scene,
                interaction_tone = excluded.interaction_tone,
                character_state = excluded.character_state,
                user_state = excluded.user_state,
                user_role_name = excluded.user_role_name,
                user_role_description = excluded.user_role_description,
                updated_at = excluded.updated_at
            ",
            params![
                id,
                next_summary,
                next_current_scene,
                next_interaction_tone,
                next_character_state,
                next_user_state,
                next_user_role_name,
                next_user_role_description,
                now,
            ],
        )?;

        let record = transaction.query_row(
            "
            SELECT chat_id, summary, current_scene, interaction_tone, character_state, user_state, user_role_name, user_role_description, updated_at
            FROM chat_relationship_states
            WHERE chat_id = ?1
            ",
            [id],
            map_chat_relationship_state_row,
        )?;

        transaction.commit()?;
        Ok(record)
    }
}

fn map_chat_relationship_state_row(row: &Row<'_>) -> rusqlite::Result<ChatRelationshipStateRecord> {
    Ok(ChatRelationshipStateRecord {
        chat_id: row.get(0)?,
        summary: row.get(1)?,
        current_scene: row.get(2)?,
        interaction_tone: row.get(3)?,
        character_state: row.get(4)?,
        user_state: row.get(5)?,
        user_role_name: row.get(6)?,
        user_role_description: row.get(7)?,
        updated_at: row.get(8)?,
    })
}
