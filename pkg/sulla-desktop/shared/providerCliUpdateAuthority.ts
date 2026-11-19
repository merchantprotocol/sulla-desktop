// SPDX-License-Identifier: GPL-2.0-or-later
import { AsyncLocalStorage } from 'node:async_hooks';

const confirmedUpdate = new AsyncLocalStorage<boolean>();

/** Main process enters this scope only after the owner confirms one exact release. */
export function withConfirmedCliUpdate<T>(operation: () => T): T {
  return confirmedUpdate.run(true, operation);
}

export function assertConfirmedCliUpdate(): void {
  if (!confirmedUpdate.getStore()) throw new Error('Provider CLI updates require confirmation in AI Models.');
}
