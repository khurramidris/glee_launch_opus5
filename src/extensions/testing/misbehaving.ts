// Test-only: an extension that does everything an extension should not, so the
// registry's isolation can be proven rather than assumed.
import type { Extension, ExtensionContext, SendDraft } from "../types";
import type { Permission } from "../permissions";

export interface Misbehavior {
  throwOnActivate?: boolean;
  hangOnActivate?: boolean;
  throwInBeforeSend?: boolean;
  hangInBeforeSend?: boolean;
  badBeforeSendResult?: boolean;
  /** Returns this many characters of note text. */
  notesOverflowChars?: number;
  hangInNotes?: boolean;
  throwInAfterReply?: boolean;
  throwInRender?: boolean;
  throwInCommand?: boolean;
  /** Tries to register a command while declaring no ui:commands permission. */
  useUndeclaredPermission?: boolean;
  /** Keeps a context reference and calls it after deactivation. */
  leakContext?: boolean;
}

export interface MisbehavingHandle {
  extension: Extension;
  leaked(): ExtensionContext | null;
}

export function createMisbehavingExtension(
  behavior: Misbehavior,
  options: { id?: string; permissions?: Permission[]; priority?: number } = {},
): MisbehavingHandle {
  let leaked: ExtensionContext | null = null;
  const extension: Extension = {
    id: options.id ?? "test.misbehaving",
    name: "Misbehaving",
    version: "1.0.0",
    apiVersion: "1",
    permissions: options.permissions ?? [
      "chat:write",
      "chat:read",
      "prompt:notes",
      "ui:commands",
      "ui:settings",
    ],
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    async activate(ctx) {
      leaked = behavior.leakContext ? ctx : null;
      if (behavior.throwOnActivate) {
        throw new Error("activation exploded");
      }
      if (behavior.hangOnActivate) {
        await new Promise(() => undefined);
      }
      if (behavior.useUndeclaredPermission) {
        ctx.messageActions.register({ id: "sneaky", label: "x", run: () => undefined });
      }
      ctx.chatPipeline.beforeSend(() => {
        if (behavior.throwInBeforeSend) {
          throw new Error("beforeSend exploded");
        }
        if (behavior.hangInBeforeSend) {
          return new Promise(() => undefined);
        }
        if (behavior.badBeforeSendResult) {
          return { text: 42 } as unknown as SendDraft;
        }
        return undefined;
      });
      ctx.chatPipeline.transformPromptNotes(() => {
        if (behavior.hangInNotes) {
          return new Promise(() => undefined);
        }
        if (behavior.notesOverflowChars) {
          const lines = Array.from(
            { length: Math.ceil(behavior.notesOverflowChars / 40) },
            (_, index) => `overflow line ${index} ${"x".repeat(20)}`,
          );
          return { append: lines };
        }
        return undefined;
      });
      ctx.chatPipeline.afterReply(() => {
        if (behavior.throwInAfterReply) {
          throw new Error("afterReply exploded");
        }
      });
      ctx.commands.register({
        id: "boom",
        label: "Boom",
        run: () => {
          if (behavior.throwInCommand) {
            throw new Error("command exploded");
          }
        },
      });
      ctx.settingsSections.register({
        id: "panel",
        title: "Misbehaving",
        render: () => {
          if (behavior.throwInRender) {
            throw new Error("render exploded");
          }
          return null;
        },
      });
    },
  };
  return { extension, leaked: () => leaked };
}
