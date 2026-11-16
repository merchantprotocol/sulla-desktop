// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** Reads the grants, public links, key contexts and retention policy that gate receipt operations. */
export class OperationPermissionRepository {
  async retentionPolicy(client:Queryable, collectionId:string):Promise<any> {
    return (await client.query('SELECT retention_policy FROM collections WHERE id=$1', [collectionId])).rows[0]?.retention_policy;
  }

  /** Moving `from` -> `to` crosses an inherited folder grant or public-link boundary. */
  async crossesFolderBoundary(client:Queryable, collectionId:string, from:string, to:string):Promise<boolean> {
    const changed = await client.query(`SELECT 1 FROM folder_shares WHERE collection_id=$1 AND
    (($2=folder_path OR starts_with($2,folder_path||'/')) IS DISTINCT FROM ($3=folder_path OR starts_with($3,folder_path||'/')))
    UNION ALL SELECT 1 FROM file_share_links WHERE collection_id=$1 AND folder_path IS NOT NULL AND revoked_at IS NULL AND
    (($2=folder_path OR starts_with($2,folder_path||'/')) IS DISTINCT FROM ($3=folder_path OR starts_with($3,folder_path||'/'))) LIMIT 1`, [collectionId, from, to]);
    return Boolean(changed.rowCount);
  }

  async shareCollections(client:Queryable, source:string, target:string):Promise<any[]> {
    return (await client.query('SELECT id,owner_user_id,kind FROM collections WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [[source, target]])).rows;
  }

  /** The collection audience plus the folder grants inherited at `path`. */
  async audience(client:Queryable, collectionId:string, path:string | undefined):Promise<any[]> {
    return (await client.query(`SELECT principal_type,principal_id,role FROM (
      SELECT principal_type,principal_id,role FROM collection_acl WHERE collection_id=$1
      UNION SELECT principal_type,principal_id,role FROM folder_shares WHERE collection_id=$1 AND $2::text IS NOT NULL
        AND ($2=folder_path OR starts_with($2,folder_path||'/'))
    ) audience ORDER BY principal_type,principal_id,role`, [collectionId, path ?? null])).rows;
  }

  async activeFolderLinkAt(client:Queryable, source:string, target:string, sourcePath:string | null, targetPath:string | null):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM file_share_links WHERE revoked_at IS NULL AND
    ((collection_id=$1 AND folder_path IS NOT NULL AND $3::text IS NOT NULL AND ($3=folder_path OR starts_with($3,folder_path||'/')))
      OR (collection_id=$2 AND folder_path IS NOT NULL AND $4::text IS NOT NULL AND ($4=folder_path OR starts_with($4,folder_path||'/')))) LIMIT 1`,
    [source, target, sourcePath, targetPath])).rowCount);
  }

  /** A version key context the current owner cannot recover. */
  async unrecoverableKeyContext(client:Queryable, fileIds:string[], ownerId:string):Promise<boolean> {
    const badContext = await client.query(`SELECT 1 FROM file_versions v LEFT JOIN file_version_key_contexts k ON k.version_id=v.id
      LEFT JOIN files_collection_key_bundles b ON b.collection_id=k.collection_id AND b.principal_id=k.principal_id
        AND b.key_version=k.key_version AND b.key_epoch=k.key_epoch
      WHERE v.file_id=ANY($1::uuid[]) AND k.version_id IS NOT NULL
        AND (k.principal_id<>$2 OR b.collection_id IS NULL) LIMIT 1`, [fileIds, ownerId]);
    return Boolean(badContext.rowCount);
  }

  async receiptTargetCollection(client:Queryable, operationId:string):Promise<string | undefined> {
    return (await client.query("SELECT request->>'targetCollectionId' AS id FROM files_database_operation_receipts WHERE id=$1", [operationId])).rows[0]?.id;
  }

  /** md5 over every grant and link that could change who sees the receipt's files. */
  async signature(client:Queryable, collections:string[], operationId:string):Promise<string> {
    return (await client.query(`SELECT md5(jsonb_build_array(
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY collection_id,principal_type,principal_id),'[]') FROM collection_acl a WHERE collection_id=ANY($1::uuid[])),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY collection_id,id),'[]') FROM folder_shares a WHERE collection_id=ANY($1::uuid[])),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM file_shares a WHERE a.file_id::text IN
      (SELECT unnest(ARRAY[before_state->>'fileId',after_state->>'fileId',displaced_after->>'fileId']) FROM files_database_operation_receipts WHERE id=$2)),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM file_share_links a WHERE collection_id=ANY($1::uuid[])
      OR file_id::text IN (SELECT unnest(ARRAY[before_state->>'fileId',after_state->>'fileId',displaced_after->>'fileId']) FROM files_database_operation_receipts WHERE id=$2)))::text) AS signature`, [collections, operationId])).rows[0].signature;
  }
}
