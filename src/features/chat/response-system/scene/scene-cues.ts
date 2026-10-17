import { clipText } from "../compile/prompt-budget";

function cleanupCue(value: string | undefined): string | null {
  const cleaned = (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\b(?:i\s+(?:say|said|ask|asked|shout|shouted|yell|yelled|reply|replied)|while|as)\b[\s\S]*$/i, "")
    .replace(/^[\s"'“”‘’*.,!?;:]+|[\s"'“”‘’*.,!?;:]+$/g, "")
    .trim();
  return cleaned ? clipText(cleaned, 180) : null;
}

export function extractLatestSceneAssertion(text: string | undefined): string | null {
  const source = text ?? "";
  const patterns = [
    /\b(?:we|you and i|all of us|everyone)\s+(?:are|re|'re)\s+(?:(?:standing|sitting|waiting|walking|driving|riding|staying|lying)\s+)?(?:in|inside|at|on|near|outside)\s+(.+?)(?:[.!?]|\b(?:and|but|so|then|while|as)\b|$)/i,
    /\b(?:this|that|the)\s+(?:is|looks like|seems like)\s+(?:a|an|the)?\s*(.+?)(?:[.!?]|\b(?:and|but|so|then|while|as)\b|$)/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const cue = cleanupCue(match?.[1]);
    if (cue && cue.length >= 3) {
      return cue;
    }
  }

  return null;
}

export function extractLatestMovementTarget(text: string | undefined): string | null {
  const source = text ?? "";
  const patterns = [
    /\b(?:we|i|you|all of us|everyone)\s+(?:need|have|has|want|wants|wanted|should|must|gotta|got to)\s+(?:to\s+)?(?:go|head|drive|walk|move|return|leave|get)\s+(?:to|toward|towards|into|inside|over to|back to)\s+(.+?)(?:[.!?]|\b(?:and|but|so|then|while|as)\b|$)/i,
    /\b(?:let'?s|lets)\s+(?:go|head|drive|walk|move|return|leave|get)\s+(?:to|toward|towards|into|inside|over to|back to)\s+(.+?)(?:[.!?]|\b(?:and|but|so|then|while|as)\b|$)/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const cue = cleanupCue(match?.[1]);
    if (cue && cue.length >= 3) {
      return cue;
    }
  }

  return null;
}
