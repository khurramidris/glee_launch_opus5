use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::types::{CharacterRecord, ChatRecord};

use super::characters::map_character_row;
use super::{now_rfc3339, Database};

impl Database {
    pub fn list_chats(&self, character_id: Option<&str>) -> AppResult<Vec<ChatRecord>> {
        let connection = self.open_connection()?;

        let mut chats = if let Some(character_id) = character_id {
            let id = character_id.trim();
            if id.is_empty() {
                return Err(AppError::Validation(
                    "character id cannot be empty".to_string(),
                ));
            }
            let mut statement = connection.prepare(
                "
                SELECT DISTINCT chats.id, chats.title, chats.character_id, chats.chat_mode, chats.created_at, chats.updated_at, chats.history_epoch
                FROM chats
                LEFT JOIN chat_participants ON chat_participants.chat_id = chats.id
                WHERE chats.character_id = ?1 OR chat_participants.character_id = ?1
                ORDER BY chats.updated_at DESC
                ",
            )?;
            let rows = statement.query_map([id], map_chat_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement = connection.prepare(
                "SELECT id, title, character_id, chat_mode, created_at, updated_at, history_epoch FROM chats ORDER BY updated_at DESC",
            )?;
            let rows = statement.query_map([], map_chat_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        for chat in &mut chats {
            chat.participant_ids = fetch_chat_participant_ids(
                &connection,
                &chat.id,
                chat.character_id.as_deref(),
                &chat.chat_mode,
            )?;
        }

        Ok(chats)
    }

    pub fn create_chat(&self, title: &str, character_id: Option<&str>) -> AppResult<ChatRecord> {
        let clean_title = title.trim();
        if clean_title.is_empty() {
            return Err(AppError::Validation(
                "chat title cannot be empty".to_string(),
            ));
        }

        let chat_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let clean_character_id = if let Some(character_id) = character_id {
            let id = character_id.trim();
            if id.is_empty() {
                return Err(AppError::Validation(
                    "character id cannot be empty".to_string(),
                ));
            }
            let exists: i64 = transaction.query_row(
                "SELECT COUNT(1) FROM characters WHERE id = ?1",
                [id],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(AppError::NotFound(format!("character {id} was not found")));
            }
            Some(id.to_string())
        } else {
            None
        };

        transaction.execute(
            "INSERT INTO chats (id, title, character_id, chat_mode, created_at, updated_at) VALUES (?1, ?2, ?3, 'single', ?4, ?4)",
            params![chat_id, clean_title, clean_character_id.as_deref(), now],
        )?;

        if let Some(character_id) = clean_character_id.as_deref() {
            transaction.execute(
                "INSERT INTO chat_participants (chat_id, character_id, ord) VALUES (?1, ?2, 0) ON CONFLICT(chat_id, character_id) DO UPDATE SET ord = excluded.ord",
                params![chat_id, character_id],
            )?;
        }

        let mut chat = transaction.query_row(
            "SELECT id, title, character_id, chat_mode, created_at, updated_at, history_epoch FROM chats WHERE id = ?1",
            [chat_id.as_str()],
            map_chat_row,
        )?;
        chat.participant_ids = clean_character_id.into_iter().collect();

        transaction.commit()?;
        Ok(chat)
    }

    pub fn create_group_chat(
        &self,
        title: &str,
        character_ids: &[String],
    ) -> AppResult<ChatRecord> {
        let clean_title = title.trim();
        if clean_title.is_empty() {
            return Err(AppError::Validation(
                "chat title cannot be empty".to_string(),
            ));
        }

        let normalized_character_ids = normalize_character_ids(character_ids);
        if normalized_character_ids.len() < 2 {
            return Err(AppError::Validation(
                "group chat requires at least 2 characters".to_string(),
            ));
        }

        let chat_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        for character_id in &normalized_character_ids {
            let exists: i64 = transaction.query_row(
                "SELECT COUNT(1) FROM characters WHERE id = ?1",
                [character_id.as_str()],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(AppError::NotFound(format!(
                    "character {character_id} was not found"
                )));
            }
        }

        transaction.execute(
            "INSERT INTO chats (id, title, character_id, chat_mode, created_at, updated_at) VALUES (?1, ?2, NULL, 'group', ?3, ?3)",
            params![chat_id, clean_title, now],
        )?;

        for (ord, character_id) in normalized_character_ids.iter().enumerate() {
            transaction.execute(
                "INSERT INTO chat_participants (chat_id, character_id, ord) VALUES (?1, ?2, ?3)",
                params![chat_id, character_id, ord as i64],
            )?;
        }

        let mut chat = transaction.query_row(
            "SELECT id, title, character_id, chat_mode, created_at, updated_at, history_epoch FROM chats WHERE id = ?1",
            [chat_id.as_str()],
            map_chat_row,
        )?;
        chat.participant_ids = normalized_character_ids;

        transaction.commit()?;
        Ok(chat)
    }

    pub fn update_group_chat(
        &self,
        chat_id: &str,
        title: &str,
        character_ids: &[String],
    ) -> AppResult<ChatRecord> {
        let clean_chat_id = chat_id.trim();
        if clean_chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let clean_title = title.trim();
        if clean_title.is_empty() {
            return Err(AppError::Validation(
                "chat title cannot be empty".to_string(),
            ));
        }

        let normalized_character_ids = normalize_character_ids(character_ids);
        if normalized_character_ids.len() < 2 {
            return Err(AppError::Validation(
                "group chat requires at least 2 characters".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let chat_mode = transaction
            .query_row(
                "SELECT chat_mode FROM chats WHERE id = ?1",
                [clean_chat_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;

        let chat_mode = if let Some(value) = chat_mode {
            value
        } else {
            return Err(AppError::NotFound(format!(
                "chat {clean_chat_id} was not found"
            )));
        };

        if !chat_mode.eq_ignore_ascii_case("group") {
            return Err(AppError::Validation(
                "only group chats can update participant rosters".to_string(),
            ));
        }

        for character_id in &normalized_character_ids {
            let exists: i64 = transaction.query_row(
                "SELECT COUNT(1) FROM characters WHERE id = ?1",
                [character_id.as_str()],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(AppError::NotFound(format!(
                    "character {character_id} was not found"
                )));
            }
        }

        let now = now_rfc3339();
        transaction.execute(
            "UPDATE chats SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![clean_title, now, clean_chat_id],
        )?;
        transaction.execute(
            "DELETE FROM chat_participants WHERE chat_id = ?1",
            [clean_chat_id],
        )?;
        for (ord, character_id) in normalized_character_ids.iter().enumerate() {
            transaction.execute(
                "INSERT INTO chat_participants (chat_id, character_id, ord) VALUES (?1, ?2, ?3)",
                params![clean_chat_id, character_id, ord as i64],
            )?;
        }

        let mut chat = transaction.query_row(
            "SELECT id, title, character_id, chat_mode, created_at, updated_at, history_epoch FROM chats WHERE id = ?1",
            [clean_chat_id],
            map_chat_row,
        )?;
        chat.participant_ids = normalized_character_ids;

        transaction.commit()?;
        Ok(chat)
    }

    pub fn list_chat_participants(&self, chat_id: &str) -> AppResult<Vec<CharacterRecord>> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let connection = self.open_connection()?;
        let chat = connection
            .query_row(
                "SELECT character_id, chat_mode FROM chats WHERE id = ?1",
                [id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;

        let (chat_character_id, chat_mode) = if let Some(chat) = chat {
            chat
        } else {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        };

        let mut statement = connection.prepare(
            "
            SELECT
                characters.id, characters.name, characters.description, characters.personality, characters.backstory,
                characters.scenario, characters.system_prompt, characters.post_history_instructions, characters.speech_style,
                characters.greeting, characters.alternate_greetings_json, characters.avatar,
                characters.tags_json, characters.likes_json, characters.dislikes_json,
                characters.boundaries, characters.creator_notes, characters.creator,
                characters.character_version, characters.card_extensions_json, characters.card_passthrough_json, characters.example_dialogue,
                characters.created_at, characters.updated_at
            FROM chat_participants
            INNER JOIN characters ON characters.id = chat_participants.character_id
            WHERE chat_participants.chat_id = ?1
            ORDER BY chat_participants.ord ASC
            ",
        )?;
        let rows = statement.query_map([id], map_character_row)?;
        let mut participants = rows.collect::<Result<Vec<_>, _>>()?;

        if participants.is_empty() && chat_mode.eq_ignore_ascii_case("single") {
            if let Some(single_character_id) = chat_character_id {
                if let Some(character) = connection
                    .query_row(
                        "SELECT id, name, description, personality, backstory, scenario, system_prompt, post_history_instructions, speech_style, greeting, alternate_greetings_json, avatar, tags_json, likes_json, dislikes_json, boundaries, creator_notes, creator, character_version, card_extensions_json, card_passthrough_json, example_dialogue, created_at, updated_at FROM characters WHERE id = ?1",
                        [single_character_id.as_str()],
                        map_character_row,
                    )
                    .optional()?
                {
                    participants.push(character);
                }
            }
        }

        Ok(participants)
    }

    pub fn branch_chat(
        &self,
        source_chat_id: &str,
        anchor_message_id: &str,
        title: Option<&str>,
    ) -> AppResult<ChatRecord> {
        let clean_source_chat_id = source_chat_id.trim();
        if clean_source_chat_id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let clean_anchor_message_id = anchor_message_id.trim();
        if clean_anchor_message_id.is_empty() {
            return Err(AppError::Validation(
                "anchor message id cannot be empty".to_string(),
            ));
        }

        let provided_title = title
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned);

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let source_chat = transaction
            .query_row(
                "SELECT title, character_id, chat_mode FROM chats WHERE id = ?1",
                [clean_source_chat_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;

        let (source_title, source_character_id, source_chat_mode) = if let Some(chat) = source_chat
        {
            chat
        } else {
            return Err(AppError::NotFound(format!(
                "chat {clean_source_chat_id} was not found"
            )));
        };

        let anchor_message_row_id: Option<i64> = transaction
            .query_row(
                "SELECT rowid FROM messages WHERE id = ?1 AND chat_id = ?2",
                params![clean_anchor_message_id, clean_source_chat_id],
                |row| row.get(0),
            )
            .optional()?;
        let anchor_message_row_id = if let Some(value) = anchor_message_row_id {
            value
        } else {
            return Err(AppError::NotFound(format!(
                "message {clean_anchor_message_id} was not found in chat {clean_source_chat_id}"
            )));
        };
        let latest_message_row_id: Option<i64> = transaction.query_row(
            "SELECT MAX(rowid) FROM messages WHERE chat_id = ?1",
            [clean_source_chat_id],
            |row| row.get(0),
        )?;
        let branch_copies_derived_state = latest_message_row_id == Some(anchor_message_row_id);

        let branch_title = provided_title.unwrap_or_else(|| {
            let trimmed = source_title.trim();
            if trimmed.is_empty() {
                "Branched Chat".to_string()
            } else {
                format!("{trimmed} (Branch)")
            }
        });
        if branch_title.trim().is_empty() {
            return Err(AppError::Validation(
                "chat title cannot be empty".to_string(),
            ));
        }

        let branch_chat_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        transaction.execute(
            "INSERT INTO chats (id, title, character_id, chat_mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![branch_chat_id, branch_title, source_character_id.as_deref(), source_chat_mode, now],
        )?;

        let mut participant_statement = transaction.prepare(
            "SELECT character_id, ord FROM chat_participants WHERE chat_id = ?1 ORDER BY ord ASC",
        )?;
        let participant_rows = participant_statement.query_map([clean_source_chat_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut participant_count = 0_i64;
        for row in participant_rows {
            let (participant_character_id, participant_ord) = row?;
            transaction.execute(
                "INSERT INTO chat_participants (chat_id, character_id, ord) VALUES (?1, ?2, ?3)",
                params![branch_chat_id, participant_character_id, participant_ord],
            )?;
            participant_count += 1;
        }
        drop(participant_statement);

        if participant_count == 0 && source_chat_mode.eq_ignore_ascii_case("single") {
            if let Some(single_character_id) = source_character_id.as_deref() {
                let trimmed = single_character_id.trim();
                if !trimmed.is_empty() {
                    transaction.execute(
                        "INSERT INTO chat_participants (chat_id, character_id, ord) VALUES (?1, ?2, 0) ON CONFLICT(chat_id, character_id) DO UPDATE SET ord = excluded.ord",
                        params![branch_chat_id, trimmed],
                    )?;
                }
            }
        }

        let mut message_statement = transaction.prepare(
            "SELECT role, content, speaker_character_id, created_at FROM messages WHERE chat_id = ?1 AND rowid <= ?2 ORDER BY rowid ASC",
        )?;
        let message_rows = message_statement.query_map(
            params![clean_source_chat_id, anchor_message_row_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )?;

        let mut copied_messages = 0_i64;
        let mut last_message_created_at: Option<String> = None;
        for row in message_rows {
            let (role, content, speaker_character_id, created_at) = row?;
            let message_id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO messages (id, chat_id, role, content, speaker_character_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![message_id, branch_chat_id, role, content, speaker_character_id.as_deref(), created_at],
            )?;
            copied_messages += 1;
            last_message_created_at = Some(created_at);
        }
        drop(message_statement);

        if copied_messages == 0 {
            return Err(AppError::Validation(
                "cannot branch chat without messages".to_string(),
            ));
        }

        if let Some(updated_at) = last_message_created_at {
            transaction.execute(
                "UPDATE chats SET updated_at = ?1 WHERE id = ?2",
                params![updated_at, branch_chat_id],
            )?;
        }

        if branch_copies_derived_state {
            transaction.execute(
                "
                INSERT INTO chat_memory (chat_id, summary, facts_json, updated_at)
                SELECT ?1, CASE WHEN summary_auto = 1 THEN '' ELSE summary END, facts_json, ?2
                FROM chat_memory
                WHERE chat_id = ?3
                ",
                params![branch_chat_id, now, clean_source_chat_id],
            )?;

            transaction.execute(
                "
                INSERT INTO chat_relationship_states (
                    chat_id,
                    summary,
                    current_scene,
                    interaction_tone,
                    character_state,
                    user_state,
                    user_role_name,
                    user_role_description,
                    updated_at
                )
                SELECT
                    ?1,
                    summary,
                    current_scene,
                    interaction_tone,
                    character_state,
                    user_state,
                    user_role_name,
                    user_role_description,
                    ?2
                FROM chat_relationship_states
                WHERE chat_id = ?3
                ",
                params![branch_chat_id, now, clean_source_chat_id],
            )?;
        }

        transaction.execute(
            "
            INSERT INTO chat_preset_profiles (chat_id, persona_preset_id, generation_preset_id, updated_at)
            SELECT ?1, persona_preset_id, generation_preset_id, ?2
            FROM chat_preset_profiles
            WHERE chat_id = ?3
            ",
            params![branch_chat_id, now, clean_source_chat_id],
        )?;

        let mut branch_chat = transaction.query_row(
            "SELECT id, title, character_id, chat_mode, created_at, updated_at, history_epoch FROM chats WHERE id = ?1",
            [branch_chat_id.as_str()],
            map_chat_row,
        )?;
        branch_chat.participant_ids = fetch_chat_participant_ids(
            &transaction,
            &branch_chat.id,
            branch_chat.character_id.as_deref(),
            &branch_chat.chat_mode,
        )?;

        transaction.commit()?;
        Ok(branch_chat)
    }

    pub fn delete_chat(&self, chat_id: &str) -> AppResult<()> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let connection = self.open_connection()?;
        let affected = connection.execute("DELETE FROM chats WHERE id = ?1", [id])?;
        if affected == 0 {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        }

        Ok(())
    }
}

fn map_chat_row(row: &Row<'_>) -> rusqlite::Result<ChatRecord> {
    Ok(ChatRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        character_id: row.get(2)?,
        chat_mode: row.get(3)?,
        participant_ids: Vec::new(),
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        history_epoch: row.get(6)?,
    })
}

pub(super) fn fetch_chat_participant_ids(
    connection: &Connection,
    chat_id: &str,
    single_character_id: Option<&str>,
    chat_mode: &str,
) -> AppResult<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT character_id FROM chat_participants WHERE chat_id = ?1 ORDER BY ord ASC",
    )?;
    let rows = statement.query_map([chat_id], |row| row.get::<_, String>(0))?;
    let mut participant_ids = Vec::new();
    let mut seen = HashSet::new();
    for row in rows {
        let participant_id = row?;
        if seen.insert(participant_id.clone()) {
            participant_ids.push(participant_id);
        }
    }

    if participant_ids.is_empty() && chat_mode.eq_ignore_ascii_case("single") {
        if let Some(single_character_id) = single_character_id {
            let trimmed = single_character_id.trim();
            if !trimmed.is_empty() {
                participant_ids.push(trimmed.to_string());
            }
        }
    }

    Ok(participant_ids)
}

fn normalize_character_ids(character_ids: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for character_id in character_ids {
        let trimmed = character_id.trim();
        if trimmed.is_empty() {
            continue;
        }
        let trimmed_string = trimmed.to_string();
        if seen.insert(trimmed_string.clone()) {
            normalized.push(trimmed_string);
        }
    }
    normalized
}
