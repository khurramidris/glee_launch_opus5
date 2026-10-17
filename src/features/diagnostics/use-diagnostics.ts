import { useCallback, useEffect } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  createDatabaseBackup,
  exportDatabaseBackup,
  exportDiagnosticsBundle,
  getDiagnosticsSnapshot,
  importDatabaseBackup,
  listDatabaseBackups,
  restoreDatabaseBackup,
} from "../../api/tauri";
import { useAppStore, useDiagnosticsStore } from "../../stores";
import { normalizeError } from "../app/app-domain";

export function useDiagnostics() {
  const { setNotice } = useAppStore();
  const {
    snapshot,
    loadingDiagnostics,
    exportingDiagnostics,
    creatingDatabaseBackup,
    restoringDatabase,
    databaseBackups,
    setSnapshot,
    setLoadingDiagnostics,
    setExportingDiagnostics,
    setCreatingDatabaseBackup,
    setRestoringDatabase,
    setDatabaseBackups,
  } = useDiagnosticsStore();

  const refreshDiagnostics = useCallback(async () => {
    setLoadingDiagnostics(true);
    try {
      const [latest, backups] = await Promise.all([
        getDiagnosticsSnapshot(),
        listDatabaseBackups(),
      ]);
      setSnapshot(latest);
      setDatabaseBackups(backups);
      return latest;
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
      throw error;
    } finally {
      setLoadingDiagnostics(false);
    }
  }, [setDatabaseBackups, setLoadingDiagnostics, setNotice, setSnapshot]);

  const exportBundle = useCallback(async () => {
    setExportingDiagnostics(true);
    try {
      const bundle = await exportDiagnosticsBundle();
      setNotice({
        kind: "info",
        message: "Support files exported successfully.",
      });
      return bundle;
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
      throw error;
    } finally {
      setExportingDiagnostics(false);
    }
  }, [setExportingDiagnostics, setNotice]);

  const backupDatabase = useCallback(async () => {
    setCreatingDatabaseBackup(true);
    try {
      const backup = await createDatabaseBackup();
      setDatabaseBackups(await listDatabaseBackups());
      setNotice({
        kind: "info",
        message: "Your data was backed up successfully.",
      });
      return backup;
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
      throw error;
    } finally {
      setCreatingDatabaseBackup(false);
    }
  }, [setCreatingDatabaseBackup, setDatabaseBackups, setNotice]);

  const restoreDatabase = useCallback(async (fileName: string) => {
    setRestoringDatabase(true);
    try {
      const restored = await restoreDatabaseBackup(fileName);
      setNotice({
        kind: "info",
        message: "Your data was restored. Glee is restarting with a safety backup available.",
      });
      return restored;
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
      throw error;
    } finally {
      setRestoringDatabase(false);
    }
  }, [setNotice, setRestoringDatabase]);

  /** Lets the user save one of Glee's backups wherever they like. */
  const saveBackupCopy = useCallback(
    async (fileName: string) => {
      try {
        const selected = await save({
          defaultPath: fileName,
          filters: [{ name: "Glee backup", extensions: ["sqlite3"] }],
        });
        if (typeof selected !== "string") {
          return;
        }
        const destination = selected.toLowerCase().endsWith(".sqlite3")
          ? selected
          : `${selected}.sqlite3`;
        await exportDatabaseBackup(fileName, destination);
        setNotice({ kind: "info", message: "Backup copy saved." });
      } catch (error) {
        setNotice({ kind: "error", message: normalizeError(error) });
      }
    },
    [setNotice],
  );

  /** Adds a backup file from another place to the list so it can be restored. */
  const addBackupFromFile = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Glee backup", extensions: ["sqlite3"] }],
      });
      if (typeof selected !== "string") {
        return;
      }
      await importDatabaseBackup(selected);
      setDatabaseBackups(await listDatabaseBackups());
      setNotice({
        kind: "info",
        message: "Backup added. Choose Restore next to it to use it.",
      });
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }, [setDatabaseBackups, setNotice]);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [latest, backups] = await Promise.all([
          getDiagnosticsSnapshot(),
          listDatabaseBackups().catch(() => []),
        ]);
        if (!cancelled) {
          setSnapshot(latest);
          setDatabaseBackups(backups);
        }
      } catch {
        // Diagnostics refresh is best-effort. Explicit actions surface errors.
      } finally {
        if (!cancelled) {
          setLoadingDiagnostics(false);
        }
      }
    }

    setLoadingDiagnostics(true);
    void load();
    const id = window.setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [setDatabaseBackups, setLoadingDiagnostics, setSnapshot]);

  return {
    diagnostics: snapshot,
    loadingDiagnostics,
    exportingDiagnostics,
    creatingDatabaseBackup,
    restoringDatabase,
    databaseBackups,
    refreshDiagnostics,
    exportBundle,
    backupDatabase,
    restoreDatabase,
    saveBackupCopy,
    addBackupFromFile,
  };
}
