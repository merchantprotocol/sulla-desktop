// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SearchQueryable } from './IndexingJobRepository.js';

export interface ClaimedRecordingJob { file_id:string; version_id:string; attempts:number }

/** The persisted recording enrichment queue (`recording_enrichment_jobs`). */
export class RecordingEnrichmentJobRepository {
  constructor(private readonly db:SearchQueryable) {}

  /** Jobs a previous process was running when it stopped go back to pending. */
  async requeueInterrupted():Promise<void> {
    await this.db.query("UPDATE recording_enrichment_jobs SET status='pending',available_at=NOW(),started_at=NULL WHERE status='processing'");
  }

  /** Jobs parked because whisper.cpp was missing become pending again. */
  async releaseWaitingForRuntime():Promise<void> {
    await this.db.query("UPDATE recording_enrichment_jobs SET status='pending',available_at=NOW() WHERE status='waiting_runtime'");
  }

  /** Claims the oldest due pending job; concurrent workers skip rows another worker holds. */
  async claimNext():Promise<ClaimedRecordingJob | undefined> {
    const claimed = await this.db.query(`UPDATE recording_enrichment_jobs SET status='processing',attempts=attempts+1,started_at=NOW(),last_error=NULL
      WHERE version_id=(SELECT version_id FROM recording_enrichment_jobs WHERE status='pending' AND available_at<=NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING file_id,version_id,attempts`);
    return claimed.rows[0];
  }

  async parkWaitingForRuntime(versionId:string):Promise<void> {
    await this.db.query("UPDATE recording_enrichment_jobs SET status='waiting_runtime',last_error='whisper.cpp model/runtime not installed' WHERE version_id=$1", [versionId]);
  }

  async findFile(fileId:string):Promise<{ id:string; path:string; current_version_id:string | null; deleted_at:Date | null } | undefined> {
    return (await this.db.query('SELECT id,path,current_version_id,deleted_at FROM files WHERE id=$1', [fileId])).rows[0];
  }

  async deleteJob(versionId:string):Promise<void> {
    await this.db.query('DELETE FROM recording_enrichment_jobs WHERE version_id=$1', [versionId]);
  }

  /** Retries after 30 s, or fails the job when `status` is 'failed'. */
  async scheduleRetry(versionId:string, status:'pending' | 'failed', lastError:string):Promise<void> {
    await this.db.query(`UPDATE recording_enrichment_jobs SET status=$2,last_error=$3,available_at=NOW()+INTERVAL '30 seconds',finished_at=CASE WHEN $2='failed' THEN NOW() END WHERE version_id=$1`, [versionId, status, lastError]);
  }
}
