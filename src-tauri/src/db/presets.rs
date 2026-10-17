use rusqlite::{params, OptionalExtension, Row};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::types::{ChatPresetProfileRecord, GenerationPresetRecord, PersonaPresetRecord};

use super::{now_rfc3339, Database};

impl Database {
    pub fn list_persona_presets(&self) -> AppResult<Vec<PersonaPresetRecord>> {
        let connection = self.open_connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, description, system_prompt, created_at, updated_at FROM persona_presets ORDER BY updated_at DESC, name ASC",
        )?;
        let rows = statement.query_map([], map_persona_preset_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn create_persona_preset(
        &self,
        name: &str,
        description: Option<&str>,
        system_prompt: Option<&str>,
    ) -> AppResult<PersonaPresetRecord> {
        let clean_name = name.trim();
        if clean_name.is_empty() {
            return Err(AppError::Validation(
                "persona preset name cannot be empty".to_string(),
            ));
        }

        let preset_id = Uuid::new_v4().to_string();
        let clean_description = description.unwrap_or("").trim().to_string();
        let clean_system_prompt = system_prompt.unwrap_or("").trim().to_string();
        let now = now_rfc3339();

        let connection = self.open_connection()?;
        connection.execute(
            "INSERT INTO persona_presets (id, name, description, system_prompt, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![preset_id, clean_name, clean_description, clean_system_prompt, now],
        )?;

        connection
            .query_row(
                "SELECT id, name, description, system_prompt, created_at, updated_at FROM persona_presets WHERE id = ?1",
                [preset_id.as_str()],
                map_persona_preset_row,
            )
            .map_err(AppError::from)
    }

    pub fn update_persona_preset(
        &self,
        preset_id: &str,
        name: Option<&str>,
        description: Option<&str>,
        system_prompt: Option<&str>,
    ) -> AppResult<PersonaPresetRecord> {
        let id = preset_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "persona preset id cannot be empty".to_string(),
            ));
        }

        if name.is_none() && description.is_none() && system_prompt.is_none() {
            return Err(AppError::Validation(
                "at least one persona preset field must be provided".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let existing = transaction
            .query_row(
                "SELECT id, name, description, system_prompt, created_at, updated_at FROM persona_presets WHERE id = ?1",
                [id],
                map_persona_preset_row,
            )
            .optional()?;
        let existing = if let Some(record) = existing {
            record
        } else {
            return Err(AppError::NotFound(format!(
                "persona preset {id} was not found"
            )));
        };

        let next_name = name.unwrap_or(&existing.name).trim().to_string();
        if next_name.is_empty() {
            return Err(AppError::Validation(
                "persona preset name cannot be empty".to_string(),
            ));
        }

        let next_description = description
            .map(|v| v.trim().to_string())
            .unwrap_or(existing.description);
        let next_system_prompt = system_prompt
            .map(|v| v.trim().to_string())
            .unwrap_or(existing.system_prompt);
        let now = now_rfc3339();

        transaction.execute(
            "UPDATE persona_presets SET name = ?1, description = ?2, system_prompt = ?3, updated_at = ?4 WHERE id = ?5",
            params![next_name, next_description, next_system_prompt, now, id],
        )?;

        let updated = transaction.query_row(
            "SELECT id, name, description, system_prompt, created_at, updated_at FROM persona_presets WHERE id = ?1",
            [id],
            map_persona_preset_row,
        )?;

        transaction.commit()?;
        Ok(updated)
    }

    pub fn delete_persona_preset(&self, preset_id: &str) -> AppResult<()> {
        let id = preset_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "persona preset id cannot be empty".to_string(),
            ));
        }

        let connection = self.open_connection()?;
        let deleted = connection.execute("DELETE FROM persona_presets WHERE id = ?1", [id])?;
        if deleted == 0 {
            return Err(AppError::NotFound(format!(
                "persona preset {id} was not found"
            )));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_generation_preset(
        &self,
        name: &str,
        description: Option<&str>,
        temperature: Option<f64>,
        top_p: Option<f64>,
        max_tokens: Option<i64>,
        repeat_penalty: Option<f64>,
    ) -> AppResult<GenerationPresetRecord> {
        let clean_name = name.trim();
        if clean_name.is_empty() {
            return Err(AppError::Validation(
                "generation preset name cannot be empty".to_string(),
            ));
        }

        let clean_description = description.unwrap_or("").trim().to_string();
        let clean_temperature = validate_temperature(temperature.unwrap_or(0.7_f64))?;
        let clean_top_p = validate_top_p(top_p.unwrap_or(0.9_f64))?;
        let clean_max_tokens = validate_max_tokens(max_tokens.unwrap_or(512_i64))?;
        let clean_repeat_penalty = validate_repeat_penalty(repeat_penalty.unwrap_or(1.1_f64))?;

        let preset_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        let connection = self.open_connection()?;
        connection.execute(
            "INSERT INTO generation_presets (id, name, description, temperature, top_p, max_tokens, repeat_penalty, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![preset_id, clean_name, clean_description, clean_temperature, clean_top_p, clean_max_tokens, clean_repeat_penalty, now],
        )?;

        connection
            .query_row(
                "SELECT id, name, description, temperature, top_p, max_tokens, repeat_penalty, created_at, updated_at FROM generation_presets WHERE id = ?1",
                [preset_id.as_str()],
                map_generation_preset_row,
            )
            .map_err(AppError::from)
    }

    pub fn list_generation_presets(&self) -> AppResult<Vec<GenerationPresetRecord>> {
        let connection = self.open_connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, description, temperature, top_p, max_tokens, repeat_penalty, created_at, updated_at FROM generation_presets ORDER BY updated_at DESC, name ASC",
        )?;
        let rows = statement.query_map([], map_generation_preset_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_generation_preset(
        &self,
        preset_id: &str,
        name: Option<&str>,
        description: Option<&str>,
        temperature: Option<f64>,
        top_p: Option<f64>,
        max_tokens: Option<i64>,
        repeat_penalty: Option<f64>,
    ) -> AppResult<GenerationPresetRecord> {
        let id = preset_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "generation preset id cannot be empty".to_string(),
            ));
        }

        if name.is_none()
            && description.is_none()
            && temperature.is_none()
            && top_p.is_none()
            && max_tokens.is_none()
            && repeat_penalty.is_none()
        {
            return Err(AppError::Validation(
                "at least one generation preset field must be provided".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let existing = transaction
            .query_row(
                "SELECT id, name, description, temperature, top_p, max_tokens, repeat_penalty, created_at, updated_at FROM generation_presets WHERE id = ?1",
                [id],
                map_generation_preset_row,
            )
            .optional()?;
        let existing = if let Some(record) = existing {
            record
        } else {
            return Err(AppError::NotFound(format!(
                "generation preset {id} was not found"
            )));
        };

        let next_name = name.unwrap_or(&existing.name).trim().to_string();
        if next_name.is_empty() {
            return Err(AppError::Validation(
                "generation preset name cannot be empty".to_string(),
            ));
        }

        let next_description = description
            .map(|v| v.trim().to_string())
            .unwrap_or(existing.description);
        let next_temperature = if let Some(v) = temperature {
            validate_temperature(v)?
        } else {
            existing.temperature
        };
        let next_top_p = if let Some(v) = top_p {
            validate_top_p(v)?
        } else {
            existing.top_p
        };
        let next_max_tokens = if let Some(v) = max_tokens {
            validate_max_tokens(v)?
        } else {
            existing.max_tokens
        };
        let next_repeat_penalty = if let Some(v) = repeat_penalty {
            validate_repeat_penalty(v)?
        } else {
            existing.repeat_penalty
        };
        let now = now_rfc3339();

        transaction.execute(
            "UPDATE generation_presets SET name = ?1, description = ?2, temperature = ?3, top_p = ?4, max_tokens = ?5, repeat_penalty = ?6, updated_at = ?7 WHERE id = ?8",
            params![next_name, next_description, next_temperature, next_top_p, next_max_tokens, next_repeat_penalty, now, id],
        )?;

        let updated = transaction.query_row(
            "SELECT id, name, description, temperature, top_p, max_tokens, repeat_penalty, created_at, updated_at FROM generation_presets WHERE id = ?1",
            [id],
            map_generation_preset_row,
        )?;

        transaction.commit()?;
        Ok(updated)
    }

    pub fn delete_generation_preset(&self, preset_id: &str) -> AppResult<()> {
        let id = preset_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "generation preset id cannot be empty".to_string(),
            ));
        }

        let connection = self.open_connection()?;
        let deleted = connection.execute("DELETE FROM generation_presets WHERE id = ?1", [id])?;
        if deleted == 0 {
            return Err(AppError::NotFound(format!(
                "generation preset {id} was not found"
            )));
        }
        Ok(())
    }

    pub fn get_chat_preset_profile(&self, chat_id: &str) -> AppResult<ChatPresetProfileRecord> {
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
                "SELECT chat_id, generation_preset_id, updated_at FROM chat_preset_profiles WHERE chat_id = ?1",
                [id],
                map_chat_preset_profile_row,
            )
            .optional()?;

        Ok(record.unwrap_or(ChatPresetProfileRecord {
            chat_id: id.to_string(),
            generation_preset_id: String::new(),
            updated_at: String::new(),
        }))
    }

    pub fn upsert_chat_preset_profile(
        &self,
        chat_id: &str,
        generation_preset_id: Option<&str>,
    ) -> AppResult<ChatPresetProfileRecord> {
        let id = chat_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("chat id cannot be empty".to_string()));
        }

        let clean_generation_preset_id = generation_preset_id
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned);

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let exists: i64 =
            transaction.query_row("SELECT COUNT(1) FROM chats WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("chat {id} was not found")));
        }

        if let Some(generation_id) = clean_generation_preset_id.as_deref() {
            let generation_exists: i64 = transaction.query_row(
                "SELECT COUNT(1) FROM generation_presets WHERE id = ?1",
                [generation_id],
                |row| row.get(0),
            )?;
            if generation_exists == 0 {
                return Err(AppError::NotFound(format!(
                    "generation preset {generation_id} was not found"
                )));
            }
        }

        let now = now_rfc3339();
        transaction.execute(
            "
            INSERT INTO chat_preset_profiles (chat_id, persona_preset_id, generation_preset_id, updated_at)
            VALUES (?1, NULL, ?2, ?3)
            ON CONFLICT(chat_id) DO UPDATE SET
                generation_preset_id = excluded.generation_preset_id,
                updated_at = excluded.updated_at
            ",
            params![id, clean_generation_preset_id.as_deref(), now],
        )?;

        let record = transaction.query_row(
            "SELECT chat_id, generation_preset_id, updated_at FROM chat_preset_profiles WHERE chat_id = ?1",
            [id],
            map_chat_preset_profile_row,
        )?;

        transaction.commit()?;
        Ok(record)
    }
}

fn map_persona_preset_row(row: &Row<'_>) -> rusqlite::Result<PersonaPresetRecord> {
    Ok(PersonaPresetRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        system_prompt: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn map_generation_preset_row(row: &Row<'_>) -> rusqlite::Result<GenerationPresetRecord> {
    Ok(GenerationPresetRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        temperature: row.get(3)?,
        top_p: row.get(4)?,
        max_tokens: row.get(5)?,
        repeat_penalty: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn map_chat_preset_profile_row(row: &Row<'_>) -> rusqlite::Result<ChatPresetProfileRecord> {
    let generation_preset_id: Option<String> = row.get(1)?;
    Ok(ChatPresetProfileRecord {
        chat_id: row.get(0)?,
        generation_preset_id: generation_preset_id.unwrap_or_default(),
        updated_at: row.get(2)?,
    })
}

fn validate_temperature(value: f64) -> AppResult<f64> {
    if !(0.0_f64..=2.0_f64).contains(&value) {
        return Err(AppError::Validation(
            "temperature must be in the range [0.0, 2.0]".to_string(),
        ));
    }
    Ok(value)
}

fn validate_top_p(value: f64) -> AppResult<f64> {
    if value <= 0.0_f64 || value > 1.0_f64 {
        return Err(AppError::Validation(
            "top_p must be in the range (0.0, 1.0]".to_string(),
        ));
    }
    Ok(value)
}

fn validate_max_tokens(value: i64) -> AppResult<i64> {
    if value <= 0 {
        return Err(AppError::Validation(
            "max_tokens must be greater than 0".to_string(),
        ));
    }
    Ok(value)
}

fn validate_repeat_penalty(value: f64) -> AppResult<f64> {
    if value <= 0.0_f64 {
        return Err(AppError::Validation(
            "repeat_penalty must be greater than 0".to_string(),
        ));
    }
    Ok(value)
}
