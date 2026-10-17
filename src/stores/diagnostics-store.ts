import { create } from "zustand";
import type { DatabaseBackup, DiagnosticsSnapshot } from "../types";

interface DiagnosticsState {
  snapshot: DiagnosticsSnapshot | null;
  loadingDiagnostics: boolean;
  exportingDiagnostics: boolean;
  creatingDatabaseBackup: boolean;
  restoringDatabase: boolean;
  databaseBackups: DatabaseBackup[];

  setSnapshot: (snapshot: DiagnosticsSnapshot | null) => void;
  setLoadingDiagnostics: (loading: boolean) => void;
  setExportingDiagnostics: (exporting: boolean) => void;
  setCreatingDatabaseBackup: (creating: boolean) => void;
  setRestoringDatabase: (restoring: boolean) => void;
  setDatabaseBackups: (backups: DatabaseBackup[]) => void;
}

export const diagnosticsStore = create<DiagnosticsState>()((set) => ({
  snapshot: null,
  loadingDiagnostics: false,
  exportingDiagnostics: false,
  creatingDatabaseBackup: false,
  restoringDatabase: false,
  databaseBackups: [],

  setSnapshot: (snapshot) => set({ snapshot }),
  setLoadingDiagnostics: (loadingDiagnostics) => set({ loadingDiagnostics }),
  setExportingDiagnostics: (exportingDiagnostics) => set({ exportingDiagnostics }),
  setCreatingDatabaseBackup: (creatingDatabaseBackup) => set({ creatingDatabaseBackup }),
  setRestoringDatabase: (restoringDatabase) => set({ restoringDatabase }),
  setDatabaseBackups: (databaseBackups) => set({ databaseBackups }),
}));

export const useDiagnosticsStore = diagnosticsStore;
