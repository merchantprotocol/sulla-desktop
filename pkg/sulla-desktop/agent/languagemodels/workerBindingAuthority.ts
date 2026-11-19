// SPDX-License-Identifier: GPL-2.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';
const ownerWrite = new AsyncLocalStorage<boolean>();
export function withWorkerBindingWrite<T>(operation: () => T): T { return ownerWrite.run(true, operation) }
export function assertWorkerBindingsUnchanged(before: unknown, after: unknown): void {
  if (!ownerWrite.getStore() && JSON.stringify(before ?? {}) !== JSON.stringify(after ?? {})) throw new Error('Worker mappings can only be changed in AI Models.');
}
