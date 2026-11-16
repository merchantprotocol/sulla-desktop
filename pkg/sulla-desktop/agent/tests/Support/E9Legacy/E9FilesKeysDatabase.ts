// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// In-memory PGlite vault database for the E9 equivalence specs. Same harness as
// Feature/Vault/VaultPostgresRepositories.spec.ts: every vault migration plus the
// Cloud sync schema, with the pgcrypto extension stripped. Delete in final cleanup.

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

import { SYNC_SCHEMA_SQL } from '../../../../../../services/sulla-vault/src/browserEnvelope/schema';
import type { Database } from '../../../../../../services/sulla-vault/src/db';

class E9EmbeddedClient {
  constructor(private readonly pglite: PGlite) {}

  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.pglite.query<T>(sql, values) as { rows: T[]; affectedRows?: number };
    return { rows: result.rows, rowCount: result.rows.length > 0 ? result.rows.length : result.affectedRows ?? 0 };
  }

  release(): void {}
}

export class E9VaultTestDatabase {
  private pglite: PGlite | null = null;
  private database: Database | null = null;

  async setup(): Promise<void> {
    this.pglite = new PGlite();
    const client = new E9EmbeddedClient(this.pglite);
    this.database = Object.assign(client, { connect: async() => client }) as unknown as Database;
    const dir = resolve(process.cwd(), 'services/sulla-vault/migrations');
    for (const file of (await readdir(dir)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort()) {
      const sql = (await readFile(resolve(dir, file), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
      await this.pglite.exec(sql);
    }
    await this.pglite.exec(SYNC_SCHEMA_SQL);
  }

  get db(): Database {
    if (!this.database) throw new Error('database not initialized');
    return this.database;
  }

  async seedUser(userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO users(id,email,login_hash_salt,login_hash_verifier,public_key,encrypted_private_key,encrypted_user_key,kdf)
       VALUES ($1,$2,$3,$4,'pk','{}'::jsonb,'{"ciphertext":"key"}'::jsonb,'{"alg":"test"}'::jsonb)`,
      [userId, `${ userId }@example.test`, Buffer.from('salt'), Buffer.from('verifier')],
    );
  }

  /** Text-normalised snapshot of both Files key bundle tables (no timestamps). */
  async filesKeyBundleTables(): Promise<{ envelopes: unknown[]; current: unknown[] }> {
    const envelopes = await this.db.query(
      `SELECT principal_id,collection_id,key_version::text AS key_version,key_epoch::text AS key_epoch,authority_key_id,authority_bundle
         FROM files_key_bundle_envelopes ORDER BY principal_id,collection_id,key_version,key_epoch`,
    );
    const current = await this.db.query(
      `SELECT principal_id,collection_id,key_version::text AS key_version,key_epoch::text AS key_epoch
         FROM files_key_bundle_current ORDER BY principal_id,collection_id`,
    );
    return { envelopes: envelopes.rows, current: current.rows };
  }

  async close(): Promise<void> {
    await this.pglite?.close();
  }
}
