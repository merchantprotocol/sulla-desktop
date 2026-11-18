// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface ScannedChunkRow { id:string; size:number; storedSize:number }

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

/**
 * Read-only queries for the chunk integrity scan. Every statement runs inside a READ ONLY transaction with
 * a statement timeout, so the scan can never write and can never hold a database connection for long.
 */
export class ChunkIntegrityRepository {
  constructor(
    private readonly db:Pick<pg.Pool, 'connect'>,
    private readonly statementTimeoutMs = DEFAULT_STATEMENT_TIMEOUT_MS,
  ) {}

  /** Collections that own chunk rows, optionally narrowed to one. */
  async collectionIds(collectionId?:string):Promise<string[]> {
    return this.readOnly(async client => (await client.query(
      'SELECT DISTINCT collection_id::text AS collection_id FROM chunks WHERE $1::uuid IS NULL OR collection_id=$1::uuid ORDER BY 1',
      [collectionId ?? null],
    )).rows.map(row => String(row.collection_id)));
  }

  /** The next page of chunk rows after the given id, in id order (keyset pagination). */
  async chunkPage(collectionId:string, afterId:string, limit:number):Promise<ScannedChunkRow[]> {
    return this.readOnly(async client => (await client.query(
      'SELECT id, size, stored_size FROM chunks WHERE collection_id=$1 AND id > $2 ORDER BY id LIMIT $3',
      [collectionId, afterId, limit],
    )).rows.map(row => ({ id: String(row.id), size: Number(row.size), storedSize: Number(row.stored_size) })));
  }

  private async readOnly<T>(work:(client:pg.PoolClient) => Promise<T>):Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${ this.statementTimeoutMs }`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
