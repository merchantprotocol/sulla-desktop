// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BackupSchemaRepository } from '../Repositories/BackupSchemaRepository.js';
import { BackupTableDataRepository } from '../Repositories/BackupTableDataRepository.js';
import { RestorePublicationRepository } from '../Repositories/RestorePublicationRepository.js';
import { TransactionControlRepository } from '../Repositories/TransactionControlRepository.js';
import { BackupPoolFactory } from './BackupPoolFactory.js';
import { BackupRowLoader } from './BackupRowLoader.js';
import { MigrationCatalog } from './MigrationCatalog.js';
import { SchemaEvidenceComparison } from './SchemaEvidence.js';
import { SchemaEvidenceReader } from './SchemaEvidenceReader.js';

import type { SchemaEvidence } from './SchemaEvidence.js';
import type pg from 'pg';

export interface StagedDatabase { database: string; url: string; pool: pg.Pool; cleanup():Promise<void> }

/**
 * Loads a backup into a throwaway database built from this build's migrations and proves the
 * result has the backup's exact schema and row counts before anything touches the live store.
 */
export class IsolatedRestoreService {
  constructor(
    private readonly pools = new BackupPoolFactory(),
    private readonly catalog = new MigrationCatalog(),
    private readonly reader = new SchemaEvidenceReader(catalog),
    private readonly loader = new BackupRowLoader(),
    private readonly schema = new BackupSchemaRepository(),
    private readonly data = new BackupTableDataRepository(),
    private readonly publications = new RestorePublicationRepository(),
    private readonly control = new TransactionControlRepository(),
  ) {}

  async restore(databaseUrl:string, rowsPath:string, expected:SchemaEvidence):Promise<StagedDatabase> {
    const stagingName = `sulla_files_restore_${ process.pid }_${ Date.now() }`; const adminUrl = BackupPoolFactory.databaseUrlFor(databaseUrl, 'postgres');
    const admin = this.pools.open(adminUrl, 1);
    await this.assertRestorePrivileges(admin);
    await this.publications.createDatabase(admin, stagingName);
    const stagingUrl = BackupPoolFactory.databaseUrlFor(databaseUrl, stagingName);
    const cleanup = async() => {
      await this.publications.dropDatabase(admin, stagingName).finally(() => admin.end());
    };
    let pool:pg.Pool | undefined;
    try {
      pool = this.pools.open(stagingUrl, 2); await this.applyInstalledSchema(pool, expected);
      const client = await pool.connect();
      try {
        await this.control.begin(client);
        await this.data.truncate(client, SchemaEvidenceComparison.truncatableTables(expected));
        await this.loader.loadAndValidate(client, rowsPath, expected); await this.control.commit(client);
        const actual = await this.reader.describe(client);
        if (!SchemaEvidenceComparison.sameSchema(actual, expected) || JSON.stringify(actual.tables.map(table => table.rows)) !== JSON.stringify(expected.tables.map(table => table.rows))) {
          throw new Error('Restored database inventory does not match backup schema or row counts');
        }
      } catch (error) { await this.control.rollback(client).catch(() => undefined); throw error } finally { client.release() }
      const stagedPool = pool;
      return { database: stagingName, url: stagingUrl, pool: stagedPool, cleanup: async() => { await stagedPool.end(); await cleanup() } };
    } catch (error) { await pool?.end().catch(() => undefined); await cleanup(); throw error }
  }

  private async assertRestorePrivileges(pool:pg.Pool):Promise<void> {
    const role = await this.publications.currentRole(pool);
    if (!role?.rolcreatedb) throw new Error('Files coherent restore requires the PostgreSQL service role to have CREATEDB for isolated validation');
    if (!role.rolsuper) throw new Error('Files coherent restore requires the PostgreSQL service role to be SUPERUSER for constraint-safe row loading');
  }

  private async applyInstalledSchema(pool:pg.Pool, expected:SchemaEvidence):Promise<void> {
    const installed = await this.catalog.installed();
    if (Object.keys(expected.migrationHashes).sort().join('\0') !== expected.migrations.slice().sort().join('\0')) throw new Error('Backup migration evidence is inconsistent');
    await this.schema.createMigrationLedger(pool);
    for (const migration of expected.migrations) {
      const source = installed.get(migration);
      if (source?.hash !== expected.migrationHashes[migration]) throw new Error(`Installed Files migration does not match backup schema evidence: ${ migration }`);
      const client = await pool.connect();
      try {
        await this.control.begin(client); await this.schema.runMigration(client, source.sql); await this.schema.recordMigration(client, migration); await this.control.commit(client);
      } catch (error) { await this.control.rollback(client); throw error } finally { client.release() }
    }
  }
}
