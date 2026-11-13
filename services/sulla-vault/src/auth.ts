// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import type { VaultConfig } from './config.js';
import type { Queryable } from './db.js';

export function makeLoginVerifier(loginHash: string, salt = randomBytes(16)): { salt: Buffer; verifier: Buffer } {
  return { salt, verifier: scryptSync(loginHash, salt, 32) };
}

export function verifyLoginHash(loginHash: string, salt: Uint8Array, expected: Uint8Array): boolean {
  const actual = scryptSync(loginHash, salt, expected.byteLength);
  return timingSafeEqual(actual, expected);
}

export async function ensureDesktopAccount(db: Queryable, config: VaultConfig): Promise<void> {
  if (!config.desktopLoginHash) {
    return;
  }
  if (!config.desktopPublicKey || !config.desktopEncryptedPrivateKey || !config.desktopEncryptedUserKey || !config.desktopKdf) {
    throw new Error('Desktop bootstrap requires public key, wrapped private key, wrapped user key, and KDF settings');
  }
  const existing = await db.query('SELECT id FROM users LIMIT 1');
  if (existing.rowCount) {
    return;
  }
  const { salt, verifier } = makeLoginVerifier(config.desktopLoginHash);
  await db.query(
    `INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['desktop@local.sulla', salt, verifier, config.desktopPublicKey, config.desktopEncryptedPrivateKey,
      config.desktopEncryptedUserKey, config.desktopKdf],
  );
}
