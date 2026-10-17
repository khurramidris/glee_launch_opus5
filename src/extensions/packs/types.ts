import type { CreateCharacterPayload, PersonaDraft } from "../../types";

export type PackKind = "characters" | "context" | "personas" | "snippets" | "theme";

export interface PackMeta {
  schemaVersion: 1;
  name: string;
  description?: string;
  author?: string;
  version?: string;
}

/** Characters carry no avatar or card extensions: packs are text only. */
export type CharacterPackItem = Omit<CreateCharacterPayload, "avatar" | "cardExtensions">;

export interface ContextPackItem {
  scope: "global" | "character";
  /** Required for character scope; the app resolves it to a character id. */
  characterName?: string;
  title: string;
  keywords: string[];
  content: string;
  enabled: boolean;
}

export type PersonaPackItem = PersonaDraft;

export interface SnippetPackItem {
  id: string;
  name: string;
  text: string;
  enabledByDefault: boolean;
}

export interface ThemePackPayload {
  base?: string;
  colorScheme?: "light" | "dark";
  variables: Record<string, string>;
}

export type CharacterPack = PackMeta & { kind: "characters"; characters: CharacterPackItem[] };
export type ContextPack = PackMeta & { kind: "context"; entries: ContextPackItem[] };
export type PersonaPack = PackMeta & { kind: "personas"; personas: PersonaPackItem[] };
export type SnippetPack = PackMeta & { kind: "snippets"; snippets: SnippetPackItem[] };
export type ThemePack = PackMeta & { kind: "theme"; theme: ThemePackPayload };

export type Pack = CharacterPack | ContextPack | PersonaPack | SnippetPack | ThemePack;

export type LoadPackResult =
  | { ok: true; pack: Pack }
  | { ok: false; errors: { path: string; message: string }[] };
