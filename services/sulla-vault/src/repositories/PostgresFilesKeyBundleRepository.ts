// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { FilesKeyBundleContext, FilesKeyBundleEnvelope } from '@sulla/vault-crypto';

import type { Database, Queryable } from '../db.js';

export interface FilesKeyBundleCurrentRow {
  principal_id:  string;
  collection_id: string;
  key_version:   number | string;
  key_epoch:     number | string;
}

export interface FilesKeyBundleEnvelopeRow extends FilesKeyBundleCurrentRow {
  authority_key_id: string;
  authority_bundle: FilesKeyBundleEnvelope;
}

export interface FilesKeyBundleRecord {
  context:        FilesKeyBundleContext;
  authorityKeyId: string;
  envelope:       FilesKeyBundleEnvelope;
}

/**
 * Files collection key bundle storage (migration 014): immutable custody
 * envelopes plus the current authorized (version, epoch) per collection.
 * SQL moved verbatim from filesKeyBundleAuthority.ts (E9).
 */
export class PostgresFilesKeyBundleRepository {
  constructor(private readonly db: Database) {}

  /**
   * One transaction holding the per-collection advisory lock. `work` runs
   * after BEGIN and the lock; COMMIT only if it resolves, ROLLBACK otherwise.
   */
  async withCollectionLock<T>(principalId: string, collectionId: string, work: (connection: Queryable) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`sulla:files:key-bundle:${ principalId }:${ collectionId }`],
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findEnvelope(connection: Queryable, context: FilesKeyBundleContext): Promise<FilesKeyBundleEnvelopeRow | undefined> {
    return (await connection.query<FilesKeyBundleEnvelopeRow>(
      `SELECT principal_id,collection_id,key_version,key_epoch,authority_key_id,authority_bundle
             FROM files_key_bundle_envelopes
            WHERE principal_id=$1 AND collection_id=$2 AND key_version=$3 AND key_epoch=$4`,
      [context.principalId, context.collectionId, context.keyVersion, context.epoch],
    )).rows[0];
  }

  async findCurrentForUpdate(connection: Queryable, principalId: string, collectionId: string): Promise<FilesKeyBundleCurrentRow | undefined> {
    return (await connection.query<FilesKeyBundleCurrentRow>(
      `SELECT principal_id,collection_id,key_version,key_epoch FROM files_key_bundle_current
              WHERE principal_id=$1 AND collection_id=$2 FOR UPDATE`,
      [principalId, collectionId],
    )).rows[0];
  }

  async insertEnvelope(connection: Queryable, bundle: FilesKeyBundleRecord): Promise<void> {
    await connection.query(
      `INSERT INTO files_key_bundle_envelopes
              (principal_id,collection_id,key_version,key_epoch,authority_key_id,authority_bundle)
             VALUES($1,$2,$3,$4,$5,$6)`,
      [bundle.context.principalId, bundle.context.collectionId, bundle.context.keyVersion,
        bundle.context.epoch, bundle.authorityKeyId, bundle.envelope],
    );
  }

  async upsertCurrent(connection: Queryable, context: FilesKeyBundleContext): Promise<void> {
    await connection.query(
      `INSERT INTO files_key_bundle_current(principal_id,collection_id,key_version,key_epoch)
             VALUES($1,$2,$3,$4)
             ON CONFLICT (principal_id,collection_id) DO UPDATE SET
               key_version=EXCLUDED.key_version,key_epoch=EXCLUDED.key_epoch,updated_at=now()`,
      [context.principalId, context.collectionId,
        context.keyVersion, context.epoch],
    );
  }

  /**
   * The envelope only when it is the collection's current authorized generation, read inside
   * the caller's collection-lock transaction. `FOR UPDATE OF c` holds the current-generation row
   * until COMMIT, so a concurrent rotation cannot advance the generation while the envelope is
   * being re-wrapped for a device. Every predicate is scoped to the requesting principal.
   */
  async findCurrentEnvelopeForUpdate(connection: Queryable, context: FilesKeyBundleContext): Promise<FilesKeyBundleEnvelopeRow | undefined> {
    return (await connection.query<FilesKeyBundleEnvelopeRow>(
      `SELECT e.principal_id,e.collection_id,e.key_version,e.key_epoch,e.authority_key_id,e.authority_bundle
           FROM files_key_bundle_current c
           JOIN files_key_bundle_envelopes e USING(principal_id,collection_id,key_version,key_epoch)
          WHERE c.principal_id=$1 AND c.collection_id=$2 AND c.key_version=$3 AND c.key_epoch=$4
          FOR UPDATE OF c`,
      [context.principalId, context.collectionId,
        context.keyVersion, context.epoch],
    )).rows[0];
  }
}
