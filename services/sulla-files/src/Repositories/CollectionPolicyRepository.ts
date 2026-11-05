// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type pg from 'pg';

export interface CollectionPublicationPolicy { system_area:string|null }

export class CollectionPolicyRepository {
  async findPublicationPolicy(client:pg.PoolClient, collectionId:string):Promise<CollectionPublicationPolicy|null> {
    return (await client.query('SELECT system_area FROM collections WHERE id=$1', [collectionId])).rows[0] ?? null;
  }
}
