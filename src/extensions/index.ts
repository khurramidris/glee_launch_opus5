// Public entry point. Importing from here never pulls in React; use
// "./react" for the hooks and provider.
import { createBuiltinExtensions, createSnippetLibrary, type SnippetLibrary } from "./builtin";
import { ExtensionRegistry } from "./registry";
import type { RegistryOptions } from "./registry-types";

export { API_VERSION, cancelSend, isCancel } from "./types";
export type * from "./types";
export { PERMISSIONS, PERMISSION_INFO, PermissionDeniedError } from "./permissions";
export type { Permission, PermissionInfo, PermissionStatus } from "./permissions";
export { ExtensionRegistry } from "./registry";
export type * from "./registry-types";
export { createBrowserStorageAdapter, createMemoryStorageAdapter } from "./storage";
export type { StorageAdapter } from "./storage";
export { DEFAULT_HOOK_TIMEOUTS, DEFAULT_NOTES_BUDGET } from "./pipeline";
export type { BeforeSendOutcome, NotesOutcome } from "./pipeline";
export { createSnippetLibrary, snippetKey } from "./builtin";
export type { SnippetLibrary } from "./builtin";
export { applyPack, loadPack } from "./packs";
export type { PackTargets, Pack, LoadPackResult } from "./packs";

export interface DefaultRegistryOptions extends RegistryOptions {
  /** Bind this to the snippet-pack target so installed packs reach the prompt. */
  snippetLibrary?: SnippetLibrary;
}

/**
 * A registry with the built-in extensions registered (not yet started: call
 * `await registry.start()` once storage and the UI are ready).
 */
export function createDefaultRegistry(options: DefaultRegistryOptions = {}): ExtensionRegistry {
  const { snippetLibrary = createSnippetLibrary(), ...registryOptions } = options;
  const registry = new ExtensionRegistry(registryOptions);
  for (const extension of createBuiltinExtensions(snippetLibrary)) {
    registry.register(extension, { builtin: true });
  }
  return registry;
}
