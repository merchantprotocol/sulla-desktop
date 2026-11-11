// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { QueryResult, QueryResultRow } from 'pg';
import type { Database, Queryable } from '../db.js';

/** Rows of the durable sign-out queue. Values are vault-encrypted refresh tokens. */
export class PostgresSullaCloudRevocationRepository {
  constructor(private readonly db: Database) {}

  insert<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`INSERT INTO sulla_cloud_pending_revocations(id,owner_user_id,ciphertext,encrypted_item_key) VALUES ($1,$2,$3,$4)`, values);
  }

  listForOwner<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`SELECT id,ciphertext,encrypted_item_key FROM sulla_cloud_pending_revocations WHERE owner_user_id=$1 ORDER BY created_at,id`, values);
  }

  deleteOwned<T extends QueryResultRow = QueryResultRow>(values: unknown[], client: Queryable = this.db): Promise<QueryResult<T>> {
    return client.query<T>(`DELETE FROM sulla_cloud_pending_revocations WHERE id=$1 AND owner_user_id=$2`, values);
  }
}
