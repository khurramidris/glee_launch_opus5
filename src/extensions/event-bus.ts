import type { AppEventName, AppEvents, Unsubscribe } from "./types";

export interface BusListener<K extends AppEventName = AppEventName> {
  extensionId: string;
  name: K;
  handler: (payload: AppEvents[K]) => void | Promise<void>;
}

/**
 * Typed fan-out. It only stores listeners; running them (with timeouts and
 * failure accounting) is the registry's job so every hook shares one policy.
 */
export class EventBus {
  private listeners = new Set<BusListener>();

  on<K extends AppEventName>(listener: BusListener<K>): Unsubscribe {
    const stored = listener as unknown as BusListener;
    this.listeners.add(stored);
    return () => {
      this.listeners.delete(stored);
    };
  }

  listenersFor<K extends AppEventName>(name: K): BusListener<K>[] {
    return [...this.listeners].filter((listener) => listener.name === name) as unknown as BusListener<K>[];
  }

  removeExtension(extensionId: string): void {
    for (const listener of [...this.listeners]) {
      if (listener.extensionId === extensionId) {
        this.listeners.delete(listener);
      }
    }
  }
}
