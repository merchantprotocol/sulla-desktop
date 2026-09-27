/**
 * Real-Postgres check of the snapshot/restore SQL. Opt-in (VAULT_PG_IT=1)
 * because it needs the local Sulla Postgres. It creates and drops its own
 * scratch database and never touches the `sulla` database.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Pool } from 'pg';

import type { VaultRowDb } from '../VaultBackupService';

const keychainStub = {
  isEncryptionAvailable: () => true,
  encryptString:         (s: string) => Buffer.from(`KC:${ s }`),
  decryptString:         (b: Buffer) => b.toString().slice(3),
};

jest.unstable_mockModule('@pkg/utils/paths', () => ({ __esModule: true, default: { sullaConfig: '/nonexistent' } }));

const { up: createTable } = await import('../../database/migrations/0013_create_integration_values_table');
const { PostgresVaultRowStore, VaultBackupService } = await import('../VaultBackupService');
const { VaultKeyService: RealVaultKeyService } = await import('../VaultKeyService');

class VaultKeyService extends RealVaultKeyService {
  constructor(dir: string) {
    super(dir, keychainStub);
  }
}

// Real PBKDF2 and bulk crypto: allow for a loaded CI machine.
jest.setTimeout(60_000);

const run = process.env.VAULT_PG_IT === '1' ? describe : describe.skip;
const conn = { host: '127.0.0.1', port: Number(process.env.VAULT_PG_PORT ?? 30116), user: 'sulla', password: process.env.VAULT_PG_PASSWORD ?? 'sulla_dev_password' };
const dbName = `sulla_vault_it_${ process.pid }_${ Date.now() }`;

run('VaultBackupService against real Postgres', () => {
  let admin: Pool;
  let pool: Pool;
  let db: VaultRowDb;

  beforeAll(async() => {
    admin = new Pool({ ...conn, database: 'postgres', max: 1 });
    await admin.query(`CREATE DATABASE "${ dbName }"`);
    pool = new Pool({ ...conn, database: dbName, max: 4 });
    await pool.query(createTable);
    db = {
      queryAll:    async(sql, params) => (await pool.query(sql, params as any[])).rows,
      transaction: async(fn) => {
        const client = await pool.connect();

        try {
          await client.query('BEGIN');
          const out = await fn({ query: (sql, params) => client.query(sql, params as any[]) as any });

          await client.query('COMMIT');

          return out;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      },
    };
  });

  afterAll(async() => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${ dbName }"`);
    await admin?.end();
  });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('snapshots, survives total loss, and restores every credential into a new vault', async() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-pg-'));
    const oldVault = new VaultKeyService(path.join(home, 'old'));
    const { recoveryKey } = await oldVault.setupFromMasterPassword('old pw');
    const expected = new Map<string, string>();

    for (let i = 0; i < 300; i++) {
      const plain = `pw-${ i }-${ '🔐'.repeat(i % 3) }`;

      expected.set(`site_${ i }`, plain);
      await pool.query(
        `INSERT INTO integration_values (integration_id, account_id, property, value, is_default) VALUES ('website', $1, 'password', $2, $3)`,
        [`site_${ i }`, oldVault.encrypt(plain), i === 0],
      );
    }

    const oldBackups = new VaultBackupService(new PostgresVaultRowStore(db), oldVault, path.join(home, 'backups'));
    const file = (await oldBackups.createSnapshot('pg-it'))!;
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));

    expect(snapshot.rowCount).toBe(300);

    // Disaster: every row gone, keys gone, new vault.
    await pool.query('DELETE FROM integration_values');
    fs.rmSync(path.join(home, 'old'), { recursive: true });
    const newVault = new VaultKeyService(path.join(home, 'new'));

    await newVault.setupFromMasterPassword('new pw');
    const newBackups = new VaultBackupService(new PostgresVaultRowStore(db), newVault, path.join(home, 'backups2'));
    const res = await newBackups.restoreSnapshot(snapshot, { recoveryKey });

    newBackups.stop();
    expect(res).toMatchObject({ inserted: 300, skipped: 0, unreadable: 0 });

    const rows = (await pool.query(`SELECT account_id, value, is_default FROM integration_values WHERE property = 'password'`)).rows;

    expect(rows).toHaveLength(300);
    for (const r of rows) expect(newVault.decrypt(r.value)).toBe(expected.get(r.account_id));
    expect(rows.find(r => r.account_id === 'site_0').is_default).toBe(true);

    // Merge restore again: nothing duplicated (UNIQUE constraint honoured).
    expect(await newBackups.restoreSnapshot(snapshot, { recoveryKey })).toMatchObject({ inserted: 0, skipped: 300 });
    newBackups.stop();
  });

  it('rolls back the whole restore if any row fails in the database', async() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-pg-'));
    const vault = new VaultKeyService(path.join(home, 'k'));

    await vault.setupFromMasterPassword('pw');
    await pool.query('DELETE FROM integration_values');
    const backups = new VaultBackupService(new PostgresVaultRowStore(db), vault, path.join(home, 'b'));
    const rows = [
      { integration_id: 'ok', account_id: 'a', property: 'p', value: vault.encrypt('1'), is_default: false },
      // integration_id is VARCHAR(100): this row makes Postgres reject the insert.
      { integration_id: 'x'.repeat(150), account_id: 'a', property: 'p', value: vault.encrypt('2'), is_default: false },
    ];
    const snapshot = { format: 'sulla-vault-snapshot', version: 1, createdAt: '', reason: 't', rowCount: 2, keyMaterial: vault.exportKeyMaterial(), rows } as any;

    await expect(backups.restoreSnapshot(snapshot)).rejects.toThrow();
    backups.stop();
    expect((await pool.query('SELECT count(*)::int AS n FROM integration_values')).rows[0].n).toBe(0);
  });
});
