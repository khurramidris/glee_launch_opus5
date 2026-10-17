export type StateUpdater<T> = T | ((prev: T) => T);

export function resolveStateUpdate<T>(prev: T, next: StateUpdater<T>): T {
  return typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
}
