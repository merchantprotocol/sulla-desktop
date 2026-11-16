// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

export interface RecordingEligibility { path:string; current_version_id:string | null; deleted_at:Date | null; system_area:string | null; protected:boolean }

export interface RecordingMetadata {
  fileId:     string;
  versionId:  string;
  language:   string | null;
  transcript: unknown[];
  chapters:   unknown[];
  duration:   number | null;
}

/**
 * Transcript-derived plaintext (recording_metadata and the file's search text). Every method
 * is meant to run on one transaction client after `lockEligibility`, through `on(client)`.
 */
export class RecordingMetadataRepository {
  constructor(private readonly db:SearchQueryable) {}

  on(client:SearchQueryable):RecordingMetadataRepository { return new RecordingMetadataRepository(client) }

  /**
   * Lock first, then re-read eligibility in a new statement. A single locking SELECT keeps its
   * pre-wait snapshot for subqueries and can miss protection committed while it waits on the file row.
   */
  async lockEligibility(fileId:string):Promise<RecordingEligibility | undefined> {
    const locked = (await this.db.query('SELECT collection_id FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
    // FOR SHARE, not FOR UPDATE: it still waits for and blocks any change to the collection row
    // (system area, publication), but it does not conflict with the FOR KEY SHARE lock that every
    // file/version/chunk INSERT takes on its collection through the foreign key. FOR UPDATE made
    // each indexing pass queue behind, and then block, every write into the collection.
    if (locked) await this.db.query('SELECT id FROM collections WHERE id=$1 FOR SHARE', [locked.collection_id]);
    return (await this.db.query(`SELECT f.path,f.current_version_id,f.deleted_at,c.system_area,
      EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) protected
      FROM files f JOIN collections c ON c.id=f.collection_id WHERE f.id=$1`, [fileId])).rows[0];
  }

  /** The file may no longer carry derived plaintext: drop metadata, search rows and both job kinds. */
  async purgeFile(fileId:string):Promise<void> {
    await this.db.query('DELETE FROM recording_metadata WHERE file_id=$1', [fileId]);
    await this.db.query('DELETE FROM file_search_text WHERE file_id=$1', [fileId]);
    await this.db.query('DELETE FROM file_search_chunks WHERE file_id=$1', [fileId]);
    await this.db.query('DELETE FROM file_index_jobs WHERE file_id=$1', [fileId]);
    await this.db.query('DELETE FROM recording_enrichment_jobs WHERE file_id=$1', [fileId]);
  }

  async deleteVersionJob(versionId:string):Promise<void> {
    await this.db.query('DELETE FROM recording_enrichment_jobs WHERE version_id=$1', [versionId]);
  }

  /** Stores the metadata, makes the transcript searchable and completes the version's job. */
  async store(output:RecordingMetadata, searchText:string):Promise<void> {
    await this.db.query(`INSERT INTO recording_metadata(file_id,version_id,language,transcript,chapters,duration_seconds,generator)
      VALUES($1,$2,$3,$4,$5,$6,'whisper.cpp') ON CONFLICT(file_id) DO UPDATE SET version_id=EXCLUDED.version_id,language=EXCLUDED.language,
      transcript=EXCLUDED.transcript,chapters=EXCLUDED.chapters,duration_seconds=EXCLUDED.duration_seconds,generator=EXCLUDED.generator,generated_at=NOW()`,
    [output.fileId, output.versionId, output.language, JSON.stringify(output.transcript), JSON.stringify(output.chapters), output.duration]);
    await this.db.query('UPDATE file_search_text SET search_text=$2 WHERE file_id=$1', [output.fileId, searchText]);
    await this.db.query("UPDATE files SET extraction_status='indexed',extracted_at=NOW() WHERE id=$1", [output.fileId]);
    await this.db.query("UPDATE recording_enrichment_jobs SET status='completed',finished_at=NOW() WHERE version_id=$1", [output.versionId]);
  }
}
