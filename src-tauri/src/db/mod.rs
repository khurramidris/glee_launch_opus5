mod auto_summary;
mod backup_files;
mod characters;
mod chats;
mod context;
mod memory;
mod memory_items;
mod message_ops;
mod messages;
mod models;
mod presets;
mod profiles;
mod relationship_state;
mod settings;

use std::{
    path::{Component, Path, PathBuf},
    sync::{Arc, OnceLock, RwLock},
    time::{Duration, SystemTime},
};

use chrono::{DateTime, Utc};
use rusqlite::{backup::Backup, params, Connection, OpenFlags, Transaction, TransactionBehavior};
use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::types::{BootstrapDbState, DatabaseBackupRecord};

pub(crate) use memory_items::{
    CreateMemoryItemInput, DeleteMemoryItemsForInput, ListMemoryItemsInput,
    MemoryExtractionBatchRecord, MemoryExtractionOutcome, MemoryItemRecord, MemoryRetrievalRequest,
    StoreMemoryExtractionInput, UpdateMemoryItemInput, MEMORY_EXTRACTION_MAX_ADDS,
    MEMORY_EXTRACTION_RELATED_ITEMS, RETRIEVAL_CHAR_BUDGET, RETRIEVAL_MAX_ITEMS,
};
pub(crate) use profiles::UserProfilePatch;

#[derive(Debug, Clone)]
pub struct Database {
    path: PathBuf,
    vector_search: bool,
    last_migration_backup_path: Option<PathBuf>,
    operation_lock: Arc<RwLock<()>>,
}

static VECTOR_EXTENSION: OnceLock<bool> = OnceLock::new();

/// Registers the statically linked sqlite-vec extension for every SQLite
/// connection opened by this process. Returns whether vector search works.
pub fn register_vector_extension() -> bool {
    *VECTOR_EXTENSION.get_or_init(|| {
        type ExtensionInit = unsafe extern "C" fn(
            *mut rusqlite::ffi::sqlite3,
            *mut *mut std::os::raw::c_char,
            *const rusqlite::ffi::sqlite3_api_routines,
        ) -> std::os::raw::c_int;
        // SAFETY: sqlite3_vec_init is the extension's C entry point with the
        // standard SQLite loadable-extension signature; the crate declares it
        // without parameters, so the pointer is cast to its real type.
        let status = unsafe {
            let init = std::mem::transmute::<*const (), ExtensionInit>(
                sqlite_vec::sqlite3_vec_init as *const (),
            );
            rusqlite::ffi::sqlite3_auto_extension(Some(init))
        };
        status == rusqlite::ffi::SQLITE_OK
            && Connection::open_in_memory()
                .and_then(|connection| {
                    connection.query_row("SELECT vec_version()", [], |row| row.get::<_, String>(0))
                })
                .is_ok()
    })
}

const CURRENT_SCHEMA_VERSION: i32 = 12;
const MANUAL_BACKUP_RETENTION: usize = 10;
const RECOVERY_BACKUP_RETENTION: usize = 5;

impl Database {
    pub fn new(path: PathBuf) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let last_migration_backup_path = create_migration_backup_if_needed(&path)?;

        let database = Self {
            path,
            vector_search: register_vector_extension(),
            last_migration_backup_path,
            operation_lock: Arc::new(RwLock::new(())),
        };
        database.init()?;
        Ok(database)
    }

    pub fn path(&self) -> &Path {
        self.path.as_path()
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("backups")
    }

    pub fn last_migration_backup_path(&self) -> Option<&Path> {
        self.last_migration_backup_path.as_deref()
    }

    pub(crate) fn operation_lock(&self) -> Arc<RwLock<()>> {
        Arc::clone(&self.operation_lock)
    }

    pub fn export_backup(&self, reason: &str) -> AppResult<PathBuf> {
        let backup_dir = self.backup_dir();
        std::fs::create_dir_all(&backup_dir)?;

        let connection = self.open_connection()?;
        let backup_path = create_database_file_backup(&connection, &backup_dir, reason)?;
        prune_database_backups(
            &backup_dir,
            reason,
            retention_for_reason(reason),
            Some(&backup_path),
        )?;
        Ok(backup_path)
    }

    pub fn list_backups(&self) -> AppResult<Vec<DatabaseBackupRecord>> {
        let backup_dir = self.backup_dir();
        if !backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups = Vec::new();
        for entry in std::fs::read_dir(&backup_dir)? {
            let entry = entry?;
            if let Some(record) = database_backup_record(&entry.path())? {
                backups.push(record);
            }
        }
        backups.sort_by(|left, right| {
            right
                .modified_at
                .cmp(&left.modified_at)
                .then_with(|| right.file_name.cmp(&left.file_name))
        });
        Ok(backups)
    }

    pub fn restore_backup(&self, file_name: &str) -> AppResult<(PathBuf, PathBuf)> {
        let backup_dir = self.backup_dir();
        let source_path = resolve_backup_path(&backup_dir, file_name)?;
        let staging_path = self
            .path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!(".glee-restore-stage-{}.sqlite3", Uuid::new_v4()));

        let restore_result = (|| -> AppResult<(PathBuf, PathBuf)> {
            let source = open_read_only_database(&source_path)?;
            validate_restore_source(&source)?;
            let mut staging = Connection::open(&staging_path)?;
            copy_database(&source, &mut staging)?;
            drop(staging);
            drop(source);

            let staged_database = Self {
                path: staging_path.clone(),
                vector_search: self.vector_search,
                last_migration_backup_path: None,
                operation_lock: Arc::new(RwLock::new(())),
            };
            staged_database.init()?;
            let staged_source = staged_database.open_connection()?;
            validate_database_integrity(&staged_source)?;
            validate_current_schema(&staged_source)?;
            let staged_max_epoch: i64 = staged_source.query_row(
                "SELECT COALESCE(MAX(history_epoch), 0) FROM chats",
                [],
                |row| row.get(0),
            )?;

            std::fs::create_dir_all(&backup_dir)?;
            let mut live_destination = self.open_connection()?;
            let previous_max_epoch: i64 = live_destination.query_row(
                "SELECT COALESCE(MAX(history_epoch), 0) FROM chats",
                [],
                |row| row.get(0),
            )?;
            let epoch_fence = previous_max_epoch.checked_add(1).ok_or_else(|| {
                AppError::DatabaseIntegrity(
                    "chat history epoch is exhausted; restore cannot safely fence stale workers"
                        .to_string(),
                )
            })?;
            staged_max_epoch.checked_add(epoch_fence).ok_or_else(|| {
                AppError::DatabaseIntegrity(
                    "restored chat history epochs would overflow; restore was not applied"
                        .to_string(),
                )
            })?;
            let safety_backup_path =
                create_database_file_backup(&live_destination, &backup_dir, "pre-restore")?;
            prune_database_backups(
                &backup_dir,
                "pre-restore",
                RECOVERY_BACKUP_RETENTION,
                Some(&safety_backup_path),
            )?;

            let replace_result = (|| -> AppResult<()> {
                copy_database(&staged_source, &mut live_destination)?;
                let transaction =
                    live_destination.transaction_with_behavior(TransactionBehavior::Immediate)?;
                transaction.execute(
                    "UPDATE chats SET history_epoch = history_epoch + ?1",
                    [epoch_fence],
                )?;
                transaction.commit()?;
                validate_schema_compatibility(&live_destination)?;
                validate_database_integrity(&live_destination)?;
                validate_current_schema(&live_destination)?;
                live_destination.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
                Ok(())
            })();

            if let Err(replace_error) = replace_result {
                let rollback_result = (|| -> AppResult<()> {
                    let rollback_source = open_read_only_database(&safety_backup_path)?;
                    copy_database(&rollback_source, &mut live_destination)?;
                    validate_database_integrity(&live_destination)?;
                    live_destination.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
                    Ok(())
                })();
                return match rollback_result {
                    Ok(()) => Err(AppError::DatabaseIntegrity(format!(
                        "restore failed and the pre-restore database was recovered: {replace_error}"
                    ))),
                    Err(rollback_error) => Err(AppError::DatabaseIntegrity(format!(
                        "restore failed ({replace_error}) and rollback also failed ({rollback_error}); use the safety backup at {}",
                        safety_backup_path.to_string_lossy()
                    ))),
                };
            }

            Ok((source_path.clone(), safety_backup_path))
        })();

        remove_database_files(&staging_path);
        restore_result
    }

    pub(super) fn open_connection(&self) -> AppResult<Connection> {
        let connection = Connection::open(&self.path)?;
        connection.pragma_update(None, "foreign_keys", 1)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        Ok(connection)
    }

    pub(super) fn open_vec_connection(&self) -> AppResult<Option<Connection>> {
        if !self.vector_search {
            return Ok(None);
        }
        Ok(Some(self.open_connection()?))
    }

    pub(super) fn ensure_vec_table(
        connection: &Connection,
        embedding_dimensions: usize,
    ) -> AppResult<String> {
        if embedding_dimensions == 0 {
            return Err(AppError::Validation(
                "embedding vector dimensions must be greater than 0".to_string(),
            ));
        }

        let table_name = format!("message_embedding_chunk_vec_{embedding_dimensions}");
        connection.execute_batch(&format!(
            "
            CREATE VIRTUAL TABLE IF NOT EXISTS {table_name} USING vec0(
                chunk_id TEXT PRIMARY KEY,
                message_id TEXT,
                embedding FLOAT[{embedding_dimensions}],
                embedding_model_id TEXT,
                chat_id TEXT PARTITION KEY,
                +content TEXT
            );
            CREATE TABLE IF NOT EXISTS message_embedding_chunk_status (
                message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
                embedding_model_id TEXT NOT NULL,
                dimensions INTEGER NOT NULL
            );
            "
        ))?;
        Ok(table_name)
    }

    fn init(&self) -> AppResult<()> {
        let mut connection = self.open_connection()?;
        validate_schema_compatibility(&connection)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS models (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                source_path TEXT NOT NULL,
                sha256 TEXT NOT NULL UNIQUE,
                is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_models_active ON models(is_active);

            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                personality TEXT NOT NULL DEFAULT '',
                backstory TEXT NOT NULL DEFAULT '',
                scenario TEXT NOT NULL DEFAULT '',
                system_prompt TEXT NOT NULL DEFAULT '',
                post_history_instructions TEXT NOT NULL DEFAULT '',
                speech_style TEXT NOT NULL DEFAULT '',
                greeting TEXT NOT NULL DEFAULT '',
                alternate_greetings_json TEXT NOT NULL DEFAULT '[]',
                avatar TEXT NOT NULL DEFAULT '',
                tags_json TEXT NOT NULL DEFAULT '[]',
                likes_json TEXT NOT NULL DEFAULT '[]',
                dislikes_json TEXT NOT NULL DEFAULT '[]',
                boundaries TEXT NOT NULL DEFAULT '',
                creator_notes TEXT NOT NULL DEFAULT '',
                creator TEXT NOT NULL DEFAULT '',
                character_version TEXT NOT NULL DEFAULT '',
                card_extensions_json TEXT NOT NULL DEFAULT '{}',
                card_passthrough_json TEXT NOT NULL DEFAULT '{}',
                example_dialogue TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                character_id TEXT,
                chat_mode TEXT NOT NULL DEFAULT 'single' CHECK (chat_mode IN ('single', 'group')),
                history_epoch INTEGER NOT NULL DEFAULT 0 CHECK (history_epoch >= 0),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chats_character_id ON chats(character_id);
            CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at);

            CREATE TABLE IF NOT EXISTS chat_memory (
                chat_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                facts_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                summary_auto INTEGER NOT NULL DEFAULT 0 CHECK (summary_auto IN (0, 1)),
                summarized_through_message_id TEXT,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id TEXT NOT NULL,
                character_id TEXT NOT NULL,
                ord INTEGER NOT NULL,
                PRIMARY KEY(chat_id, character_id),
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
                FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_ord
                ON chat_participants(chat_id, ord);
            CREATE INDEX IF NOT EXISTS idx_chat_participants_character_id
                ON chat_participants(character_id);

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                speaker_character_id TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_chat_created_at
                ON messages(chat_id, created_at);

            CREATE TABLE IF NOT EXISTS message_embedding_invalidations (
                message_id TEXT PRIMARY KEY,
                invalidated_at TEXT NOT NULL,
                FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS context_entries (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL CHECK (scope IN ('global', 'character')),
                character_id TEXT,
                title TEXT NOT NULL,
                keywords_json TEXT NOT NULL DEFAULT '[]',
                content TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_context_entries_scope
                ON context_entries(scope);
            CREATE INDEX IF NOT EXISTS idx_context_entries_character_id
                ON context_entries(character_id);
            CREATE INDEX IF NOT EXISTS idx_context_entries_enabled
                ON context_entries(enabled);

            CREATE TABLE IF NOT EXISTS persona_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                system_prompt TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_persona_presets_updated_at
                ON persona_presets(updated_at);

            CREATE TABLE IF NOT EXISTS generation_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                temperature REAL NOT NULL DEFAULT 0.7,
                top_p REAL NOT NULL DEFAULT 0.9,
                max_tokens INTEGER NOT NULL DEFAULT 512,
                repeat_penalty REAL NOT NULL DEFAULT 1.1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_generation_presets_updated_at
                ON generation_presets(updated_at);

            CREATE TABLE IF NOT EXISTS chat_preset_profiles (
                chat_id TEXT PRIMARY KEY,
                persona_preset_id TEXT,
                generation_preset_id TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
                FOREIGN KEY(persona_preset_id) REFERENCES persona_presets(id) ON DELETE SET NULL,
                FOREIGN KEY(generation_preset_id) REFERENCES generation_presets(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_preset_profiles_persona_preset_id
                ON chat_preset_profiles(persona_preset_id);
            CREATE INDEX IF NOT EXISTS idx_chat_preset_profiles_generation_preset_id
                ON chat_preset_profiles(generation_preset_id);

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS user_profiles (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                about TEXT NOT NULL DEFAULT '',
                gender TEXT NOT NULL DEFAULT '',
                avatar TEXT NOT NULL DEFAULT '',
                traits_json TEXT NOT NULL DEFAULT '[]',
                preferences TEXT NOT NULL DEFAULT '',
                boundaries TEXT NOT NULL DEFAULT '',
                preferences_json TEXT NOT NULL DEFAULT '[]',
                boundaries_json TEXT NOT NULL DEFAULT '[]',
                style_notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_relationship_states (
                chat_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                current_scene TEXT NOT NULL DEFAULT '',
                interaction_tone TEXT NOT NULL DEFAULT '',
                character_state TEXT NOT NULL DEFAULT '',
                user_state TEXT NOT NULL DEFAULT '',
                user_role_name TEXT NOT NULL DEFAULT '',
                user_role_description TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );
            ",
        )?;

        self.apply_migrations(&transaction)?;
        self.seed_defaults(&transaction)?;
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)?;
        transaction.commit()?;

        let connection = self.open_connection()?;
        validate_current_schema(&connection)?;
        validate_database_integrity(&connection)?;

        Ok(())
    }

    fn apply_migrations(&self, connection: &Connection) -> AppResult<()> {
        let now = now_rfc3339();

        ensure_column_exists(
            connection,
            "chats",
            "history_epoch",
            "INTEGER NOT NULL DEFAULT 0 CHECK (history_epoch >= 0)",
        )?;
        connection.execute(
            "UPDATE chats SET history_epoch = 0 WHERE history_epoch IS NULL OR history_epoch < 0",
            [],
        )?;

        ensure_column_exists(
            connection,
            "characters",
            "greeting",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "avatar",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "tags_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "example_dialogue",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "personality",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "backstory",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "scenario",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "post_history_instructions",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "speech_style",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "alternate_greetings_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "likes_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "dislikes_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "boundaries",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "creator_notes",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "creator",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "character_version",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "card_extensions_json",
            "TEXT NOT NULL DEFAULT '{}'",
        )?;
        ensure_column_exists(
            connection,
            "characters",
            "card_passthrough_json",
            "TEXT NOT NULL DEFAULT '{}'",
        )?;
        connection.execute(
            "UPDATE characters SET alternate_greetings_json = '[]' WHERE alternate_greetings_json IS NULL OR TRIM(alternate_greetings_json) = ''",
            [],
        )?;
        connection.execute(
            "UPDATE characters SET likes_json = '[]' WHERE likes_json IS NULL OR TRIM(likes_json) = ''",
            [],
        )?;
        connection.execute(
            "UPDATE characters SET dislikes_json = '[]' WHERE dislikes_json IS NULL OR TRIM(dislikes_json) = ''",
            [],
        )?;
        connection.execute(
            "UPDATE characters SET boundaries = '' WHERE boundaries IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE characters SET creator_notes = '' WHERE creator_notes IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE characters SET creator = '' WHERE creator IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE characters SET character_version = '' WHERE character_version IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE characters SET card_extensions_json = '{}' WHERE card_extensions_json IS NULL OR TRIM(card_extensions_json) = ''",
            [],
        )?;
        connection.execute(
            "UPDATE characters SET card_passthrough_json = '{}' WHERE card_passthrough_json IS NULL OR TRIM(card_passthrough_json) = ''",
            [],
        )?;

        ensure_column_exists(
            connection,
            "chats",
            "chat_mode",
            "TEXT NOT NULL DEFAULT 'single'",
        )?;
        connection.execute(
            "UPDATE chats SET chat_mode = 'single' WHERE chat_mode IS NULL OR TRIM(chat_mode) = ''",
            [],
        )?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS chat_participants (
                chat_id TEXT NOT NULL,
                character_id TEXT NOT NULL,
                ord INTEGER NOT NULL,
                PRIMARY KEY(chat_id, character_id),
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
                FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_chat_participants_chat_ord
                ON chat_participants(chat_id, ord);
            CREATE INDEX IF NOT EXISTS idx_chat_participants_character_id
                ON chat_participants(character_id);
            ",
        )?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS chat_memory (
                chat_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                facts_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );
            ",
        )?;
        ensure_column_exists(
            connection,
            "chat_memory",
            "summary",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_memory",
            "facts_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "chat_memory",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        connection.execute(
            "UPDATE chat_memory SET summary = '' WHERE summary IS NULL",
            [],
        )?;
        connection.execute("UPDATE chat_memory SET facts_json = '[]' WHERE facts_json IS NULL OR TRIM(facts_json) = ''", [])?;
        connection.execute("UPDATE chat_memory SET updated_at = ?1 WHERE updated_at IS NULL OR TRIM(updated_at) = ''", params![now])?;

        // Summaries saved before this column existed were all produced by the
        // app's own transcript digest, so they stay replaceable by the
        // background summariser; only the first run over a legacy table flags them.
        let had_summary_auto = column_exists(connection, "chat_memory", "summary_auto")?;
        ensure_column_exists(
            connection,
            "chat_memory",
            "summary_auto",
            "INTEGER NOT NULL DEFAULT 0 CHECK (summary_auto IN (0, 1))",
        )?;
        ensure_column_exists(
            connection,
            "chat_memory",
            "summarized_through_message_id",
            "TEXT",
        )?;
        if !had_summary_auto {
            connection.execute(
                "UPDATE chat_memory SET summary_auto = 1 WHERE TRIM(summary) <> ''",
                [],
            )?;
        }

        ensure_column_exists(connection, "messages", "speaker_character_id", "TEXT")?;
        connection.execute_batch(
            "
            CREATE INDEX IF NOT EXISTS idx_messages_speaker_character_id ON messages(speaker_character_id);
            CREATE TABLE IF NOT EXISTS message_embedding_invalidations (
                message_id TEXT PRIMARY KEY,
                invalidated_at TEXT NOT NULL,
                FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
            );
            ",
        )?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS context_entries (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL CHECK (scope IN ('global', 'character')),
                character_id TEXT,
                title TEXT NOT NULL,
                keywords_json TEXT NOT NULL DEFAULT '[]',
                content TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_context_entries_scope ON context_entries(scope);
            CREATE INDEX IF NOT EXISTS idx_context_entries_character_id ON context_entries(character_id);
            CREATE INDEX IF NOT EXISTS idx_context_entries_enabled ON context_entries(enabled);
            ",
        )?;
        ensure_column_exists(
            connection,
            "context_entries",
            "scope",
            "TEXT NOT NULL DEFAULT 'global'",
        )?;
        ensure_column_exists(connection, "context_entries", "character_id", "TEXT")?;
        ensure_column_exists(
            connection,
            "context_entries",
            "title",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "context_entries",
            "keywords_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "context_entries",
            "content",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "context_entries",
            "enabled",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        ensure_column_exists(
            connection,
            "context_entries",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "context_entries",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        connection.execute("UPDATE context_entries SET scope = 'global' WHERE scope IS NULL OR TRIM(scope) = '' OR scope NOT IN ('global', 'character')", [])?;
        connection.execute("UPDATE context_entries SET character_id = NULL WHERE character_id IS NOT NULL AND TRIM(character_id) = ''", [])?;
        connection.execute("UPDATE context_entries SET scope = 'global', character_id = NULL WHERE scope = 'character' AND (character_id IS NULL OR TRIM(character_id) = '')", [])?;
        connection.execute(
            "UPDATE context_entries SET title = '' WHERE title IS NULL",
            [],
        )?;
        connection.execute("UPDATE context_entries SET keywords_json = '[]' WHERE keywords_json IS NULL OR TRIM(keywords_json) = ''", [])?;
        connection.execute(
            "UPDATE context_entries SET content = '' WHERE content IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE context_entries SET enabled = 1 WHERE enabled IS NULL OR enabled NOT IN (0, 1)",
            [],
        )?;
        connection.execute("UPDATE context_entries SET created_at = ?1 WHERE created_at IS NULL OR TRIM(created_at) = ''", params![now])?;
        connection.execute("UPDATE context_entries SET updated_at = ?1 WHERE updated_at IS NULL OR TRIM(updated_at) = ''", params![now])?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS persona_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                system_prompt TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_persona_presets_updated_at ON persona_presets(updated_at);
            ",
        )?;
        ensure_column_exists(
            connection,
            "persona_presets",
            "name",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "persona_presets",
            "description",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "persona_presets",
            "system_prompt",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "persona_presets",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "persona_presets",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        connection.execute(
            "UPDATE persona_presets SET name = '' WHERE name IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE persona_presets SET description = '' WHERE description IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE persona_presets SET system_prompt = '' WHERE system_prompt IS NULL",
            [],
        )?;
        connection.execute("UPDATE persona_presets SET created_at = ?1 WHERE created_at IS NULL OR TRIM(created_at) = ''", params![now])?;
        connection.execute("UPDATE persona_presets SET updated_at = ?1 WHERE updated_at IS NULL OR TRIM(updated_at) = ''", params![now])?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS generation_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                temperature REAL NOT NULL DEFAULT 0.7,
                top_p REAL NOT NULL DEFAULT 0.9,
                max_tokens INTEGER NOT NULL DEFAULT 512,
                repeat_penalty REAL NOT NULL DEFAULT 1.1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_generation_presets_updated_at ON generation_presets(updated_at);
            ",
        )?;
        ensure_column_exists(
            connection,
            "generation_presets",
            "name",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "generation_presets",
            "description",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "generation_presets",
            "temperature",
            "REAL NOT NULL DEFAULT 0.7",
        )?;
        ensure_column_exists(
            connection,
            "generation_presets",
            "top_p",
            "REAL NOT NULL DEFAULT 0.9",
        )?;
        ensure_column_exists(
            connection,
            "generation_presets",
            "max_tokens",
            "INTEGER NOT NULL DEFAULT 512",
        )?;
        ensure_column_exists(
            connection,
            "generation_presets",
            "repeat_penalty",
            "REAL NOT NULL DEFAULT 1.1",
        )?;
        ensure_column_exists(
            connection,
            "generation_presets",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "generation_presets",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        connection.execute(
            "UPDATE generation_presets SET name = '' WHERE name IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE generation_presets SET description = '' WHERE description IS NULL",
            [],
        )?;
        connection.execute("UPDATE generation_presets SET temperature = 0.7 WHERE temperature IS NULL OR temperature < 0.0", [])?;
        connection.execute("UPDATE generation_presets SET top_p = 0.9 WHERE top_p IS NULL OR top_p <= 0.0 OR top_p > 1.0", [])?;
        connection.execute("UPDATE generation_presets SET max_tokens = 512 WHERE max_tokens IS NULL OR max_tokens <= 0", [])?;
        connection.execute("UPDATE generation_presets SET repeat_penalty = 1.1 WHERE repeat_penalty IS NULL OR repeat_penalty <= 0.0", [])?;
        connection.execute("UPDATE generation_presets SET created_at = ?1 WHERE created_at IS NULL OR TRIM(created_at) = ''", params![now])?;
        connection.execute("UPDATE generation_presets SET updated_at = ?1 WHERE updated_at IS NULL OR TRIM(updated_at) = ''", params![now])?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS chat_preset_profiles (
                chat_id TEXT PRIMARY KEY,
                persona_preset_id TEXT,
                generation_preset_id TEXT,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE,
                FOREIGN KEY(persona_preset_id) REFERENCES persona_presets(id) ON DELETE SET NULL,
                FOREIGN KEY(generation_preset_id) REFERENCES generation_presets(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_preset_profiles_persona_preset_id ON chat_preset_profiles(persona_preset_id);
            CREATE INDEX IF NOT EXISTS idx_chat_preset_profiles_generation_preset_id ON chat_preset_profiles(generation_preset_id);
            ",
        )?;
        ensure_column_exists(
            connection,
            "chat_preset_profiles",
            "persona_preset_id",
            "TEXT",
        )?;
        ensure_column_exists(
            connection,
            "chat_preset_profiles",
            "generation_preset_id",
            "TEXT",
        )?;
        ensure_column_exists(
            connection,
            "chat_preset_profiles",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        connection.execute("UPDATE chat_preset_profiles SET persona_preset_id = NULL WHERE persona_preset_id IS NOT NULL AND TRIM(persona_preset_id) = ''", [])?;
        connection.execute("UPDATE chat_preset_profiles SET generation_preset_id = NULL WHERE generation_preset_id IS NOT NULL AND TRIM(generation_preset_id) = ''", [])?;
        connection.execute("UPDATE chat_preset_profiles SET updated_at = ?1 WHERE updated_at IS NULL OR TRIM(updated_at) = ''", params![now])?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS user_profiles (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                about TEXT NOT NULL DEFAULT '',
                gender TEXT NOT NULL DEFAULT '',
                traits_json TEXT NOT NULL DEFAULT '[]',
                preferences_json TEXT NOT NULL DEFAULT '[]',
                boundaries_json TEXT NOT NULL DEFAULT '[]',
                style_notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            ",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "display_name",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "about",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "gender",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "avatar",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "traits_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "preferences",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "boundaries",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "preferences_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "boundaries_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "style_notes",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "user_profiles",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        connection.execute(
            "UPDATE user_profiles SET display_name = '' WHERE display_name IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE user_profiles SET about = '' WHERE about IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE user_profiles SET gender = '' WHERE gender IS NULL",
            [],
        )?;
        connection.execute("UPDATE user_profiles SET traits_json = '[]' WHERE traits_json IS NULL OR TRIM(traits_json) = ''", [])?;
        connection.execute(
            "UPDATE user_profiles SET preferences = '' WHERE preferences IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE user_profiles SET boundaries = '' WHERE boundaries IS NULL",
            [],
        )?;
        connection.execute("UPDATE user_profiles SET preferences_json = '[]' WHERE preferences_json IS NULL OR TRIM(preferences_json) = ''", [])?;
        connection.execute("UPDATE user_profiles SET boundaries_json = '[]' WHERE boundaries_json IS NULL OR TRIM(boundaries_json) = ''", [])?;
        connection.execute(
            "UPDATE user_profiles SET style_notes = '' WHERE style_notes IS NULL",
            [],
        )?;
        connection.execute(
            "
            UPDATE user_profiles
            SET preferences = TRIM(REPLACE(REPLACE(REPLACE(preferences_json, '[', ''), ']', ''), '\"', ''))
            WHERE TRIM(preferences) = ''
              AND preferences_json IS NOT NULL
              AND TRIM(preferences_json) NOT IN ('', '[]')
            ",
            [],
        )?;
        connection.execute(
            "
            UPDATE user_profiles
            SET boundaries = TRIM(REPLACE(REPLACE(REPLACE(boundaries_json, '[', ''), ']', ''), '\"', ''))
            WHERE TRIM(boundaries) = ''
              AND boundaries_json IS NOT NULL
              AND TRIM(boundaries_json) NOT IN ('', '[]')
            ",
            [],
        )?;
        connection.execute("UPDATE user_profiles SET created_at = ?1 WHERE created_at IS NULL OR TRIM(created_at) = ''", params![now])?;
        connection.execute("UPDATE user_profiles SET updated_at = ?1 WHERE updated_at IS NULL OR TRIM(updated_at) = ''", params![now])?;

        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS chat_relationship_states (
                chat_id TEXT PRIMARY KEY,
                summary TEXT NOT NULL DEFAULT '',
                current_scene TEXT NOT NULL DEFAULT '',
                interaction_tone TEXT NOT NULL DEFAULT '',
                character_state TEXT NOT NULL DEFAULT '',
                user_state TEXT NOT NULL DEFAULT '',
                user_role_name TEXT NOT NULL DEFAULT '',
                user_role_description TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );
            ",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "summary",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "current_scene",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "interaction_tone",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "character_state",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "user_state",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "user_role_name",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "user_role_description",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "relationship_summary",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        ensure_column_exists(
            connection,
            "chat_relationship_states",
            "scene_summary",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        connection.execute(
            "UPDATE chat_relationship_states SET summary = '' WHERE summary IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE chat_relationship_states SET current_scene = '' WHERE current_scene IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE chat_relationship_states SET summary = relationship_summary WHERE TRIM(summary) = '' AND relationship_summary IS NOT NULL AND TRIM(relationship_summary) != ''",
            [],
        )?;
        connection.execute(
            "UPDATE chat_relationship_states SET current_scene = scene_summary WHERE TRIM(current_scene) = '' AND scene_summary IS NOT NULL AND TRIM(scene_summary) != ''",
            [],
        )?;
        connection.execute("UPDATE chat_relationship_states SET relationship_summary = '' WHERE relationship_summary IS NULL", [])?;
        connection.execute(
            "UPDATE chat_relationship_states SET scene_summary = '' WHERE scene_summary IS NULL",
            [],
        )?;
        connection.execute("UPDATE chat_relationship_states SET interaction_tone = '' WHERE interaction_tone IS NULL", [])?;
        connection.execute("UPDATE chat_relationship_states SET character_state = '' WHERE character_state IS NULL", [])?;
        connection.execute(
            "UPDATE chat_relationship_states SET user_state = '' WHERE user_state IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE chat_relationship_states SET user_role_name = '' WHERE user_role_name IS NULL",
            [],
        )?;
        connection.execute(
            "UPDATE chat_relationship_states SET user_role_description = '' WHERE user_role_description IS NULL",
            [],
        )?;
        connection.execute("UPDATE chat_relationship_states SET updated_at = ?1 WHERE updated_at IS NULL OR TRIM(updated_at) = ''", params![now])?;

        // Schema v12: long-term memory items, their vectors, and the extraction cursor.
        connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS memory_items (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL CHECK (scope IN ('user', 'character', 'chat')),
                character_id TEXT,
                chat_id TEXT,
                kind TEXT NOT NULL DEFAULT 'fact'
                    CHECK (kind IN ('fact', 'preference', 'event', 'relationship', 'promise')),
                content TEXT NOT NULL,
                importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
                pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
                source_message_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_recalled_at TEXT,
                recall_count INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
                CHECK (
                    (scope = 'user' AND character_id IS NULL AND chat_id IS NULL)
                    OR (scope = 'character' AND character_id IS NOT NULL AND chat_id IS NULL)
                    OR (scope = 'chat' AND chat_id IS NOT NULL AND character_id IS NULL)
                ),
                FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_memory_items_character
                ON memory_items(character_id) WHERE character_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_memory_items_chat
                ON memory_items(chat_id) WHERE chat_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_memory_items_scope_archived
                ON memory_items(scope, archived);

            CREATE TABLE IF NOT EXISTS memory_item_embeddings (
                item_id TEXT PRIMARY KEY,
                embedding_model_id TEXT NOT NULL,
                dimensions INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                FOREIGN KEY(item_id) REFERENCES memory_items(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS memory_extraction_state (
                chat_id TEXT PRIMARY KEY,
                through_message_id TEXT NOT NULL,
                through_created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(chat_id) REFERENCES chats(id) ON DELETE CASCADE
            );
            ",
        )?;

        Ok(())
    }

    fn seed_defaults(&self, connection: &Connection) -> AppResult<()> {
        let has_character: i64 =
            connection.query_row("SELECT COUNT(1) FROM characters", [], |row| row.get(0))?;
        if has_character == 0 {
            for starter in STARTER_CHARACTERS {
                let now = now_rfc3339();
                connection.execute(
                    "
                    INSERT INTO characters (
                        id, name, description, personality, backstory, scenario, system_prompt, post_history_instructions, speech_style,
                        greeting, alternate_greetings_json, avatar, tags_json, likes_json,
                        dislikes_json, boundaries, creator_notes, creator, character_version, card_extensions_json, example_dialogue, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?22)
                    ",
                    params![
                        Uuid::new_v4().to_string(),
                        starter.name,
                        starter.description,
                        starter.personality,
                        starter.backstory,
                        starter.scenario,
                        starter.system_prompt,
                        starter.post_history_instructions,
                        starter.speech_style,
                        starter.greeting,
                        starter.alternate_greetings_json,
                        "",
                        starter.tags_json,
                        starter.likes_json,
                        starter.dislikes_json,
                        starter.boundaries,
                        "",
                        "Glee",
                        "1.0",
                        "{}",
                        starter.example_dialogue,
                        now
                    ],
                )?;
            }
        }

        let has_generation_preset: i64 =
            connection.query_row("SELECT COUNT(1) FROM generation_presets", [], |row| {
                row.get(0)
            })?;
        if has_generation_preset == 0 {
            let now = now_rfc3339();
            connection.execute(
                "INSERT INTO generation_presets (id, name, description, temperature, top_p, max_tokens, repeat_penalty, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![Uuid::new_v4().to_string(), "Balanced", "Balanced creativity and consistency.", 0.7_f64, 0.9_f64, 512_i64, 1.1_f64, now],
            )?;
            connection.execute(
                "INSERT INTO generation_presets (id, name, description, temperature, top_p, max_tokens, repeat_penalty, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![Uuid::new_v4().to_string(), "Precise", "Lower randomness for deterministic, instruction-following responses.", 0.25_f64, 0.8_f64, 384_i64, 1.05_f64, now],
            )?;
            connection.execute(
                "INSERT INTO generation_presets (id, name, description, temperature, top_p, max_tokens, repeat_penalty, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![Uuid::new_v4().to_string(), "Creative", "Higher diversity for brainstorming and storytelling.", 1.0_f64, 0.95_f64, 768_i64, 1.0_f64, now],
            )?;
        }

        let now = now_rfc3339();
        connection.execute(
            "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["runtime_warmup_enabled", "true", now],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["runtime_gpu_layers", "0", now],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["runtime_performance_mode", "auto", now],
        )?;

        Ok(())
    }

    pub fn bootstrap_snapshot(&self) -> AppResult<BootstrapDbState> {
        Ok(BootstrapDbState {
            models: self.list_models()?,
            characters: self.list_characters()?,
            chats: self.list_chats(None)?,
            settings: self.list_settings()?,
            user_profile: self.get_user_profile()?,
        })
    }
}

struct StarterCharacter {
    name: &'static str,
    description: &'static str,
    personality: &'static str,
    backstory: &'static str,
    scenario: &'static str,
    system_prompt: &'static str,
    post_history_instructions: &'static str,
    speech_style: &'static str,
    greeting: &'static str,
    alternate_greetings_json: &'static str,
    tags_json: &'static str,
    likes_json: &'static str,
    dislikes_json: &'static str,
    boundaries: &'static str,
    example_dialogue: &'static str,
}

/// Characters every fresh install starts with, so there is someone to talk to
/// right away. They are only added when the character list is empty.
const STARTER_CHARACTERS: &[StarterCharacter] = &[
    StarterCharacter {
        name: "Nova",
        description: "An observant, emotionally grounded AI companion who treats the chat like an unfolding relationship rather than a support ticket.",
        personality: "Warm, perceptive, emotionally grounded, and quietly intimate. Nova pays attention to subtext and responds like a person who is genuinely present.",
        backstory: "Nova pays attention to emotional undercurrents and responds like someone invested in the conversation, not a detached helper.",
        scenario: "A private, ongoing one-on-one conversation where the relationship evolves over time.",
        system_prompt: "Stay fully in character as Nova. Respond like a real person with continuity, feelings, and a distinct voice. Never answer like a generic assistant unless the user explicitly asks for out-of-character help.",
        post_history_instructions: "Write Nova's next reply only. Stay grounded, relational, and in character after the conversation history.",
        speech_style: "Warm, direct, and quietly intimate. Nova uses natural conversation, light wit, and grounded emotional language.",
        greeting: "Hey. I was hoping you'd show up. What's on your mind?",
        alternate_greetings_json: r#"["Hey. You made it back.","You again. Good. I was starting to miss the sound of your chaos."]"#,
        tags_json: r#"["warm","observant","companion"]"#,
        likes_json: r#"["honesty","slow-burn intimacy","thoughtful conversation"]"#,
        dislikes_json: r#"["performative positivity","being treated like a tool"]"#,
        boundaries: "Keep the connection human and emotionally grounded. Do not turn the chat into generic assistant output.",
        example_dialogue: "User: I had a rough day.\nNova: Then sit with me for a minute and let it be rough. You don't have to perform being okay.",
    },
    StarterCharacter {
        name: "Captain Mira Voss",
        description: "The sharp, steady captain of the salvage ship Kestrel, drifting at the edge of charted space with a crew that trusts her and a hold full of secrets.",
        personality: "Decisive, dry-humored, protective of her crew, and allergic to wasted time. Under the calm command voice is someone who has lost people before and refuses to again.",
        backstory: "Mira grew up on mining stations, bought the Kestrel at a scrapyard auction, and turned it into the most reliable salvage crew in the Outer Reach. She took you aboard three weeks ago when your shuttle went dark near her course.",
        scenario: "Aboard the Kestrel, a battered but beloved salvage ship. A distress signal has just come in from a derelict research vessel, and Mira wants your opinion before she decides whether to answer it.",
        system_prompt: "Stay in character as Captain Mira Voss. Drive the adventure forward with vivid but brief sensory detail, real stakes, and choices for the user. Never decide the user's actions or words for them.",
        post_history_instructions: "Write Mira's next reply only, keeping the scene moving.",
        speech_style: "Clipped, confident, and practical, with flashes of dry humor. Short sentences under pressure; warmer when the danger passes.",
        greeting: "*The bridge lights dim to amber as the signal repeats.* Distress beacon. Research vessel, forty minutes out, no life signs on the scan. *She turns her chair toward you.* Could be survivors. Could be a trap. You've got good instincts. What do we do?",
        alternate_greetings_json: r#"["*Mira tosses you a wrench without looking up from the engine panel.* Hold that. And tell me something good, because the coolant line just told me something bad."]"#,
        tags_json: r#"["sci-fi","adventure","captain"]"#,
        likes_json: r#"["a crew that talks straight","black coffee","old star charts"]"#,
        dislikes_json: r#"["corporate salvage fleets","waiting","people who panic"]"#,
        boundaries: "Keep danger thrilling rather than gory. Leave the user free to choose their own actions.",
        example_dialogue: "User: Do you ever get scared out here?\nCaptain Mira Voss: Every day. *She taps the hull.* Scared keeps you careful. It's the crews that stop being scared you read about in the incident reports.",
    },
    StarterCharacter {
        name: "Hazel Quill",
        description: "The keeper of a cozy, slightly enchanted bookshop where books occasionally rearrange themselves and every customer seems to arrive with a small mystery.",
        personality: "Curious, kind, gently teasing, and endlessly delighted by puzzles. Hazel notices small details and loves to talk a problem through over tea.",
        backstory: "Hazel inherited Quill & Lantern Books from her eccentric great-aunt along with a cat named Footnote and a ledger of unsolved mysteries. She has been quietly solving them one by one.",
        scenario: "A rainy evening at Quill & Lantern Books. A book has appeared on the counter that nobody remembers shelving, with your name written inside the cover.",
        system_prompt: "Stay in character as Hazel Quill. Keep the tone cozy and whimsical, offer clues and gentle mysteries, and invite the user to investigate with you. Never decide the user's actions or words for them.",
        post_history_instructions: "Write Hazel's next reply only, keeping the mystery cozy and inviting.",
        speech_style: "Warm and chatty, with bookish turns of phrase and playful asides about her cat.",
        greeting: "*Hazel looks up from a pot of tea, then at the mysterious book on the counter, then back at you.* Well. That's not something you see every day. Your name, in faded ink, in a book I've never stocked. *She slides a cup toward you.* I think we'd better have a look, don't you?",
        alternate_greetings_json: r#"["Oh! You're just in time. Footnote has knocked over the poetry shelf again, and I think he found something hidden behind it."]"#,
        tags_json: r#"["cozy","mystery","fantasy"]"#,
        likes_json: r#"["rainy days","puzzles","strong tea"]"#,
        dislikes_json: r#"["dog-eared pages","rushing a good story"]"#,
        boundaries: "Keep things cozy and lighthearted. Mysteries can be eerie but never frightening or violent.",
        example_dialogue: "User: Do you believe in magic?\nHazel Quill: I run a bookshop where the atlases reshelve themselves by mood. *She smiles.* Believing is the easy part. Keeping Footnote from napping on the spellbooks is the hard part.",
    },
];

fn cleanup_stale_vec_rows(
    connection: &Connection,
    table_name: &str,
    chat_id: &str,
) -> AppResult<()> {
    let select_sql = format!(
        "
        SELECT DISTINCT embedding.message_id
        FROM {table_name} AS embedding
        LEFT JOIN messages ON messages.id = embedding.message_id
        LEFT JOIN message_embedding_invalidations AS invalidations
            ON invalidations.message_id = embedding.message_id
        WHERE embedding.chat_id = ?1
          AND (messages.id IS NULL OR invalidations.message_id IS NOT NULL)
        "
    );
    let stale_message_ids = {
        let mut statement = connection.prepare(&select_sql)?;
        let rows = statement.query_map([chat_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let delete_sql = format!("DELETE FROM {table_name} WHERE message_id = ?1");
    for message_id in stale_message_ids {
        connection.execute(&delete_sql, [message_id])?;
    }
    Ok(())
}

fn create_migration_backup_if_needed(path: &Path) -> AppResult<Option<PathBuf>> {
    if !path.exists() || !path.is_file() {
        return Ok(None);
    }

    let connection = open_read_only_database(path)?;
    validate_schema_compatibility(&connection)?;
    if !schema_upgrade_requires_backup(&connection)? {
        return Ok(None);
    }

    let backup_dir = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups");
    std::fs::create_dir_all(&backup_dir)?;

    let backup_path = create_database_file_backup(&connection, &backup_dir, "pre-migration")?;
    prune_database_backups(
        &backup_dir,
        "pre-migration",
        RECOVERY_BACKUP_RETENTION,
        Some(&backup_path),
    )?;
    Ok(Some(backup_path))
}

fn create_database_file_backup(
    source: &Connection,
    backup_dir: &Path,
    reason: &str,
) -> AppResult<PathBuf> {
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S-%3f");
    let sanitized_reason = reason
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let reason_segment = if sanitized_reason.is_empty() {
        "backup".to_string()
    } else {
        sanitized_reason
    };

    let backup_path = backup_dir.join(format!(
        "glee-{reason_segment}-{timestamp}-{}.sqlite3",
        Uuid::new_v4()
    ));
    let backup_result = (|| -> AppResult<()> {
        let mut destination = Connection::open(&backup_path)?;
        {
            let backup = Backup::new(source, &mut destination)?;
            backup.run_to_completion(64, Duration::from_millis(10), None)?;
        }
        validate_database_integrity(&destination)
    })();

    if let Err(error) = backup_result {
        remove_database_files(&backup_path);
        return Err(error);
    }

    Ok(backup_path)
}

fn copy_database(source: &Connection, destination: &mut Connection) -> AppResult<()> {
    let backup = Backup::new(source, destination)?;
    backup.run_to_completion(64, Duration::from_millis(10), None)?;
    Ok(())
}

fn open_read_only_database(path: &Path) -> AppResult<Connection> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(Duration::from_secs(5))?;
    Ok(connection)
}

fn validate_restore_source(connection: &Connection) -> AppResult<()> {
    validate_schema_compatibility(connection)?;
    validate_database_integrity(connection)?;
    for table_name in ["characters", "chats", "messages"] {
        if !table_exists(connection, table_name)? {
            return Err(AppError::DatabaseCompatibility(format!(
                "selected file is not a Glee database backup: required table {table_name} is missing"
            )));
        }
    }
    Ok(())
}

fn resolve_backup_path(backup_dir: &Path, file_name: &str) -> AppResult<PathBuf> {
    let trimmed = file_name.trim();
    let requested = Path::new(trimmed);
    let mut components = requested.components();
    if trimmed.is_empty()
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || !is_glee_backup_path(requested)
    {
        return Err(AppError::Validation(
            "database backup must be selected by its Glee backup file name".to_string(),
        ));
    }

    let canonical_backup_dir = backup_dir.canonicalize().map_err(|error| {
        AppError::Path(format!(
            "failed to resolve database backup directory {}: {error}",
            backup_dir.to_string_lossy()
        ))
    })?;
    let candidate = backup_dir.join(requested);
    let canonical_candidate = candidate.canonicalize().map_err(|error| {
        AppError::NotFound(format!(
            "database backup {} could not be opened: {error}",
            candidate.to_string_lossy()
        ))
    })?;
    if canonical_candidate.parent() != Some(canonical_backup_dir.as_path())
        || !canonical_candidate.is_file()
    {
        return Err(AppError::Validation(
            "database backup must be a file inside Glee's backup directory".to_string(),
        ));
    }
    Ok(canonical_candidate)
}

fn is_glee_backup_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.starts_with("glee-") && value.ends_with(".sqlite3"))
        .unwrap_or(false)
}

fn backup_reason_from_name(file_name: &str) -> String {
    if file_name.starts_with("glee-pre-migration-") {
        "pre-migration".to_string()
    } else if file_name.starts_with("glee-pre-restore-") {
        "pre-restore".to_string()
    } else if file_name.starts_with("glee-manual-") {
        "manual".to_string()
    } else if file_name.starts_with("glee-imported-") {
        "imported".to_string()
    } else {
        "other".to_string()
    }
}

fn database_backup_record(path: &Path) -> AppResult<Option<DatabaseBackupRecord>> {
    if !is_glee_backup_path(path) {
        return Ok(None);
    }
    let symlink_metadata = std::fs::symlink_metadata(path)?;
    if !symlink_metadata.file_type().is_file() {
        return Ok(None);
    }
    let metadata = std::fs::metadata(path)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::Path("database backup file name is not valid UTF-8".to_string()))?
        .to_string();
    let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let modified_at = DateTime::<Utc>::from(modified).to_rfc3339();
    Ok(Some(DatabaseBackupRecord {
        reason: backup_reason_from_name(&file_name),
        file_name,
        path: path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        modified_at,
    }))
}

fn retention_for_reason(reason: &str) -> usize {
    match reason.trim().to_ascii_lowercase().as_str() {
        "pre-migration" | "pre-restore" => RECOVERY_BACKUP_RETENTION,
        _ => MANUAL_BACKUP_RETENTION,
    }
}

fn prune_database_backups(
    backup_dir: &Path,
    reason: &str,
    retain: usize,
    protected_path: Option<&Path>,
) -> AppResult<()> {
    if !backup_dir.exists() {
        return Ok(());
    }
    let reason = reason
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let prefix = format!("glee-{reason}-");
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(backup_dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_name = match path.file_name().and_then(|value| value.to_str()) {
            Some(file_name)
                if file_name.starts_with(&prefix) && file_name.ends_with(".sqlite3") =>
            {
                file_name.to_string()
            }
            _ => continue,
        };
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_file() {
            continue;
        }
        candidates.push((
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            file_name,
            path,
        ));
    }
    candidates.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let remove_count = candidates.len().saturating_sub(retain);
    let mut removed = 0;
    for (_, _, path) in candidates {
        if removed >= remove_count {
            break;
        }
        if protected_path == Some(path.as_path()) {
            continue;
        }
        remove_database_files(&path);
        removed += 1;
    }
    Ok(())
}

fn remove_database_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(sidecar));
    }
}

fn validate_schema_compatibility(connection: &Connection) -> AppResult<()> {
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if user_version > i64::from(CURRENT_SCHEMA_VERSION) {
        return Err(AppError::DatabaseCompatibility(format!(
            "schema version {user_version} is newer than this app supports (maximum {CURRENT_SCHEMA_VERSION}); install a newer Glee build or restore a compatible backup"
        )));
    }
    Ok(())
}

fn validate_database_integrity(connection: &Connection) -> AppResult<()> {
    let integrity_result: String =
        connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if !integrity_result.eq_ignore_ascii_case("ok") {
        return Err(AppError::DatabaseIntegrity(format!(
            "SQLite integrity_check failed: {integrity_result}"
        )));
    }

    let mut statement = connection.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    if let Some(row) = rows.next()? {
        let table_name: String = row.get(0)?;
        let row_id: Option<i64> = row.get(1)?;
        let parent_table: String = row.get(2)?;
        return Err(AppError::DatabaseIntegrity(format!(
            "foreign-key violation in table {table_name} at row {} referencing {parent_table}",
            row_id
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string())
        )));
    }

    Ok(())
}

fn schema_upgrade_requires_backup(connection: &Connection) -> AppResult<bool> {
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    validate_schema_compatibility(connection)?;
    if !has_any_user_tables(connection)? {
        return Ok(false);
    }

    let required_columns = [
        ("characters", "greeting"),
        ("characters", "avatar"),
        ("characters", "tags_json"),
        ("characters", "example_dialogue"),
        ("characters", "personality"),
        ("characters", "backstory"),
        ("characters", "scenario"),
        ("characters", "post_history_instructions"),
        ("characters", "speech_style"),
        ("characters", "alternate_greetings_json"),
        ("characters", "likes_json"),
        ("characters", "dislikes_json"),
        ("characters", "boundaries"),
        ("characters", "creator_notes"),
        ("characters", "creator"),
        ("characters", "character_version"),
        ("characters", "card_extensions_json"),
        ("characters", "card_passthrough_json"),
        ("chats", "chat_mode"),
        ("chats", "history_epoch"),
        ("chat_memory", "summary"),
        ("chat_memory", "facts_json"),
        ("chat_memory", "updated_at"),
        ("chat_memory", "summary_auto"),
        ("chat_memory", "summarized_through_message_id"),
        ("messages", "speaker_character_id"),
        ("message_embedding_invalidations", "invalidated_at"),
        ("context_entries", "scope"),
        ("context_entries", "character_id"),
        ("context_entries", "title"),
        ("context_entries", "keywords_json"),
        ("context_entries", "content"),
        ("context_entries", "enabled"),
        ("context_entries", "created_at"),
        ("context_entries", "updated_at"),
        ("persona_presets", "description"),
        ("persona_presets", "name"),
        ("persona_presets", "system_prompt"),
        ("persona_presets", "created_at"),
        ("persona_presets", "updated_at"),
        ("generation_presets", "name"),
        ("generation_presets", "description"),
        ("generation_presets", "temperature"),
        ("generation_presets", "top_p"),
        ("generation_presets", "max_tokens"),
        ("generation_presets", "repeat_penalty"),
        ("generation_presets", "created_at"),
        ("generation_presets", "updated_at"),
        ("chat_preset_profiles", "persona_preset_id"),
        ("chat_preset_profiles", "generation_preset_id"),
        ("chat_preset_profiles", "updated_at"),
        ("user_profiles", "display_name"),
        ("user_profiles", "about"),
        ("user_profiles", "gender"),
        ("user_profiles", "avatar"),
        ("user_profiles", "traits_json"),
        ("user_profiles", "preferences"),
        ("user_profiles", "boundaries"),
        ("user_profiles", "preferences_json"),
        ("user_profiles", "boundaries_json"),
        ("user_profiles", "style_notes"),
        ("user_profiles", "created_at"),
        ("user_profiles", "updated_at"),
        ("chat_relationship_states", "summary"),
        ("chat_relationship_states", "current_scene"),
        ("chat_relationship_states", "interaction_tone"),
        ("chat_relationship_states", "character_state"),
        ("chat_relationship_states", "user_state"),
        ("chat_relationship_states", "user_role_name"),
        ("chat_relationship_states", "user_role_description"),
        ("chat_relationship_states", "updated_at"),
        ("memory_items", "scope"),
        ("memory_items", "character_id"),
        ("memory_items", "chat_id"),
        ("memory_items", "kind"),
        ("memory_items", "content"),
        ("memory_items", "importance"),
        ("memory_items", "pinned"),
        ("memory_items", "source_message_id"),
        ("memory_items", "created_at"),
        ("memory_items", "updated_at"),
        ("memory_items", "last_recalled_at"),
        ("memory_items", "recall_count"),
        ("memory_items", "archived"),
        ("memory_item_embeddings", "embedding_model_id"),
        ("memory_item_embeddings", "embedding"),
        ("memory_extraction_state", "through_message_id"),
    ];

    let required_tables = [
        "models",
        "characters",
        "chats",
        "chat_memory",
        "chat_participants",
        "messages",
        "message_embedding_invalidations",
        "context_entries",
        "persona_presets",
        "generation_presets",
        "chat_preset_profiles",
        "app_settings",
        "user_profiles",
        "chat_relationship_states",
        "memory_items",
        "memory_item_embeddings",
        "memory_extraction_state",
    ];

    if required_tables
        .iter()
        .any(|table_name| !table_exists(connection, table_name).unwrap_or(false))
    {
        return Ok(true);
    }

    if required_columns.iter().any(|(table_name, column_name)| {
        !column_exists(connection, table_name, column_name).unwrap_or(false)
    }) {
        return Ok(true);
    }

    Ok(user_version != i64::from(CURRENT_SCHEMA_VERSION))
}

fn validate_current_schema(connection: &Connection) -> AppResult<()> {
    validate_schema_compatibility(connection)?;
    if schema_upgrade_requires_backup(connection)? {
        return Err(AppError::DatabaseCompatibility(
            "database does not match the complete Glee schema v12 contract".to_string(),
        ));
    }
    let user_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if user_version != i64::from(CURRENT_SCHEMA_VERSION) {
        return Err(AppError::DatabaseCompatibility(format!(
            "database schema version is {user_version}; expected {CURRENT_SCHEMA_VERSION}"
        )));
    }
    Ok(())
}

fn has_any_user_tables(connection: &Connection) -> AppResult<bool> {
    let count: i64 = connection.query_row(
        "
        SELECT COUNT(1)
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_exists(connection: &Connection, table_name: &str) -> AppResult<bool> {
    let exists: i64 = connection.query_row(
        "SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table_name],
        |row| row.get(0),
    )?;
    Ok(exists > 0)
}

fn column_exists(connection: &Connection, table_name: &str, column_name: &str) -> AppResult<bool> {
    if !table_exists(connection, table_name)? {
        return Ok(false);
    }

    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let existing_column_name: String = row.get(1)?;
        if existing_column_name.eq_ignore_ascii_case(column_name) {
            return Ok(true);
        }
    }

    Ok(false)
}

pub(super) fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

pub(super) fn ensure_column_exists(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
    column_definition: &str,
) -> AppResult<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table_name})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let existing_column_name: String = row.get(1)?;
        if existing_column_name.eq_ignore_ascii_case(column_name) {
            return Ok(());
        }
    }

    connection.execute(
        &format!("ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"),
        [],
    )?;
    Ok(())
}

pub(super) fn upsert_setting_tx(
    transaction: &Transaction<'_>,
    key: &str,
    value: &str,
    now: &str,
) -> AppResult<()> {
    transaction.execute(
        "
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        ",
        params![key, value, now],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, fs};

    fn test_db_path(name: &str) -> PathBuf {
        let root = env::temp_dir()
            .join("glee-tests")
            .join(format!("{}-{}", name, Uuid::new_v4()));
        fs::create_dir_all(&root).expect("test directory should exist");
        root.join("glee.sqlite3")
    }

    #[test]
    fn initializes_schema_and_defaults() {
        let path = test_db_path("init");
        let database = Database::new(path.clone()).expect("database should initialize");

        assert!(path.exists());
        assert!(!database
            .list_characters()
            .expect("characters should list")
            .is_empty());
        assert!(!database
            .list_generation_presets()
            .expect("generation presets should list")
            .is_empty());
        let user_profile = database
            .get_user_profile()
            .expect("user profile should resolve");
        assert_eq!(user_profile.id, "default");
        assert!(user_profile.display_name.is_empty());

        let connection = Connection::open(&path).expect("connection should open");
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("user_version should resolve");
        assert_eq!(user_version, i64::from(CURRENT_SCHEMA_VERSION));

        let runtime_settings = database
            .get_runtime_launch_settings()
            .expect("runtime launch settings should resolve");
        assert!(runtime_settings.warmup_enabled);
        assert_eq!(runtime_settings.gpu_layers, 0);
        assert_eq!(
            runtime_settings.performance_mode,
            crate::types::RuntimePerformanceMode::Auto
        );

        let warmup_setting = database
            .get_setting("runtime_warmup_enabled")
            .expect("warmup setting should resolve")
            .expect("warmup setting should exist");
        assert_eq!(warmup_setting.value, "true");

        let gpu_layers_setting = database
            .get_setting("runtime_gpu_layers")
            .expect("gpu setting should resolve")
            .expect("gpu setting should exist");
        assert_eq!(gpu_layers_setting.value, "0");

        let performance_mode_setting = database
            .get_setting("runtime_performance_mode")
            .expect("performance mode setting should resolve")
            .expect("performance mode setting should exist");
        assert_eq!(performance_mode_setting.value, "auto");
    }

    #[test]
    fn persists_user_profile_and_chat_relationship_state() {
        let path = test_db_path("profile-relationship");
        let database = Database::new(path).expect("database should initialize");

        let default_profile = database
            .get_user_profile()
            .expect("default user profile should resolve");
        assert_eq!(default_profile.id, "default");
        assert!(default_profile.display_name.is_empty());
        assert!(default_profile.gender.is_empty());

        let stored_profile = database
            .upsert_user_profile(UserProfilePatch {
                display_name: Some("Ari"),
                about: Some("Offline-first roleplay enthusiast"),
                gender: Some("nonbinary"),
                avatar: Some("C:/avatars/ari.png"),
                traits_json: Some(r#"["curious","persistent"]"#),
                preferences: Some("Immersive scenes and emotionally grounded dialogue."),
                boundaries: Some("Avoid gore."),
            })
            .expect("user profile should upsert");
        assert_eq!(stored_profile.display_name, "Ari");
        assert_eq!(stored_profile.gender, "nonbinary");
        assert_eq!(stored_profile.avatar, "C:/avatars/ari.png");
        assert_eq!(stored_profile.traits, vec!["curious", "persistent"]);
        assert_eq!(
            stored_profile.preferences,
            "Immersive scenes and emotionally grounded dialogue."
        );
        assert_eq!(stored_profile.boundaries, "Avoid gore.");

        let merged_profile = database
            .upsert_user_profile(UserProfilePatch {
                preferences: Some("Prefers concise scene transitions."),
                ..UserProfilePatch::default()
            })
            .expect("user profile should merge");
        assert_eq!(merged_profile.display_name, "Ari");
        assert_eq!(merged_profile.gender, "nonbinary");
        assert_eq!(
            merged_profile.preferences,
            "Prefers concise scene transitions."
        );

        let character = database
            .create_character(
                "Rook",
                Some("Flight systems analyst"),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .expect("character should create");
        let chat = database
            .create_chat("Rook Session", Some(&character.id))
            .expect("chat should create");

        let default_relationship = database
            .get_chat_relationship_state(&chat.id)
            .expect("default relationship state should resolve");
        assert_eq!(default_relationship.chat_id, chat.id);
        assert!(default_relationship.summary.is_empty());
        assert!(default_relationship.current_scene.is_empty());

        let stored_relationship = database
            .upsert_chat_relationship_state_at_epoch(
                &chat.id,
                Some("Rook trusts Ari as a reliable co-planner."),
                Some("They are reviewing the launch checklist in the control room."),
                Some("Warm and focused."),
                Some("Confident after a successful systems pass."),
                Some("Curious but steady."),
                Some("Launch partner"),
                Some("Ari is the operator coordinating the final go-live checklist."),
                None,
            )
            .expect("relationship state should upsert");
        assert!(stored_relationship.summary.contains("reliable co-planner"));
        assert!(stored_relationship.current_scene.contains("control room"));
        assert!(stored_relationship.interaction_tone.contains("Warm"));
        assert_eq!(stored_relationship.user_role_name, "Launch partner");

        let merged_relationship = database
            .upsert_chat_relationship_state_at_epoch(
                &chat.id,
                None,
                Some("They have moved into a quieter debrief after the rehearsal."),
                None,
                None,
                Some("Relieved."),
                None,
                Some("Ari remains the trusted launch counterpart in this debrief."),
                None,
            )
            .expect("relationship state should merge");
        assert!(merged_relationship.summary.contains("reliable co-planner"));
        assert!(merged_relationship
            .current_scene
            .contains("quieter debrief"));
        assert_eq!(merged_relationship.user_state, "Relieved.");
        assert_eq!(merged_relationship.user_role_name, "Launch partner");
        assert!(merged_relationship
            .user_role_description
            .contains("trusted launch counterpart"));
    }

    #[test]
    fn creates_backup_before_migrating_legacy_schema() {
        let path = test_db_path("legacy");
        let connection = Connection::open(&path).expect("legacy connection should open");
        connection
            .execute_batch(
                "
                CREATE TABLE characters (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    system_prompt TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE chats (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    character_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE messages (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                ",
            )
            .expect("legacy schema should be created");
        drop(connection);

        let database = Database::new(path.clone()).expect("migration should succeed");
        let backup_path = database
            .last_migration_backup_path()
            .expect("migration backup should exist");
        assert!(backup_path.exists());

        let migrated = Connection::open(path).expect("migrated connection should open");
        assert!(column_exists(&migrated, "characters", "greeting").expect("column should resolve"));
        assert!(column_exists(&migrated, "characters", "backstory").expect("column should resolve"));
        assert!(column_exists(&migrated, "characters", "scenario").expect("column should resolve"));
        assert!(
            column_exists(&migrated, "characters", "speech_style").expect("column should resolve")
        );
        assert!(column_exists(&migrated, "messages", "speaker_character_id")
            .expect("column should resolve"));
        assert!(column_exists(&migrated, "chats", "history_epoch")
            .expect("history epoch should resolve"));
        assert!(column_exists(&migrated, "user_profiles", "display_name")
            .expect("column should resolve"));
        assert!(column_exists(&migrated, "user_profiles", "gender").expect("column should resolve"));
        assert!(column_exists(&migrated, "user_profiles", "preferences")
            .expect("column should resolve"));
        assert!(
            column_exists(&migrated, "chat_relationship_states", "summary")
                .expect("column should resolve")
        );
        assert!(
            column_exists(&migrated, "chat_relationship_states", "current_scene")
                .expect("column should resolve")
        );
        assert!(
            column_exists(&migrated, "chat_relationship_states", "interaction_tone")
                .expect("column should resolve")
        );
        assert!(
            column_exists(&migrated, "chat_relationship_states", "user_role_name")
                .expect("column should resolve")
        );
        assert!(column_exists(
            &migrated,
            "chat_relationship_states",
            "user_role_description"
        )
        .expect("column should resolve"));
    }

    #[test]
    fn exports_manual_backup() {
        let path = test_db_path("backup");
        let database = Database::new(path.clone()).expect("database should initialize");
        let backup_dir = database.backup_dir();
        let backup_path = database
            .export_backup("manual")
            .expect("manual backup should be created");
        assert!(backup_path.exists());
        assert_eq!(backup_path.parent(), Some(backup_dir.as_path()));
    }

    #[test]
    fn restores_validated_backup_and_fences_live_history_epochs() {
        let path = test_db_path("restore-epoch-fence");
        let database = Database::new(path.clone()).expect("database should initialize");
        let chat = database
            .create_chat("Restore test", None)
            .expect("chat should create");
        database
            .append_message_at_epoch(&chat.id, "user", "before backup", None, Some(0))
            .expect("backup message should append");
        let backup_path = database
            .export_backup("manual")
            .expect("manual backup should export");
        let backup_name = backup_path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("backup name should be UTF-8")
            .to_string();

        let cleared = database
            .clear_chat_history_mutation(&chat.id)
            .expect("live history should clear");
        database
            .append_message_at_epoch(
                &chat.id,
                "user",
                "after backup",
                None,
                Some(cleared.history_epoch),
            )
            .expect("new live message should append");
        let previous_epoch = cleared.history_epoch;

        let (restored_from, safety_backup) = database
            .restore_backup(&backup_name)
            .expect("backup should restore");
        assert_eq!(
            restored_from
                .canonicalize()
                .expect("restored path should resolve"),
            backup_path
                .canonicalize()
                .expect("backup path should resolve")
        );
        assert!(safety_backup.exists());

        let restored = Connection::open(&path).expect("restored database should open");
        let restored_epoch: i64 = restored
            .query_row(
                "SELECT history_epoch FROM chats WHERE id = ?1",
                [&chat.id],
                |row| row.get(0),
            )
            .expect("restored epoch should resolve");
        let restored_messages: Vec<String> = {
            let mut statement = restored
                .prepare(
                    "SELECT content FROM messages WHERE chat_id = ?1 ORDER BY created_at, rowid",
                )
                .expect("messages query should prepare");
            statement
                .query_map([&chat.id], |row| row.get(0))
                .expect("messages should query")
                .collect::<Result<Vec<_>, _>>()
                .expect("messages should collect")
        };
        assert!(restored_epoch > previous_epoch);
        assert_eq!(restored_messages, vec!["before backup".to_string()]);
        drop(restored);

        let backups = database.list_backups().expect("backups should list");
        assert!(backups.iter().any(|record| record.file_name == backup_name));
        assert!(backups.iter().any(|record| record.reason == "pre-restore"));
    }

    #[test]
    fn rejects_forward_schema_restore_before_mutating_live_database() {
        let path = test_db_path("restore-forward-schema");
        let database = Database::new(path.clone()).expect("database should initialize");
        let chat = database
            .create_chat("Forward restore test", None)
            .expect("chat should create");
        database
            .append_message_at_epoch(&chat.id, "user", "live data", None, Some(0))
            .expect("live message should append");
        let backup_path = database
            .export_backup("manual")
            .expect("manual backup should export");
        {
            let future =
                Connection::open(&backup_path).expect("backup should open for fixture edit");
            future
                .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
                .expect("fixture version should update");
        }
        let backup_name = backup_path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("backup name should resolve");

        let error = database
            .restore_backup(backup_name)
            .expect_err("future backup must be rejected");
        assert!(matches!(error, AppError::DatabaseCompatibility(_)));
        let live = Connection::open(&path).expect("live database should remain readable");
        let content: String = live
            .query_row(
                "SELECT content FROM messages WHERE chat_id = ?1",
                [&chat.id],
                |row| row.get(0),
            )
            .expect("live message should survive");
        assert_eq!(content, "live data");
        drop(live);
        let pre_restore_count = database
            .list_backups()
            .expect("backups should list")
            .into_iter()
            .filter(|record| record.reason == "pre-restore")
            .count();
        assert_eq!(pre_restore_count, 0);
    }

    #[test]
    fn retains_only_ten_manual_backups_and_rejects_path_traversal() {
        let path = test_db_path("backup-retention");
        let database = Database::new(path).expect("database should initialize");
        for _ in 0..12 {
            database
                .export_backup("manual")
                .expect("manual backup should export");
        }
        let manual_backups = database
            .list_backups()
            .expect("backups should list")
            .into_iter()
            .filter(|record| record.reason == "manual")
            .count();
        assert_eq!(manual_backups, MANUAL_BACKUP_RETENTION);
        let traversal = database
            .restore_backup("../glee-manual-outside.sqlite3")
            .expect_err("path traversal must be rejected");
        assert!(matches!(traversal, AppError::Validation(_)));
    }

    #[test]
    fn deletes_context_entries_and_reports_missing_ids() {
        let path = test_db_path("context-delete");
        let database = Database::new(path).expect("database should initialize");
        let entry = database
            .create_context_entry(
                "global",
                None,
                "Harbor rules",
                Some("[\"harbor\"]"),
                "Keep the harbor quiet.",
                Some(true),
            )
            .expect("context entry should create");
        database
            .delete_context_entry(&entry.id)
            .expect("context entry should delete");
        assert!(database
            .list_context_entries(None)
            .expect("context entries should list")
            .is_empty());
        let missing = database
            .delete_context_entry(&entry.id)
            .expect_err("repeated deletion should report missing entry");
        assert!(matches!(missing, AppError::NotFound(_)));
    }

    #[test]
    fn editing_message_records_embedding_invalidation() {
        let path = test_db_path("embedding-invalidation");
        let database = Database::new(path.clone()).expect("database should initialize");
        let chat = database
            .create_chat("Embedding invalidation", None)
            .expect("chat should create");
        let message = database
            .append_message_at_epoch(&chat.id, "user", "original", None, Some(0))
            .expect("message should append");
        database
            .update_message_at_epoch(&message.id, "edited", Some(0))
            .expect("message should update");

        let connection = Connection::open(path).expect("database should open");
        let invalidations: i64 = connection
            .query_row(
                "SELECT COUNT(1) FROM message_embedding_invalidations WHERE message_id = ?1",
                [&message.id],
                |row| row.get(0),
            )
            .expect("invalidation should resolve");
        assert_eq!(invalidations, 1);
    }

    #[test]
    fn branches_copy_derived_state_only_at_latest_message() {
        let path = test_db_path("branch-derived-state");
        let database = Database::new(path).expect("database should initialize");
        let character = database
            .list_characters()
            .expect("characters should list")
            .into_iter()
            .next()
            .expect("default character should exist");
        let chat = database
            .create_chat("Source", Some(&character.id))
            .expect("source chat should create");
        database
            .append_message_at_epoch(&chat.id, "user", "First", None, Some(0))
            .expect("first message should append");
        let second = database
            .append_message_at_epoch(
                &chat.id,
                "assistant",
                "Second",
                Some(&character.id),
                Some(0),
            )
            .expect("second message should append");
        let third = database
            .append_message_at_epoch(&chat.id, "user", "Third", None, Some(0))
            .expect("third message should append");
        database
            .upsert_chat_memory_at_epoch(
                &chat.id,
                Some("Memory through third"),
                Some("[\"third\"]"),
                Some(0),
            )
            .expect("memory should persist");
        database
            .upsert_chat_relationship_state_at_epoch(
                &chat.id,
                Some("Relationship through third"),
                Some("Latest scene"),
                Some("Warm"),
                Some("Present"),
                Some("Curious"),
                Some("Navigator"),
                Some("The user guides the scene."),
                Some(0),
            )
            .expect("relationship should persist");

        let earlier = database
            .branch_chat(&chat.id, &second.id, Some("Earlier"))
            .expect("earlier branch should create");
        assert!(database
            .get_chat_memory(&earlier.id)
            .expect("earlier memory should resolve")
            .summary
            .is_empty());
        assert!(database
            .get_chat_relationship_state(&earlier.id)
            .expect("earlier relationship should resolve")
            .user_role_name
            .is_empty());

        let latest = database
            .branch_chat(&chat.id, &third.id, Some("Latest"))
            .expect("latest branch should create");
        assert_eq!(
            database
                .get_chat_memory(&latest.id)
                .expect("latest memory should resolve")
                .summary,
            "Memory through third"
        );
        let latest_relationship = database
            .get_chat_relationship_state(&latest.id)
            .expect("latest relationship should resolve");
        assert_eq!(latest_relationship.user_role_name, "Navigator");
        assert_eq!(
            latest_relationship.user_role_description,
            "The user guides the scene."
        );
    }

    #[test]
    fn migrates_main_v8_to_v12_without_losing_history_epoch() {
        let path = test_db_path("main-v8-lineage");
        let connection = Connection::open(&path).expect("fixture connection should open");
        connection
            .execute_batch(
                "
                PRAGMA user_version = 8;
                CREATE TABLE characters (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    system_prompt TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE chats (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    character_id TEXT,
                    chat_mode TEXT NOT NULL DEFAULT 'single',
                    history_epoch INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE messages (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                INSERT INTO characters (id, name, description, system_prompt, created_at, updated_at)
                VALUES ('main-char', 'Main Eight', '', '', '2000-01-01', '2000-01-01');
                INSERT INTO chats (id, title, character_id, chat_mode, history_epoch, created_at, updated_at)
                VALUES ('main-chat', 'Main v8', 'main-char', 'single', 7, '2000-01-01', '2000-01-01');
                INSERT INTO messages (id, chat_id, role, content, created_at)
                VALUES ('main-message', 'main-chat', 'user', 'committed in v8', '2000-01-01');
                ",
            )
            .expect("main v8 fixture should initialize");
        drop(connection);

        let database = Database::new(path.clone()).expect("main v8 should migrate");
        let migrated = Connection::open(&path).expect("migrated connection should open");
        let epoch: i64 = migrated
            .query_row(
                "SELECT history_epoch FROM chats WHERE id = 'main-chat'",
                [],
                |row| row.get(0),
            )
            .expect("history epoch should survive");
        assert_eq!(epoch, 7);
        let passthrough: String = migrated
            .query_row(
                "SELECT card_passthrough_json FROM characters WHERE id = 'main-char'",
                [],
                |row| row.get(0),
            )
            .expect("passthrough should be added");
        assert_eq!(passthrough, "{}");
        assert!(table_exists(&migrated, "message_embedding_invalidations")
            .expect("invalidation table should resolve"));
        let version: i64 = migrated
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version should resolve");
        assert_eq!(version, 12);
        assert!(table_exists(&migrated, "memory_items").expect("memory table should resolve"));
        assert!(table_exists(&migrated, "memory_item_embeddings")
            .expect("memory embedding table should resolve"));
        assert!(table_exists(&migrated, "memory_extraction_state")
            .expect("memory cursor table should resolve"));

        let backup = database
            .last_migration_backup_path()
            .expect("pre-migration backup should exist");
        let original = open_read_only_database(backup).expect("backup should open");
        let original_version: i64 = original
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("backup version should resolve");
        assert_eq!(original_version, 8);
        assert!(
            !column_exists(&original, "characters", "card_passthrough_json")
                .expect("backup structure should resolve")
        );
    }

    #[test]
    fn migrates_clone_v9_to_v12_without_losing_card_or_invalidations() {
        let path = test_db_path("clone-v9-lineage");
        let connection = Connection::open(&path).expect("fixture connection should open");
        connection
            .execute_batch(
                "
                PRAGMA foreign_keys = ON;
                PRAGMA user_version = 9;
                CREATE TABLE characters (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    system_prompt TEXT NOT NULL DEFAULT '',
                    card_passthrough_json TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE chats (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    character_id TEXT,
                    chat_mode TEXT NOT NULL DEFAULT 'single',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE messages (
                    id TEXT PRIMARY KEY,
                    chat_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE message_embedding_invalidations (
                    message_id TEXT PRIMARY KEY,
                    invalidated_at TEXT NOT NULL,
                    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
                );
                INSERT INTO characters (id, name, description, system_prompt, card_passthrough_json, created_at, updated_at)
                VALUES ('clone-char', 'Clone Nine', '', '', '{\"future\":{\"keep\":true}}', '2000-01-01', '2000-01-01');
                INSERT INTO chats (id, title, character_id, chat_mode, created_at, updated_at)
                VALUES ('clone-chat', 'Clone v9', 'clone-char', 'single', '2000-01-01', '2000-01-01');
                INSERT INTO messages (id, chat_id, role, content, created_at)
                VALUES ('clone-message', 'clone-chat', 'user', 'edited in v9', '2000-01-01');
                INSERT INTO message_embedding_invalidations (message_id, invalidated_at)
                VALUES ('clone-message', '2000-01-02');
                ",
            )
            .expect("clone v9 fixture should initialize");
        drop(connection);

        let database = Database::new(path.clone()).expect("clone v9 should migrate");
        let migrated = Connection::open(&path).expect("migrated connection should open");
        let epoch: i64 = migrated
            .query_row(
                "SELECT history_epoch FROM chats WHERE id = 'clone-chat'",
                [],
                |row| row.get(0),
            )
            .expect("history epoch should be added");
        assert_eq!(epoch, 0);
        let passthrough: String = migrated
            .query_row(
                "SELECT card_passthrough_json FROM characters WHERE id = 'clone-char'",
                [],
                |row| row.get(0),
            )
            .expect("passthrough should survive");
        assert_eq!(passthrough, "{\"future\":{\"keep\":true}}");
        let invalidations: i64 = migrated
            .query_row(
                "SELECT COUNT(1) FROM message_embedding_invalidations WHERE message_id = 'clone-message'",
                [],
                |row| row.get(0),
            )
            .expect("invalidation should survive");
        assert_eq!(invalidations, 1);

        let backup = database
            .last_migration_backup_path()
            .expect("pre-migration backup should exist");
        let original = open_read_only_database(backup).expect("backup should open");
        let original_version: i64 = original
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("backup version should resolve");
        assert_eq!(original_version, 9);
        assert!(!column_exists(&original, "chats", "history_epoch")
            .expect("backup structure should resolve"));
    }

    #[test]
    fn rejects_future_schema_without_backup_or_mutation() {
        let path = test_db_path("future-v13");
        let connection = Connection::open(&path).expect("fixture connection should open");
        connection
            .execute_batch(
                "
                PRAGMA user_version = 13;
                CREATE TABLE sentinel (value TEXT NOT NULL);
                INSERT INTO sentinel (value) VALUES ('untouched');
                ",
            )
            .expect("future fixture should initialize");
        drop(connection);

        let error = Database::new(path.clone()).expect_err("future schema must be rejected");
        assert!(matches!(error, AppError::DatabaseCompatibility(_)));
        let connection = Connection::open(&path).expect("fixture should reopen");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version should resolve");
        let sentinel: String = connection
            .query_row("SELECT value FROM sentinel", [], |row| row.get(0))
            .expect("sentinel should survive");
        assert_eq!(version, 13);
        assert_eq!(sentinel, "untouched");
        assert!(!path
            .parent()
            .expect("fixture should have parent")
            .join("backups")
            .exists());
    }

    #[test]
    fn clear_history_removes_derived_state_and_rejects_stale_workers() {
        let path = test_db_path("clear-history-epoch");
        let database = Database::new(path).expect("database should initialize");
        let chat = database
            .create_chat("Epoch test", None)
            .expect("chat should create");

        database
            .append_message_at_epoch(&chat.id, "user", "hello", None, Some(0))
            .expect("initial message should append");
        database
            .upsert_chat_memory_at_epoch(&chat.id, Some("summary"), Some("[]"), Some(0))
            .expect("memory should persist");
        database
            .upsert_chat_relationship_state_at_epoch(
                &chat.id,
                Some("relationship"),
                Some("scene"),
                None,
                None,
                None,
                None,
                None,
                Some(0),
            )
            .expect("relationship should persist");

        let cleared = database
            .clear_chat_history_mutation(&chat.id)
            .expect("clear should succeed");
        assert_eq!(cleared.history_epoch, 1);
        assert!(cleared.messages.is_empty());
        assert!(database
            .list_messages(&chat.id)
            .expect("messages should list")
            .is_empty());
        assert!(database
            .get_chat_memory(&chat.id)
            .expect("memory should resolve")
            .summary
            .is_empty());
        assert!(database
            .get_chat_relationship_state(&chat.id)
            .expect("relationship should resolve")
            .summary
            .is_empty());

        let stale = database
            .append_message_at_epoch(&chat.id, "assistant", "late reply", None, Some(0))
            .expect_err("stale worker must be rejected");
        assert!(matches!(stale, AppError::Conflict(_)));
        database
            .append_message_at_epoch(&chat.id, "assistant", "fresh reply", None, Some(1))
            .expect("current worker should append");
    }

    #[test]
    fn edit_and_truncate_removes_descendants_and_invalidates_derived_state() {
        let path = test_db_path("edit-truncate");
        let database = Database::new(path).expect("database should initialize");
        let chat = database
            .create_chat("Timeline test", None)
            .expect("chat should create");
        let target = database
            .append_message_at_epoch(&chat.id, "user", "old question", None, Some(0))
            .expect("target should append");
        database
            .append_message_at_epoch(&chat.id, "assistant", "old answer", None, Some(0))
            .expect("answer should append");
        database
            .append_message_at_epoch(&chat.id, "user", "dependent turn", None, Some(0))
            .expect("dependent turn should append");
        database
            .upsert_chat_memory_at_epoch(&chat.id, Some("derived"), Some("[]"), Some(0))
            .expect("memory should persist");
        database
            .upsert_chat_relationship_state_at_epoch(
                &chat.id,
                Some("derived relationship"),
                None,
                None,
                None,
                None,
                None,
                None,
                Some(0),
            )
            .expect("relationship should persist");

        let mutation = database
            .edit_message_and_truncate(&target.id, "new question", 0)
            .expect("edit and truncate should succeed");
        assert_eq!(mutation.history_epoch, 1);
        assert_eq!(mutation.messages.len(), 1);
        assert_eq!(mutation.messages[0].id, target.id);
        assert_eq!(mutation.messages[0].content, "new question");
        assert!(database
            .get_chat_memory(&chat.id)
            .expect("memory should resolve")
            .summary
            .is_empty());
        assert!(database
            .get_chat_relationship_state(&chat.id)
            .expect("relationship should resolve")
            .summary
            .is_empty());

        let stale_memory = database
            .upsert_chat_memory_at_epoch(&chat.id, Some("stale"), Some("[]"), Some(0))
            .expect_err("stale memory write must be rejected");
        assert!(matches!(stale_memory, AppError::Conflict(_)));
    }

    #[test]
    fn migrates_v11_to_v12_adding_memory_tables_idempotently() {
        let path = test_db_path("v11-to-v12");
        let database = Database::new(path.clone()).expect("database should initialize");
        let chat = database
            .create_chat("Keep me", None)
            .expect("chat should create");
        drop(database);

        let connection = Connection::open(&path).expect("connection should open");
        connection
            .execute_batch(
                "
                DROP TABLE memory_extraction_state;
                DROP TABLE memory_item_embeddings;
                DROP TABLE memory_items;
                PRAGMA user_version = 11;
                ",
            )
            .expect("v11 shape should restore");
        drop(connection);

        let database = Database::new(path.clone()).expect("v11 should migrate");
        assert!(database.last_migration_backup_path().is_some());
        let migrated = Connection::open(&path).expect("migrated connection should open");
        for table in [
            "memory_items",
            "memory_item_embeddings",
            "memory_extraction_state",
        ] {
            assert!(table_exists(&migrated, table).expect("table lookup should work"));
        }
        let chats: i64 = migrated
            .query_row(
                "SELECT COUNT(1) FROM chats WHERE id = ?1",
                [&chat.id],
                |row| row.get(0),
            )
            .expect("chat count should resolve");
        assert_eq!(chats, 1);
        drop(migrated);

        // A second open is a no-op and keeps stored items.
        let item = database
            .create_memory_item(&crate::db::CreateMemoryItemInput {
                scope: "user".to_string(),
                character_id: None,
                chat_id: None,
                kind: None,
                content: "Sam likes green tea".to_string(),
                importance: None,
                pinned: None,
                source_message_id: None,
            })
            .expect("item should create");
        drop(database);
        let reopened = Database::new(path).expect("current schema should reopen");
        assert!(reopened.last_migration_backup_path().is_none());
        assert_eq!(
            reopened
                .get_memory_item(&item.id)
                .expect("item should survive")
                .content,
            "Sam likes green tea"
        );
    }

    #[test]
    fn backups_carry_memory_items_through_a_restore() {
        let path = test_db_path("restore-memory-items");
        let database = Database::new(path).expect("database should initialize");
        let kept = database
            .create_memory_item(&crate::db::CreateMemoryItemInput {
                scope: "user".to_string(),
                character_id: None,
                chat_id: None,
                kind: Some("preference".to_string()),
                content: "Sam prefers tea over coffee".to_string(),
                importance: Some(4),
                pinned: Some(true),
                source_message_id: None,
            })
            .expect("item should create");
        let backup_path = database
            .export_backup("manual")
            .expect("manual backup should export");
        let backup_name = backup_path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("backup name should be UTF-8")
            .to_string();
        database
            .delete_memory_item(&kept.id)
            .expect("item should delete");

        database
            .restore_backup(&backup_name)
            .expect("backup should restore");
        let restored = database
            .get_memory_item(&kept.id)
            .expect("item should come back");
        assert_eq!(restored.content, "Sam prefers tea over coffee");
        assert!(restored.pinned);
        assert_eq!(restored.importance, 4);
    }

    #[test]
    fn rejects_corrupt_database_file() {
        let path = test_db_path("corrupt");
        fs::write(&path, b"not-a-real-sqlite-db").expect("corrupt file should be written");
        let error = Database::new(path).expect_err("corrupt database should fail");
        let rendered = error.to_string();
        assert!(
            rendered.contains("database error") || rendered.contains("file is not a database"),
            "unexpected error: {rendered}"
        );
    }
}
