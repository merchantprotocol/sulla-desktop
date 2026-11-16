// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** Finds live files and folders by collection path: mounted-path resolution and move/copy selections. */
export class FileLocatorRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** Every published native collection, the default first. */
  async publishedCollections():Promise<Array<{ id:string; name:string; explorer_path:string | null; is_default:boolean }>> {
    return (await this.db.query(`SELECT id,name,explorer_path,is_default FROM collections WHERE published=TRUE AND legacy_source=FALSE ORDER BY is_default DESC`)).rows;
  }

  async liveFileId(collectionId:string, path:string):Promise<string | undefined> {
    return (await this.db.query('SELECT id FROM files WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [collectionId, path])).rows[0]?.id;
  }

  async liveFolderExists(collectionId:string, path:string):Promise<boolean> {
    return ((await this.db.query('SELECT 1 FROM file_folders WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [collectionId, path])).rowCount ?? 0) > 0;
  }

  /** The live files at or under a folder path, in path order (a move/copy selection). */
  async liveSubtreeFiles(collectionId:string, folderPath:string):Promise<any[]> {
    return (await this.db.query(`SELECT * FROM files WHERE collection_id=$1 AND deleted_at IS NULL AND (path=$2 OR starts_with(path,$2||'/')) ORDER BY path`, [collectionId, folderPath])).rows;
  }
}
