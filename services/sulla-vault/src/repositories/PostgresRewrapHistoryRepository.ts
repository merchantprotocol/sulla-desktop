// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Queryable } from '../db.js';

export interface VaultWrapHistoryRecord {
  user_id: string;
  login_hash_salt: Buffer;
  login_hash_verifier: Buffer;
  encrypted_user_key: unknown;
  kdf: unknown;
  reason: string;
}

export interface VaultRecoveryHistoryRecord {
  id: string;
  user_id: string;
  recovery_salt: string;
  recovery_verifier: string;
  encrypted_user_key: unknown;
  reason: string;
}

export class PostgresRewrapHistoryRepository {
  constructor(private readonly db: Queryable) {}

  async preserveCurrentPasswordWrap(userId: string, reason: 'password_change' | 'account_password_migration' | 'recovery', connection: Queryable = this.db): Promise<void> {
    await connection.query(
      `INSERT INTO local_vault_wrap_history(user_id,login_hash_salt,login_hash_verifier,encrypted_user_key,kdf,reason)
       SELECT id,login_hash_salt,login_hash_verifier,encrypted_user_key,kdf,$2 FROM users WHERE id=$1`, [userId, reason]);
  }

  async preservePasswordWrap(record: Omit<VaultWrapHistoryRecord, 'reason'>, reason: 'cloud_rewrap', connection: Queryable = this.db): Promise<void> {
    await connection.query(
      `INSERT INTO local_vault_wrap_history(user_id,login_hash_salt,login_hash_verifier,encrypted_user_key,kdf,reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [record.user_id, record.login_hash_salt, record.login_hash_verifier, record.encrypted_user_key, record.kdf, reason]);
  }

  async preserveCurrentRecoveryWrap(userId: string, reason: 'rotation', connection: Queryable = this.db): Promise<boolean> {
    const prior = await connection.query<VaultRecoveryHistoryRecord>(
      `INSERT INTO local_vault_recovery_history(user_id,recovery_salt,recovery_verifier,encrypted_user_key,reason)
       SELECT user_id,recovery_salt,recovery_verifier,encrypted_user_key,$2
       FROM local_vault_recovery WHERE user_id=$1 RETURNING *`, [userId, reason]);
    return Boolean(prior.rowCount);
  }
}
