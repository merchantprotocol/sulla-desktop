// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { RefreshLock } from '@sulla/domain';

/** Runs work under the vault's per-credential queue (the same primitive that serialized token mutations before). */
export type CredentialSerializer = <T>(name: string, work: () => Promise<T>) => Promise<T>;

/**
 * RefreshLock over `withCredentialQueue`. Refresh and sign-out share it, so an in-flight refresh finishes before
 * the clear and can never write after it (finding S8). Not re-entrant: do not call it from inside its own work.
 */
export class CredentialQueueRefreshLock implements RefreshLock {
  constructor(private readonly serialize: CredentialSerializer) {}

  run<T>(name: string, work: () => Promise<T>): Promise<T> {
    return this.serialize(name, work);
  }
}
