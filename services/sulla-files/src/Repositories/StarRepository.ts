// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

export interface StarPrincipal { type:string; id:string }

/** A principal's starred files and folders in one collection. */
export class StarRepository {
  constructor(private readonly db:Pick<pg.Pool, 'query'>) {}

  /** Stars in creation order, skipping trashed and protected files (reviewed unbounded read: one principal's stars). */
  async list(principal:StarPrincipal, collectionId:string):Promise<Array<{ collection_id:string; file_id:string | null; folder_path:string | null }>> {
    return (await this.db.query(`SELECT s.collection_id,s.file_id,s.folder_path FROM file_stars s LEFT JOIN files f ON f.id=s.file_id
      WHERE s.principal_type=$1 AND s.principal_id=$2 AND s.collection_id=$3 AND (s.file_id IS NULL OR (f.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id))) ORDER BY s.created_at`, [principal.type, principal.id, collectionId])).rows;
  }

  async starFile(principal:StarPrincipal, collectionId:string, fileId:string):Promise<void> {
    await this.db.query(`INSERT INTO file_stars(principal_type,principal_id,collection_id,file_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [principal.type, principal.id, collectionId, fileId]);
  }

  async starFolder(principal:StarPrincipal, collectionId:string, folderPath:string):Promise<void> {
    await this.db.query(`INSERT INTO file_stars(principal_type,principal_id,collection_id,folder_path) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [principal.type, principal.id, collectionId, folderPath]);
  }

  async unstar(principal:StarPrincipal, collectionId:string, fileId?:string, folderPath?:string):Promise<void> {
    await this.db.query(`DELETE FROM file_stars WHERE principal_type=$1 AND principal_id=$2 AND collection_id=$3 AND (($4::uuid IS NOT NULL AND file_id=$4) OR ($5::text IS NOT NULL AND folder_path=$5))`, [principal.type, principal.id, collectionId, fileId ?? null, folderPath ?? null]);
  }
}
