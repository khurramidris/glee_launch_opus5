import { useEffect, useState } from "react";
import { readLocalImageDataUrl } from "../../api/tauri";

const portraitCache = new Map<string, string>();
const portraitRequests = new Map<string, Promise<string | undefined>>();

function normalizePortraitPath(path?: string): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function useCharacterPortrait(path?: string): string | undefined {
  const normalizedPath = normalizePortraitPath(path);
  const [portraitSrc, setPortraitSrc] = useState<string | undefined>(() => {
    if (!normalizedPath) {
      return undefined;
    }
    if (normalizedPath.startsWith("data:image/")) {
      return normalizedPath;
    }
    return portraitCache.get(normalizedPath);
  });

  useEffect(() => {
    if (!normalizedPath) {
      setPortraitSrc(undefined);
      return;
    }
    if (normalizedPath.startsWith("data:image/")) {
      setPortraitSrc(normalizedPath);
      return;
    }

    const cached = portraitCache.get(normalizedPath);
    if (cached) {
      setPortraitSrc(cached);
      return;
    }

    let cancelled = false;
    const existing = portraitRequests.get(normalizedPath);
    const request =
      existing ??
      readLocalImageDataUrl(normalizedPath)
        .then((dataUrl) => {
          portraitCache.set(normalizedPath, dataUrl);
          portraitRequests.delete(normalizedPath);
          return dataUrl;
        })
        .catch(() => {
          portraitRequests.delete(normalizedPath);
          return undefined;
        });

    if (!existing) {
      portraitRequests.set(normalizedPath, request);
    }

    void request.then((value) => {
      if (!cancelled) {
        setPortraitSrc(value);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [normalizedPath]);

  return portraitSrc;
}

export function clearCharacterPortraitCache(path?: string): void {
  const normalizedPath = normalizePortraitPath(path);
  if (!normalizedPath) {
    portraitCache.clear();
    portraitRequests.clear();
    return;
  }
  portraitCache.delete(normalizedPath);
  portraitRequests.delete(normalizedPath);
}
