import type { ReactNode } from "react";
import { GleeIcon } from "../../components/glee-icon";
import type {
  DatabaseBackup,
  DiagnosticsSnapshot,
  RuntimeState,
} from "../../types";
import {
  buildRuntimeRecoveryMessage,
  formatHealthStatus,
  formatIndexingStatus,
  highestPriorityHealthCheck,
  summarizeDiagnostics,
} from "./diagnostics-domain";

interface DiagnosticsWorkspaceProps {
  diagnostics: DiagnosticsSnapshot | null;
  runtime: RuntimeState;
  activeModelName?: string;
  messageCounts?: { user: number; assistant: number };
  loadingDiagnostics: boolean;
  exportingDiagnostics: boolean;
  creatingDatabaseBackup: boolean;
  restoringDatabase: boolean;
  databaseBackups: DatabaseBackup[];
  runtimeRecoveryCard?: ReactNode;
  onRefresh: () => void | Promise<unknown>;
  onExport: () => void | Promise<unknown>;
  onBackup: () => void | Promise<unknown>;
  onRestore: (fileName: string) => void | Promise<unknown>;
  onBack?: () => void;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 || size >= 10 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function displayDate(iso: string): string {
  if (!iso) {
    return "Unknown";
  }
  return new Date(iso).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function runtimeStatusText(runtime: RuntimeState): string {
  if (runtime.status === "running") {
    return "Running";
  }
  if (runtime.status === "starting") {
    return "Starting";
  }
  if (runtime.status === "error") {
    return "Error";
  }
  return "Stopped";
}

export function DiagnosticsWorkspace({
  diagnostics,
  runtime,
  activeModelName,
  messageCounts,
  loadingDiagnostics,
  exportingDiagnostics,
  creatingDatabaseBackup,
  restoringDatabase,
  databaseBackups,
  runtimeRecoveryCard,
  onRefresh,
  onExport,
  onBackup,
  onRestore,
  onBack,
}: DiagnosticsWorkspaceProps) {
  const priorityHealthCheck = highestPriorityHealthCheck(diagnostics);

  return (
    <div className="diagnostics-workspace" aria-label="Diagnostics and recovery">
      <section className="detail-section">
        <header className="diagnostics-workspace-heading">
          <div>
            <span className="detail-kicker">Support workspace</span>
            <h4>
              <span className="glee-icon-label">
                <GleeIcon name="diagnostics" size={15} />
                <span>Diagnostics &amp; Recovery</span>
              </span>
            </h4>
          </div>
          {onBack ? (
            <button type="button" className="ghost" onClick={onBack}>
              Back
            </button>
          ) : null}
        </header>
        <div className="inspector-panel-note">
          <strong>Observational only</strong>
          <p>
            Diagnostics inspect local runtime and app health. Exported summaries redact
            local filesystem paths and exclude conversation history. Review an included
            runtime log before sharing it with anyone.
          </p>
        </div>
        <p>{summarizeDiagnostics(diagnostics)}</p>
        {messageCounts ? (
          <div className="stat-grid diagnostics-message-stats">
            <div>
              <strong>{messageCounts.user}</strong>
              <span>Your msgs</span>
            </div>
            <div>
              <strong>{messageCounts.assistant}</strong>
              <span>AI msgs</span>
            </div>
          </div>
        ) : null}
        <ul className="meta-list">
          <li><span>App version</span><strong>{diagnostics?.appVersion ?? "-"}</strong></li>
          <li><span>Platform</span><strong>{diagnostics?.platform ?? "-"}</strong></li>
          <li>
            <span>Startup health</span>
            <strong>
              {diagnostics
                ? formatHealthStatus(diagnostics.startup.overallStatus)
                : "-"}
            </strong>
          </li>
          <li>
            <span>Indexing</span>
            <strong>
              {diagnostics
                ? formatIndexingStatus(diagnostics.startup.indexing.status)
                : "-"}
            </strong>
          </li>
        </ul>
        {priorityHealthCheck ? (
          <p>
            Priority issue: <strong>{priorityHealthCheck.label}</strong> -{" "}
            {priorityHealthCheck.detail}
          </p>
        ) : null}
        <div className="preset-form-actions">
          <button
            type="button"
            className="ghost"
            disabled={loadingDiagnostics}
            onClick={() => void onRefresh()}
          >
            {loadingDiagnostics ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={exportingDiagnostics}
            onClick={() => void onExport()}
          >
            <span className="glee-icon-label">
              <GleeIcon name="export" size={15} />
              <span>{exportingDiagnostics ? "Exporting..." : "Export Bundle"}</span>
            </span>
          </button>
          <button
            type="button"
            className="ghost"
            disabled={creatingDatabaseBackup}
            onClick={() => void onBackup()}
          >
            {creatingDatabaseBackup ? "Backing up..." : "Backup DB"}
          </button>
        </div>
        <div className="database-backup-list" aria-label="Database recovery backups">
          <h5>Recovery backups</h5>
          <p className="settings-note">
            Restoring validates and upgrades the selected backup, creates a safety copy
            of current data, then restarts Glee.
          </p>
          {databaseBackups.length === 0 ? (
            <p className="empty-note">No recovery backups are available yet.</p>
          ) : (
            databaseBackups.map((backup) => (
              <div className="context-entry" key={backup.fileName}>
                <div className="context-entry-head">
                  <span>
                    <strong>
                      {backup.reason === "manual"
                        ? "Manual backup"
                        : backup.reason.replace(/-/g, " ")}
                    </strong>
                    <small>
                      {displayDate(backup.modifiedAt)} · {formatBytes(backup.sizeBytes)}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={restoringDatabase}
                    aria-label={`Restore backup from ${displayDate(backup.modifiedAt)}`}
                    onClick={() => {
                      const confirmed = window.confirm(
                        "Restore this backup? Glee will preserve your current database as a safety backup and restart.",
                      );
                      if (confirmed) {
                        void onRestore(backup.fileName);
                      }
                    }}
                  >
                    {restoringDatabase ? "Restoring..." : "Restore"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="detail-section">
        <h4>Runtime Recovery</h4>
        <p>{buildRuntimeRecoveryMessage(runtime)}</p>
        {runtimeRecoveryCard}
        <ul className="meta-list">
          <li><span>Status</span><strong>{runtimeStatusText(runtime)}</strong></li>
          <li><span>Endpoint</span><strong>{runtime.endpoint}</strong></li>
          <li><span>Runtime log</span><strong>{runtime.logFile ?? "Unavailable"}</strong></li>
          <li><span>Active model</span><strong>{activeModelName ?? "Not selected"}</strong></li>
        </ul>
      </section>

      <section className="detail-section">
        <h4>Health Checks</h4>
        <div className="context-list">
          {diagnostics ? (
            diagnostics.startup.checks.map((check) => (
              <div key={check.key} className="context-entry">
                <div className="context-entry-head">
                  <strong>{check.label}</strong>
                  <small>{formatHealthStatus(check.status)}</small>
                </div>
                <p>{check.detail}</p>
                {check.path ? <small>{check.path}</small> : null}
              </div>
            ))
          ) : (
            <p className="empty-note">Diagnostics unavailable.</p>
          )}
        </div>
      </section>

      <section className="detail-section">
        <h4>Storage</h4>
        <ul className="meta-list">
          <li><span>App data</span><strong>{diagnostics?.startup.appDataDir ?? "-"}</strong></li>
          <li><span>Database</span><strong>{diagnostics?.startup.databasePath ?? "-"}</strong></li>
          <li><span>Backup dir</span><strong>{diagnostics?.startup.backupDir ?? "-"}</strong></li>
          <li>
            <span>Last migration backup</span>
            <strong>{diagnostics?.startup.lastMigrationBackupPath ?? "None"}</strong>
          </li>
        </ul>
      </section>

      <section className="detail-section">
        <h4>Feature Exposure</h4>
        <div className="trait-wrap">
          {(diagnostics?.featureExposure.stable ?? []).map((feature) => (
            <span key={`stable-${feature}`} className="trait-chip">{feature}</span>
          ))}
          {(diagnostics?.featureExposure.labs ?? []).map((feature) => (
            <span key={`labs-${feature}`} className="trait-chip memory-chip">{feature}</span>
          ))}
        </div>
      </section>
    </div>
  );
}
