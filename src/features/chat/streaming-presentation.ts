export function nextStreamingTextFrame(
  current: string,
  target: string,
): string {
  if (!target || current === target) {
    return target;
  }
  if (!target.startsWith(current)) {
    return target;
  }

  const currentUnits = Array.from(current);
  const targetUnits = Array.from(target);
  const pending = targetUnits.length - currentUnits.length;
  if (pending <= 0) {
    return target;
  }

  const step =
    pending > 120
      ? Math.min(16, Math.ceil(pending / 8))
      : pending > 48
        ? 8
        : pending > 20
          ? 4
          : pending > 7
            ? 2
            : 1;

  return targetUnits
    .slice(0, currentUnits.length + step)
    .join("");
}

export function retainVisibleStreamingPreview(
  previous: string,
  candidate: string,
): string {
  return candidate.trim() ? candidate : previous;
}
