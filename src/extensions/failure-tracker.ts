import type { HookFailure } from "./pipeline";

export interface FailureTrackerOptions {
  maxFailures: number;
  windowMs: number;
  now: () => number;
}

export const DEFAULT_FAILURE_POLICY = { maxFailures: 5, windowMs: 10 * 60_000 } as const;

/**
 * Sliding-window failure counter. A window (not a lifetime total) lets a
 * healthy extension survive the odd error while a flapping one is stopped fast.
 */
export class FailureTracker {
  private stamps = new Map<string, number[]>();
  private last = new Map<string, HookFailure>();

  constructor(private readonly options: FailureTrackerOptions) {}

  /** Returns true when this failure crosses the limit. */
  record(extensionId: string, failure: HookFailure): boolean {
    const now = this.options.now();
    const recent = (this.stamps.get(extensionId) ?? []).filter(
      (stamp) => now - stamp < this.options.windowMs,
    );
    recent.push(now);
    this.stamps.set(extensionId, recent);
    this.last.set(extensionId, failure);
    return recent.length >= this.options.maxFailures;
  }

  count(extensionId: string): number {
    const now = this.options.now();
    return (this.stamps.get(extensionId) ?? []).filter(
      (stamp) => now - stamp < this.options.windowMs,
    ).length;
  }

  lastFailure(extensionId: string): HookFailure | undefined {
    return this.last.get(extensionId);
  }

  reset(extensionId: string): void {
    this.stamps.delete(extensionId);
    this.last.delete(extensionId);
  }
}
