export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 MB";
  }
  const mib = value / (1024 * 1024);
  if (mib < 1024) {
    return `${Math.max(1, Math.round(mib))} MB`;
  }
  return `${(mib / 1024).toFixed(1)} GB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "";
  }
  if (seconds < 60) {
    return "less than a minute";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} h` : `about ${hours} h ${rest} min`;
}

/** Smooths download speed so the time estimate does not jump around. */
export class TransferRateMeter {
  private lastBytes = 0;
  private lastTime = 0;
  private rate = 0;

  update(bytes: number, now = Date.now()): number {
    if (this.lastTime === 0 || bytes < this.lastBytes) {
      this.lastBytes = bytes;
      this.lastTime = now;
      return this.rate;
    }
    const elapsed = (now - this.lastTime) / 1000;
    if (elapsed >= 0.5) {
      const instant = (bytes - this.lastBytes) / elapsed;
      this.rate = this.rate === 0 ? instant : this.rate * 0.7 + instant * 0.3;
      this.lastBytes = bytes;
      this.lastTime = now;
    }
    return this.rate;
  }
}

export function describeTransfer(done: number, total: number, bytesPerSecond: number): string {
  const parts = [`${formatBytes(done)} of ${formatBytes(total)}`];
  if (bytesPerSecond > 0) {
    parts.push(`${formatBytes(bytesPerSecond)}/s`);
    const remaining = formatDuration((total - done) / bytesPerSecond);
    if (remaining) {
      parts.push(`${remaining} left`);
    }
  }
  return parts.join(" · ");
}
