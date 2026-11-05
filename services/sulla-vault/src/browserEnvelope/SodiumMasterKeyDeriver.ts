// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AccountKdf, MasterKeyDeriver } from '@sulla/domain';

import type { VaultSyncShape } from './VaultSyncShape.js';
import { EnvelopeError } from './VaultSyncContracts.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Sodium = any;

/**
 * Runtime adapter: Argon2id through libsodium's WASM build, injected into the
 * domain VaultSyncCodec in place of its pure-JS default. Same bytes (vault-sync-v3
 * KAT), and it keeps the container's established KDF and password error codes.
 */
export class SodiumMasterKeyDeriver implements MasterKeyDeriver {
  private static readonly KEY_BYTES = 32;

  constructor(
    private readonly sodium: Sodium,
    private readonly shape: VaultSyncShape,
  ) {}

  deriveMasterKey(password: string, kdf: AccountKdf): Uint8Array {
    const checked: unknown = kdf;
    this.shape.checkKdf(checked);
    if (typeof password !== 'string' || !password) throw new EnvelopeError('password_required', 'Master password is required');
    const salt = this.sodium.from_base64(checked.salt, this.sodium.base64_variants.URLSAFE_NO_PADDING);
    return this.sodium.crypto_pwhash(
      SodiumMasterKeyDeriver.KEY_BYTES,
      password,
      salt,
      checked.ops,
      checked.memoryBytes,
      this.sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
  }
}
