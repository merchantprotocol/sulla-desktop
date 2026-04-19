/**
 * TypedEventEmitter — lightweight typed event system.
 *
 * Follows the app's subscription-returns-unsubscribe pattern:
 *   const unsub = emitter.on('event', handler);
 *   unsub(); // removes handler
 *
 * Subclasses call `this.emit(event, payload)` to dispatch.
 */
export class TypedEventEmitter<EventMap extends Record<string, any>> {
  private handlers = new Map<keyof EventMap, Set<Function>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  /**
   * Emit an event to all subscribed handlers.
   * Errors in handlers are caught and logged to prevent cascading failures.
   */
  protected emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[TypedEventEmitter] Handler error on "${ String(event) }":`, err);
      }
    }
  }

  /**
   * Remove all handlers. Called during dispose().
   */
  protected clearAllHandlers(): void {
    this.handlers.clear();
  }
}
