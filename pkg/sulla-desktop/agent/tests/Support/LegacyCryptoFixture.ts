// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Reads, writes and seeds the committed legacy local-vault crypto goldens
// (services/sulla-vault/test/fixtures/legacy-crypto/legacy-local-vault.json). Rows are stored exactly as
// Postgres holds them: bytea as {"$bytea": base64}, jsonb as JSON, timestamps as ISO text.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Database } from '../../../../../services/sulla-vault/src/db';

export type FixtureRow = Record<string, unknown>;

export interface LegacyVaultState {
  users:       FixtureRow[];
  items:       FixtureRow[];
  recovery:    FixtureRow[];
  wrapHistory: FixtureRow[];
  /** sha256 of the users key-material columns (LegacyVaultDatabase.userKeyMaterialDigest). */
  userKeyMaterialSha256: string;
}

export interface LegacyBackupEnvelope {
  version:    1;
  salt:       string;
  parameters: { memoryBytes: number; operations: number };
  envelope:   { version: 1; algorithm: 'xchacha20-poly1305'; nonce: string; ciphertext: string };
}

export interface LegacyCryptoFixture {
  format:        'sulla-desktop-legacy-local-crypto';
  version:       1;
  generatedAt:   string;
  generatedFrom: { baseCommit: string; producers: string[] };
  /** Synthetic secrets only. Never real user data. */
  secrets:       { password: string; changedPassword: string; recoveryCode: string; backupPassword: string };
  userId:        string;
  /** sha256 hex of the 32-byte user key; every wrap in every state must open to this key. */
  userKeySha256: string;
  /** Exact decrypted item plaintext (the UTF-8 JSON text inside each item ciphertext), by item id. */
  plaintexts:    Record<string, string>;
  states:        { initial: LegacyVaultState; afterPasswordChange: LegacyVaultState; legacyFlatKdf: LegacyVaultState };
  /** HumanBackupEnvelope exported from the `initial` state with secrets.backupPassword. */
  backup:        LegacyBackupEnvelope;
}

interface TableSpec { table: string; owner: string; order: string; bytea: readonly string[]; jsonb: readonly string[] }

const TABLES: Record<'users' | 'items' | 'recovery' | 'wrapHistory', TableSpec> = {
  users:       { table: 'users', owner: 'id', order: 'id', bytea: ['login_hash_salt', 'login_hash_verifier'], jsonb: ['encrypted_private_key', 'encrypted_user_key', 'kdf'] },
  items:       { table: 'items', owner: 'owner_user_id', order: 'id', bytea: [], jsonb: ['ciphertext', 'encrypted_item_key', 'agent_wrapped_item_key', 'agent_policy'] },
  recovery:    { table: 'local_vault_recovery', owner: 'user_id', order: 'user_id', bytea: [], jsonb: ['encrypted_user_key'] },
  wrapHistory: { table: 'local_vault_wrap_history', owner: 'user_id', order: 'created_at, id', bytea: ['login_hash_salt', 'login_hash_verifier'], jsonb: ['encrypted_user_key', 'kdf'] },
};

type TableKey = keyof typeof TABLES;

export class LegacyCryptoFixtureStore {
  static readonly PATH = resolve(process.cwd(), 'services/sulla-vault/test/fixtures/legacy-crypto/legacy-local-vault.json');

  async read(): Promise<LegacyCryptoFixture> {
    return JSON.parse(await readFile(LegacyCryptoFixtureStore.PATH, 'utf8')) as LegacyCryptoFixture;
  }

  async write(fixture: LegacyCryptoFixture): Promise<void> {
    await writeFile(LegacyCryptoFixtureStore.PATH, `${ JSON.stringify(fixture, null, 2) }\n`);
  }

  /** Dump every row of one table for a user, exactly as stored. */
  async dump(db: Database, key: TableKey, userId: string): Promise<FixtureRow[]> {
    const spec = TABLES[key];
    const result = await db.query<FixtureRow>(`SELECT * FROM ${ spec.table } WHERE ${ spec.owner }=$1 ORDER BY ${ spec.order }`, [userId]);

    return result.rows.map(row => {
      const out: FixtureRow = {};
      for (const [column, value] of Object.entries(row)) {
        if (spec.bytea.includes(column)) out[column] = { $bytea: Buffer.from(value as Uint8Array).toString('base64') };
        else if (value instanceof Date) out[column] = value.toISOString();
        else out[column] = value;
      }
      return out;
    });
  }

  /** Insert fixture rows into a fresh vault database, byte-for-byte. */
  async seed(db: Database, state: LegacyVaultState): Promise<void> {
    for (const key of ['users', 'items', 'recovery', 'wrapHistory'] as const) {
      for (const row of state[key]) await this.insert(db, key, row);
    }
  }

  private async insert(db: Database, key: TableKey, row: FixtureRow): Promise<void> {
    const spec = TABLES[key];
    const columns = Object.keys(row);
    const values = columns.map(column => {
      const value = row[column];
      if (spec.bytea.includes(column)) return Buffer.from((value as { $bytea: string }).$bytea, 'base64');
      if (spec.jsonb.includes(column)) return value === null ? null : JSON.stringify(value);
      return value;
    });
    const placeholders = columns.map((column, index) => spec.jsonb.includes(column) ? `$${ index + 1 }::jsonb` : `$${ index + 1 }`);
    await db.query(`INSERT INTO ${ spec.table }(${ columns.join(',') }) VALUES (${ placeholders.join(',') })`, values);
  }
}
