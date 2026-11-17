// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Collection rows a caller may be granted access to. */
export class CollectionAccessRepository {
  constructor(private readonly db:Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  /** A published, non-legacy collection by id. */
  async agentCanUse(collectionId:string,userId:string,groupIds:string[]=[]):Promise<boolean> {
    return Boolean((await this.db.query(`SELECT 1 FROM collection_acl WHERE collection_id=$1 AND role='use-by-agents' AND
      ((principal_type='user' AND principal_id=$2) OR (principal_type='group' AND principal_id=ANY($3::text[]))) LIMIT 1`,[collectionId,userId,groupIds])).rowCount);
  }

  async findAccessible(collectionId:string):Promise<any | undefined> {
    const result = await this.db.query(
      'SELECT * FROM collections WHERE id=$1 AND published=TRUE AND legacy_source=FALSE',
      [collectionId],
    );
    return result.rows[0];
  }
}
