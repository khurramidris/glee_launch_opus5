import { useCallback, useEffect } from "react";
import {
  createDatabaseBackup,
  exportDiagnosticsBundle,
  getDiagnosticsSnapshot,
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
  };
}
