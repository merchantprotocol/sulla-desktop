// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

/** Where a file version's encrypted content lives: its chunk collection and ordered chunk ids. */
export interface StoredVersionContent {
  id:                  string;
  path:                string;
  mime:                string;
  version_id:          string;
  chunk_collection_id: string;
  chunk_ids:           string[] | null;
}

export interface CachedPreview { relative_path:string; mime:string }

/** File content lookups and the generated preview (thumbnail) cache. */
export class PreviewRepository {
  constructor(private readonly db:SearchQueryable) {}

  /** The requested version (or the current one) of the file, unless that version is deleted. */
  async findVersionContent(fileId:string, versionId?:string):Promise<StoredVersionContent | undefined> {
    const result = await this.db.query(
      `SELECT f.id,f.path,f.mime,COALESCE($2::uuid,f.current_version_id) AS version_id,
            v.chunk_collection_id,m.chunk_ids
       FROM files f
       JOIN file_versions v ON v.id=COALESCE($2::uuid,f.current_version_id) AND v.file_id=f.id
       LEFT JOIN manifests m ON m.hash=v.manifest_hash
      WHERE f.id=$1 AND NOT v.deleted`,
      [fileId, versionId ?? null],
    );
    return result.rows[0];
  }

  async findPreview(versionId:string, kind:string):Promise<CachedPreview | undefined> {
    return (await this.db.query('SELECT relative_path,mime FROM generated_previews WHERE version_id=$1 AND kind=$2', [versionId, kind])).rows[0];
  }

  async saveThumbnail(versionId:string, relativePath:string):Promise<void> {
    await this.db.query(`INSERT INTO generated_previews(version_id,kind,mime,relative_path) VALUES($1,'thumbnail','image/jpeg',$2)
      ON CONFLICT(version_id,kind) DO UPDATE SET relative_path=EXCLUDED.relative_path,created_at=NOW()`, [versionId, relativePath]);
  }
}
