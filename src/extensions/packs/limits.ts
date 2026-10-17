// Hard ceilings for pack content. A pack is untrusted text from the internet,
// so every size is bounded before anything reaches the database or the prompt.
export const PACK_SCHEMA_VERSION = 1;

export const PACK_LIMITS = {
  maxJsonChars: 1_000_000,
  maxIssues: 25,
  maxCharacters: 50,
  maxContextEntries: 500,
  maxPersonas: 50,
  maxSnippets: 100,
  maxThemeVariables: 80,
  nameChars: 100,
  packDescriptionChars: 1_000,
  shortTextChars: 1_000,
  mediumTextChars: 4_000,
  longTextChars: 8_000,
  tagCount: 25,
  tagChars: 40,
  listItemChars: 80,
  alternateGreetings: 10,
  keywordCount: 20,
  keywordChars: 60,
  contextContentChars: 4_000,
  snippetChars: 400,
  snippetLines: 4,
  themeValueChars: 300,
} as const;
