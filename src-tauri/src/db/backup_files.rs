//! Moving backups in and out of Glee's backup folder, so people can keep a copy
//! somewhere they choose or restore a backup made on another computer.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::errors::{AppError, AppResult};
use crate::types::DatabaseBackupRecord;

use super::{
    database_backup_record, open_read_only_database, prune_database_backups, resolve_backup_path,
    validate_restore_source, Database, MANUAL_BACKUP_RETENTION,
};

const IMPORTED_REASON: &str = "imported";

impl Database {
    /// Copies a stored backup to `destination`, which must end in `.sqlite3`.
    pub fn copy_backup_to(&self, file_name: &str, destination: &Path) -> AppResult<PathBuf> {
        let source = resolve_backup_path(&self.backup_dir(), file_name)?;
        let is_sqlite_file = destination
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("sqlite3"));
        if !is_sqlite_file {
            return Err(AppError::Validation(
                "backup copies must be saved as a .sqlite3 file".to_string(),
            ));
        }
        let parent_exists = destination
            .parent()
            .is_some_and(|parent| parent.as_os_str().is_empty() || parent.is_dir());
        if !parent_exists || destination.is_dir() {
            return Err(AppError::Validation(format!(
                "backup location is invalid: {}",
                destination.display()
            )));
        }
        std::fs::copy(&source, destination)?;
        Ok(destination.to_path_buf())
    }

    /// Adds a backup file from elsewhere to the backup list after checking that it
    /// really is a Glee database. It can then be restored like any other backup.
    pub fn import_backup_file(&self, source: &Path) -> AppResult<DatabaseBackupRecord> {
        if !source.is_file() {
            return Err(AppError::Validation(format!(
                "backup file was not found: {}",
                source.display()
            )));
        }
        {
            let connection = open_read_only_database(source).map_err(|_| {
                AppError::Validation("selected file is not a Glee backup".to_string())
            })?;
            validate_restore_source(&connection)?;
        }

        let backup_dir = self.backup_dir();
        std::fs::create_dir_all(&backup_dir)?;
        let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f");
        let target = backup_dir.join(format!(
            "glee-{IMPORTED_REASON}-{timestamp}-{}.sqlite3",
            Uuid::new_v4()
        ));
        std::fs::copy(source, &target)?;
        prune_database_backups(
            &backup_dir,
            IMPORTED_REASON,
            MANUAL_BACKUP_RETENTION,
            Some(&target),
        )?;
        database_backup_record(&target)?
            .ok_or_else(|| AppError::Path("imported backup could not be listed".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glee-{name}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn backups_can_leave_and_come_back() {
        let root = scratch("backup-files");
        let database = Database::new(root.join("glee.sqlite3")).unwrap();
        database.init().unwrap();
        let stored = database.export_backup("manual").unwrap();
        let file_name = stored.file_name().unwrap().to_str().unwrap().to_string();

        let copy = root.join("my-copy.sqlite3");
        database.copy_backup_to(&file_name, &copy).unwrap();
        assert!(copy.is_file());
        assert!(database
            .copy_backup_to(&file_name, &root.join("copy.txt"))
            .is_err());
        assert!(database
            .copy_backup_to("../glee.sqlite3", &root.join("x.sqlite3"))
            .is_err());

        let imported = database.import_backup_file(&copy).unwrap();
        assert_eq!(imported.reason, "imported");
        assert!(database
            .list_backups()
            .unwrap()
            .iter()
            .any(|backup| backup.file_name == imported.file_name));

        let not_a_backup = root.join("notes.sqlite3");
        std::fs::write(&not_a_backup, b"definitely not sqlite").unwrap();
        assert!(database.import_backup_file(&not_a_backup).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
