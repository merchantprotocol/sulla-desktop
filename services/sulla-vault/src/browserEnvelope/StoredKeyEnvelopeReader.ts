// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { KeyWrap, type XChaChaEnvelope } from '@sulla/domain';

/**
 * READ-ONLY opener for the key envelopes stored in `users` (user key, private key) and the recovery wrap.
 * It never seals or rewrites anything: the stored `encrypted_user_key` format is owned by the Desktop vault
 * and only changes on a fresh install through packages/vault-crypto.
 */
export class StoredKeyEnvelopeReader {
  static readonly USER_KEY_AAD = 'sulla:user-key:v1';
  static readonly USER_PRIVATE_KEY_AAD = 'sulla:user-private-key:v1';
  static readonly RECOVERY_USER_KEY_AAD = 'sulla:recovery-user-key:v1';

  constructor(private readonly keyWrap: KeyWrap) {}

  unwrapUserKey(envelope: XChaChaEnvelope, masterKey: Uint8Array): Uint8Array {
    return this.keyWrap.open(masterKey, envelope, StoredKeyEnvelopeReader.USER_KEY_AAD);
  }

  unwrapUserPrivateKey(envelope: XChaChaEnvelope, userKey: Uint8Array): Uint8Array {
    return this.keyWrap.open(userKey, envelope, StoredKeyEnvelopeReader.USER_PRIVATE_KEY_AAD);
  }

  unwrapRecoveryUserKey(envelope: XChaChaEnvelope, recoveryKey: Uint8Array): Uint8Array {
    return this.keyWrap.open(recoveryKey, envelope, StoredKeyEnvelopeReader.RECOVERY_USER_KEY_AAD);
  }
}
