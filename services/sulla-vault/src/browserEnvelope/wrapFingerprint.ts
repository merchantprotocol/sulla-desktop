// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { jcs, type AeadEnvelope, type RecoveryWrap, type SyncKdf } from './envelope.js';
import { passwordKdf, pickEnvelope, recoveryWrap, type LocalAccountRow, type LocalRecoveryRow } from './exportBuilder.js';

interface WrappedBundleFields {
  kdf: SyncKdf;
  encryptedUserKey: AeadEnvelope;
  publicKey: string;
  encryptedPrivateKey: AeadEnvelope;
  recovery?: RecoveryWrap;
}

/** Hashes the effective bundle wraps, independent of JSONB/object insertion order. */
export class VaultWrapFingerprint {
  forAccount(account: LocalAccountRow, recovery?: LocalRecoveryRow | null): string {
    return this.forBundleFields({
      kdf: passwordKdf(account.kdf),
      encryptedUserKey: pickEnvelope(account.encrypted_user_key),
      publicKey: account.public_key,
      encryptedPrivateKey: pickEnvelope(account.encrypted_private_key),
      ...(recovery ? { recovery: recoveryWrap(recovery) } : {}),
    });
  }

  forBundleFields(fields: WrappedBundleFields): string {
    return createHash('sha256').update(Buffer.from(jcs([
      fields.kdf,
      fields.encryptedUserKey,
      fields.publicKey,
      fields.encryptedPrivateKey,
      fields.recovery ?? null,
    ]))).digest('hex');
  }
}
