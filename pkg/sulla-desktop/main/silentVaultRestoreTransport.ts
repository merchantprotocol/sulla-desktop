// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultBrokerFetch } from '@pkg/vault-broker';

/**
 * Retries a locked broker request (HTTP 423) once after restoring the opaque vault session.
 * Concurrent locked requests share one restore attempt.
 */
export class SilentVaultRestoreTransport {
  private restoring: Promise<boolean> | undefined;

  constructor(
    private readonly fetcher: VaultBrokerFetch,
    private readonly restore: () => Promise<boolean>,
  ) {}

  readonly fetch: VaultBrokerFetch = async(input, init) => {
    const response = await this.fetcher(input, init);

    if (response.status !== 423) return response;
    this.restoring ??= this.restore().finally(() => { this.restoring = undefined });
    if (!await this.restoring) return response;
    await response.body?.cancel();

    return this.fetcher(input, init);
  };
}

/** Compatibility seam for existing callers; prefer constructing a `SilentVaultRestoreTransport`. */
export function withSilentVaultRestore(fetcher: VaultBrokerFetch, restore: () => Promise<boolean>): VaultBrokerFetch {
  return new SilentVaultRestoreTransport(fetcher, restore).fetch;
}
