// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AccountKdf } from '@sulla/domain';

export interface PendingCloudKeyContext {
  key: Uint8Array | undefined;
  kdf: AccountKdf | undefined;
  userId: string | undefined;
}

/** Holds the first-run Cloud-derived vault key only in process memory and zeros replaced or cleared key bytes. */
export class CloudSessionKeyStore {
  private key: Uint8Array | undefined;
  private kdf: AccountKdf | undefined;
  private userId: string | undefined;
  private exitCleanupRegistered = false;

  constructor(private readonly registerExitCleanup: (cleanup: () => void) => void = cleanup => process.once('exit', cleanup)) {}

  retain(key: Uint8Array, kdf: AccountKdf, userId: string): void {
    this.clear();
    this.key = key;
    this.kdf = kdf;
    this.userId = userId;
    if (!this.exitCleanupRegistered) {
      this.exitCleanupRegistered = true;
      this.registerExitCleanup(() => this.clear());
    }
  }

  take(): Uint8Array | undefined {
    const key = this.key;
    this.key = undefined;
    return key;
  }

  clear(): void {
    this.key?.fill(0);
    this.key = undefined;
    this.kdf = undefined;
    this.userId = undefined;
  }

  context(): PendingCloudKeyContext {
    return { key: this.key, kdf: this.kdf, userId: this.userId };
  }
}
