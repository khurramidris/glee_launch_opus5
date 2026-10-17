export interface RecommendedModelConfig {
  name: string;
  url: string;
  sha256?: string;
  description?: string;
  sizeLabel?: string;
}

function envValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function getRecommendedModelConfig(): RecommendedModelConfig | null {
  const url = sanitizeUrl(envValue(import.meta.env.VITE_GLEE_RECOMMENDED_MODEL_URL));
  if (!url) {
    return null;
  }
  return {
    url,
    name: envValue(import.meta.env.VITE_GLEE_RECOMMENDED_MODEL_NAME) ?? "Glee Starter Model",
    sha256: envValue(import.meta.env.VITE_GLEE_RECOMMENDED_MODEL_SHA256),
    description:
      envValue(import.meta.env.VITE_GLEE_RECOMMENDED_MODEL_DESCRIPTION) ??
      "Download the hosted starter GGUF for first-run setup.",
    sizeLabel: envValue(import.meta.env.VITE_GLEE_RECOMMENDED_MODEL_SIZE),
  };
}
