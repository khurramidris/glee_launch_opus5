use std::collections::HashSet;

use rusqlite::{params, params_from_iter, OptionalExtension, Row};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::types::ContextEntryRecord;

use super::{now_rfc3339, Database};

impl Database {
    pub fn list_context_entries(
        &self,
        character_id: Option<&str>,
    ) -> AppResult<Vec<ContextEntryRecord>> {
        let connection = self.open_connection()?;

        let entries = if let Some(character_id) = character_id {
            let id = character_id.trim();
            if id.is_empty() {
                return Err(AppError::Validation(
                    "character id cannot be empty".to_string(),
                ));
            }
            let mut statement = connection.prepare(
                "SELECT id, scope, character_id, title, keywords_json, content, enabled, created_at, updated_at FROM context_entries WHERE scope = 'global' OR (scope = 'character' AND character_id = ?1) ORDER BY updated_at DESC",
            )?;
            let rows = statement.query_map([id], map_context_entry_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let mut statement = connection.prepare(
                "SELECT id, scope, character_id, title, keywords_json, content, enabled, created_at, updated_at FROM context_entries WHERE scope = 'global' ORDER BY updated_at DESC",
            )?;
            let rows = statement.query_map([], map_context_entry_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        Ok(entries)
    }

    pub fn create_context_entry(
        &self,
        scope: &str,
        character_id: Option<&str>,
        title: &str,
        keywords_json: Option<&str>,
        content: &str,
        enabled: Option<bool>,
    ) -> AppResult<ContextEntryRecord> {
        let clean_scope = scope.trim().to_lowercase();
        if clean_scope != "global" && clean_scope != "character" {
            return Err(AppError::Validation(
                "scope must be either global or character".to_string(),
            ));
        }

        let clean_title = title.trim();
        if clean_title.is_empty() {
            return Err(AppError::Validation(
                "context entry title cannot be empty".to_string(),
            ));
        }

        let clean_content = content.trim().to_string();
        let clean_keywords_json = normalize_keywords_json(keywords_json)?;
        let clean_enabled = enabled.unwrap_or(true);

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let clean_character_id = if clean_scope == "character" {
            let id = if let Some(character_id) = character_id {
                let id = character_id.trim();
                if id.is_empty() {
                    return Err(AppError::Validation(
                        "character id cannot be empty".to_string(),
                    ));
                }
                id.to_string()
            } else {
                return Err(AppError::Validation(
                    "character id is required for character scope".to_string(),
                ));
            };

            let exists: i64 = transaction.query_row(
                "SELECT COUNT(1) FROM characters WHERE id = ?1",
                [id.as_str()],
                |row| row.get(0),
            )?;
            if exists == 0 {
                return Err(AppError::NotFound(format!("character {id} was not found")));
            }
            Some(id)
        } else {
            None
        };

        let entry_id = Uuid::new_v4().to_string();
        let now = now_rfc3339();
        transaction.execute(
            "INSERT INTO context_entries (id, scope, character_id, title, keywords_json, content, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![entry_id, clean_scope, clean_character_id.as_deref(), clean_title, clean_keywords_json, clean_content, if clean_enabled { 1_i64 } else { 0_i64 }, now],
        )?;

        let entry = transaction.query_row(
            "SELECT id, scope, character_id, title, keywords_json, content, enabled, created_at, updated_at FROM context_entries WHERE id = ?1",
            [entry_id.as_str()],
            map_context_entry_row,
        )?;

        transaction.commit()?;
        Ok(entry)
    }

    pub fn update_context_entry(
        &self,
        context_entry_id: &str,
        title: Option<&str>,
        keywords_json: Option<&str>,
        content: Option<&str>,
        enabled: Option<bool>,
    ) -> AppResult<ContextEntryRecord> {
        let id = context_entry_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "context entry id cannot be empty".to_string(),
            ));
        }

        if title.is_none() && keywords_json.is_none() && content.is_none() && enabled.is_none() {
            return Err(AppError::Validation(
                "at least one context entry field must be provided".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;

        let existing = transaction
            .query_row(
                "SELECT id, scope, character_id, title, keywords_json, content, enabled, created_at, updated_at FROM context_entries WHERE id = ?1",
                [id],
                map_context_entry_row,
            )
            .optional()?;

        let existing = if let Some(record) = existing {
            record
        } else {
            return Err(AppError::NotFound(format!(
                "context entry {id} was not found"
            )));
        };

        let next_title = if let Some(title) = title {
            let clean_title = title.trim();
            if clean_title.is_empty() {
                return Err(AppError::Validation(
                    "context entry title cannot be empty".to_string(),
                ));
            }
            clean_title.to_string()
        } else {
            existing.title
        };
        let next_keywords_json = if let Some(keywords_json) = keywords_json {
            normalize_keywords_json(Some(keywords_json))?
        } else {
            existing.keywords_json
        };
        let next_content = content
            .map(|v| v.trim().to_string())
            .unwrap_or(existing.content);
        let next_enabled = enabled.unwrap_or(existing.enabled);
        let now = now_rfc3339();

        transaction.execute(
            "UPDATE context_entries SET title = ?1, keywords_json = ?2, content = ?3, enabled = ?4, updated_at = ?5 WHERE id = ?6",
            params![next_title, next_keywords_json, next_content, if next_enabled { 1_i64 } else { 0_i64 }, now, id],
        )?;

        let updated = transaction.query_row(
            "SELECT id, scope, character_id, title, keywords_json, content, enabled, created_at, updated_at FROM context_entries WHERE id = ?1",
            [id],
            map_context_entry_row,
        )?;

        transaction.commit()?;
        Ok(updated)
    }

    pub fn delete_context_entry(&self, context_entry_id: &str) -> AppResult<()> {
        let id = context_entry_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation(
                "context entry id cannot be empty".to_string(),
            ));
        }

        let connection = self.open_connection()?;
        let deleted = connection.execute("DELETE FROM context_entries WHERE id = ?1", [id])?;
        if deleted == 0 {
            return Err(AppError::NotFound(format!(
                "context entry {id} was not found"
            )));
        }
        Ok(())
    }

    pub fn resolve_context_entries(
        &self,
        character_ids: &[String],
        query: &str,
        limit: usize,
    ) -> AppResult<Vec<ContextEntryRecord>> {
        let clean_query = query.trim();
        if clean_query.is_empty() {
            return Err(AppError::Validation(
                "resolve query cannot be empty".to_string(),
            ));
        }

        let max_results = limit.clamp(1, 20);
        let normalized_character_ids = normalize_character_ids(character_ids);
        let connection = self.open_connection()?;

        let entries = if normalized_character_ids.is_empty() {
            let mut statement = connection.prepare(
                "SELECT id, scope, character_id, title, keywords_json, content, enabled, created_at, updated_at FROM context_entries WHERE enabled = 1 AND scope = 'global'",
            )?;
            let rows = statement.query_map([], map_context_entry_row)?;
            rows.collect::<Result<Vec<_>, _>>()?
        } else {
            let placeholders = vec!["?"; normalized_character_ids.len()].join(", ");
            let sql = format!(
                "SELECT id, scope, character_id, title, keywords_json, content, enabled, created_at, updated_at FROM context_entries WHERE enabled = 1 AND (scope = 'global' OR (scope = 'character' AND character_id IN ({placeholders})))"
            );
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(
                params_from_iter(normalized_character_ids.iter().map(|v| v.as_str())),
                map_context_entry_row,
            )?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let query_lower = clean_query.to_lowercase();
        let query_tokens = tokenize_query(&query_lower);

        let mut scored = entries
            .into_iter()
            .filter_map(|entry| {
                let score = score_context_entry(&entry, &query_lower, &query_tokens);
                if score > 0 {
                    Some((score, entry))
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        scored.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| right.1.updated_at.cmp(&left.1.updated_at))
                .then_with(|| left.1.id.cmp(&right.1.id))
        });

        Ok(scored
            .into_iter()
            .take(max_results)
            .map(|(_, entry)| entry)
            .collect())
    }
}

fn map_context_entry_row(row: &Row<'_>) -> rusqlite::Result<ContextEntryRecord> {
    let keywords_json: String = row.get(4)?;
    Ok(ContextEntryRecord {
        id: row.get(0)?,
        scope: row.get(1)?,
        character_id: row.get(2)?,
        title: row.get(3)?,
        keywords: parse_keywords_json_lossy(&keywords_json),
        keywords_json,
        content: row.get(5)?,
        enabled: row.get::<_, i64>(6)? != 0,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn normalize_keywords_json(keywords_json: Option<&str>) -> AppResult<String> {
    let raw = keywords_json.unwrap_or("[]").trim();
    if raw.is_empty() {
        return Ok("[]".to_string());
    }
    let keywords = parse_keywords_json(raw)?;
    serde_json::to_string(&keywords)
        .map_err(|error| AppError::Validation(format!("invalid keywords_json value: {error}")))
}

fn parse_keywords_json(raw: &str) -> AppResult<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| AppError::Validation(format!("invalid keywords_json value: {error}")))?;

    let keywords = match value {
        serde_json::Value::Array(values) => {
            let mut keywords = Vec::new();
            for value in values {
                match value {
                    serde_json::Value::String(keyword) => keywords.push(keyword),
                    serde_json::Value::Number(number) => keywords.push(number.to_string()),
                    serde_json::Value::Bool(boolean) => keywords.push(boolean.to_string()),
                    _ => {}
                }
            }
            keywords
        }
        serde_json::Value::String(value) => value
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        serde_json::Value::Null => Vec::new(),
        _ => {
            return Err(AppError::Validation(
                "keywords_json must be a JSON array or string".to_string(),
            ))
        }
    };

    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for keyword in keywords {
        let clean_keyword = keyword.trim();
        if clean_keyword.is_empty() {
            continue;
        }
        let keyword_string = clean_keyword.to_string();
        if seen.insert(keyword_string.clone()) {
            normalized.push(keyword_string);
        }
    }

    Ok(normalized)
}

fn parse_keywords_json_lossy(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    parse_keywords_json(trimmed).unwrap_or_default()
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

fn tokenize_query(query_lower: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut seen = HashSet::new();
    for token in query_lower.split(|character: char| !character.is_alphanumeric()) {
        let clean_token = token.trim();
        if clean_token.is_empty() {
            continue;
        }
        let normalized_token = clean_token.to_string();
        if seen.insert(normalized_token.clone()) {
            tokens.push(normalized_token);
        }
    }
    if tokens.is_empty() && !query_lower.trim().is_empty() {
        tokens.push(query_lower.trim().to_string());
    }
    tokens
}

fn score_context_entry(
    entry: &ContextEntryRecord,
    query_lower: &str,
    query_tokens: &[String],
) -> i64 {
    let mut score = 0_i64;
    for keyword in &entry.keywords {
        let clean_keyword = keyword.trim().to_lowercase();
        if clean_keyword.is_empty() {
            continue;
        }
        if query_lower.contains(&clean_keyword) {
            score += 10_i64;
        }
    }

    if score == 0 {
        let title = entry.title.to_lowercase();
        let content = entry.content.to_lowercase();
        for token in query_tokens {
            if title.contains(token) {
                score += 2_i64;
            }
            if content.contains(token) {
                score += 1_i64;
            }
        }
    }

    score
}
