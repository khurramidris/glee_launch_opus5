import type { ReactNode } from "react";
import type { HookTimeouts, NotesBudget } from "./pipeline";
import type { Permission } from "./permissions";
import type { StorageAdapter } from "./storage";

export type ExtensionStatus = "inactive" | "active" | "disabled" | "failed" | "incompatible";
export type DisabledBy = "user" | "auto" | "dependency";

/** What Settings shows for each extension. `statusReason` is user-readable. */
export interface ExtensionInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly apiVersion: string;
  readonly permissions: readonly Permission[];
  readonly dependencies: readonly string[];
  readonly builtin: boolean;
  readonly status: ExtensionStatus;
  readonly disabledBy?: DisabledBy;
  readonly statusReason?: string;
  readonly failureCount: number;
  readonly lastError?: string;
  readonly contributionCount: number;
}

export interface CommandView {
  readonly id: string;
  readonly extensionId: string;
  readonly label: string;
  readonly hint: string;
  /** Never rejects: failures are recorded and surfaced through the host. */
  run(): Promise<void>;
}

export interface SettingsSectionView {
  readonly id: string;
  readonly extensionId: string;
  readonly title: string;
  readonly order: number;
  /** Returns null if the extension's render throws. */
  render(): ReactNode;
}

export interface ComposerToolView {
  readonly id: string;
  readonly extensionId: string;
  readonly order: number;
  render(): ReactNode;
}

export interface MessageActionView {
  readonly id: string;
  readonly extensionId: string;
  readonly label: string;
  run(): Promise<void>;
}

export interface RegistrySnapshot {
  readonly version: number;
  readonly extensions: readonly ExtensionInfo[];
  readonly commands: readonly CommandView[];
  readonly settingsSections: readonly SettingsSectionView[];
  readonly composerTools: readonly ComposerToolView[];
}

export interface HostNotice {
  kind: "info" | "error";
  message: string;
}

/** Side effects the host performs on behalf of extensions. */
export interface HostEffects {
  notify?(notice: HostNotice): void;
  copyText?(text: string): void | Promise<void>;
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  at: number;
}

export interface RegistryOptions {
  /** Contract version this host provides. */
  apiVersion?: string;
  storage?: StorageAdapter;
  host?: HostEffects;
  now?: () => number;
  hookTimeouts?: Partial<HookTimeouts>;
  notesBudget?: Partial<NotesBudget>;
  totalBlockingMs?: number;
  activationTimeoutMs?: number;
  maxFailures?: number;
  failureWindowMs?: number;
  logSink?: (extensionId: string, entry: LogEntry) => void;
}

export type RegisterResult = { ok: true } | { ok: false; reason: string };

export interface RegisterOptions {
  builtin?: boolean;
}
