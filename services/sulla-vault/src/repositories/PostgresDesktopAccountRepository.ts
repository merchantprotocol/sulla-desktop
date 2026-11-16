// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { Queryable } from '../db.js';

export interface DesktopAccountRow {
  email:               string;
  loginHashSalt:       Buffer;
  loginHashVerifier:   Buffer;
  publicKey:           string;
  encryptedPrivateKey: unknown;
  encryptedUserKey:    unknown;
  kdf:                 unknown;
}

/** The users-table statements behind the one-time desktop account bootstrap. */
export class PostgresDesktopAccountRepository {
  constructor(private readonly client: Queryable) {}

  async anyUserExists(): Promise<boolean> {
    const existing = await this.client.query('SELECT id FROM users LIMIT 1');
    return Boolean(existing.rowCount);
  }

  async insert(row: DesktopAccountRow): Promise<void> {
    await this.client.query(
      `INSERT INTO users(email, login_hash_salt, login_hash_verifier, public_key, encrypted_private_key, encrypted_user_key, kdf)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.email, row.loginHashSalt, row.loginHashVerifier, row.publicKey, row.encryptedPrivateKey,
        row.encryptedUserKey, row.kdf],
    );
  }
}
