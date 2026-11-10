// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { VaultWrapFingerprint } from '../../../../../../services/sulla-vault/src/browserEnvelope/wrapFingerprint.js';

describe('Cloud vault wrap fingerprint', () => {
  const fingerprint = new VaultWrapFingerprint();

  it('treats reordered JSONB objects as the same uploaded wrap', () => {
    // risk: data integrity — JSONB key order must not trigger an authHash-gated rewrap.
    const remote = {
      kdf: { authority: 'container', version: 1, password: { salt: 'local-salt', parameters: { memoryBytes: 65536, operations: 3 } } },
      encrypted_user_key: { version: 1, algorithm: 'xchacha20-poly1305', nonce: 'nonce', ciphertext: 'user-key-wrap' },
      public_key: 'public-key',
      encrypted_private_key: { version: 1, algorithm: 'xchacha20-poly1305', nonce: 'private-nonce', ciphertext: 'private-key-wrap' },
    };
    const localJsonb = {
      id: 'user-id',
      kdf: { version: 1, password: { parameters: { operations: 3, memoryBytes: 65536 }, salt: 'local-salt' }, authority: 'container' },
      encrypted_user_key: { algorithm: 'xchacha20-poly1305', ciphertext: 'user-key-wrap', nonce: 'nonce', version: 1 },
      public_key: 'public-key',
      encrypted_private_key: { algorithm: 'xchacha20-poly1305', ciphertext: 'private-key-wrap', nonce: 'private-nonce', version: 1 },
    };
    const localRecovery = {
      recovery_salt: JSON.stringify({ kdf: 'recovery-salt', parameters: { memoryBytes: 65536, operations: 3 } }),
      encrypted_user_key: { algorithm: 'xchacha20-poly1305', ciphertext: 'recovery-wrap', nonce: 'recovery-nonce', version: 1 },
    };
    const remoteRecovery = {
      kdf: { alg: 'argon2id13', ops: 3, salt: 'recovery-salt', memoryBytes: 65536 },
      encryptedUserKey: { ciphertext: 'recovery-wrap', version: 1, algorithm: 'xchacha20-poly1305', nonce: 'recovery-nonce' },
    };

    expect(fingerprint.forAccount(localJsonb, localRecovery)).toBe(fingerprint.forBundleFields({
      kdf: { alg: 'argon2id13', salt: 'local-salt', memoryBytes: 65536, ops: 3 },
      encryptedUserKey: remote.encrypted_user_key,
      publicKey: remote.public_key,
      encryptedPrivateKey: remote.encrypted_private_key,
      recovery: remoteRecovery,
    }));
  });

  it('changes the fingerprint when the password KDF or wrapped key changes', () => {
    // risk: data integrity — real password rotations must still request a Cloud rewrap.
    const baseline = {
      kdf: { alg: 'argon2id13' as const, salt: 'salt-a', memoryBytes: 65536, ops: 3 },
      encryptedUserKey: { version: 1 as const, algorithm: 'xchacha20-poly1305' as const, nonce: 'nonce', ciphertext: 'wrap-a' },
      publicKey: 'public-key',
      encryptedPrivateKey: { version: 1 as const, algorithm: 'xchacha20-poly1305' as const, nonce: 'private-nonce', ciphertext: 'private-wrap' },
    };

    expect(fingerprint.forBundleFields({ ...baseline, kdf: { ...baseline.kdf, salt: 'salt-b' } })).not.toBe(fingerprint.forBundleFields(baseline));
    expect(fingerprint.forBundleFields({ ...baseline, encryptedUserKey: { ...baseline.encryptedUserKey, ciphertext: 'wrap-b' } }))
      .not.toBe(fingerprint.forBundleFields(baseline));
  });
});
