// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

const sharedSlot = Symbol.for('sulla-files.operation-cancellation-registry');

/**
 * Cooperative cancellation for batch operations.
 *
 * A cancellation request may arrive while the item holds its transaction's
 * batch-row lock. This signal stops publication between leaves; the durable
 * cancelled flag is written once rollback releases that lock.
 *
 * One instance must be shared by everything that requests (the batch service)
 * and everything that asserts (folder batches, the native journal). Build it
 * once at composition and inject it.
 */
export class OperationCancellationRegistry {
  private readonly requested = new Set<string>();

  request(id:string):void { this.requested.add(id) }

  clear(id:string):void { this.requested.delete(id) }

  isRequested(id:string):boolean { return this.requested.has(id) }

  assertNotCancelled(id:string):void {
    if (this.requested.has(id)) throw Object.assign(new Error('Operation cancelled between leaves'), { status: 409, code: 'operation-cancelled' });
  }

  /**
   * Transitional composition hook: the one registry owned by a database pool.
   * Today app.ts (cancel/run) and LocalFilesManager (native journal) share only
   * that pool, so the legacy export shims resolve the registry through it. When
   * app.ts is split, build one registry there and inject it instead.
   */
  static sharedBy(owner:object):OperationCancellationRegistry {
    const slot = owner as { [sharedSlot]?:OperationCancellationRegistry };
    if (!slot[sharedSlot]) Object.defineProperty(owner, sharedSlot, { value: new OperationCancellationRegistry(), enumerable: false, configurable: false, writable: false });
    return slot[sharedSlot]!;
  }
}
