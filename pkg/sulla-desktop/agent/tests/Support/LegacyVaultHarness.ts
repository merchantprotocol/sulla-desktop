// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test-only harness for the legacy local-vault crypto characterization (M3 S7a).
// Runs the real vault migrations on a real Postgres: SULLA_TEST_DATABASE_URL when set (a throwaway schema),
// otherwise an in-process PGlite. It then drives the real LocalVaultAuthority, exactly as the human vault
// page does (control identity -> human session -> unlock / list / reveal / recover / backup).

import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

import type { Database } from '../../../../../services/sulla-vault/src/db';
import { SYNC_SCHEMA_SQL } from '../../../../../services/sulla-vault/src/browserEnvelope/schema';
import { LocalVaultAuthority } from '../../../../../services/sulla-vault/src/localAuthority';

const { Pool } = pg;

/**
 * PGlite returns bytea as Uint8Array; node-postgres returns Buffer. The vault code relies on Buffer
 * (the backup export serializes bytea through Buffer#toJSON), so rows are normalized to what `pg` returns.
 */
class PgliteQueryClient {
  constructor(private readonly db: PGlite) {}

  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    const result = await this.db.query<Record<string, unknown>>(sql, values) as { rows: Record<string, unknown>[]; affectedRows?: number };
    const rows = result.rows.map(row => {
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) normalized[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
      return normalized as T;
    });
    return { rows, rowCount: result.affectedRows || rows.length };
  }

  release(): void { /* single embedded connection */ }
}

export class LegacyVaultDatabase {
  private pool: pg.Pool | null = null;
  private pglite: PGlite | null = null;
  private schema = '';
  private database: Database | null = null;

  constructor(private readonly url = process.env.SULLA_TEST_DATABASE_URL ?? '') {}

  get db(): Database {
    if (!this.database) throw new Error('database not initialized');
    return this.database;
  }

  get engine(): 'postgres' | 'pglite' { return this.pool ? 'postgres' : 'pglite' }

  async open(): Promise<this> {
    if (this.url) {
      this.schema = `legacy_crypto_${ randomUUID().replaceAll('-', '') }`;
      this.pool = new Pool({ connectionString: this.url, options: `-csearch_path=${ this.schema },public` });
      await this.pool.query(`CREATE SCHEMA "${ this.schema }"`);
      this.database = this.pool;
    } else {
      this.pglite = new PGlite();
      const client = new PgliteQueryClient(this.pglite);
      this.database = Object.assign(client, { connect: async() => client }) as unknown as Database;
    }
    const dir = resolve(process.cwd(), 'services/sulla-vault/migrations');
    for (const file of (await readdir(dir)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort()) {
      const sql = await readFile(resolve(dir, file), 'utf8');
      if (this.pglite) await this.pglite.exec(sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
      else await this.db.query(sql);
    }
    if (this.pglite) await this.pglite.exec(SYNC_SCHEMA_SQL);
    else await this.db.query(SYNC_SCHEMA_SQL);
    return this;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.query(`DROP SCHEMA IF EXISTS "${ this.schema }" CASCADE`);
      await this.pool.end();
    }
    await this.pglite?.close();
  }

  /** sha256 of the whole `users` row (every column, Postgres-canonical jsonb text). Any write changes it (updated_at). */
  async userRowDigest(userId: string): Promise<string> {
    return this.digest('SELECT to_jsonb(u)::text AS row FROM users u WHERE id=$1', [userId]);
  }

  /** sha256 of the stored key material only (no timestamps): comparable to the committed fixture. */
  async userKeyMaterialDigest(userId: string): Promise<string> {
    return this.digest(`SELECT jsonb_build_array(id, email, encode(login_hash_salt,'base64'), encode(login_hash_verifier,'base64'),
      public_key, encrypted_private_key, encrypted_user_key, kdf)::text AS row FROM users WHERE id=$1`, [userId]);
  }

  /** sha256 of every item row owned by the user, in id order. */
  async itemRowsDigest(userId: string): Promise<string> {
    return this.digest(`SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)::text AS row FROM items i WHERE owner_user_id=$1`, [userId]);
  }

  /** sha256 of the recovery row. */
  async recoveryRowDigest(userId: string): Promise<string> {
    return this.digest('SELECT to_jsonb(r)::text AS row FROM local_vault_recovery r WHERE user_id=$1', [userId]);
  }

  private async digest(sql: string, values: unknown[]): Promise<string> {
    const result = await this.db.query<{ row: string | null }>(sql, values);
    if (!result.rowCount || result.rows[0].row === null) throw new Error('row not found for digest');
    return createHash('sha256').update(result.rows[0].row).digest('hex');
  }
}

/** A real LocalVaultAuthority in desktop mode with synthetic, distinct service credentials. */
export class LegacyVaultAuthorityDriver {
  static readonly CONTROL_ID = 'control';
  static readonly CONTROL_TOKEN = 'c'.repeat(40);

  readonly authority: LocalVaultAuthority;
  private session: { sessionId: string; csrf: string } | null = null;

  constructor(db: Database) {
    this.authority = new LocalVaultAuthority(db, {
      mode: 'desktop', port: 0, databaseUrl: 'postgresql://synthetic/unused', extensionOrigins: [],
      bootstrapServiceId: 'bootstrap', bootstrapServiceToken: 'b'.repeat(40),
      controlServiceId: LegacyVaultAuthorityDriver.CONTROL_ID, controlServiceToken: LegacyVaultAuthorityDriver.CONTROL_TOKEN,
      approvalServiceId: 'approval', approvalServiceToken: 'a'.repeat(40),
      brokerServiceId: 'broker', brokerServiceToken: 'r'.repeat(40),
      filesServiceId: 'files', filesServiceToken: 'f'.repeat(40),
    } as unknown as ConstructorParameters<typeof LocalVaultAuthority>[1]);
  }

  private get current(): { sessionId: string; csrf: string } {
    if (!this.session) this.session = this.authority.createHumanSession(LegacyVaultAuthorityDriver.CONTROL_ID, LegacyVaultAuthorityDriver.CONTROL_TOKEN);
    return this.session;
  }

  private remember<T extends { sessionId: string; csrf: string }>(next: T): T {
    this.session = { sessionId: next.sessionId, csrf: next.csrf };
    return next;
  }

  async unlock(password: string) { const s = this.current; return this.remember(await this.authority.unlockHumanSession(s.sessionId, s.csrf, password)) }
  async lock() { const s = this.current; return this.remember(await this.authority.lockHumanSession(s.sessionId, s.csrf)) }
  list() { const s = this.current; return this.authority.listHumanItems(s.sessionId, s.csrf) }
  reveal(itemId: string) { const s = this.current; return this.authority.revealHumanItem(s.sessionId, s.csrf, itemId) }
  save(input: Parameters<LocalVaultAuthority['saveHumanItem']>[2]) { const s = this.current; return this.authority.saveHumanItem(s.sessionId, s.csrf, input) }
  changePassword(current: string, next: string) { const s = this.current; return this.authority.changeHumanPassword(s.sessionId, s.csrf, current, next) }
  configureRecovery(code: string) { const s = this.current; return this.authority.configureHumanRecovery(s.sessionId, s.csrf, code) }
  async recover(code: string, nextPassword: string) { const s = this.current; return this.remember(await this.authority.recoverHumanSession(s.sessionId, s.csrf, code, nextPassword)) }
  exportBackup(password: string) { const s = this.current; return this.authority.exportHumanBackup(s.sessionId, s.csrf, password) }
  importBackup(password: string, envelope: Parameters<LocalVaultAuthority['importHumanBackup']>[3]) { const s = this.current; return this.authority.importHumanBackup(s.sessionId, s.csrf, password, envelope) }
  status() { return this.authority.status() }
}
