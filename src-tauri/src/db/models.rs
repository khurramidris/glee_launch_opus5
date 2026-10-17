use rusqlite::{params, OptionalExtension, Row};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::types::ModelRecord;

use super::{now_rfc3339, upsert_setting_tx, Database};

impl Database {
    pub fn list_models(&self) -> AppResult<Vec<ModelRecord>> {
        let connection = self.open_connection()?;
        let mut statement = connection.prepare(
            "
            SELECT id, name, source_path, sha256, is_active, created_at, updated_at
            FROM models
            ORDER BY is_active DESC, updated_at DESC
            ",
        )?;
        let rows = statement.query_map([], map_model_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn import_model(
        &self,
        name: &str,
        source_path: &str,
        sha256: &str,
    ) -> AppResult<ModelRecord> {
        if name.trim().is_empty() {
            return Err(AppError::Validation(
                "model name cannot be empty".to_string(),
            ));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let now = now_rfc3339();

        let existing_id: Option<String> = transaction
            .query_row("SELECT id FROM models WHERE sha256 = ?1", [sha256], |row| {
                row.get(0)
            })
            .optional()?;

        let model_id = if let Some(existing_id) = existing_id {
            transaction.execute(
                "
                UPDATE models
                SET name = ?1, source_path = ?2, updated_at = ?3
                WHERE id = ?4
                ",
                params![name, source_path, now, existing_id],
            )?;
            existing_id
        } else {
            let model_id = Uuid::new_v4().to_string();
            transaction.execute(
                "
                INSERT INTO models (id, name, source_path, sha256, is_active, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
                ",
                params![model_id, name, source_path, sha256, now],
            )?;
            model_id
        };

        let has_active: i64 = transaction.query_row(
            "SELECT COUNT(1) FROM models WHERE is_active = 1",
            [],
            |row| row.get(0),
        )?;
        if has_active == 0 {
            transaction.execute(
                "UPDATE models SET is_active = 1, updated_at = ?1 WHERE id = ?2",
                params![now, model_id],
            )?;
            upsert_setting_tx(&transaction, "active_model_id", &model_id, &now)?;
        }

        let model = transaction.query_row(
            "
            SELECT id, name, source_path, sha256, is_active, created_at, updated_at
            FROM models
            WHERE id = ?1
            ",
            [model_id.as_str()],
            map_model_row,
        )?;

        transaction.commit()?;
        Ok(model)
    }

    pub fn set_active_model(&self, model_id: &str) -> AppResult<ModelRecord> {
        let id = model_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("model id cannot be empty".to_string()));
        }

        let mut connection = self.open_connection()?;
        let transaction = connection.transaction()?;
        let now = now_rfc3339();

        let exists: i64 =
            transaction.query_row("SELECT COUNT(1) FROM models WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
        if exists == 0 {
            return Err(AppError::NotFound(format!("model {id} was not found")));
        }

        transaction.execute(
            "UPDATE models SET is_active = 0, updated_at = ?1 WHERE is_active = 1",
            params![now],
        )?;
        transaction.execute(
            "UPDATE models SET is_active = 1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        upsert_setting_tx(&transaction, "active_model_id", id, &now)?;

        let model = transaction.query_row(
            "
            SELECT id, name, source_path, sha256, is_active, created_at, updated_at
            FROM models
            WHERE id = ?1
            ",
            [id],
            map_model_row,
        )?;

        transaction.commit()?;
        Ok(model)
    }

    pub fn get_active_model(&self) -> AppResult<Option<ModelRecord>> {
        let connection = self.open_connection()?;
        connection
            .query_row(
                "
                SELECT id, name, source_path, sha256, is_active, created_at, updated_at
                FROM models
                WHERE is_active = 1
                LIMIT 1
                ",
                [],
                map_model_row,
            )
            .optional()
            .map_err(AppError::from)
    }

    pub fn get_model_by_id(&self, model_id: &str) -> AppResult<Option<ModelRecord>> {
        let id = model_id.trim();
        if id.is_empty() {
            return Err(AppError::Validation("model id cannot be empty".to_string()));
        }

        let connection = self.open_connection()?;
        connection
            .query_row(
                "
                SELECT id, name, source_path, sha256, is_active, created_at, updated_at
                FROM models
                WHERE id = ?1
                ",
                [id],
                map_model_row,
            )
            .optional()
            .map_err(AppError::from)
    }
}

fn map_model_row(row: &Row<'_>) -> rusqlite::Result<ModelRecord> {
    Ok(ModelRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        source_path: row.get(2)?,
        sha256: row.get(3)?,
        is_active: row.get::<_, i64>(4)? != 0,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}
