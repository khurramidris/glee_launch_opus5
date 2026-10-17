export interface UserPronouns {
  subject: string;
  object: string;
  possessive: string;
  reflexive: string;
  label: string;
}

function normalizeGender(value?: string): string {
  return value?.trim().toLowerCase().replace(/[^a-z]+/g, " ")?.trim() ?? "";
}

export function deriveUserPronouns(gender?: string): UserPronouns {
  const normalized = normalizeGender(gender);

  if (
    /^(man|male|he|he him|him|boy|guy)$/.test(normalized) ||
    /\b(he him|male|man)\b/.test(normalized)
  ) {
    return {
      subject: "he",
      object: "him",
      possessive: "his",
      reflexive: "himself",
      label: "he/him",
    };
  }

  if (
    /^(woman|female|she|she her|her|girl)$/.test(normalized) ||
    /\b(she her|female|woman)\b/.test(normalized)
  ) {
    return {
      subject: "she",
      object: "her",
      possessive: "her",
      reflexive: "herself",
      label: "she/her",
    };
  }

  if (
    /^(nonbinary|non binary|non binary person|nb|they|they them|them)$/.test(normalized) ||
    /\b(they them|nonbinary|non binary|nb)\b/.test(normalized)
  ) {
    return {
      subject: "they",
      object: "them",
      possessive: "their",
      reflexive: "themself",
      label: "they/them",
    };
  }

  return {
    subject: "they",
    object: "them",
    possessive: "their",
    reflexive: "themself",
    label: "they/them",
  };
}

export function buildUserReferenceInstruction(input: {
  userName?: string;
  userGender?: string;
}): string {
  const userName = input.userName?.trim();
  const pronouns = deriveUserPronouns(input.userGender);

  if (userName) {
    return `Do not call ${userName} "the user". Address ${userName} directly as "you" whenever possible. If a third-person reference is absolutely necessary, use ${userName} or ${pronouns.subject}/${pronouns.object}/${pronouns.possessive}.`;
  }

  return 'Do not call the other person "the user" inside the reply. Address them directly as "you" unless a third-person reference is absolutely necessary.';
}
