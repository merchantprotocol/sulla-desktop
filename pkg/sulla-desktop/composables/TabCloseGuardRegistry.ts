// SPDX-License-Identifier: GPL-2.0-or-later
/** Coordinates asynchronous close confirmation before a tab is removed. */
export class TabCloseGuardRegistry {
  private readonly guards = new Map<string, () => Promise<boolean>>();
  private readonly pending = new Map<string, Promise<boolean>>();

  register(tabId: string, guard: () => Promise<boolean>): () => void {
    this.guards.set(tabId, guard);
    return () => { if (this.guards.get(tabId) === guard) this.guards.delete(tabId); };
  }

  requestClose(tabId: string, remove: () => void): Promise<boolean> {
    const current = this.pending.get(tabId);
    if (current) return current;
    const operation = (async() => {
      const guard = this.guards.get(tabId);
      if (guard && !await guard()) return false;
      remove();
      this.guards.delete(tabId);
      return true;
    })();
    this.pending.set(tabId, operation);
    void operation.finally(() => { if (this.pending.get(tabId) === operation) this.pending.delete(tabId); }).catch(() => undefined);
    return operation;
  }
}
