// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

/** Derived search content of one file: text chunks, their halfvec copies and the full-text payload. */
export class SearchContentRepository {
  constructor(private readonly db:SearchQueryable) {}

  on(client:SearchQueryable):SearchContentRepository { return new SearchContentRepository(client) }

  /** Drops the chunks of every version of the file, so only the version being written remains searchable. */
  async deleteChunksForFile(fileId:string):Promise<void> {
    await this.db.query('DELETE FROM file_search_chunks WHERE version_id IN (SELECT id FROM file_versions WHERE file_id=$1)', [fileId]);
  }

  /** `embeddingJson` is the JSON fallback copy; null once search reads halfvec. Returns the chunk id. */
  async insertChunk(fileId:string, versionId:string, ordinal:number, content:string, embeddingJson:string | null):Promise<string> {
    const inserted = await this.db.query(`INSERT INTO file_search_chunks(file_id,version_id,ordinal,content,embedding_json)
              VALUES($1,$2,$3,$4,$5) RETURNING id`, [fileId, versionId, ordinal, content, embeddingJson]);
    return inserted.rows[0].id;
  }

  async insertVector(chunkId:string, literal:string):Promise<void> {
    await this.db.query('INSERT INTO file_search_vectors(chunk_id,embedding) VALUES($1,$2::halfvec)', [chunkId, literal]);
  }

  async upsertText(fileId:string, path:string, text:string | null):Promise<void> {
    await this.db.query('INSERT INTO file_search_text(file_id,path,search_text) VALUES($1,$2,$3) ON CONFLICT(file_id) DO UPDATE SET path=EXCLUDED.path,search_text=EXCLUDED.search_text', [fileId, path, text]);
  }
}
