// Permissions are the single gate between an extension and anything it can
// touch. Each one maps to concrete context functions (see context.ts), so a
// reviewer can read an extension's `permissions` array and know its reach.

export const PERMISSIONS = [
  "chat:read",
  "chat:write",
  "prompt:notes",
  "ui:commands",
  "ui:settings",
  "ui:message-actions",
  "ui:composer",
  "storage",
  "network",
  "memory:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type PermissionStatus = "granted" | "reserved" | "denied";

export interface PermissionInfo {
  permission: Permission;
  /** `reserved`: accepted but grants nothing yet. `denied`: refuses to load. */
  status: PermissionStatus;
  description: string;
}

export const PERMISSION_INFO: readonly PermissionInfo[] = [
  {
    permission: "chat:read",
    status: "granted",
    description:
      "See message text and chat details in hooks, message actions and app events.",
  },
  {
    permission: "chat:write",
    status: "granted",
    description: "Edit or cancel a message before it is sent.",
  },
  {
    permission: "prompt:notes",
    status: "granted",
    description: "Add a few short lines to the per-turn notes the model reads.",
  },
  {
    permission: "ui:commands",
    status: "granted",
    description: "Add entries to the command palette.",
  },
  {
    permission: "ui:settings",
    status: "granted",
    description: "Add a section to Settings.",
  },
  {
    permission: "ui:message-actions",
    status: "granted",
    description: "Add buttons to the message toolbar.",
  },
  {
    permission: "ui:composer",
    status: "granted",
    description: "Add small controls above the message field.",
  },
  {
    permission: "storage",
    status: "granted",
    description: "Keep a small private key-value store.",
  },
  {
    permission: "network",
    status: "denied",
    description: "Reserved. Glee is offline, so extensions cannot reach the network.",
  },
  {
    permission: "memory:read",
    status: "reserved",
    description: "Reserved for reading chat memory in a later API version.",
  },
];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

export function permissionStatus(permission: Permission): PermissionStatus {
  return PERMISSION_INFO.find((info) => info.permission === permission)?.status ?? "denied";
}

export class PermissionDeniedError extends Error {
  readonly permission: Permission;

  constructor(extensionId: string, permission: Permission, action: string) {
    super(`Extension "${extensionId}" needs the "${permission}" permission to ${action}.`);
    this.name = "PermissionDeniedError";
    this.permission = permission;
  }
}
