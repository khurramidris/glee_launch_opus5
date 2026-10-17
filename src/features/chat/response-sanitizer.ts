const USER_SPEAKER_PREFIXES = new Set(["user", "human", "you", "me"]);
const ASSISTANT_SPEAKER_PREFIXES = new Set([
  "assistant",
  "character",
  "ai",
  "bot",
]);
const SPEAKER_PREFACE_VERBS =
  "(?:repl(?:y|ies|ied)|responds?|responded|says?|said|asks?|asked|whispers?|whispered|mutters?|muttered|murmurs?|murmured|shouts?|shouted|exclaims?|exclaimed|continues?|continued)";

export interface AssistantSanitizeOptions {
  speakerName?: string;
  userName?: string;
}

function replacementName(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function normalizeTemplatePlaceholders(
  text: string,
  options?: AssistantSanitizeOptions,
): string {
  const userName = replacementName(options?.userName, "you");
  const speakerName = replacementName(options?.speakerName, "the character");

  return text
    .replace(/\{\{\s*(?:user|name)\s*\}\}/gi, userName)
    .replace(/\{\{\s*(?:char|character|speaker|assistant|bot|persona)\s*\}\}/gi, speakerName)
    .replace(/\{\s*(?:user|user[_ -]?name|your[_ -]?name|name)\s*\}/gi, userName)
    .replace(/\{\s*(?:char|char[_ -]?name|character|character[_ -]?name|speaker|speaker[_ -]?name|assistant|assistant[_ -]?name|bot|bot[_ -]?name|persona)\s*\}/gi, speakerName)
    .replace(/<\s*(?:user|name)\s*>/gi, userName)
    .replace(/<\s*(?:char|character|speaker|assistant|bot|persona)\s*>/gi, speakerName)
    .replace(/%\s*(?:user|name)\s*%/gi, userName)
    .replace(/%\s*(?:char|character|speaker|assistant|bot|persona)\s*%/gi, speakerName)
    .replace(/\[\s*(?:user|name)\s*\]/gi, userName)
    .replace(/\[\s*(?:char|character|speaker|assistant|bot|persona)\s*\]/gi, speakerName);
}

function normalizeSpeakerToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/[{}<>[\]()"']/g, "")
    .replace(/\s+/g, " ");
}

function classifySpeakerPrefix(
  prefix: string,
  options?: AssistantSanitizeOptions,
): "assistant" | "user" | null {
  const normalizedPrefix = normalizeSpeakerToken(prefix);
  if (!normalizedPrefix) {
    return null;
  }
  if (USER_SPEAKER_PREFIXES.has(normalizedPrefix)) {
    return "user";
  }
  if (ASSISTANT_SPEAKER_PREFIXES.has(normalizedPrefix)) {
    return "assistant";
  }
  if (
    options?.userName &&
    normalizedPrefix === normalizeSpeakerToken(options.userName)
  ) {
    return "user";
  }
  if (
    options?.speakerName &&
    normalizedPrefix === normalizeSpeakerToken(options.speakerName)
  ) {
    return "assistant";
  }
  return null;
}

function stripTaggedBlocks(text: string, tagNames: string[]): string {
  let next = text;
  for (const tagName of tagNames) {
    const paired = new RegExp(
      `<\\s*${tagName}\\b[^>]*>[\\s\\S]*?(?:<\\s*\\/\\s*${tagName}\\s*>|$)`,
      "gi",
    );
    const orphan = new RegExp(`<\\s*\\/?\\s*${tagName}\\b[^>]*>`, "gi");
    next = next.replace(paired, "");
    next = next.replace(orphan, "");
  }
  return next;
}

function unwrapTaggedBlock(text: string, tagName: string): string {
  const match = text.match(
    new RegExp(
      `<\\s*${tagName}\\b[^>]*>([\\s\\S]*?)(?:<\\s*\\/\\s*${tagName}\\s*>|$)`,
      "i",
    ),
  );
  if (match?.[1]) {
    return match[1];
  }
  return text.replace(new RegExp(`<\\s*\\/?\\s*${tagName}\\b[^>]*>`, "gi"), "");
}

function extractExplicitResponseBody(text: string): string {
  const match = text.match(
    /<\s*response\b[^>]*>([\s\S]*?)(?:<\s*\/\s*response\s*>|$)/i,
  );
  return match?.[1] ?? text;
}

function isMetaReasoningLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized.startsWith("as an ai assistant") ||
    normalized.startsWith("as an assistant") ||
    normalized.startsWith("assistant is asking") ||
    normalized.startsWith("system is asking") ||
    normalized.startsWith("assistant must engage in a roleplay conversation") ||
    normalized.startsWith("you must engage in a roleplay conversation") ||
    normalized.startsWith("core contract:") ||
    normalized.startsWith("core contract") ||
    /^(?:analysis|reasoning|thought|thinking|system|developer|prompt|instructions?|response contract|turn frame|latest user move|current live scene)\s*:/.test(
      normalized,
    ) ||
    normalized.startsWith("scenario:") ||
    normalized.startsWith("characters:") ||
    normalized.startsWith("setting:") ||
    normalized.includes("{{user}}") ||
    normalized.includes("{{char}}") ||
    normalized.includes("roleplay conversation with the user below this line") ||
    normalized.includes("write only the character's next reply") ||
    normalized.includes("write only the character s next reply") ||
    normalized.includes("write one short in-character reply in plain text") ||
    normalized.includes("write one short in character reply in plain text") ||
    normalized.includes("prompt metadata") ||
    normalized.includes("transcript scaffolding") ||
    normalized.startsWith("i need to understand") ||
    normalized.startsWith("let me consider") ||
    normalized.startsWith("let me think")
  ) {
    return true;
  }
  if (
    /^(based on|given|considering|let me|i need to|i should|the user is asking|the character would|as the character|to respond)/.test(
      normalized,
    ) &&
    /(persona|scenario|character|respond|reply|user|request)/.test(normalized)
  ) {
    return true;
  }
  if (
    /^(analysis|reasoning|thought|thinking)\s*:/i.test(line) ||
    normalized.includes("internal monologue") ||
    /\b(?:system prompt|developer message|chain-of-thought|chain of thought|hidden reasoning|internal reasoning|instructions say|prompt says)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function stripPartialTagFragments(text: string): string {
  return text
    .replace(/<\s*(thinking|think|response)\b[^>\n]*$/gi, "")
    .replace(/<\/\s*(thinking|think|response)?[^>\n]*$/gi, "");
}

function containsThirdPersonSelfNarrationFragment(
  fragment: string,
  speakerName?: string,
): boolean {
  const safeName = speakerName?.trim();
  if (!safeName) {
    return false;
  }
  const escapedName = safeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`\\b${escapedName}'s\\b`, "i").test(fragment) ||
    new RegExp(
      `\\b${escapedName}\\b\\s+(is|looks|looked|glances|glanced|raises|raised|moves|moved|nods|nodded|smiles|smiled|laughs|laughed|stammers|stammered|says|said|asks|asked|holds|held|twirls|twirled|steps|stepped|backs|backed|appears|appeared|feels|felt)\\b`,
      "i",
    ).test(fragment)
  );
}

function buildStopSequenceNameCandidates(userName?: string): string[] {
  const trimmed = userName?.trim();
  if (!trimmed) {
    return [];
  }
  return [...new Set([trimmed])];
}

function isUnsafeAssistantFragment(fragment: string): boolean {
  const normalized = fragment.trim().toLowerCase();
  return (
    normalized.startsWith("as an ai assistant") ||
    normalized.startsWith("as an assistant") ||
    normalized.startsWith("assistant is asking") ||
    normalized.startsWith("system is asking") ||
    normalized.startsWith("assistant is") ||
    normalized.startsWith("assistant must engage in a roleplay conversation") ||
    normalized.startsWith("you must engage in a roleplay conversation") ||
    normalized.startsWith("core contract:") ||
    normalized.startsWith("core contract") ||
    /^(?:analysis|reasoning|thought|thinking|system|developer|prompt|instructions?|response contract|turn frame|latest user move|current live scene)\s*:/.test(
      normalized,
    ) ||
    normalized.startsWith("scenario:") ||
    normalized.startsWith("characters:") ||
    normalized.startsWith("setting:") ||
    normalized.includes("{{user}}") ||
    normalized.includes("{{char}}") ||
    normalized.includes("roleplay conversation with the user below this line") ||
    normalized.includes("write only the character's next reply") ||
    normalized.includes("write only the character s next reply") ||
    normalized.includes("write one short in-character reply in plain text") ||
    normalized.includes("write one short in character reply in plain text") ||
    normalized.includes("prompt metadata") ||
    normalized.includes("transcript scaffolding") ||
    normalized.startsWith("i need to understand") ||
    normalized.startsWith("let me consider") ||
    normalized.startsWith("based on the persona") ||
    normalized.startsWith("based on the scenario") ||
    normalized.startsWith("the character would respond") ||
    normalized.startsWith("to respond")
  );
}

function filterUnsafeAssistantFragments(
  text: string,
  speakerName?: string,
): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => {
      if (/\[\s*(dialogue|action|narration)\s*\]/i.test(paragraph)) {
        return paragraph.trim();
      }
      const fragments =
        paragraph.match(/[^.!?\n]+(?:[.!?]+|$)/g)?.map((part) => part.trim()) ?? [];
      if (fragments.length === 0) {
        return "";
      }
      const kept = fragments.filter(
        (fragment) =>
          fragment &&
          !isUnsafeAssistantFragment(fragment) &&
          (/\[\s*(dialogue|action|narration)\s*\]/i.test(fragment) ||
            /^\s*["“][^"”\n]+["”]\s+/.test(fragment) ||
            !containsThirdPersonSelfNarrationFragment(fragment, speakerName)),
      );
      return kept.join(" ").trim();
    })
    .filter(Boolean);

  return paragraphs.join("\n\n").trim();
}

function isPromptEchoLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return (
    normalized.startsWith("assistant must engage in a roleplay conversation") ||
    normalized.startsWith("you must engage in a roleplay conversation") ||
    normalized.startsWith("system is asking") ||
    normalized.startsWith("core contract:") ||
    normalized.startsWith("core contract") ||
    /^(?:analysis|reasoning|thought|thinking|system|developer|prompt|instructions?|response contract|turn frame|latest user move|current live scene)\s*:/.test(
      normalized,
    ) ||
    normalized.startsWith("scenario:") ||
    normalized.startsWith("characters:") ||
    normalized.startsWith("setting:") ||
    normalized.includes("write only the character's next reply") ||
    normalized.includes("write only the character s next reply") ||
    normalized.includes("write one short in-character reply in plain text") ||
    normalized.includes("write one short in character reply in plain text") ||
    normalized.includes("prompt metadata") ||
    normalized.includes("transcript scaffolding")
  );
}

function stripLeadingSpeakerNameFromNarration(
  text: string,
  speakerName?: string,
): string {
  const safeName = speakerName?.trim();
  if (!safeName) {
    return text.trim();
  }
  const escapedName = safeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .trim()
    .replace(new RegExp(`^${escapedName}\\b\\s*`, "i"), "")
    .replace(new RegExp(`^${escapedName}'s\\b\\s*`, "i"), "")
    .trim();
}

function isCardRosterLine(line: string): boolean {
  return /^\s*[a-z0-9][^:\n]{0,80}\s+-\s+/i.test(line.trim());
}

function isPromptIdentityLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return (
    /^you are [a-z0-9 _'-]{1,60}\.?$/i.test(normalized) ||
    /^stay fully in character as [a-z0-9 _'-]{1,60}\.?$/i.test(normalized)
  );
}

const INTERNAL_SCAFFOLD_LABEL_PATTERN =
  /^\s*(?:previous|prior|earlier|last)\s+(?:group\s+)?(?:assistant\s+)?reply\s+from\s+[^:\n]{1,80}\s*:\s*/i;

function isInternalScaffoldLabelLine(line: string): boolean {
  return INTERNAL_SCAFFOLD_LABEL_PATTERN.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripInternalScaffoldLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isInternalScaffoldLabelLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unwrapInternalScaffoldHistoryLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(INTERNAL_SCAFFOLD_LABEL_PATTERN, "").trimEnd())
    .filter((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripPromptEchoLines(text: string): string {
  const lines = text.split("\n");
  const sawPromptEcho = lines.some((line) => isPromptEchoLine(line));
  const filtered = lines.filter((line) => {
    if (isPromptEchoLine(line)) {
      return false;
    }
    if (sawPromptEcho && isCardRosterLine(line)) {
      return false;
    }
    if (sawPromptEcho && isPromptIdentityLine(line)) {
      return false;
    }
    return true;
  });
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripAssistantSpeakerPreface(
  text: string,
  options?: AssistantSanitizeOptions,
): string {
  const labels = [
    options?.speakerName,
    ...ASSISTANT_SPEAKER_PREFIXES,
  ]
    .map((label) => label?.trim())
    .filter((label): label is string => Boolean(label));
  if (labels.length === 0) {
    return text.trim();
  }
  const labelPattern = [...new Set(labels)]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  return text
    .replace(
      new RegExp(
        `^\\s*(?:["“']\\s*)?(?:${labelPattern})\\s+${SPEAKER_PREFACE_VERBS}\\b[^:\\n]{0,120}:\\s*`,
        "i",
      ),
      "",
    )
    .trim();
}

function normalizeRoleplaySentenceSpacing(text: string): string {
  return text
    .replace(/([.!?])(?=(?:She|He|They|Her|His|Their|I|We|You|The|A|An)\b)/g, "$1 ");
}

function normalizeReplySpacing(text: string): string {
  return normalizeRoleplaySentenceSpacing(text)
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/\s+(["”])(?=\s|$|[,.!?;:])/g, "$1")
    .replace(/(^|[\s([{])(["“])\s+/gm, "$1$2")
    .replace(/(["”])(?=(?:I|[A-Z][a-z]+)\s+(?:say|says|said|ask|asks|asked)\b)/g, "$1 ")
    .replace(/(["”])\*(?=\S)/g, "$1 *")
    .replace(/\*(["“])/g, "* $1")
    .replace(/\*\s+\*/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function stripStarsInsideQuotedDialogue(text: string): string {
  let next = text;
  let previous = "";
  while (next !== previous) {
    previous = next;
    next = next.replace(
      /(["“][^"”\n]*?)\*([^*"”\n]+)\*([^"”\n]*["”])/g,
      (_match, before: string, inner: string, after: string) =>
        `${before}${inner.trim()}${after}`,
    );
  }
  return next;
}

function stripOuterDialogueQuotes(text: string): string {
  const trimmed = text.trim();
  const match = /^(["“])([\s\S]*?)(["”])$/.exec(trimmed);
  if (!match) {
    return trimmed;
  }
  return match[2].trim();
}

function normalizeExplicitSegmentMarkers(
  text: string,
  speakerName?: string,
): string {
  const markerPattern = /\[\s*(dialogue|action|narration)\s*\]/gi;
  const matches = [...text.matchAll(markerPattern)];
  if (matches.length === 0) {
    return text;
  }

  const parts: string[] = [];
  const leading = text.slice(0, matches[0].index).trim();
  if (leading) {
    parts.push(leading);
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const marker = match[1].toLowerCase();
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd =
      index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length;
    const rawContent = text.slice(contentStart, contentEnd).trim();
    if (!rawContent) {
      continue;
    }

    const unstarred = rawContent.replace(/^\*+\s*|\s*\*+$/g, "").trim();
    if (!unstarred) {
      continue;
    }

    if (marker === "dialogue") {
      parts.push(stripOuterDialogueQuotes(stripStarsInsideQuotedDialogue(unstarred)));
      continue;
    }

    const narration = stripLeadingSpeakerNameFromNarration(
      stripOuterDialogueQuotes(unstarred),
      speakerName,
    );
    if (narration) {
      parts.push(narration);
    }
  }

  return parts.join(" ").replace(/\s+\n/g, "\n").replace(/\n\s+/g, "\n").trim();
}

function looksLikeDialogueFragment(text: string): boolean {
  const normalized = text.trim().replace(/^[*"“”"'`\s]+|[*"“”"'`\s]+$/g, "");
  if (!normalized) {
    return false;
  }
  if (/^[A-Z][a-z]+:$/.test(normalized)) {
    return false;
  }
  if (/^["“]/.test(normalized)) {
    return true;
  }
  if (/[!?]/.test(normalized)) {
    return true;
  }
  if (
    /\b(please|oh|ah|hey|hello|well|wait|look|what|why|how|can|could|would|should)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return /^(i(?:'m|m|\s+am)?|we(?:'re|\s+are)?|you(?:'re|\s+are)?)\b\s+(?:can|cannot|can't|could|would|should|will|won't|need|want|think|know|guess|hope|wish|mean|have|haven't|had|do|don't|dont|did|didn't|feel|see|hear|remember|promise|swear|appreciate|understand|agree|disagree|love|hate|prefer|apologize|apologise|assure|let|tell|please)\b/i.test(
    normalized,
  );
}

function looksLikeNarrationFragment(
  text: string,
  speakerName?: string,
): boolean {
  const normalized = text.trim().replace(/^[*"“”"'`\s]+|[*"“”"'`\s]+$/g, "");
  if (!normalized) {
    return false;
  }
  if (containsThirdPersonSelfNarrationFragment(normalized, speakerName)) {
    return true;
  }
  return (
    /\b(she|he|they)\b(?:\s+\w+ly)?\s+(is|was|looks|looked|glances|glanced|turns|turned|moves|moved|shifts|shifted|settles|settled|pauses|paused|hesitates|hesitated|steps|stepped|raises|raised|holds|held|smiles|smiled|laughs|laughed|asks|asked|says|said|stares|stared|walks|walked|approaches|approached|backs|backed|feels|felt|leans|leaned|widens|widened|spots|spotted|stretches|stretched|giggles|giggled|gets|got)\b/i.test(
      normalized,
    ) ||
    /\b(she|he|they)\b(?:\s+\w+ly)?\s+(takes|took|reaches|reached|fidgets|fidgeted|adjusts|adjusted|clutches|clutched)\b/i.test(
      normalized,
    ) ||
    /\b(his|her|their)\b\s+(voice|eyes|expression|arm|arms|hair|hand|hands|breath|heart|perfume|stance|posture|movement|movements|face|body|breasts?)\b/i.test(
      normalized,
    ) ||
    /\b(my|our)\b\s+(voice|eyes|expression|arm|arms|hair|hand|hands|breath|heart|stance|face|body|breasts?|fingers|jaw|shoulders|stomach)\b/i.test(
      normalized,
    )
  );
}

function wrapLeadingNarrationBeforeDialogue(
  paragraph: string,
  speakerName?: string,
): string {
  const trimmed = paragraph.trim();
  if (!trimmed || trimmed.startsWith("*")) {
    return trimmed;
  }

  const dialogueMatch = trimmed.match(
    /\s(?=(?:"|“|Oh\b|Ah\b|Hey\b|Hello\b|Well\b|Please\b|Wait\b|Look\b|Can\b|Could\b|Would\b|I\b|We\b|What\b|Why\b|How\b))/i,
  );
  if (!dialogueMatch?.index) {
    return trimmed;
  }

  const narration = trimmed.slice(0, dialogueMatch.index).trim().replace(/\*+$/g, "").trim();
  const dialogue = trimmed.slice(dialogueMatch.index).trim().replace(/^\*+\s*/g, "");
  if (
    !narration ||
    !dialogue ||
    !looksLikeNarrationFragment(narration, speakerName) ||
    !looksLikeDialogueFragment(dialogue)
  ) {
    return trimmed;
  }

  return `${narration} ${dialogue}`.trim();
}

function normalizePlainRoleplaySegment(
  segment: string,
  speakerName?: string,
): string {
  const sentences =
    segment.match(/[^.!?\n]+(?:[.!?]+(?:["”']*)?|$)/g)?.map((part) => part.trim()) ??
    [segment.trim()];
  const normalized = sentences
    .filter(Boolean)
    .map((sentence) => {
      const bareSentence = sentence.replace(/^\*+\s*|\s*\*+$/g, "").trim();
      if (!bareSentence) {
        return "";
      }
      const startsLikeDialogue = /^(?:"|“|Oh\b|Ah\b|Hey\b|Hello\b|Well\b|Please\b|Wait\b|Look\b|Can\b|Could\b|Would\b|I\b|We\b|What\b|Why\b|How\b)/i.test(
        bareSentence,
      );
      if (
        looksLikeNarrationFragment(bareSentence, speakerName) &&
        (!looksLikeDialogueFragment(bareSentence) || !startsLikeDialogue)
      ) {
        return bareSentence;
      }
      return bareSentence;
    })
    .filter(Boolean);

  return normalized.join(" ").trim();
}

function normalizeDialogueTerminalForAttribution(dialogue: string): string {
  const cleaned = stripOuterDialogueQuotes(stripStarsInsideQuotedDialogue(dialogue)).trim();
  if (!cleaned) {
    return "";
  }
  if (/,\s*$/.test(cleaned)) {
    return cleaned.replace(/,\s*$/, ".");
  }
  return cleaned;
}

function stripSafeAttributionTail(tail: string): string {
  return tail
    .trim()
    .replace(/^[,;:]\s*/, "")
    .replace(/^(?:and|as|while)\s+/i, "")
    .trim();
}

function looksLikeSafeAttributionTail(tail: string): boolean {
  const normalized = tail.trim();
  if (!normalized) {
    return false;
  }
  return (
    /^\w+ing\b/i.test(normalized) ||
    /^(?:with|while|as)\b/i.test(normalized) ||
    /^(?:softly|quietly|gently|nervously|hesitantly|warmly|coldly|carefully)\b/i.test(
      normalized,
    ) ||
    /^(?:his|her|their|my|our)\s+(?:voice|eyes|expression|face|hands?|smile)\b/i.test(
      normalized,
    )
  );
}

function normalizeSafeQuotedAttributionParagraph(
  paragraph: string,
  speakerName?: string,
): string {
  const trimmed = paragraph.trim();
  const match = /^(["“][^"”\n]+["”])\s+([^"”\n]+)$/.exec(trimmed);
  if (!match) {
    return paragraph;
  }

  const dialogue = normalizeDialogueTerminalForAttribution(match[1]);
  if (!dialogue || looksLikeNarrationFragment(dialogue, speakerName)) {
    return paragraph;
  }

  const attribution = match[2].trim();
  const verbs =
    "(?:says|said|asks|asked|replies|replied|whispers|whispered|mutters|muttered|murmurs|murmured|calls|called)";
  const attributionMatch =
    speakerName?.trim()
      ? new RegExp(
          `^${speakerName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+${verbs}\\b([\\s\\S]*)$`,
          "i",
        ).exec(attribution)
      : null;

  if (!attributionMatch) {
    return paragraph;
  }

  const tail = stripSafeAttributionTail(attributionMatch[1] ?? "");
  if (!tail) {
    return dialogue;
  }
  if (!looksLikeSafeAttributionTail(tail)) {
    return paragraph;
  }
  return `${dialogue} ${tail}`.trim();
}

function normalizeSafeQuotedAttributions(
  text: string,
  speakerName?: string,
): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) =>
      normalizeSafeQuotedAttributionParagraph(paragraph, speakerName),
    )
    .join("\n\n");
}

function normalizeQuotedDialogueNarrationSandwich(
  paragraph: string,
  speakerName?: string,
): string {
  let withoutInlineStars = normalizeSafeQuotedAttributionParagraph(
    stripStarsInsideQuotedDialogue(paragraph),
    speakerName,
  );

  if (speakerName?.trim()) {
    const escapedSpeakerName = speakerName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    withoutInlineStars = withoutInlineStars.replace(
      new RegExp(
        `((?:["“][^"”\\n]+["”]))\\s+${escapedSpeakerName}\\s+([^"\\n]+?)(?=\\s+(?:["“])|$)`,
        "gi",
      ),
      (_match, dialogue: string, narration: string) => {
        const cleanedNarration = stripLeadingSpeakerNameFromNarration(
          narration,
          speakerName,
        );
        if (
          cleanedNarration &&
          looksLikeNarrationFragment(cleanedNarration, speakerName) &&
          !looksLikeDialogueFragment(cleanedNarration)
        ) {
          return `${dialogue} ${cleanedNarration}`.trim();
        }
        return `${dialogue} ${cleanedNarration}`.trim();
      },
    );
  }

  return withoutInlineStars.replace(
    /((?:["“][^"”\n]+["”]))\s+([^"\n]+?)(?=\s+(?:["“])|$)/g,
    (_match, dialogue: string, narration: string) => {
      const trimmedNarration = narration.trim().replace(/^\*+\s*|\s*\*+$/g, "");
      if (!trimmedNarration) {
        return dialogue;
      }
      if (
        looksLikeNarrationFragment(trimmedNarration, speakerName) &&
        !looksLikeDialogueFragment(trimmedNarration)
      ) {
        return `${dialogue} ${trimmedNarration}`.trim();
      }
      return `${dialogue} ${trimmedNarration}`;
    },
  );
}

function normalizeExplicitRoleplayFormatting(
  text: string,
  speakerName?: string,
): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const normalizedParagraph = normalizeQuotedDialogueNarrationSandwich(
        paragraph,
        speakerName,
      );
      const segments = normalizedParagraph.match(/\*[^*]+\*|[^*]+/g) ?? [
        normalizedParagraph,
      ];
      return segments
        .map((segment) => {
          const trimmed = segment.trim();
          if (!trimmed) {
            return "";
          }
          if (trimmed.startsWith("*") && trimmed.endsWith("*")) {
            const inner = trimmed.slice(1, -1).trim();
            if (!inner) {
              return "";
            }
            if (
              looksLikeDialogueFragment(inner) &&
              looksLikeNarrationFragment(inner, speakerName)
            ) {
              return normalizePlainRoleplaySegment(inner, speakerName);
            }
            if (
              looksLikeDialogueFragment(inner) &&
              !looksLikeNarrationFragment(inner, speakerName)
            ) {
              return inner;
            }
            return inner;
          }
          return normalizePlainRoleplaySegment(trimmed, speakerName);
        })
        .filter(Boolean)
        .join(" ")
        .trim();
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeMalformedRoleplayParagraph(
  paragraph: string,
  speakerName?: string,
): string {
  let next = paragraph.trim();
  if (!next) {
    return "";
  }

  const firstStar = next.indexOf("*");
  if (firstStar > 0) {
    const before = next.slice(0, firstStar).trim();
    const after = next.slice(firstStar + 1).trimStart();
    if (looksLikeNarrationFragment(before, speakerName) && after) {
      next = `${before.replace(/\*+$/g, "").trim()} ${after}`;
    }
  }

  const strippedLeadingStars = next.replace(/^\*+\s*/g, "").trim();
  if (
    next.startsWith("*") &&
    !/^\*[^*]+\*/.test(next) &&
    strippedLeadingStars &&
    looksLikeDialogueFragment(strippedLeadingStars) &&
    !looksLikeNarrationFragment(strippedLeadingStars, speakerName)
  ) {
    next = strippedLeadingStars;
  }

  const bareLeadingNarration = stripLeadingSpeakerNameFromNarration(next, speakerName);
  if (
    bareLeadingNarration &&
    bareLeadingNarration !== next &&
    looksLikeNarrationFragment(bareLeadingNarration, speakerName) &&
    !looksLikeDialogueFragment(bareLeadingNarration)
  ) {
    next = bareLeadingNarration;
  }

  next = next.replace(/\*\s*([^*]+?)\s*\*/g, (_match, inner: string) => {
    const trimmed = stripLeadingSpeakerNameFromNarration(inner.trim(), speakerName);
    if (
      looksLikeDialogueFragment(trimmed) &&
      !looksLikeNarrationFragment(trimmed, speakerName)
    ) {
      return trimmed;
    }
    return trimmed;
  });

  next = wrapLeadingNarrationBeforeDialogue(next, speakerName);

  const bareParagraph = next.trim();
  const normalizedBareParagraph = bareParagraph
    .replace(/^\*+\s*/g, "")
    .replace(/\s*\*+$/g, "")
    .trim();
  if (
    normalizedBareParagraph &&
    !bareParagraph.startsWith("*") &&
    looksLikeNarrationFragment(normalizedBareParagraph, speakerName) &&
    !looksLikeDialogueFragment(normalizedBareParagraph)
  ) {
    next = normalizedBareParagraph;
  }

  next = next
    .replace(/(^|\n)\s*\*(?=\s*(?:\n|$))/g, "$1")
    .replace(/\s+\*(?=\s*(?:\n|$))/g, "")
    .replace(/\*\s*\*/g, "")
    .trim();

  return normalizeExplicitRoleplayFormatting(next, speakerName);
}

function normalizeMalformedRoleplayFormatting(
  text: string,
  speakerName?: string,
): string {
  const bridged = normalizeRoleplaySentenceSpacing(text).replace(
    /(^|\n\n)([^*\n][^\n]*?)\s+\*(?=\n\n(?:Oh|Ah|Hey|Hello|Well|Please|Wait|Look|Can|Could|Would|I|We|What|Why|How)\b)/gim,
    (_match, prefix: string, narration: string) => {
      const trimmedNarration = narration.trim();
      if (!looksLikeNarrationFragment(trimmedNarration, speakerName)) {
        return `${prefix}${narration}`;
      }
      return `${prefix}${trimmedNarration}`;
    },
  );

  return bridged
    .split(/\n{2,}/)
    .map((paragraph) => normalizeMalformedRoleplayParagraph(paragraph, speakerName))
    .filter(Boolean)
    .join("\n\n")
    .replace(/(["”])(?=(?:I|[A-Z][a-z]+)\s+(?:say|says|said|ask|asks|asked)\b)/g, "$1 ")
    .trim();
}

function containsRawMetaDraft(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    isInternalScaffoldLabelLine(text.split("\n", 1)[0] ?? "") ||
    normalized.includes("assistant must engage in a roleplay conversation") ||
    normalized.includes("you must engage in a roleplay conversation") ||
    normalized.includes("system is asking") ||
    normalized.includes("core contract") ||
    normalized.includes("characters:") ||
    normalized.includes("scenario:") ||
    normalized.includes("setting:") ||
    /(?:^|\n)\s*(?:analysis|reasoning|thought|thinking|system|developer|prompt|instructions?|response contract|turn frame|latest user move|current live scene)\s*:/i.test(
      text,
    ) ||
    normalized.includes("{{user}}") ||
    normalized.includes("{{char}}") ||
    normalized.includes("roleplay conversation with the user below this line") ||
    normalized.includes("write only the character's next reply") ||
    normalized.includes("write only the character s next reply") ||
    normalized.includes("write one short in-character reply in plain text") ||
    normalized.includes("write one short in character reply in plain text") ||
    normalized.includes("prompt metadata") ||
    normalized.includes("transcript scaffolding") ||
    normalized.includes("as an ai language model") ||
    normalized.includes("i don't have personal experiences") ||
    normalized.includes("i do not have personal experiences") ||
    normalized.includes("based on the character description provided") ||
    normalized.includes("based on the persona and scenario described") ||
    normalized.includes("considering the character and scenario described") ||
    normalized.includes("here's how '") ||
    normalized.includes("here is how '") ||
    normalized.includes("might respond to this specific request") ||
    normalized.includes("let me consider how this character") ||
    (normalized.includes("i need to understand what") && normalized.includes("character")) ||
    /\b(?:system prompt|developer message|chain-of-thought|chain of thought|hidden reasoning|internal reasoning|instructions say|prompt says)\b/.test(
      normalized,
    )
  );
}

function looksLikeDanglingSpeakerStub(
  text: string,
  options?: AssistantSanitizeOptions,
): boolean {
  const normalized = normalizeSpeakerToken(text);
  if (!normalized) {
    return false;
  }
  if (
    options?.speakerName &&
    normalized === normalizeSpeakerToken(options.speakerName)
  ) {
    return true;
  }
  if (
    options?.userName &&
    normalized === normalizeSpeakerToken(options.userName)
  ) {
    return true;
  }
  return false;
}

function sanitizeTranscriptWithRoles(
  text: string,
  options?: AssistantSanitizeOptions,
): string {
  const output: string[] = [];
  let seenAssistantContent = false;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      continue;
    }

    if (!seenAssistantContent && isMetaReasoningLine(trimmed)) {
      continue;
    }

    const match = /^([^:\n]{1,60}):\s*(.*)$/.exec(trimmed);
    if (match) {
      const role = classifySpeakerPrefix(match[1], options);
      if (role === "user") {
        if (seenAssistantContent || output.length > 0) {
          break;
        }
        continue;
      }
      if (role === "assistant") {
        const content = match[2].trim();
        if (content) {
          output.push(content);
          seenAssistantContent = true;
        }
        continue;
      }
    }

    output.push(rawLine.trimEnd());
    seenAssistantContent = true;
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function sanitizeAssistantReply(
  raw: string,
  options?: AssistantSanitizeOptions,
): string {
  let next = raw.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
  if (!next) {
    return "";
  }

  next = stripTaggedBlocks(next, ["thinking", "think"]);
  next = extractExplicitResponseBody(next);
  next = unwrapTaggedBlock(next, "response");
  next = stripTaggedBlocks(next, ["thinking", "think"]);
  next = next.replace(/<\s*\/?\s*(response|thinking|think)\b[^>]*>/gi, "");
  next = stripPartialTagFragments(next);
  next = normalizeTemplatePlaceholders(next, options);
  next = stripInternalScaffoldLines(next);
  next = stripPromptEchoLines(next);
  next = sanitizeTranscriptWithRoles(next, options);
  next = stripAssistantSpeakerPreface(next, options);
  next = sanitizeTranscriptWithRoles(next, options);
  next = stripInternalScaffoldLines(next);
  next = stripPromptEchoLines(next);
  next = normalizeTemplatePlaceholders(next, options);
  next = filterUnsafeAssistantFragments(next, options?.speakerName);
  next = normalizeExplicitSegmentMarkers(next, options?.speakerName);
  next = normalizeSafeQuotedAttributions(next, options?.speakerName);
  next = normalizeMalformedRoleplayFormatting(next, options?.speakerName);
  next = normalizeReplySpacing(next);
  return next.trim();
}

export function sanitizeAssistantHistoryContent(
  raw: string,
  options?: AssistantSanitizeOptions,
): string {
  const cleaned = sanitizeAssistantReply(raw, options);
  if (cleaned) {
    return cleaned;
  }
  return unwrapInternalScaffoldHistoryLines(
    raw
      .replace(/\r\n/g, "\n")
      .replace(/\u0000/g, "")
      .replace(/<\s*\/?\s*(response|thinking|think)\b[^>]*>/gi, "")
      .trim(),
  );
}

export const LLAMA_STOP_SEQUENCES = ["\nUser:", "\nHuman:", "\nYou:", "\nMe:"];

export function buildLlamaStopSequences(options?: AssistantSanitizeOptions): string[] {
  return [
    ...LLAMA_STOP_SEQUENCES,
    ...buildStopSequenceNameCandidates(options?.userName).map(
      (name) => `\n${name}:`,
    ),
  ];
}

export function sanitizeStreamingAssistantPreview(
  raw: string,
  options?: AssistantSanitizeOptions,
): string {
  const trimmedRaw = raw.trim();
  if (
    !trimmedRaw ||
    containsRawMetaDraft(trimmedRaw) ||
    /<\s*response\b[^>]*>\s*$/i.test(trimmedRaw)
  ) {
    return "";
  }
  const sanitized = sanitizeAssistantReply(raw, options);
  if (!sanitized) {
    return "";
  }
  const normalized = sanitized.trim().toLowerCase();
  if (
    normalized.startsWith("as an ai assistant") ||
    normalized.startsWith("as an assistant") ||
    normalized.startsWith("assistant is asking") ||
    normalized.startsWith("assistant must engage in a roleplay conversation") ||
    normalized.startsWith("you must engage in a roleplay conversation") ||
    normalized.startsWith("scenario:") ||
    normalized.startsWith("characters:") ||
    normalized.startsWith("setting:") ||
    /^(?:analysis|reasoning|thought|thinking|system|developer|prompt|instructions?|response contract|turn frame|latest user move|current live scene)\s*:/.test(
      normalized,
    ) ||
    normalized.includes("{{user}}") ||
    normalized.includes("{{char}}") ||
    normalized.includes("roleplay conversation with the user below this line") ||
    normalized.startsWith("i need to understand") ||
    normalized.startsWith("let me consider") ||
    normalized.startsWith("let me think") ||
    normalized.startsWith("based on the") ||
    normalized.startsWith("the user is asking")
  ) {
    return "";
  }
  if (
    /<\s*response\b/i.test(trimmedRaw) &&
    (sanitized.length < 24 || looksLikeDanglingSpeakerStub(sanitized, options))
  ) {
    return "";
  }
  if (/<\s*[a-z]*$/i.test(raw.trim())) {
    return "";
  }
  return sanitized;
}
