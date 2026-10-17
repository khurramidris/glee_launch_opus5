use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Row};

use crate::errors::{AppError, AppResult};
use crate::types::UserProfileRecord;

use super::{now_rfc3339, Database};

const DEFAULT_USER_PROFILE_ID: &str = "default";

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct UserProfilePatch<'a> {
    pub display_name: Option<&'a str>,
    pub about: Option<&'a str>,
    pub gender: Option<&'a str>,
    pub avatar: Option<&'a str>,
    pub traits_json: Option<&'a str>,
    pub preferences: Option<&'a str>,
    pub boundaries: Option<&'a str>,
}

impl Database {
    pub fn get_user_profile(&self) -> AppResult<UserProfileRecord> {
        let connection = self.open_connection()?;
        let record = connection
            .query_row(
                "
                SELECT
                    id,
                    display_name,
                    about,
                    gender,
                    avatar,
                    traits_json,
                    preferences,
                    boundaries,
                    preferences_json,
                    boundaries_json,
                    created_at,
                    updated_at
                FROM user_profiles
                WHERE id = ?1
                ",
                [DEFAULT_USER_PROFILE_ID],
                map_user_profile_row,
            )
            .optional()?;

        Ok(record.unwrap_or_else(default_user_profile_record))
    }

    pub fn upsert_user_profile(&self, patch: UserProfilePatch<'_>) -> AppResult<UserProfileRecord> {
        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let existing = transaction
            .query_row(
                "
                SELECT
                    id,
                    display_name,
                    about,
                    gender,
                    avatar,
                    traits_json,
                    preferences,
                    boundaries,
                    preferences_json,
                    boundaries_json,
                    created_at,
                    updated_at
                FROM user_profiles
                WHERE id = ?1
                ",
                [DEFAULT_USER_PROFILE_ID],
                map_user_profile_row,
            )
            .optional()?;

        let default_record = existing.unwrap_or_else(default_user_profile_record);
        let now = now_rfc3339();
        let next_display_name = patch
            .display_name
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(default_record.display_name);
        let next_about = patch
            .about
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(default_record.about);
        let next_gender = patch
            .gender
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(default_record.gender);
        let next_avatar = patch
            .avatar
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(default_record.avatar);
        let next_traits_json = if let Some(value) = patch.traits_json {
            normalize_string_list_json(Some(value))?
        } else {
            normalize_string_list_json(Some(&default_record.traits_json))?
        };
        let next_preferences = patch
            .preferences
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(default_record.preferences);
        let next_boundaries = patch
            .boundaries
            .map(str::trim)
            .map(ToOwned::to_owned)
            .unwrap_or(default_record.boundaries);
        let created_at = if default_record.created_at.trim().is_empty() {
            now.clone()
        } else {
            default_record.created_at
        };

        transaction.execute(
            "
            INSERT INTO user_profiles (
                id, display_name, about, gender, avatar, traits_json, preferences, boundaries, created_at, updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                display_name = excluded.display_name,
                about = excluded.about,
                gender = excluded.gender,
                avatar = excluded.avatar,
                traits_json = excluded.traits_json,
                preferences = excluded.preferences,
                boundaries = excluded.boundaries,
                updated_at = excluded.updated_at
            ",
            params![
                DEFAULT_USER_PROFILE_ID,
                next_display_name,
                next_about,
                next_gender,
                next_avatar,
                next_traits_json,
                next_preferences,
                next_boundaries,
                created_at,
                now,
            ],
        )?;

        let record = transaction.query_row(
            "
            SELECT
                id,
                display_name,
                about,
                gender,
                avatar,
                traits_json,
                preferences,
                boundaries,
                preferences_json,
                boundaries_json,
                created_at,
                updated_at
            FROM user_profiles
            WHERE id = ?1
            ",
            [DEFAULT_USER_PROFILE_ID],
            map_user_profile_row,
        )?;

        transaction.commit()?;
        Ok(record)
    }
}

fn map_user_profile_row(row: &Row<'_>) -> rusqlite::Result<UserProfileRecord> {
    let gender: String = row.get(3)?;
    let avatar: String = row.get(4)?;
    let traits_json: String = row.get(5)?;
    let preferences: String = row.get(6)?;
    let boundaries: String = row.get(7)?;
    let preferences_json: String = row.get(8)?;
    let boundaries_json: String = row.get(9)?;
    Ok(UserProfileRecord {
        id: row.get(0)?,
        display_name: row.get(1)?,
        about: row.get(2)?,
        gender,
        avatar,
        traits: parse_string_list_json_lossy(&traits_json),
        traits_json,
        preferences: if preferences.trim().is_empty() {
            parse_string_list_json_lossy(&preferences_json).join(", ")
        } else {
            preferences
        },
        boundaries: if boundaries.trim().is_empty() {
            parse_string_list_json_lossy(&boundaries_json).join(", ")
        } else {
            boundaries
        },
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn default_user_profile_record() -> UserProfileRecord {
    UserProfileRecord {
        id: DEFAULT_USER_PROFILE_ID.to_string(),
        display_name: String::new(),
        about: String::new(),
        gender: String::new(),
        avatar: String::new(),
        traits_json: "[]".to_string(),
        traits: Vec::new(),
        preferences: String::new(),
        boundaries: String::new(),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

pub(super) fn normalize_string_list_json(raw: Option<&str>) -> AppResult<String> {
    let raw = raw.unwrap_or("[]").trim();
    if raw.is_empty() {
        return Ok("[]".to_string());
    }

    let values = parse_string_list_json(raw)?;
    serde_json::to_string(&values)
        .map_err(|error| AppError::Validation(format!("invalid string-list JSON value: {error}")))
}

fn parse_string_list_json(raw: &str) -> AppResult<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|error| {
        AppError::Validation(format!("invalid string-list JSON value: {error}"))
    })?;

    let values = match value {
        serde_json::Value::Array(entries) => {
            let mut values = Vec::new();
            for entry in entries {
                match entry {
                    serde_json::Value::String(value) => values.push(value),
                    serde_json::Value::Number(value) => values.push(value.to_string()),
                    serde_json::Value::Bool(value) => values.push(value.to_string()),
                    _ => {}
                }
            }
            values
        }
        serde_json::Value::String(value) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        serde_json::Value::Null => Vec::new(),
        _ => {
            return Err(AppError::Validation(
                "string-list JSON must be a JSON array or string".to_string(),
            ));
        }
    };

    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let clean_value = value.trim();
        if clean_value.is_empty() {
            continue;
        }
        let item = clean_value.to_string();
        if seen.insert(item.clone()) {
            normalized.push(item);
        }
    }

    Ok(normalized)
}

fn parse_string_list_json_lossy(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    parse_string_list_json(trimmed).unwrap_or_default()
}
