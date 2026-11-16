// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

export interface IndexSourceManifest { chunk_collection_id:string; chunk_ids:string[]; total_size:string | number }

/** Where the indexer reads a file version from: its enabled Files root, or its stored manifest. */
export class IndexSourceRepository {
  constructor(private readonly db:SearchQueryable) {}

  async enabledRootPath(collectionId:string):Promise<string | undefined> {
    return (await this.db.query('SELECT mount_path FROM file_roots WHERE collection_id=$1 AND enabled=TRUE', [collectionId])).rows[0]?.mount_path;
  }

  async versionManifest(versionId:string):Promise<IndexSourceManifest | undefined> {
    return (await this.db.query(`SELECT v.chunk_collection_id,m.chunk_ids,m.total_size FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1`, [versionId])).rows[0];
  }
}
