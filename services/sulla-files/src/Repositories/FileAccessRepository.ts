// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = pg.Pool | pg.PoolClient;

/** Single-row lookups every Files access check starts from. Pass a transaction client to read inside it. */
export class FileAccessRepository {
  constructor(private readonly db:Queryable) {}

  /** A published, non-legacy collection, or undefined. */
  async publishedCollection(collectionId:string, queryable:Queryable = this.db):Promise<any> {
    return (await queryable.query('SELECT * FROM collections WHERE id=$1 AND published=TRUE AND legacy_source=FALSE', [collectionId])).rows[0];
  }

  async file(fileId:string, queryable:Queryable = this.db):Promise<any> {
    return (await queryable.query('SELECT * FROM files WHERE id=$1', [fileId])).rows[0];
  }
}
