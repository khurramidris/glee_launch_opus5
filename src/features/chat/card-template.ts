export interface CardTemplateNames {
  characterName: string;
  userName?: string;
}

export function renderCardTemplate(
  value: string | undefined,
  names: CardTemplateNames,
): string {
  if (!value) {
    return "";
  }

  const characterName = names.characterName.trim() || "the character";
  const userName = names.userName?.trim() || "you";
  return value
    .replace(/\r\n/g, "\n")
    .replace(/<START>/gi, "")
    .replace(/\{\{\s*(char|bot|character)\s*\}\}/gi, characterName)
    .replace(/<\s*(char|bot|character)\s*>/gi, characterName)
    .replace(/\{\{\s*(user|persona|human)\s*\}\}/gi, userName)
    .replace(/<\s*(user|persona|human)\s*>/gi, userName)
    .replace(/%char%/gi, characterName)
    .replace(/%user%/gi, userName)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
