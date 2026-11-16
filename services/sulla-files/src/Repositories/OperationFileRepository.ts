// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

type Queryable = Pick<pg.PoolClient, 'query'>;

/** files-table reads and writes made by receipt operations (move, copy, rename, Trash, undo, restore). */
export class OperationFileRepository {
  async lockById(client:Queryable, id:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }

  /** The file's collection, read before the transaction so access can be prepared. */
  async collectionOf(db:Queryable, id:string):Promise<{ collection_id:string } | undefined> {
    return (await db.query('SELECT collection_id FROM files WHERE id=$1', [id])).rows[0];
  }

  async pathOf(client:Queryable, id:string):Promise<string | undefined> {
    return (await client.query('SELECT path FROM files WHERE id=$1', [id])).rows[0]?.path;
  }

  /** Whether the collection is a native root or the file is under watched custody. */
  async underNativeCustody(client:Queryable, collectionId:string, fileId:string):Promise<boolean> {
    const native = await client.query(`SELECT 1 FROM file_roots WHERE collection_id=$1
    UNION ALL SELECT 1 FROM watched_folder_state WHERE file_id=$2 LIMIT 1`, [collectionId, fileId]);
    return Boolean(native.rowCount);
  }

  async hasNativeRoot(client:Queryable, collectionId:string):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM file_roots WHERE collection_id=$1 LIMIT 1', [collectionId])).rowCount);
  }

  async anyNativeRoot(client:Queryable, collectionIds:string[]):Promise<boolean> {
    return Boolean((await client.query('SELECT 1 FROM file_roots WHERE collection_id=ANY($1::uuid[]) LIMIT 1', [collectionIds])).rowCount);
  }

  async hasDescendant(client:Queryable, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query("SELECT 1 FROM files WHERE collection_id=$1 AND starts_with(path,$2||'/') LIMIT 1", [collectionId, path])).rowCount);
  }

  /** A file sits at an ancestor of `path`. */
  async ancestorIsFile(client:Queryable, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query("SELECT 1 FROM files WHERE collection_id=$1 AND starts_with($2,path||'/') LIMIT 1", [collectionId, path])).rowCount);
  }

  /** A stored file or folder occupies `path` or its subtree. */
  async namespaceOccupied(client:Queryable, collectionId:string, path:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/'))
        UNION ALL SELECT 1 FROM file_folders WHERE collection_id=$1 AND (path=$2 OR starts_with(path,$2||'/')) LIMIT 1`, [collectionId, path])).rowCount);
  }

  /** Undo destination check: another file at, under or above `path`. */
  async undoDestinationOccupied(client:Queryable, collectionId:string, path:string, fileId:string):Promise<boolean> {
    return Boolean((await client.query(`SELECT 1 FROM files WHERE collection_id=$1 AND id<>$3
      AND (path=$2 OR starts_with(path,$2||'/') OR starts_with($2,path||'/')) LIMIT 1`, [collectionId, path, fileId])).rowCount);
  }

  async lockAtPath(client:Queryable, collectionId:string, path:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 FOR UPDATE', [collectionId, path])).rows[0];
  }

  async findAtPath(client:Queryable, collectionId:string, path:string):Promise<any> {
    return (await client.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2', [collectionId, path])).rows[0];
  }

  async rename(client:Queryable, id:string, path:string):Promise<any> {
    return (await client.query('UPDATE files SET path=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [id, path])).rows[0];
  }

  async relocate(client:Queryable, id:string, path:string, collectionId:string):Promise<any> {
    return (await client.query('UPDATE files SET path=$2,collection_id=$3,updated_at=NOW() WHERE id=$1 RETURNING *', [id, path, collectionId])).rows[0];
  }

  async markTrashed(client:Queryable, id:string, tombstoneId:string):Promise<any> {
    return (await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *', [id, tombstoneId])).rows[0];
  }

  async markTrashedQuietly(client:Queryable, id:string, tombstoneId:string):Promise<void> {
    await client.query('UPDATE files SET current_version_id=$2,deleted_at=NOW(),updated_at=NOW() WHERE id=$1', [id, tombstoneId]);
  }

  /** Undo of a copy: the copy moves to its recovery path as a tombstone. */
  async retireCopy(client:Queryable, id:string, recoveryPath:string, tombstoneId:string):Promise<any> {
    return (await client.query('UPDATE files SET path=$2,current_version_id=$3,deleted_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *', [id, recoveryPath, tombstoneId])).rows[0];
  }

  /** Undo of Trash: point back at the exact pre-Trash version. */
  async untrash(client:Queryable, id:string, versionId:string):Promise<any> {
    return (await client.query('UPDATE files SET current_version_id=$2,deleted_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *', [id, versionId])).rows[0];
  }

  /** Restore from Trash, only if the head is still the expected tombstone. */
  async restoreHead(client:Queryable, id:string, versionId:string, size:unknown, expectedHead:string):Promise<any> {
    return (await client.query(`UPDATE files SET current_version_id=$2,deleted_at=NULL,size=$3,updated_at=NOW()
    WHERE id=$1 AND current_version_id=$4 AND deleted_at IS NOT NULL RETURNING *`, [id, versionId, size, expectedHead])).rows[0];
  }
}
