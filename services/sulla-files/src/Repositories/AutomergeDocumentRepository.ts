// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

/** The stored Automerge text document of a file and the heads of each saved version (moved from app.ts). */
export class AutomergeDocumentRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** Saves the file's current document and the version's heads (payload stays NULL; retention trims history). */
  async saveVersion(client:pg.PoolClient, fileId:string, versionId:string, document:Buffer, heads:string):Promise<void> {
    await client.query(`INSERT INTO file_automerge_docs(file_id,document,heads,updated_at) VALUES($1,$2,$3,NOW())
      ON CONFLICT(file_id) DO UPDATE SET document=EXCLUDED.document,heads=EXCLUDED.heads,updated_at=EXCLUDED.updated_at`, [fileId, document, heads]);
    await client.query(`INSERT INTO file_automerge_versions(version_id,file_id,document,heads) VALUES($1,$2,NULL,$3)
      ON CONFLICT(version_id) DO UPDATE SET document=NULL,heads=EXCLUDED.heads`, [versionId, fileId, heads]);
  }

  async currentDocument(queryable:Queryable, fileId:string):Promise<{ document:Buffer } | undefined> {
    return (await queryable.query('SELECT document FROM file_automerge_docs WHERE file_id=$1', [fileId])).rows[0];
  }

  /** One-time compatibility bridge for rows written before migration 063. */
  async legacyVersionDocument(queryable:Queryable, versionId:string, fileId:string):Promise<{ document:Buffer } | undefined> {
    return (await queryable.query('SELECT document FROM file_automerge_versions WHERE version_id=$1 AND file_id=$2 AND document IS NOT NULL', [versionId, fileId])).rows[0];
  }

  async versionHeads(queryable:Queryable, versionId:string, fileId:string):Promise<{ heads:any } | undefined> {
    return (await queryable.query('SELECT heads FROM file_automerge_versions WHERE version_id=$1 AND file_id=$2', [versionId, fileId])).rows[0];
  }

  /** The stored document and its change stamp, read through the pool before a live flush. */
  async latest(fileId:string):Promise<{ document:Buffer; stamp:string } | undefined> {
    return (await this.db.query('SELECT document,updated_at::text AS stamp FROM file_automerge_docs WHERE file_id=$1', [fileId])).rows[0];
  }

  /** The change stamp, re-read under the path lock inside the flush transaction. */
  async stamp(client:pg.PoolClient, fileId:string):Promise<string | undefined> {
    return (await client.query('SELECT updated_at::text AS stamp FROM file_automerge_docs WHERE file_id=$1', [fileId])).rows[0]?.stamp;
  }

  async replaceDocument(client:pg.PoolClient, fileId:string, document:Buffer, heads:string):Promise<void> {
    await client.query('UPDATE file_automerge_docs SET document=$2,heads=$3,updated_at=NOW() WHERE file_id=$1', [fileId, document, heads]);
  }
}
