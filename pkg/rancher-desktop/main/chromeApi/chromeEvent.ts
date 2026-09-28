// Minimal chrome.events.Event implementation shared by the chrome.* namespaces.

import Logging from '@pkg/utils/logging';

import type { ChromeEvent, EventListener } from './types';

const console = Logging.sulla;


export class ChromeEventImpl<T extends unknown[]> implements ChromeEvent<T> {
  private listeners = new Set<EventListener<T>>();

  addListener(callback: EventListener<T>): void {
    this.listeners.add(callback);
  }

  removeListener(callback: EventListener<T>): void {
    this.listeners.delete(callback);
  }

  hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  emit(...args: T): void {
    for (const listener of this.listeners) {
      try {
        listener(...args);
      } catch (err) {
        console.error('[ChromeApi] Event listener error:', err);
      }
    }
  }
}

