// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { UnlockedFilesAuthorityIdentity } from '../filesKeyBundleAuthority.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';

/**
 * Lends bounded copies of unlocked key material to other vault components for one operation,
 * guarded by the generation and always erased afterwards.
 * Moved verbatim from LocalVaultAuthority (E9); keys and generation live on the host.
 */
export class UnlockedKeyLender {
  constructor(private readonly host: LocalAuthorityHost) {}

  /**
   * Lend a bounded copy of the unlocked user X25519 identity to another
   * Vault-owned component. Lock remains responsive while the operation is in
   * flight; generation checks prevent any result from escaping after a lock or
   * re-unlock, and the private-key copy is always erased.
   */
  async withUnlockedIdentity<T>(
    operation:(identity:UnlockedFilesAuthorityIdentity) => Promise<T>,
  ):Promise<T> {
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const privateKey = Uint8Array.from(keys.privateKey);
    try {
      const result = await operation({
        principalId: keys.userId,
        publicKey: keys.publicKey,
        privateKey,
        generation,
        assertCurrent: () => this.host.requireGeneration(generation),
      });
      this.host.requireGeneration(generation);
      return result;
    } finally {
      privateKey.fill(0);
    }
  }

  /**
   * Lend the unlocked user key to the Passwords sync v3 runner
   * (browserEnvelope/syncRunner.ts) for one operation. Same generation guard
   * as withUnlockedIdentity: a lock during the operation fails it, and the
   * copy is erased afterwards.
   */
  async withUnlockedUserKey<T>(
    operation: (keys: { userId: string; userKey: Uint8Array; assertCurrent: () => void }) => Promise<T>,
  ): Promise<T> {
    const keys = this.host.requireKeys();
    const generation = this.host.generation;
    const userKey = Uint8Array.from(keys.userKey);
    try {
      const result = await operation({ userId: keys.userId, userKey, assertCurrent: () => this.host.requireGeneration(generation) });
      this.host.requireGeneration(generation);
      return result;
    } finally {
      userKey.fill(0);
    }
  }
}
