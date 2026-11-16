// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { resolve } from 'node:path';

import { BackupTableDataRepository } from '../Repositories/BackupTableDataRepository.js';
import { RestorePublicationRepository } from '../Repositories/RestorePublicationRepository.js';
import { TransactionControlRepository } from '../Repositories/TransactionControlRepository.js';
import { BackupPoolFactory } from './BackupPoolFactory.js';
import { BackupRowLoader } from './BackupRowLoader.js';
import { SchemaEvidenceComparison } from './SchemaEvidence.js';
import { SchemaEvidenceReader } from './SchemaEvidenceReader.js';

import type { PublicationIdentity, RestoreLock, SchemaEvidence } from './SchemaEvidence.js';

export class PublicationOutcomeUnknownError extends Error {
  constructor(cause:unknown) { super('Files restore publication outcome is uncertain; preserved recovery state must be reconciled before retrying', { cause }) }
}

/** Publishes a validated snapshot into the live (empty) Files database together with its ciphertext. */
export class DatabasePublisher {
  constructor(
    private readonly pools = new BackupPoolFactory(),
    private readonly reader = new SchemaEvidenceReader(),
    private readonly loader = new BackupRowLoader(),
    private readonly data = new BackupTableDataRepository(),
    private readonly publications = new RestorePublicationRepository(),
    private readonly control = new TransactionControlRepository(),
  ) {}

  /** Serializes restores of one chunk root across processes with a session advisory lock. */
  async acquireRestoreLock(databaseUrl:string, chunkRoot:string):Promise<RestoreLock> {
    const pool = this.pools.open(databaseUrl, 1); const client = await pool.connect();
    try { await this.publications.lock(client, `sulla-files-restore:${ resolve(chunkRoot) }`) } catch (error) { client.release(); await pool.end(); throw error }
    return {
      release: async() => {
        try { await this.publications.unlock(client, `sulla-files-restore:${ resolve(chunkRoot) }`) } finally { client.release(); await pool.end() }
      },
    };
  }

  async publish(
    databaseUrl:string,
    rowsPath:string,
    expected:SchemaEvidence,
    publication:PublicationIdentity,
    publishChunks:()=>Promise<()=>Promise<void>>,
  ):Promise<void> {
    const pool = this.pools.open(databaseUrl, 1); const client = await pool.connect();
    let rollbackChunks:(()=>Promise<void>) | undefined;
    let commitAttempted = false;
    try {
      await this.control.begin(client);
      await this.data.lockExclusive(client, expected.tables.map(table => table.name));
      const actual = await this.reader.describe(client);
      if (!SchemaEvidenceComparison.sameSchema(actual, expected)) throw new Error('Files restore target schema does not match the backup');
      for (const table of expected.tables.filter(table => table.name !== 'files_schema_migrations' && table.name !== 'files_runtime_state')) {
        if (await this.data.hasAnyRow(client, table.name)) throw new Error('Files restore target is not empty');
      }
      rollbackChunks = await publishChunks();
      await this.data.truncate(client, SchemaEvidenceComparison.truncatableTables(expected));
      await this.loader.loadAndValidate(client, rowsPath, expected);
      await this.publications.record(client, publication.snapshotId, publication.archiveSha256);
      commitAttempted = true;
      await this.control.commit(client);
      rollbackChunks = undefined;
    } catch (error) {
      await this.control.rollback(client).catch(() => undefined);
      if (commitAttempted) {
        try {
          if (await this.publicationCommitted(databaseUrl, publication)) { rollbackChunks = undefined; return }
        } catch (probeError) {
          throw new PublicationOutcomeUnknownError(new AggregateError([error, probeError], 'PostgreSQL commit failed and its durable publication marker could not be read'));
        }
      }
      if (rollbackChunks) {
        await rollbackChunks().catch(rollback => {
          throw new PublicationOutcomeUnknownError(new AggregateError([error, rollback], 'Files database and chunk rollback failed'));
        });
      }
      throw error;
    } finally { client.release(); await pool.end() }
  }

  async publicationCommitted(databaseUrl:string, publication:PublicationIdentity):Promise<boolean> {
    const pool = this.pools.open(databaseUrl, 1);
    try {
      const archive = await this.publications.publishedArchive(pool, publication.snapshotId);
      if (archive === undefined) return false;
      if (archive !== publication.archiveSha256) throw new Error('Restore publication marker conflicts with the selected archive');
      return true;
    } finally { await pool.end() }
  }
}
