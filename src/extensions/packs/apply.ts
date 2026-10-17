import type {
  ContextPackItem,
  Pack,
  PersonaPackItem,
  CharacterPackItem,
  SnippetPackItem,
  ThemePackPayload,
} from "./types";

export interface SnippetRegistration extends SnippetPackItem {
  packName: string;
}

/**
 * Where a validated pack goes. The app binds these to its own stores and IPC;
 * the pack code never imports them, which keeps it testable and swappable.
 */
export interface PackTargets {
  createCharacter(item: CharacterPackItem): Promise<unknown>;
  createContextEntry(item: ContextPackItem): Promise<unknown>;
  createPersona(item: PersonaPackItem): Promise<unknown>;
  setTheme(theme: ThemePackPayload, packName: string): void | Promise<void>;
  registerSnippet(snippet: SnippetRegistration): void | Promise<void>;
}

export interface ApplyReport {
  applied: number;
  failed: { label: string; error: string }[];
}

async function each<T>(
  items: readonly T[],
  label: (item: T) => string,
  run: (item: T) => unknown,
): Promise<ApplyReport> {
  const report: ApplyReport = { applied: 0, failed: [] };
  // Sequential on purpose: the database serialises writes anyway and a stable
  // order keeps partial failures easy to explain.
  for (const item of items) {
    try {
      await run(item);
      report.applied += 1;
    } catch (error) {
      report.failed.push({
        label: label(item),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/** One failing item never blocks the rest; the report says what happened. */
export function applyPack(pack: Pack, targets: PackTargets): Promise<ApplyReport> {
  switch (pack.kind) {
    case "characters":
      return each(pack.characters, (c) => c.name, (c) => targets.createCharacter(c));
    case "context":
      return each(pack.entries, (e) => e.title, (e) => targets.createContextEntry(e));
    case "personas":
      return each(pack.personas, (p) => p.name, (p) => targets.createPersona(p));
    case "snippets":
      return each(pack.snippets, (s) => s.name, (s) =>
        targets.registerSnippet({ ...s, packName: pack.name }),
      );
    case "theme":
      return each([pack.theme], () => pack.name, (theme) => targets.setTheme(theme, pack.name));
  }
}
