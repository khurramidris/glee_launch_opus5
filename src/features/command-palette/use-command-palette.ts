import { useEffect, useMemo, useRef } from "react";
import { useAppStore } from "../../stores";
import { type CommandAction, normalizeError } from "../app/app-domain";

export function useCommandPalette(commandActions: CommandAction[]) {
  const {
    commandPaletteOpen,
    commandFilter,
    setCommandPaletteOpen,
    setCommandFilter,
    setNotice,
  } = useAppStore();
  const commandInputRef = useRef<HTMLInputElement | null>(null);

  const filteredCommands = useMemo(() => {
    const query = commandFilter.trim().toLowerCase();
    if (!query) {
      return commandActions;
    }
    return commandActions.filter((action) => {
      return (
        action.label.toLowerCase().includes(query) ||
        action.hint.toLowerCase().includes(query)
      );
    });
  }, [commandActions, commandFilter]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      const isPaletteShortcut =
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      if (isPaletteShortcut) {
        event.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
      if (event.key === "Escape") {
        setCommandPaletteOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setCommandPaletteOpen]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      setCommandFilter("");
      return;
    }
    window.setTimeout(() => {
      commandInputRef.current?.focus();
    }, 0);
  }, [commandPaletteOpen, setCommandFilter]);

  async function runCommand(action: CommandAction): Promise<void> {
    setCommandPaletteOpen(false);
    try {
      await action.run();
    } catch (error) {
      setNotice({ kind: "error", message: normalizeError(error) });
    }
  }

  return {
    commandInputRef,
    filteredCommands,
    runCommand,
  };
}
