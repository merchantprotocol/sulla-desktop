// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type pg from 'pg';

/** A pool or a checked-out (transaction) client: anything that runs a parameterized statement. */
export interface SearchQueryable {
  query<R extends pg.QueryResultRow = any>(text:string, values?:unknown[]):Promise<pg.QueryResult<R>>;
}

/** A file's indexing eligibility, read after both of its scope rows are locked. */
export interface IndexEligibility {
  id:                 string;
  collection_id:      string;
  path:               string;
  mime:               string;
  current_version_id: string | null;
  deleted_at:         Date | null;
  system_area:        string | null;
  protected:          boolean;
}

/** A job the worker owns after claiming it; `attempts` fences a later completion against a re-claim. */
export interface ClaimedIndexJob { file_id:string; version_id:string; attempts:number }

/** One terminal or retry outcome written back to the file and its job row. */
export interface IndexJobOutcome { status:string; reasonCode:string; reason:string }

/**
 * The persisted local indexing queue (`file_index_jobs`) and the file-side extraction
 * status it mirrors. Bind it to a transaction client with `on(client)`; statements that
 * must share a transaction's row locks have to run through that bound copy.
 */
export class IndexingJobRepository {
  constructor(private readonly db:SearchQueryable) {}

  /** The same queries, run through `client` (a checked-out transaction client). */
  on(client:SearchQueryable):IndexingJobRepository { return new IndexingJobRepository(client) }

  /**
   * Locks the file row, then its collection row, and only then reads eligibility in a new
   * statement: a single locking statement keeps its pre-wait snapshot for subqueries and
   * could miss protection committed while it waited.
   */
  async lockEligibility(fileId:string):Promise<IndexEligibility | undefined> {
    const locked = (await this.db.query('SELECT collection_id FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
    // FOR SHARE, not FOR UPDATE: it still waits for and blocks any change to the collection row
    // (system area, publication), but it does not conflict with the FOR KEY SHARE lock that every
    // file/version/chunk INSERT takes on its collection through the foreign key. FOR UPDATE made
    // each indexing pass queue behind, and then block, every write into the collection.
    if (locked) await this.db.query('SELECT id FROM collections WHERE id=$1 FOR SHARE', [locked.collection_id]);
    return (await this.db.query(`SELECT f.id,f.collection_id,f.path,f.mime,f.current_version_id,f.deleted_at,c.system_area,
    EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=f.id) protected
    FROM files f JOIN collections c ON c.id=f.collection_id WHERE f.id=$1`, [fileId])).rows[0];
  }

  /** Claims the oldest due pending job; concurrent workers skip rows another worker holds. */
  async claimNext():Promise<ClaimedIndexJob | undefined> {
    const claimed = await this.db.query(`UPDATE file_index_jobs SET status='indexing',attempts=attempts+1,started_at=NOW(),last_error=NULL,reason_code='indexing',reason='Local extraction is in progress.'
      WHERE version_id=(SELECT version_id FROM file_index_jobs WHERE status='pending' AND available_at<=NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING file_id,version_id,attempts`);
    return claimed.rows[0];
  }

  /** Manual re-index: drops the version's chunks, re-queues its job from zero attempts and resets the file. */
  async requeueManually(fileId:string, versionId:string):Promise<void> {
    await this.db.query('DELETE FROM file_search_chunks WHERE file_id=$1 AND version_id=$2', [fileId, versionId]);
    await this.db.query(`INSERT INTO file_index_jobs(file_id,version_id,status,attempts,last_error,available_at,started_at,finished_at,reason_code,reason)
        VALUES($1,$2,'pending',0,NULL,NOW(),NULL,NULL,'manual_retry','Waiting for local indexing.')
        ON CONFLICT(version_id) DO UPDATE SET status='pending',attempts=0,last_error=NULL,available_at=NOW(),started_at=NULL,finished_at=NULL,reason_code='manual_retry',reason='Waiting for local indexing.'`, [fileId, versionId]);
    await this.db.query('UPDATE file_search_text SET search_text=NULL WHERE file_id=$1', [fileId]);
    await this.db.query("UPDATE files SET extracted_at=NULL,extraction_status='pending',extraction_reason_code='manual_retry',extraction_reason='Waiting for local indexing.' WHERE id=$1", [fileId]);
  }

  /** The file is gone, deleted, protected or in an unindexed area: drop every derived row and the job. */
  async discardIneligible(fileId:string, versionId:string):Promise<void> {
    await this.db.query('DELETE FROM file_search_text WHERE file_id=$1', [fileId]);
    await this.db.query('DELETE FROM file_search_chunks WHERE file_id=$1', [fileId]);
    await this.db.query('DELETE FROM file_index_jobs WHERE version_id=$1', [versionId]);
  }

  /** A newer version superseded the job: drop only that version's chunks and its job. */
  async discardStale(fileId:string, versionId:string):Promise<void> {
    await this.db.query('DELETE FROM file_search_chunks WHERE file_id=$1 AND version_id=$2', [fileId, versionId]);
    await this.db.query('DELETE FROM file_index_jobs WHERE version_id=$1', [versionId]);
  }

  async markFileIndexing(fileId:string, versionId:string):Promise<void> {
    await this.db.query("UPDATE files SET extraction_status='indexing',extraction_reason_code='indexing',extraction_reason='Local extraction is in progress.' WHERE id=$1 AND current_version_id=$2", [fileId, versionId]);
  }

  async lockJob(versionId:string):Promise<{ status:string; attempts:number } | undefined> {
    return (await this.db.query('SELECT status,attempts FROM file_index_jobs WHERE version_id=$1 FOR UPDATE', [versionId])).rows[0];
  }

  /** Records the extraction outcome on the file and finishes its job. */
  async complete(fileId:string, versionId:string, outcome:IndexJobOutcome):Promise<void> {
    await this.db.query('UPDATE files SET extracted_at=NOW(),extraction_status=$2,extraction_reason_code=$3,extraction_reason=$4 WHERE id=$1', [fileId, outcome.status, outcome.reasonCode, outcome.reason]);
    await this.db.query('UPDATE file_index_jobs SET status=$2,finished_at=NOW(),reason_code=$3,reason=$4,last_error=NULL WHERE version_id=$1', [versionId, outcome.status, outcome.reasonCode, outcome.reason]);
  }

  /**
   * Re-queues (or fails) a job this worker still owns: only while it is `indexing` with the
   * attempt count the worker claimed. Returns whether the job row was updated.
   */
  async rescheduleOwnedJob(job:ClaimedIndexJob, outcome:IndexJobOutcome, lastError:string):Promise<boolean> {
    const updated = await this.db.query(`UPDATE file_index_jobs SET status=$2,last_error=$3,reason_code=$4,reason=$5,available_at=NOW()+INTERVAL '5 seconds',finished_at=CASE WHEN $2='failed' THEN NOW() END
            WHERE version_id=$1 AND status='indexing' AND attempts=$6`, [job.version_id, outcome.status, lastError, outcome.reasonCode, outcome.reason, job.attempts]);
    return Boolean(updated.rowCount);
  }

  async markFileRetry(fileId:string, versionId:string, outcome:IndexJobOutcome):Promise<void> {
    await this.db.query('UPDATE files SET extraction_status=$3,extraction_reason_code=$4,extraction_reason=$5,extracted_at=CASE WHEN $3=\'failed\' THEN NOW() ELSE NULL END WHERE id=$1 AND current_version_id=$2', [fileId, versionId, outcome.status, outcome.reasonCode, outcome.reason]);
  }
}
